# Hawkeye load tests (k6)

These tests prove the election-night numbers in
`docs/private/ELECTION-NIGHT-HOSTING.md` against a **staging** copy of
Hawkeye. [k6](https://grafana.com/docs/k6/latest/) is open source and ships as
a single binary. **k6 ≥ 1.0 is required**, because the upload scenario signs
reports with the global WebCrypto API.

## Production is refused

`run.sh` and the scripts refuse production three times over:

1. **`run.sh`** treats `hawkeye.com.ng`, and every subdomain except
   `staging.hawkeye.com.ng`, as production. It also treats as production any
   server whose `/api/health` says `"env":"production"`, whatever it is called.
2. **The k6 init context** (`lib/guard.js`) applies the same hostname rule,
   even if you run k6 directly.
3. **`setup()`** asks `/api/health` again and aborts on `env=production`.

`--i-know-this-is-prod` unlocks **only the read scenario**, and only with:

- `--profile smoke` or `edge`;
- at most 25 req/s (`PROD_MAX_RPS`, hard ceiling 50) for 3 minutes;
- cacheable public endpoints only: no fixtures, no `--legacy`,
  no `--direct-origin`, no `ORIGIN_AUTH`.

Use it to confirm edge cache behaviour (`edge_hit`) after a cache-rule change,
never to measure capacity.

## No real SMS or WhatsApp, ever

The auth scenario creates accounts through the real `/register` → `/verify`
path. That is only safe because of the following checks:

- Staging runs `SMS_PROVIDER=console` with `SMS_OTP_ENABLED` off and **no**
  `SENDCHAMP_API_KEY`, `TERMII_API_KEY`, `BULKSMS_NG_API_TOKEN`,
  `WA_CLOUD_TOKEN` or `WA_PHONE_NUMBER_ID`. On that provider, outside
  production, the server returns the code as `devOtp`.
- `backend/scripts/seed_staging.mjs` (private repo: it loads server code) refuses to run unless all of that is true on the host
  itself. It writes an attestation into the fixtures, which k6 rejects if it
  was made for another host or is more than 24 hours old.
- `run.sh` and `setup()` refuse unless `/api/health` reports `smsOtp:false`
  and `waCloud:false`.
- **A canary sign-up must come back as `devOtp`.** If it does not, the whole
  test aborts before the first iteration. Every later register reply is checked
  the same way, and the test aborts on the first one without `devOtp`.
- Test numbers are `0700` + 7 digits, a non-mobile prefix. The stub is the
  safety, not the prefix.

## Scenarios

| Scenario | File | What it does | Where it may run |
|---|---|---|---|
| `read` | `scenarios/read-storm.js` | Results and ledger read storm, weighted like the real pollers: `/api/national` (with state crops), contests, integrity, incidents, ledger head, docket, declarations, per-PU results, HTML. With fixtures it adds authenticated GETs (`/me`, `/notifications`, `/my-unit`). `--legacy` adds what shipped clients poll today: the 1,000-row ledger default and the unbounded `/api/results`. | staging; production smoke only |
| `upload` | `scenarios/report-upload.js` | The real observer path: presign, two R2 PUTs, then a signed JSON submit. Seeded test observers, synthetic JPEGs made unique per report. `--upload-path proxy` measures the multipart fallback (kill switch KS-6). | staging only |
| `auth` | `scenarios/auth-otp.js` | 50% sign-up (register → verify with `devOtp`), 20% wrong-code verify, 20% password login (the scrypt cost), 10% device resume. | staging only |
| `ramp` | `scenarios/ramp.js` | All four at once on the election-night shape: warm 10%, ramp, hold, a **+50% spike** for the herd after a push broadcast, recover, drain. | staging only |

Profiles (per second at 100%, from `lib/common.js`):

| Profile | Public GET | Authed GET | Reports | Auth | Use |
|---|---|---|---|---|---|
| `smoke` | 20 | 50 | 5 | 2 | Does it work? |
| `origin` | 400 | 1,500 | 250 | 20 | **The design point**: post-edge origin load at 1M users, with no cache in front |
| `stress` | 600 | 2,250 | 375 | 30 | 1.5× design (LT#3 gate) |
| `edge` | 1,000 | 0 | 0 | 0 | Through Cloudflare: hit ratio and SWR, not capacity |

`--scale N` multiplies every rate. `--time-scale 0.2` compresses the ~30-minute
shape to about 6 minutes.

## Setting up staging (once)

1. **Hosting.** Staging runs the same stack as production (AWS eu-west-1,
   Caddy, systemd roles, Litestream), at `staging.hawkeye.com.ng`. It has its
   own R2 buckets (`hawkeye-evidence-staging`, `hawkeye-db-staging`) and
   **fresh secrets**: `JWT_SECRET`, `PHONE_SALT` and `ORACLE_SECRET` are never
   copied from production.
2. **`backend/.env` on staging:**

   ```
   APP_ENV=staging
   SMS_PROVIDER=console
   UPLOAD_MODE=direct
   BLOB_DRIVER=s3
   ```

   Also: SMS OTP off, and none of the messaging keys listed above.
3. **Data.** Restore a production snapshot (it is public data plus hashed
   phones), then **take a snapshot of staging itself**. That snapshot is how you
   reset after each test.
4. **Contest dates.** In staging's own `backend/src/data/contests.json`, set
   the `date` of PRES, SEN and REP to the test day, so reporting is open from
   08:30 WAT. **Never commit that edit.**
5. **Seed.** On the staging host, from the repo root:

   ```bash
   node scripts/loadtest/seed/make_sample_jpegs.mjs scripts/loadtest/.fixtures
   APP_ENV=staging node backend/scripts/seed_staging.mjs --i-am-on-staging \
     --host staging.hawkeye.com.ng --count 60000 --auth 2000 \
     --out scripts/loadtest/.fixtures/staging.json
   ```

   Each upload observer can file each of the 3 races once, so `--count` must be
   at least one third of the reports you plan to send. For example, 250/s for
   ~20 minutes of the ramp is about 300k reports, which needs 100k observers.
   Copy `.fixtures/` to the load generator over SSH or SSM. **It holds
   staging-only tokens and private keys; it is gitignored. Never commit or share
   it.**

## Running

```bash
# 0. smoke everything first
scripts/loadtest/run.sh read   --base-url https://staging.hawkeye.com.ng
scripts/loadtest/run.sh upload --base-url https://staging.hawkeye.com.ng --fixtures scripts/loadtest/.fixtures/staging.json
scripts/loadtest/run.sh auth   --base-url https://staging.hawkeye.com.ng --fixtures scripts/loadtest/.fixtures/staging.json --direct-origin

# 1. the design point, straight at the staging ORIGIN (no Cloudflare)
scripts/loadtest/run.sh ramp --base-url https://<staging-origin> --profile origin \
  --fixtures scripts/loadtest/.fixtures/staging.json --direct-origin --legacy

# 2. the edge: is the allowlisted API served from cache?
scripts/loadtest/run.sh read --base-url https://staging.hawkeye.com.ng --profile edge
```

- **`--direct-origin`** sends a synthetic `CF-Connecting-IP` from
  `198.18.0.0/15` (the RFC 2544 benchmarking range), skewed so a few addresses
  carry many users, the way Nigerian CGNAT does. This is the only honest way to
  exercise the per-IP limits. It works only because staging accepts direct
  traffic. **Production must not**: its security group admits only Cloudflare.
  If staging arms the origin lock, export `ORIGIN_AUTH=<staging's own secret>`.
- **Capacity is measured at the origin, not through Cloudflare.** Several
  thousand requests per second from a few IPs looks like an attack, and
  Cloudflare may mitigate it. Keep edge runs at `--profile edge` or below, and
  add a WAF skip rule for the generator IPs.
- Results go to `results/<timestamp>-<scenario>-<profile>/summary.json`
  (gitignored). Key metrics:
  - `http_req_duration` by `name` tag (`national`, `presign`, `submit`,
    `r2_put`, `login_password` …);
  - `report_ok`, `report_end_to_end_ms`, `otp_flow_ok`;
  - `server_busy_503`, `rate_limited_429`, `edge_hit`.
- Watch the server during every run: event-loop lag, CPU per role, the
  writer's queue, WAL size and Litestream lag. A test that only reads k6 output
  measures the generator, not Hawkeye.

## Where to run

- **A VM** in eu-west-1: 3 × c7g.2xlarge, about US$0.31/h each. Use the
  DigitalOcean nonprofit credit instead if it lands. Use `k6 run` on each with
  `--scale 0.34`, or k6's distributed mode.
- **GitHub Actions:** `ci/loadtest.yml.example`. It is manual only, the target
  is a fixed choice of staging, and it runs only the read scenario with the
  smoke or edge profile. One runner cannot generate the origin profile.

## After a run

**Reset staging by restoring the pre-test snapshot.** Test rows cannot be
deleted: submissions form a hash chain, and deleting any of them breaks the
chain. The seeded observers are `is_staff=1` and are excluded from public
counts in any case.

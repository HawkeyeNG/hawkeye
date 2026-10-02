# Hawkeye staging on AWS (stand up in November, spend nothing before)

These scripts build the staging copy of the election-night stack described in
`docs/private/ELECTION-NIGHT-HOSTING.md`: EC2 Graviton in eu-west-1, SQLite
with two independent copies (Litestream 0.5 to R2, and an hourly backup to S3),
Caddy behind Cloudflare, and systemd writer, reader and worker roles. **Nothing exists until you run `provision.sh --apply`. Until then
staging costs $0.**

| Script | What it does | Safe to run today? |
|---|---|---|
| `provision.sh` | Dry run by default. It prints every resource and the cost, then checks the account and asks EC2 `--dry-run` whether the launch would succeed. `--apply` creates the resources. `--offline` makes no AWS call. | Yes. It refuses with the CLI in 131708657746. |
| `bootstrap.sh` | Builds the code bundle, ships it to the instance over SSM (no SSH), and runs the on-host setup there. `--dry-run` only builds and checks the bundle. | `--dry-run` yes. A real run refuses in the wrong account. |
| `teardown.sh` | Lists everything tagged `project=hawkeye env=staging`, asks you to type `delete hawkeye staging`, deletes it all, then lists again to prove nothing is left. `--list` deletes nothing. | Yes. It refuses in the wrong account. |
| `lib.sh` | Shared settings: the account guard, names, tags, prices and Cloudflare ranges. | n/a |

## Guarantees

- **The account guard runs before every AWS call that is not a pure print.**
  `aws sts get-caller-identity` must return `025232685387`, the production
  account (owner decision). Any other account prints `REFUSED`, exits 2, and
  nothing is created, changed or deleted.
- **Every resource is tagged `project=hawkeye env=staging`**: instance, volumes,
  ENI, security group, IAM role, instance profile, bucket and SSM parameters.
  Teardown finds resources by these tags. IAM also has a fixed path,
  `/hawkeye/staging/`.
- **Only Cloudflare can reach the origin.** Ports 80 and 443 accept only
  Cloudflare's published ranges. The live list is fetched, the pinned list in
  `lib.sh` is the fallback, and drift is warned about. Egress is 443 only.
  **There is no port 22 and no key pair**; the shell is
  `aws ssm start-session`. `provision.sh` re-reads the security group after
  creating it and fails if it finds port 22 or a non-Cloudflare source.
- **No secret is on disk or in these scripts.**
  - `provision.sh` generates fresh `JWT_SECRET`, `ORACLE_SECRET`, `PHONE_SALT`
    and `ORIGIN_AUTH_SECRET` as SSM SecureStrings. They are never printed and
    never copied from production.
  - At every boot, `hawkeye-prestart` reads `/hawkeye/staging/*` into
    `/run/hawkeye`, which is tmpfs.
- **Staging cannot message a real person.** It restores a production snapshot,
  which holds real phone hashes and push tokens. So `hawkeye-prestart` refuses
  to start anything in any of these cases:
  - SSM holds a Sendchamp, Termii, BulkSMS, WhatsApp, Telegram, FCM, VAPID or
    social credential;
  - `SMS_OTP_ENABLED` is on;
  - `SMS_PROVIDER` is not `console`;
  - `APP_ENV` is not `staging`.

  This is the precondition of `scripts/loadtest/`.

## Why bash + AWS CLI, not Terraform/OpenTofu

- **No state file.** Terraform keeps generated secrets in plaintext in its
  state file. A lost state file orphans resources. Here the secrets live only
  in SSM, and teardown works from tags, even from a fresh laptop.
- **No new tool.** The AWS CLI is already installed and signed in. OpenTofu
  would be one more binary and one more version to pin in the freeze window.
- **The job is small.** It is about 9 resources, created once per season.
  `ec2 --dry-run` gives a free permission check, and the teardown requirement
  ("everything tagged env=staging") maps directly onto the tagging API.

## Cost

These are eu-west-1 on-demand prices from the plan's §3.1. `provision.sh`
prints the same table.

| `--size` | Instance | USD/day | USD/month (730 h) |
|---|---|---|---|
| `rehearsal` (default) | c7g.xlarge, 4 vCPU / 8 GB | **4.03** | 122.52 |
| `small` | t4g.medium, the plan's staging line (CPU credits capped at "standard") | 1.19 | ~36 |
| `loadtest` | c7g.4xlarge, for LT#1–#3 | 15.19 | ~462 |

The default day breaks down as follows:

| Item | USD/day |
|---|---|
| c7g.xlarge | 3.72 |
| EBS gp3, 10 GB root + 40 GB data | 0.14 |
| Public IPv4 | 0.12 |
| S3 hourly backups + replica (upper bound) | 0.04 |
| SSM Parameter Store (standard), Session Manager, data out (under 100 GB, behind Cloudflare) | 0 |

- **Stopped** (not torn down): EBS only, **0.14/day**. The public IP is released
  when the instance stops.
- **After `teardown.sh`: 0.**
- **LT#1 week at `loadtest` size (5 days):** about $76. Running `rehearsal` for
  the rest of November is about $4/day.

## The November sequence

**Before you start (once, owner):**

- **The account.** Upgrade `025232685387` to the Paid plan, so a Free-plan
  account cannot close itself (plan §3.2). Add budget alarms.
- **Cloudflare.**
  1. Create an **Origin CA certificate** for `staging.hawkeye.com.ng`
     (SSL/TLS → Origin Server).
  2. Create the R2 buckets `hawkeye-db-staging` and `hawkeye-evidence-staging`.
  3. Create an R2 API token scoped to those two buckets only.

**0. Sign in to the right account**

```bash
aws login                       # or: export AWS_PROFILE=<the 025232685387 profile>
aws sts get-caller-identity     # must say 025232685387
```

**1. Provision** (about 5 minutes)

```bash
scripts/staging/provision.sh            # read the plan and the cost
scripts/staging/provision.sh --apply    # prints the instance id and the origin IP
```

Point Cloudflare DNS at the origin: `staging.hawkeye.com.ng`, an A record to
the printed IP, **proxied**. Never use a DNS-only record, and never paste the
IP into a doc or a chat.

Then add a Transform Rule for that hostname that sets `X-Origin-Auth` to the
staging secret. Read the secret with:

```bash
aws ssm get-parameter --region eu-west-1 --with-decryption \
  --name /hawkeye/staging/env/ORIGIN_AUTH_SECRET --query Parameter.Value --output text
```

The origin lock is armed from the first boot, so every request gets 403 until
the rule exists.

**2. Owner-held keys into SSM** (optional but expected; each part below degrades
safely without its keys)

```bash
R=eu-west-1; P=/hawkeye/staging; T=(--tags Key=project,Value=hawkeye Key=env,Value=staging)

# TLS. Without it Caddy uses `tls internal`, which Cloudflare accepts in "Full"
# mode but not in "Full (strict)".
aws ssm put-parameter --region $R --type SecureString --name $P/tls/origin_cert --value file://staging-origin.pem "${T[@]}"
aws ssm put-parameter --region $R --type SecureString --name $P/tls/origin_key  --value file://staging-origin.key "${T[@]}"

# The Litestream replica, R2. Without it Litestream replicates to the S3 bucket,
# the same provider as the hourly backup, so the two copies are not independent.
for k in R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  read -rsp "$k: " v; echo; aws ssm put-parameter --region $R --type SecureString --name $P/litestream/$k --value "$v" "${T[@]}"; done

# Evidence bucket, which gives UPLOAD_MODE=direct. Without it: proxy mode with fs storage.
for k in S3_BUCKET S3_ENDPOINT S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  read -rsp "$k: " v; echo; aws ssm put-parameter --region $R --type SecureString --name $P/env/$k --value "$v" "${T[@]}"; done
```

`read -s` keeps the values out of your shell history. If you add keys after
bootstrap, run `sudo hawkeye-restart` on the host.

**3. Bootstrap, with a production snapshot as the database**

```bash
# the snapshot comes from the existing backup path (pull_backup.sh)
scripts/staging/bootstrap.sh --seed-db /path/to/hawkeye-snapshot.db
```

This installs Node v22.23.3, Caddy 2.11.4 and Litestream 0.5.17. Each download
is pinned to a hash; Litestream's is the line in its release `checksums.txt`.
It then:

1. formats and mounts the data volume at `/var/lib/hawkeye`;
2. runs `npm ci` on arm64 and checks that the npm ffmpeg binary runs;
3. starts `hawkeye.target`, including Litestream and the hourly backup timer;
4. proves the result by behaviour. The writer must report `role=writer` and
   `env=staging`, every reader `role=reader`, and the worker `role=worker`, and
   `:443` must answer through Caddy;
5. takes the first hourly backup and runs `hawkeye-restore-test`, which must
   restore from **both** copies (below).

`--seed-db` never overwrites an existing database.

## The database: two copies, two providers

| Copy | What | Where | RPO | Kept |
|---|---|---|---|---|
| 1 | Litestream 0.5, continuous, one replica | R2 `hawkeye-db-staging`, path `hawkeye.db` (S3 `litestream/` until the R2 keys exist) | ≤ 1 s in election week (13–24 Jan 2027), ≤ 10 s otherwise | 72 h of snapshots (hourly) plus LTX |
| 2 | `hawkeye-db-backup.timer`, hourly at :05: `sqlite3 .backup`, `PRAGMA quick_check` on the copy, gzip | S3 `s3://hawkeye-staging-replica-025232685387/backup/hourly/`, first of each UTC day also in `backup/daily/` | ≤ 1 h | newest 48 hourly and 14 daily, pruned by count |

- Litestream 0.5 allows **one** replica per database. The second copy is
  therefore not a second Litestream replica. It shares nothing with copy 1: not
  the tool, the format, the provider or the credentials. Each object carries
  its SHA-256 and its ledger head in the S3 metadata.
- Pruning is by count, not age. If the timer stops, the last 48 good copies
  stay. `systemctl list-timers hawkeye-db-backup.timer` shows the next run;
  `journalctl -u hawkeye-db-backup` shows each result;
  `/var/lib/hawkeye/backup/last-ok` holds the time of the last success.
- The backup opens the database with `no_ckpt_on_close`, so it can never
  checkpoint the WAL behind Litestream's back.
- `/api/health` → `litestreamGeneration` is Litestream's position for this
  database: the TXID of its newest local LTX file (16 hex digits; one per sync
  that found new writes; the name is kept from 0.3). It is null when Litestream
  has never run here, and it must rise as reports arrive.

### Sync interval (design D7)

Litestream's `sync-interval` is **1 s from 13 to 24 January 2027** (dates in
West Africa Time, both days included) and **10 s at every other time**. At 1 s
Litestream makes about 90,000 R2 PUTs a day, which passes R2's free million a
month; at 10 s it stays inside it. The cost is RPO: up to 10 s of writes
outside election week, 1 s inside it. The hourly S3 backup is unaffected.

- `hawkeye-prestart` asks `hawkeye-litestream-interval --print` at every boot
  and writes the answer into `/run/hawkeye/litestream.yml`. If the helper
  fails, it writes 1 s, the safe side, and starts anyway.
- `hawkeye-litestream-interval.timer` runs the helper hourly at :00:30. The
  helper rewrites the config and restarts Litestream only when the value
  changes, so on 13 Jan it switches to 1 s within a minute of midnight WAT
  (23:00 UTC on 12 Jan). On 25 Jan it switches back to 10 s. It uses
  `try-restart`, so it never starts a Litestream someone stopped on purpose
  during a failover or a restore.
- Litestream reads its config only at start, so a change costs one restart of
  a couple of seconds. The writes in that gap are in the WAL, and Litestream
  ships them when it comes back.

Runbook (on the host):

```bash
sudo hawkeye-litestream-interval --status     # schedule, any pin, running value, next timer run
sudo hawkeye-litestream-interval --set 1s     # pin 1 s now, e.g. for a governorship or re-run week
sudo hawkeye-litestream-interval --set auto   # remove the pin and go back to the date schedule
sudo hawkeye-litestream-interval              # apply what applies now (what the timer runs)
journalctl -u hawkeye-litestream-interval     # every switch, with the old and the new value
```

The pin lives in `/etc/hawkeye/litestream-sync-interval` and survives reboots.
To move election week, edit `WINDOW_START`/`WINDOW_END` in `bootstrap.sh` and
re-run it. `bootstrap.sh` checks that the running config carries the value the
schedule gives.

### Restore test (run it after every drill, and weekly)

```bash
sudo hawkeye-restore-test          # on the host
```

It restores copy 1 with `litestream restore` and copy 2 from the newest hourly
object (after checking its SHA-256 against the metadata). For each copy it runs
`PRAGMA integrity_check` and checks that the copy's ledger head row exists in
the **live** database with the same hash, so the copy is the same chain and not
merely a valid file. It prints how far behind live each copy is. Nothing live is
written, and the scratch directory is removed.

### Restore and failover

Restore by hand, into a scratch path, never over the live file:

```bash
# copy 1, the Litestream replica (latest, or -timestamp 2026-11-17T01:59:00Z)
sudo -u hawkeye litestream restore -config /run/hawkeye/litestream.yml \
  -o /var/lib/hawkeye/restore.db /var/lib/hawkeye/storage/hawkeye.db
# copy 2, an hourly backup
aws s3 ls s3://hawkeye-staging-replica-025232685387/backup/hourly/ | tail -3
aws s3 cp s3://hawkeye-staging-replica-025232685387/backup/hourly/hawkeye-<UTC>.db.gz - | gunzip > /tmp/restore.db
```

A standby can follow the replica continuously with
`litestream restore -f -o <path> <replica-url>` (0.5.17 has follow mode). Treat
the followed file as read-only.

**Failover drill (fenced, manual):**

1. **Fence the primary.** Stop the instance, or detach its security group.
   From here the old primary must never write again.
2. **Final restore** on the new host from copy 1 (from copy 2 only if copy 1 is
   lost; then up to an hour of reports is lost and must come back from phones'
   outboxes). Run `PRAGMA integrity_check`.
3. **Point Litestream at a new path.** Put a new, unique `REPLICA_PATH`, such as
   `hawkeye-20261117-b`, into SSM (below). Never let the new primary write into
   the old primary's path. The old path stays as it was, as evidence and as a
   restore point.
4. **Install the database.** `sudo systemctl stop hawkeye.target`, move the
   restored file to `/var/lib/hawkeye/storage/hawkeye.db` (owner `hawkeye`),
   delete any `hawkeye.db-wal`, `hawkeye.db-shm` and
   `.hawkeye.db-litestream/` beside it, then `sudo hawkeye-restart`.
5. Switch the Cloudflare origin record.
6. **Verify by behaviour**: `/api/health` shows the new `host`, the ledger head
   equals the restored head, and `litestreamGeneration` rises as reports arrive.
   Then run `sudo hawkeye-restore-test`.

```bash
aws ssm put-parameter --region eu-west-1 --type SecureString --overwrite \
  --name /hawkeye/staging/litestream/REPLICA_PATH --value hawkeye-20261117-b
```

A standby that follows the replica must be pointed at the new path too.

**4. Seed load-test observers**, on the host:

```bash
aws ssm start-session --region eu-west-1 --target <instance-id>
sudo python3 - <<'PY'   # open PRES/SEN/REP for the test day, in THIS release only (never committed)
import json, datetime; p = "/opt/hawkeye/current/backend/src/data/contests.json"; d = json.load(open(p))
for c in d:
    if c.get("code") in ("PRES", "SEN", "REP"): c["date"] = datetime.date.today().isoformat()
json.dump(d, open(p, "w"), indent=2)
PY
sudo hawkeye-restart
sudo install -d -o hawkeye -g hawkeye /var/lib/hawkeye/loadtest
sudo -u hawkeye bash -c 'set -a; . /etc/hawkeye/staging.env; . /run/hawkeye/app.env; set +a; cd /opt/hawkeye/current
  node scripts/loadtest/seed/make_sample_jpegs.mjs /var/lib/hawkeye/loadtest
  node backend/scripts/seed_staging.mjs --i-am-on-staging --host staging.hawkeye.com.ng \
    --count 100000 --auth 2000 --out /var/lib/hawkeye/loadtest/staging.json'
sudo -u hawkeye sqlite3 /var/lib/hawkeye/storage/hawkeye.db ".backup /var/lib/hawkeye/pretest.db"   # the reset point
sudo aws s3 cp --recursive /var/lib/hawkeye/loadtest/ s3://hawkeye-staging-replica-025232685387/fixtures/
```

On the load generator, fetch the fixtures:

```bash
aws s3 cp --recursive s3://hawkeye-staging-replica-025232685387/fixtures/ scripts/loadtest/.fixtures/
```

Then delete them from S3 again. They hold staging-only tokens and keys.

**5. Load test #1** (plan §4, 2–6 Nov)

1. **Resize.** A stop/start changes the public IP, so update the Cloudflare A
   record afterwards. The readers scale to vCPUs/2 at boot, which is 8 on the
   4xlarge.

   ```bash
   I=<instance-id>; R=eu-west-1
   aws ec2 stop-instances --region $R --instance-ids $I && aws ec2 wait instance-stopped --region $R --instance-ids $I
   aws ec2 modify-instance-attribute --region $R --instance-id $I --instance-type Value=c7g.4xlarge
   aws ec2 start-instances --region $R --instance-ids $I && aws ec2 wait instance-running --region $R --instance-ids $I
   ```

2. **Direct-to-origin runs** (`--direct-origin`) need the generator to reach
   the origin, which the security group forbids.
   1. Add a **temporary** rule, and remove it after the run:

      ```bash
      aws ec2 authorize-security-group-ingress --region eu-west-1 --group-id <sg> \
        --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=<generator-ip>/32,Description=loadtest-temp}]'
      ```

      `provision.sh --apply` fails its Cloudflare-only check while that rule
      exists. That is deliberate.
   2. On the generator, map `staging.hawkeye.com.ng` to the origin IP in
      `/etc/hosts`.
   3. Trust Cloudflare's **Origin CA root** in the system store, so that curl
      and k6 accept the origin certificate without an insecure flag.
   4. `export ORIGIN_AUTH=<the staging secret>`.
   5. Run `scripts/loadtest/run.sh ... --base-url https://staging.hawkeye.com.ng --direct-origin`.
3. **Reset between runs** by restoring the reset point:

   ```bash
   sudo systemctl stop hawkeye.target
   sudo -u hawkeye cp /var/lib/hawkeye/pretest.db /var/lib/hawkeye/storage/hawkeye.db
   sudo rm -f /var/lib/hawkeye/storage/hawkeye.db-wal /var/lib/hawkeye/storage/hawkeye.db-shm
   sudo hawkeye-restart
   ```

   Rows cannot be deleted, because the ledger is a hash chain. A k6 run reuses
   seeded observers from index 0, so without a reset a second upload run gets
   `409 already_submitted`.

**6. Teardown, or keep it**

```bash
scripts/staging/teardown.sh --list      # what exists and what it costs you
scripts/staging/teardown.sh             # type: delete hawkeye staging
```

To pause for a few days instead, stop the instance: 0.14 USD/day. To shrink
back after LT#1, do the same resize with `c7g.xlarge`. Teardown also deletes
the S3 bucket; pass `--keep-bucket` to keep the hourly backups (and any
Litestream history in it).

## Open items for the owner (found while writing this)

1. **Settled 27 Sep: Litestream 0.5.17, one replica, plus the hourly S3
   backup** (see "The database: two copies"). Pinned from the release
   `checksums.txt`. Replaces 0.3.14, which published no checksum.
2. **Settled 27 Sep: ffmpeg on Graviton.** The platform binaries
   (`@ffmpeg-installer/linux-x64` and `linux-arm64`) are backend
   `optionalDependencies`, so npm picks the right one and `npm ci` needs no
   `--force`. Bootstrap fails if the ffmpeg it gets does not run.
3. **Which GETs go to readers.** Caddy sends public boards, static files and
   HTML to the readers, and everything else (authenticated GETs included) to
   the writer. Widen the reader allowlist in the Caddyfile only after the
   `ROLE` work (plan §5 item 6) confirms those GETs never write. A reader that
   writes fails loudly with `SQLITE_READONLY`.
4. **Direct-origin load testing** needs the temporary security-group rule and
   the Origin CA trust described in step 5. `scripts/loadtest/run.sh` has no
   insecure-TLS switch, on purpose.

# Hawkeye warm standby (Oracle Cloud free tier)

A second origin that can take over **reading** when the GO54 primary is down,
and that never acts on anyone's behalf while the primary is alive. Free:
Oracle Always Free, VM.Standard.A1.Flex (2 OCPU, 12 GB, arm64), Ubuntu 24.04,
uk-london-1. Built 2 Oct 2026.

**The address is not in this repository.** It lives in
`~/.config/hawkeye/standby.env` on the laptop (`STANDBY_HOST`, `STANDBY_USER`,
`STANDBY_SSH_KEY`). An origin address is never published: Cloudflare records
that point at it are always proxied.

## What runs there

| Piece | Where |
|---|---|
| Code | `/srv/hawkeye/{app,backend}`, owned by the deploy user, read-only to the service |
| Backend | `hawkeye-standby.service`, user `hawkeye`, Node 20 (production's major), `STANDBY=1` |
| Proxy | `hawkeye-caddy.service`: `:80` and `:443`, any Host, everything to Node; if Node is down it serves `app/` itself and `/api/*` answers 503 + Retry-After |
| DB | `/var/lib/hawkeye/storage/hawkeye.db` (restored snapshot) |
| Snapshots | `/var/lib/hawkeye-snapshots/` (verified copies, newest 8 kept), `/srv/hawkeye-inbox/` (pushed from the laptop) |
| Env | `/etc/hawkeye/standby.env` (role, wins over everything), `local.env` (throwaway keys, used only until production's env arrives), `secrets.env` (production's env, only via `standby_env_sync.sh`), `pull.env` (GO54 login for the pull) |
| Timers | `hawkeye-standby-pull.timer` (hourly), `hawkeye-standby-cfips.timer` (weekly Cloudflare range refresh) |
| Host | key-only SSH (no passwords, no root, `AllowUsers ubuntu`), fail2ban on sshd, unattended security upgrades (no auto-reboot), 4 GB swap, UTC, NTP |
| Firewall | iptables, saved with netfilter-persistent: 22 from anywhere, 80/443 **from Cloudflare's ranges only**; the `hawkeye` user may not open any outbound connection except loopback (`HAWKEYE-EGRESS`) |

Re-run the setup any time (idempotent): `scripts/standby_sync.sh --setup`.

## The standby never sends anything — how that is enforced

Two independent layers, either one sufficient:

1. **Code** (`backend/src/services/standby.js`, `config.standby`): with `STANDBY=1`
   (or `HAWKEYE_ROLE=standby`) the process
   - runs **no background job** whatever `ROLE` says (`config.runsBackground`):
     no reminders, pushes, Telegram/WhatsApp/SMS, IReV chain, GPU fleet, backups,
     anchors, docket, closeRaces, OCR/analysis, ledger sweep;
   - answers every `/api` **write with 503 `read_only` + Retry-After** (apps hold
     reports in their outboxes);
   - answers requests **carrying credentials with 503** unless production's
     session key is present (`STANDBY_AUTH_READS`), because a 401 from a box with
     the wrong key would sign every app out;
   - sets the DB **`query_only`** after boot, so the restored copy cannot drift;
   - **refuses every outbound TCP connection** at `net.Socket#connect` (the
     point fetch, http/https, tls and every SDK share), before even a DNS lookup,
     except loopback and `STANDBY_EGRESS_ALLOW`.
   Proof: `node backend/tests/standby_test.mjs` (48 checks; each refusal beside a
   control that succeeds with the guard off; a real sender, Telegram, refused
   with zero DNS lookups; the real server booted as a standby with sender
   credentials present, and with `ROLE=worker`).
2. **Host**: the `HAWKEYE-EGRESS` iptables chain rejects every non-loopback
   packet from the service's uid (covers child processes too). Checked on the
   host: `ubuntu -> https://1.1.1.1` = 301, `hawkeye ->` the same = refused.

`systemd`'s environment beats `backend/.env`, so even production's `.env` on the
box cannot turn `STANDBY` off. Only `/etc/hawkeye/promoted.env` (written by
`promote-full`) does.

## Data: the hourly pull

`hawkeye-standby-pull` (root, hourly, journal only — a standby raises no alerts):

- **Sources:** GO54's daily snapshot through the DirectAdmin file API (one list
  and at most one download per hour, never a retry loop), once `pull.env` exists;
  and `/srv/hawkeye-inbox/` (`scripts/standby_sync.sh --db [--fresh]`).
- **Verify:** `gzip -t`, `PRAGMA integrity_check` = ok, register present
  (> 100k polling units), ledger head read. Failures go to `rejected/` (retried
  after 3 h) and are never installed.
- **Keep** the newest 8 verified, pruned by count.
- **Install** only if newer: stop, swap (no `-wal/-shm`), start, prove by
  behaviour (`/api/health` ledger head = the snapshot's), else roll back. Never
  over a promoted primary; while `SERVING`, only with `--install-now`.

RPO is a day: production writes one snapshot a day (`services/backup.js`).
`journalctl -u hawkeye-standby-pull`, `sudo hawkeye-standby-pull --status`.

## Production's env (owner approval required)

`scripts/standby_env_sync.sh` prints its plan; `--approved` runs it. It pipes
GO54's `backend/.env` straight from the DirectAdmin API into the standby
(never on the laptop's disk, never printed, never in argv), plus the GO54 login
for the pull (prefer a **DirectAdmin Login Key** restricted to
`CMD_API_FILE_MANAGER` + `CMD_FILE_MANAGER` and the standby's IP, saved in
`backend/.env` as `GO54_STANDBY_KEY`). `--with-key-files` adds `anchor_key.json`
and the DeviceCheck `.p8`, needed only before a full promotion. Afterwards the
standby serves credentialed reads (situation rooms, "my reports"); it still
writes nothing and sends nothing.

## Failover (read-only) — the normal case

```bash
scripts/standby_failover.sh status          # records, who answers, standby health
scripts/standby_failover.sh to-standby      # dry run
scripts/standby_failover.sh to-standby --yes
# ... GO54 is back:
scripts/standby_failover.sh to-primary --yes
```

Only the site hostnames move (`FLIP_NAMES`, default `hawkeye.com.ng
www.hawkeye.com.ng`), and only proxied records: `mail`, `smtp`, `pop`, `ftp`
stay on GO54. Proxied records switch in seconds. The script saves the primary's
records first (`~/.config/hawkeye/standby_failover.json`, 0600) and restores
exactly those. It checks the standby answers with a database before flipping,
and that the primary's Node answers (a 403 `origin_locked` counts) before
flipping back.

**While the standby serves:** every page, board, result, map, the ledger and
its verification, from the last snapshot; installed apps keep working
read-only. **It cannot:** accept reports, sign anyone in (OTP is a write), send
alerts, run IReV/OCR, or show evidence photos stored on GO54's disk
(`/uploads` is not copied). Reports wait in the phones' outboxes and arrive
when the primary is back. Nothing to merge, so no split-brain.

## Full promotion (GO54 gone for good) — fenced, manual

Only when GO54 can no longer write: Node stopped in DirectAdmin (Setup Node.js
App -> Stop), or the account suspended. Two writable primaries is split-brain.

1. Fence GO54 (above). If it is still reachable, set `readOnly: true` in its
   `ops-switches.json` first and take a final snapshot (`--db --fresh`).
2. `scripts/standby_env_sync.sh --approved --with-key-files` (if not done).
3. On the host: `sudo hawkeye-standby-pull --install-now` (freshest snapshot),
   then `sudo hawkeye-standby-mode promote-full --i-have-fenced-the-primary`.
   This writes `promoted.env` (`STANDBY=0`), opens egress, disables the pull,
   restarts, and checks `/api/health` shows a writable primary.
4. `scripts/standby_failover.sh to-standby --yes` if not already flipped.
5. Prove it by behaviour: `/api/health` `host` = `oci-standby`,
   `readOnly: false`; a practice submission lands.

Losses: up to a day of writes (the snapshot's age). Evidence photos on GO54's
disk stay there.

## Fail-back after a full promotion

1. On the standby: `ops-switches.json` `readOnly: true`
   (`OPS_SWITCHES_FILE=/var/lib/hawkeye/ops-switches.json`); phones hold reports.
2. `sudo hawkeye-standby-mode export-db /root/failback` (consistent online copy,
   integrity-checked, gz + sha256).
3. Upload it to GO54 as `storage/hawkeye.db` (DirectAdmin file manager; remove
   any `-wal`/`-shm` beside it), start the Node app, verify the ledger head.
4. `scripts/standby_failover.sh to-primary --yes --db-copied-back`.
5. On the standby: `sudo hawkeye-standby-mode demote --db-copied-back`.

## Origin certificate

The standby starts with a self-signed cert (works with Cloudflare SSL **Flexible**
on :80 and **Full** on :443). **Full (strict)** needs a Cloudflare Origin CA cert,
or every request answers 526. The current mode could not be read (the token has
no Zone Settings permission). Install the Origin CA cert before relying on a
flip; it works in every mode:

- with the token: add **Zone · SSL and Certificates · Edit**, then
  `scripts/standby_failover.sh origin-cert --yes` (issued from the standby's CSR;
  the private key never leaves the host); or
- by hand: SSL/TLS -> Origin Server -> Create Certificate -> "Use my private key
  and CSR", paste `sudo cat /etc/hawkeye/tls/origin.csr`, hostnames
  `hawkeye.com.ng, *.hawkeye.com.ng`, then on the host
  `sudo hawkeye-standby-mode install-origin-cert < cert.pem`.

## The Cloudflare token

A **User API token** (this account's Account API token page offered no zone
permissions). Created at dash.cloudflare.com -> My Profile -> API Tokens ->
Create Token -> Custom token: Zone · DNS · Edit and Zone · Zone · Read, Zone
Resources: Include · Specific zone · hawkeye.com.ng. Saved on the laptop as
`~/.config/hawkeye/cf_failover.env` (`CF_FAILOVER_TOKEN=...`, mode 600).
Worth adding: Zone · Zone Settings · Read (the script then reads the SSL mode)
and Zone · SSL and Certificates · Edit (the `origin-cert` step).
`scripts/standby_failover.sh verify` checks it.

## Cloudflare Load Balancing instead of a manual flip?

~US$5/month (two origins, health checks). It would move traffic automatically
in a minute or two, and because this standby is read-only by construction, an
automatic move to it cannot cause split-brain. Against it: it flaps users
between "writes work" and "read-only" when GO54 is merely slow, it must be
switched off by hand before any full promotion (or it sends traffic back to
GO54 when GO54 recovers), and it is one more paid moving part. **Manual flip
now;** reconsider Load Balancing for election week, alongside the AWS plan in
`docs/private/ELECTION-NIGHT-HOSTING.md`.

## Known limits

- Node 20 matches production but is past end of life (April 2026); move both together.
- RPO about a day (daily snapshot). Continuous replication is the AWS plan's Litestream, not this box.
- No evidence photos or training images (GO54 `storage/` is not copied).
- Kernel updates need a planned `sudo reboot` (no automatic reboots).
- `hawkeye-standby-mode ops-allow IP` opens 80/443 to one address for testing;
  run `ops-clear` afterwards.

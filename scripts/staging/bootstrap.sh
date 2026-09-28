#!/usr/bin/env bash
# Bootstrap the Hawkeye STAGING server (docs/private/ELECTION-NIGHT-HOSTING.md §2.2, §2.3).
#
# FROM YOUR MACHINE (repo root; the account guard runs first):
#   scripts/staging/bootstrap.sh --dry-run           # build + check the code bundle only; no AWS call
#   scripts/staging/bootstrap.sh                     # ship code, run the on-host setup over SSM
#   scripts/staging/bootstrap.sh --seed-db FILE      # ...and restore FILE (a prod snapshot) as the DB,
#                                                    #    only if the server has no DB yet
#   --allow-dirty    ship uncommitted changes (refused by default: staging must run a known revision)
#   --readers N      reader processes (default auto = vCPUs/2, 1..8; re-evaluated at every boot)
#
# ON THE INSTANCE (what SSM runs; you never call this by hand):
#   bootstrap.sh --on-host --bucket B --stamp S [--seed-db] [--readers N]
#
# What the server gets: Node 22 LTS, Caddy (Cloudflare Origin CA cert, or `tls internal`
# until you add one), Litestream 0.5 (ONE continuous replica: R2 once its keys exist, S3 until
# then), an hourly sqlite3 .backup to S3 (the independent second copy), an unprivileged
# `hawkeye` user, the data volume at /var/lib/hawkeye, and systemd units:
#   hawkeye-prestart  (boot: secrets from SSM Parameter Store -> /run/hawkeye, tmpfs)
#   hawkeye-writer    ROLE=writer :8430   every non-GET, the only request-path writer
#   hawkeye-reader@N  ROLE=reader :844N   public GETs + static (SQLite query_only)
#   hawkeye-worker    ROLE=worker :8450   every timer: OCR, analysis, push waves, IReV, anchor, sweep
#   hawkeye-litestream                    continuous replica: RPO <= 1 s in election week, <= 10 s otherwise
#   hawkeye-litestream-interval.timer     hourly: sync-interval 1s from 13 to 24 Jan 2027 (WAT), 10s otherwise
#                                         (design D7; `sudo hawkeye-litestream-interval --set 1s|10s|auto`)
#   hawkeye-db-backup.timer               hourly at :05: sqlite3 .backup -> gzip -> s3://BUCKET/backup/
#                                         (newest 48 hourly + 14 daily kept), RPO <= 1 h (S3)
#   caddy, all grouped under hawkeye.target
# `sudo hawkeye-restore-test` restores from BOTH copies and checks them against the live ledger.
# NO SECRET IS EVER WRITTEN TO DISK OR INTO THIS SCRIPT: they are read from SSM at every boot.
set -euo pipefail

# Pinned downloads (verified by hash; bump deliberately).
NODE_VERSION="v22.23.3"   # 22 = the LTS the backend is tested on; better-sqlite3 9.6.0 predates Node 24
NODE_SHA256="a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f"   # node-v22.23.3-linux-arm64.tar.xz (nodejs.org SHASUMS256.txt)
CADDY_VERSION="2.11.4"
CADDY_SHA512="d5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c"   # caddy_2.11.4_linux_arm64.tar.gz (release checksums file)
# Litestream 0.5.x: ONE replica per database (0.5 removed multiple replicas). The second,
# independent copy is hawkeye-db-backup.timer, not a second Litestream replica.
# Hash from the release's checksums.txt, identical to GitHub's asset digest and to a
# download measured on 27 Sep 2026.
LITESTREAM_VERSION="0.5.17"
LITESTREAM_SHA256="f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5"   # litestream-0.5.17-linux-arm64.tar.gz

REGION_H="eu-west-1"
SSM_PREFIX_H="/hawkeye/staging"
DATA=/var/lib/hawkeye

# =====================================================================================
#  ON-HOST MODE (root on the staging instance, via SSM Run Command)
# =====================================================================================
on_host() {
  local BUCKET="" STAMP="" SEED="" READERS="auto"
  while [ $# -gt 0 ]; do
    case "$1" in
      --bucket) BUCKET="$2"; shift 2 ;;
      --stamp) STAMP="$2"; shift 2 ;;
      --seed-db) SEED=1; shift ;;
      --readers) READERS="$2"; shift 2 ;;
      *) echo "on-host: unknown option $1" >&2; exit 2 ;;
    esac
  done
  exec > >(tee -a /var/log/hawkeye-bootstrap.log) 2>&1
  export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"   # SSM's PATH is minimal
  log() { echo "[bootstrap $(date -u +%H:%M:%S)] $*"; }
  fail() { echo "[bootstrap] FAILED: $*" >&2; exit 1; }
  [ "$(id -u)" = 0 ] || fail "must run as root"
  [ "$(uname -m)" = aarch64 ] || fail "expected arm64 (Graviton), got $(uname -m)"
  [ -n "$BUCKET" ] && [ -n "$STAMP" ] || fail "--bucket and --stamp are required"
  # This box must BE staging: read its own tag through IMDSv2.
  local tok envtag
  tok="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
  envtag="$(curl -fsS -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/tags/instance/env || true)"
  [ "$envtag" = staging ] || fail "this instance is not tagged env=staging (got '$envtag'); refusing"

  log "packages"
  dnf -y -q install tar xz gzip gcc-c++ make python3 sqlite >/dev/null

  local W; W="$(mktemp -d)"
  fetch() { curl -fsSL --retry 3 --max-time 300 -o "$2" "$1"; }
  if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
    log "node $NODE_VERSION"
    fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz" "$W/node.tar.xz"
    echo "$NODE_SHA256  $W/node.tar.xz" | sha256sum -c - >/dev/null || fail "node checksum mismatch"
    rm -rf "/opt/node-$NODE_VERSION"; mkdir -p "/opt/node-$NODE_VERSION"
    tar -xJf "$W/node.tar.xz" -C "/opt/node-$NODE_VERSION" --strip-components=1
    for b in node npm npx; do ln -sfn "/opt/node-$NODE_VERSION/bin/$b" "/usr/local/bin/$b"; done
  fi
  if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
    log "caddy $CADDY_VERSION"
    fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_arm64.tar.gz" "$W/caddy.tgz"
    echo "$CADDY_SHA512  $W/caddy.tgz" | sha512sum -c - >/dev/null || fail "caddy checksum mismatch"
    tar -xzf "$W/caddy.tgz" -C "$W" caddy && install -m 0755 "$W/caddy" /usr/local/bin/caddy
  fi
  if ! /usr/local/bin/litestream version 2>/dev/null | grep -q "$LITESTREAM_VERSION"; then
    log "litestream $LITESTREAM_VERSION"
    fetch "https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM_VERSION/litestream-$LITESTREAM_VERSION-linux-arm64.tar.gz" "$W/ls.tgz"
    echo "$LITESTREAM_SHA256  $W/ls.tgz" | sha256sum -c - >/dev/null || fail "litestream checksum mismatch"
    tar -xzf "$W/ls.tgz" -C "$W" litestream && install -m 0755 "$W/litestream" /usr/local/bin/litestream
  fi

  log "users"
  id hawkeye >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --no-create-home --shell /sbin/nologin hawkeye
  id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy

  log "data volume -> $DATA"
  if ! findmnt -rn "$DATA" >/dev/null; then
    local rootdisk dev=""
    rootdisk="$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")"
    if blkid -L hawkeye-data >/dev/null 2>&1; then dev="$(blkid -L hawkeye-data)"
    else
      for d in $(lsblk -dnpo NAME,TYPE | awk '$2=="disk"{print $1}'); do
        [ "$(basename "$d")" = "$rootdisk" ] && continue
        [ -z "$(lsblk -no FSTYPE "$d" | tr -d '[:space:]')" ] || continue   # never format a disk that has data
        dev="$d"; break
      done
      [ -n "$dev" ] || fail "no empty data disk found (expected the gp3 data volume from provision.sh)"
      mkfs.ext4 -q -L hawkeye-data "$dev"
    fi
    mkdir -p "$DATA"
    grep -q 'LABEL=hawkeye-data' /etc/fstab || echo "LABEL=hawkeye-data $DATA ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
    mount "$DATA"
  fi
  install -d -o hawkeye -g hawkeye -m 0750 "$DATA" "$DATA/storage" "$DATA/storage/uploads"
  install -d -o root -g root -m 0755 /opt/hawkeye/releases /etc/hawkeye /usr/local/libexec/hawkeye /etc/caddy

  log "code (deploy/$STAMP)"
  local REL="/opt/hawkeye/releases/$STAMP"
  aws --region "$REGION_H" s3 cp --only-show-errors "s3://$BUCKET/deploy/$STAMP/bundle.tgz" "$W/bundle.tgz"
  rm -rf "$REL"; mkdir -p "$REL"; tar -xzf "$W/bundle.tgz" -C "$REL"
  [ ! -e "$REL/backend/.env" ] || fail "the bundle contains backend/.env; refusing"
  rm -rf "$REL/backend/storage"; ln -sfn "$DATA/storage" "$REL/backend/storage"
  log "npm ci (backend)"
  (cd "$REL/backend" && HOME=/root npm ci --omit=dev --no-audit --no-fund >"$W/npm.log" 2>&1) || { tail -40 "$W/npm.log"; fail "npm ci"; }
  (cd "$REL/backend" && /usr/local/bin/node -e 'require("better-sqlite3"); require("sharp")') || fail "native modules do not load on arm64"
  # The ffmpeg platform binaries are optionalDependencies, which npm skips SILENTLY when it cannot
  # install one. Say so here rather than find out from an untranscoded incident video.
  local ffm
  ffm="$(cd "$REL/backend" && /usr/local/bin/node -e 'console.log(require("@ffmpeg-installer/ffmpeg").path)' 2>"$W/ffm.err")" \
    && "$ffm" -version >/dev/null 2>&1 || fail "ffmpeg from @ffmpeg-installer does not run on arm64: ${ffm:-$(head -3 "$W/ffm.err")}"
  log "ffmpeg: $ffm"
  chown -R root:root "$REL"; chmod -R go-w "$REL"
  ln -sfn "$REL" /opt/hawkeye/current

  if [ -n "$SEED" ]; then
    if [ -e "$DATA/storage/hawkeye.db" ]; then
      log "a database already exists; NOT overwriting it with the seed (restore deliberately if you mean it)"
    else
      log "seeding the database from deploy/$STAMP/seed.db"
      aws --region "$REGION_H" s3 cp --only-show-errors "s3://$BUCKET/deploy/$STAMP/seed.db" "$W/seed.db"
      [ "$(sqlite3 "$W/seed.db" 'PRAGMA integrity_check;')" = ok ] || fail "seed.db fails integrity_check"
      install -o hawkeye -g hawkeye -m 0640 "$W/seed.db" "$DATA/storage/hawkeye.db"
      aws --region "$REGION_H" s3 rm --only-show-errors "s3://$BUCKET/deploy/$STAMP/seed.db"
    fi
  fi
  rm -rf "$W"

  log "config"
  cat > /etc/hawkeye/staging.env <<EOF
# NON-secret settings. Secrets come from SSM ($SSM_PREFIX_H/env/*) into /run/hawkeye/app.env at boot.
APP_ENV=staging
NODE_ENV=production
SMS_PROVIDER=console
SMS_OTP_ENABLED=false
DB_PATH=$DATA/storage/hawkeye.db
UPLOAD_DIR=$DATA/storage/uploads
PUBLIC_BASE_URL=https://staging.hawkeye.com.ng
UV_THREADPOOL_SIZE=16
READERS=$READERS
EOF
  echo "$STAMP" > /etc/hawkeye/release

  # ---- boot-time loader: SSM -> /run/hawkeye (tmpfs). Runs before every app start. ----
  cat > /usr/local/libexec/hawkeye/prestart <<'PY'
#!/usr/bin/env python3
"""Boot-time loader for Hawkeye staging. Reads SSM Parameter Store and writes
/run/hawkeye/{app.env,litestream.yml,caddy-tls.caddy,caddy-readers.caddy,readers,tls/}.
/run is tmpfs: secrets never touch the disk. REFUSES (exit 1, so nothing starts)
if staging has any credential that could message a real person."""
import json, os, re, subprocess, sys, grp, pwd
PREFIX, REGION, RUN = "/hawkeye/staging", "eu-west-1", "/run/hawkeye"
def die(m): print("prestart: REFUSED: " + m, file=sys.stderr); sys.exit(1)
out = subprocess.run(["aws", "--region", REGION, "ssm", "get-parameters-by-path", "--path", PREFIX,
                      "--recursive", "--with-decryption", "--output", "json"], check=True, capture_output=True, text=True).stdout
params = {p["Name"][len(PREFIX) + 1:]: p["Value"] for p in json.loads(out)["Parameters"]}
env = {k[4:]: v for k, v in params.items() if k.startswith("env/")}
ls = {k[11:]: v for k, v in params.items() if k.startswith("litestream/")}
tls = {k[4:]: v for k, v in params.items() if k.startswith("tls/")}
# Staging restores a PRODUCTION snapshot: real phone hashes, real push tokens. Nothing on
# this box may be able to reach a real person (scripts/loadtest/README.md).
FORBIDDEN = ["SENDCHAMP_API_KEY", "TERMII_API_KEY", "BULKSMS_NG_API_TOKEN", "WA_CLOUD_TOKEN", "WA_PHONE_NUMBER_ID",
             "TELEGRAM_BOT_TOKEN", "TELEGRAM_TEST_BOT_TOKEN", "FCM_PRIVATE_KEY", "FCM_CLIENT_EMAIL", "VAPID_PRIVATE_KEY",
             "X_API_KEY", "X_ACCESS_TOKEN", "META_PAGE_TOKEN", "TIKTOK_CLIENT_SECRET", "MASTER_PHONE"]
for k in FORBIDDEN:
    if env.get(k): die(f"{PREFIX}/env/{k} is set. Staging must hold no messaging, push or social credentials.")
for k, want in (("APP_ENV", "staging"), ("SMS_PROVIDER", "console")):
    if k in env and env[k] != want: die(f"{k}={env[k]} in SSM; staging requires {want}")
if env.get("SMS_OTP_ENABLED", "").lower() in ("1", "true", "yes", "on"): die("SMS_OTP_ENABLED is on")
for k in ("JWT_SECRET", "ORACLE_SECRET", "PHONE_SALT"):
    if len(env.get(k, "")) < 32: die(f"{PREFIX}/env/{k} missing or short (provision.sh creates it)")
SAFE = re.compile(r"^[A-Za-z0-9._:/+=@,\-]*$")
for k, v in env.items():
    if not re.match(r"^[A-Z][A-Z0-9_]*$", k) or not SAFE.match(v): die(f"env/{k}: bad name or value characters")
blob = all(env.get(k) for k in ("S3_BUCKET", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"))
env.setdefault("UPLOAD_MODE", "direct" if blob else "proxy")
env.setdefault("BLOB_DRIVER", "s3" if blob else "fs")
if not blob: print("prestart: WARNING no R2 evidence-bucket keys (env/S3_*): UPLOAD_MODE=proxy, BLOB_DRIVER=fs", file=sys.stderr)
gid_h, gid_c = grp.getgrnam("hawkeye").gr_gid, grp.getgrnam("caddy").gr_gid
os.makedirs(RUN + "/tls", exist_ok=True); os.chmod(RUN, 0o751); os.chmod(RUN + "/tls", 0o750); os.chown(RUN + "/tls", 0, gid_c)
def write(path, text, mode, gid):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as f: f.write(text)
    os.chown(tmp, 0, gid); os.chmod(tmp, mode); os.replace(tmp, path)
write(RUN + "/app.env", "".join(f"{k}={v}\n" for k, v in sorted(env.items())), 0o640, gid_h)
# The app's origin lock (X-Origin-Auth) applies to every request, localhost included:
# root's own health checks send it from this file (curl -H @file), never on a command line.
write(RUN + "/origin-auth.hdr", f"X-Origin-Auth: {env['ORIGIN_AUTH_SECRET']}\n" if env.get("ORIGIN_AUTH_SECRET") else "", 0o600, 0)
# Litestream 0.5: ONE replica per database. R2 when its four params exist; until then S3 through
# the instance role, so staging is never unreplicated. The independent second copy is
# hawkeye-db-backup.timer (hourly sqlite3 .backup to S3), not Litestream.
# sync-interval (design D7): 1s in election week (13-24 Jan 2027, WAT), 10s otherwise, from
# hawkeye-litestream-interval, which the hourly timer re-runs to switch it on the day. If the
# helper fails, 1s: the safe side is the shorter RPO, never a refusal to start.
# litestream/REPLICA_PATH (optional) moves the stream to a NEW path: after a promotion or a restore
# the new primary must never write into the old primary's path (README "Restore and failover").
try:
    sync = subprocess.run(["/usr/local/sbin/hawkeye-litestream-interval", "--print"], check=True,
                          capture_output=True, text=True).stdout.strip()
    if not re.match(r"^[1-9][0-9]{0,2}s$", sync): raise ValueError(sync)
except Exception as e:
    print(f"prestart: WARNING litestream interval helper failed ({e}); using sync-interval 1s", file=sys.stderr)
    sync = "1s"
db = "/var/lib/hawkeye/storage/hawkeye.db"
bucket = open("/etc/hawkeye/replica-bucket").read().strip()
for k in ls:
    if not SAFE.match(ls[k]): die(f"litestream/{k}: bad characters")
rpath = ls.get("REPLICA_PATH") or "hawkeye.db"
if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", rpath): die("litestream/REPLICA_PATH: one path segment of [A-Za-z0-9._-]")
q = json.dumps   # a JSON string is a valid YAML scalar; no value is ever parsed as YAML syntax
r2 = all(ls.get(k) for k in ("R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"))
if r2:
    replica = (f"      type: s3\n      bucket: {q(ls['R2_BUCKET'])}\n      path: {q(rpath)}\n"
               f"      endpoint: {q(ls['R2_ENDPOINT'])}\n      region: auto\n"
               f"      access-key-id: {q(ls['R2_ACCESS_KEY_ID'])}\n      secret-access-key: {q(ls['R2_SECRET_ACCESS_KEY'])}\n"
               f"      sync-interval: {sync}\n")
else:
    print("prestart: WARNING no R2 replica keys (litestream/R2_*): Litestream replicates to S3, the SAME provider "
          "as the hourly backup, until they exist", file=sys.stderr)
    replica = (f"      type: s3\n      bucket: {q(bucket)}\n      path: {q('litestream/' + rpath)}\n"
               f"      region: {REGION}\n      sync-interval: {sync}\n")
write(RUN + "/litestream.yml",
      "# generated by hawkeye-prestart at boot (Litestream 0.5 format: one `replica` per db)\n"
      "snapshot:\n  interval: 1h\n  retention: 72h\n"
      f"dbs:\n  - path: {db}\n    replica:\n" + replica, 0o640, gid_h)
# TLS: Cloudflare Origin CA cert if present, else Caddy's internal CA (Cloudflare "Full", not "Full (strict)").
if tls.get("origin_cert") and tls.get("origin_key"):
    write(RUN + "/tls/origin.pem", tls["origin_cert"].strip() + "\n", 0o640, gid_c)
    write(RUN + "/tls/origin.key", tls["origin_key"].strip() + "\n", 0o640, gid_c)
    write(RUN + "/caddy-tls.caddy", "tls /run/hawkeye/tls/origin.pem /run/hawkeye/tls/origin.key\n", 0o644, 0)
else:
    print("prestart: WARNING no Origin CA cert (tls/origin_cert, tls/origin_key): Caddy uses `tls internal`", file=sys.stderr)
    write(RUN + "/caddy-tls.caddy", "tls internal\n", 0o644, 0)
# Readers: auto = vCPUs/2 (1..8), so a resize to c7g.4xlarge gets 8 on the next boot.
want = "auto"
for line in open("/etc/hawkeye/staging.env"):
    if line.startswith("READERS="): want = line.split("=", 1)[1].strip()
n = max(1, min(8, (os.cpu_count() or 2) // 2)) if want == "auto" else max(1, min(8, int(want)))
write(RUN + "/readers", f"{n}\n", 0o644, 0)
write(RUN + "/caddy-readers.caddy", "to " + " ".join(f"127.0.0.1:{8440 + i}" for i in range(1, n + 1)) + "\n", 0o644, 0)
print(f"prestart: ok (readers={n}, upload={env['UPLOAD_MODE']}/{env['BLOB_DRIVER']}, litestream={'r2' if r2 else 's3'}:{rpath} every {sync})")
PY
  chmod 0755 /usr/local/libexec/hawkeye/prestart
  echo "$BUCKET" > /etc/hawkeye/replica-bucket

  # ---- design D7: Litestream sync-interval by date (1s in election week, 10s otherwise) ----
  cat > /usr/local/sbin/hawkeye-litestream-interval <<'SH'
#!/usr/bin/env bash
# Litestream sync-interval switch (design D7, docs/private/CHEAPEST-ELECTION-NIGHT.html).
#   1s from 13 to 24 Jan 2027 inclusive (West Africa Time), 10s otherwise. At 1s Litestream makes
#   ~90,000 R2 PUTs a day, past R2's free million a month; at 10s it stays inside it.
#   RPO: <= 1 s in election week, <= 10 s otherwise (the hourly S3 backup is unaffected).
# Usage (root):
#   hawkeye-litestream-interval             apply what applies now: rewrite sync-interval in
#                                           /run/hawkeye/litestream.yml and restart Litestream, only if
#                                           it changed and only if Litestream is running
#   hawkeye-litestream-interval --print     the interval that applies now (prestart uses it at boot)
#   hawkeye-litestream-interval --status    the schedule, any pin, and what the running config says
#   hawkeye-litestream-interval --set 1s    pin an interval (e.g. a governorship week), then apply
#   hawkeye-litestream-interval --set auto  remove the pin: back to the date schedule, then apply
# hawkeye-litestream-interval.timer runs it hourly at :00:30, so the switch lands within a minute of
# midnight WAT (23:00 UTC). The pin survives reboots (/etc/hawkeye); the generated config does not
# (tmpfs, rebuilt by prestart at every boot from this same helper).
set -euo pipefail
WINDOW_START=20270113   # first day at 1s (WAT)
WINDOW_END=20270124     # last day at 1s (WAT)
PIN=/etc/hawkeye/litestream-sync-interval
CONF=/run/hawkeye/litestream.yml
valid() { [[ "$1" =~ ^[1-9][0-9]{0,2}s$ ]]; }
today() { TZ=WAT-1 date +%Y%m%d; }   # POSIX TZ string = UTC+1 without tzdata; Nigeria keeps no DST
scheduled() {
  local d; d="$(today)"
  if [ "$d" -ge "$WINDOW_START" ] && [ "$d" -le "$WINDOW_END" ]; then echo 1s; else echo 10s; fi
}
wanted() {
  local p
  if [ -s "$PIN" ]; then
    p="$(tr -d '[:space:]' < "$PIN")"
    if valid "$p"; then echo "$p"; return; fi
    echo "hawkeye-litestream-interval: ignoring bad pin '$p' in $PIN" >&2
  fi
  scheduled
}
current() { sed -n 's/^ *sync-interval: *//p' "$CONF" | head -1; }
apply() {
  local want cur tmp
  want="$(wanted)"
  [ -f "$CONF" ] || { echo "no $CONF yet: prestart will write sync-interval $want at start"; return 0; }
  cur="$(current)"
  if [ "$cur" = "$want" ]; then echo "sync-interval $want (unchanged)"; return 0; fi
  tmp="$(mktemp "$CONF.XXXXXX")"   # created 0600: the config holds the R2 keys
  sed "s/^\( *sync-interval:\).*/\1 $want/" "$CONF" > "$tmp"
  chown --reference="$CONF" "$tmp"; chmod --reference="$CONF" "$tmp"; mv -f "$tmp" "$CONF"
  # Litestream 0.5 reads its config only at start. try-restart never STARTS a Litestream that
  # someone stopped on purpose (a failover, a restore): the new value waits for its next start.
  systemctl try-restart hawkeye-litestream.service
  if systemctl is-active --quiet hawkeye-litestream.service; then echo "sync-interval ${cur:-?} -> $want (litestream restarted)"
  else echo "sync-interval ${cur:-?} -> $want (litestream not running: applies at its next start)"; fi
}
case "${1:-}" in
  "") apply ;;
  --print) wanted ;;
  --status)
    echo "schedule: 1s from $WINDOW_START to $WINDOW_END (WAT), 10s otherwise; today $(today) WAT -> $(scheduled)"
    if [ -s "$PIN" ]; then echo "pin: $(cat "$PIN") ($PIN)"; else echo "pin: none"; fi
    echo "applies now: $(wanted); running config: $( [ -f "$CONF" ] && current || echo 'not written yet')" ;;
  --set)
    v="${2:-}"
    if [ "$v" = auto ]; then rm -f "$PIN"
    elif valid "$v"; then echo "$v" > "$PIN"
    else echo "usage: hawkeye-litestream-interval --set 1s|10s|<N>s|auto" >&2; exit 2; fi
    apply ;;
  *) echo "usage: hawkeye-litestream-interval [--print|--status|--set 1s|10s|auto]" >&2; exit 2 ;;
esac
SH
  chmod 0755 /usr/local/sbin/hawkeye-litestream-interval

  cat > /usr/local/libexec/hawkeye/start-readers <<'SH'
#!/usr/bin/env bash
# Start reader@1..N (N from prestart) once the writer answers; stop any above N.
set -euo pipefail
n="$(cat /run/hawkeye/readers)"
for _ in $(seq 1 60); do curl -fsS --max-time 2 -H @/run/hawkeye/origin-auth.hdr http://127.0.0.1:8430/api/health >/dev/null 2>&1 && break; sleep 1; done
for i in $(seq 1 8); do
  if [ "$i" -le "$n" ]; then systemctl start "hawkeye-reader@$i.service"; else systemctl stop "hawkeye-reader@$i.service" 2>/dev/null || true; fi
done
SH
  chmod 0755 /usr/local/libexec/hawkeye/start-readers

  # ---- the independent second copy of the database (plan §2.3): hourly, to S3 ----
  cat > /usr/local/libexec/hawkeye/db-backup <<'SH'
#!/usr/bin/env bash
# Hourly INDEPENDENT copy of the live database to S3 (hawkeye-db-backup.timer). Litestream has ONE
# replica (R2, RPO <= 1 s in election week, <= 10 s otherwise: D7); this is the second provider (RPO <= 1 h) and shares nothing with it:
# not the tool, not the format, not the credentials.
#   1. sqlite3 .backup: SQLite's online-backup API, a consistent copy while the writer keeps writing
#   2. PRAGMA quick_check on the COPY; its ledger head goes into the object's metadata
#   3. gzip -> s3://BUCKET/backup/hourly/hawkeye-<UTC>.db.gz   (metadata: sha256, ledger-id, ledger-hash)
#   4. the first copy of each UTC day is also copied, server side, to backup/daily/hawkeye-<date>.db.gz
#   5. prune to the newest 48 hourly and 14 daily objects (names sort by time). Count, not age:
#      if this timer ever stops, the last good copies stay.
# Any failure exits non-zero: `systemctl --failed` and `journalctl -u hawkeye-db-backup` say so.
set -euo pipefail
DB=/var/lib/hawkeye/storage/hawkeye.db
WORK=/var/lib/hawkeye/backup
BUCKET="$(cat /etc/hawkeye/replica-bucket)"
REGION=eu-west-1
KEEP_HOURLY=48
KEEP_DAILY=14
[ -f "$DB" ] || { echo "db-backup: no database at $DB" >&2; exit 1; }
mkdir -p "$WORK"; rm -f "$WORK"/hawkeye-*.db "$WORK"/hawkeye-*.db.gz   # leftovers of a killed run
now="$(date -u +%Y%m%dT%H%M%SZ)"; snap="$WORK/hawkeye-$now.db"
trap 'rm -f "$snap" "$snap.gz"' EXIT
# no_ckpt_on_close: should this ever be the last connection, closing it must NOT checkpoint the
# live WAL. Litestream owns checkpoints: it has to read every frame before it reaches the main file.
sqlite3 "$DB" ".timeout 30000" ".output /dev/null" ".dbconfig no_ckpt_on_close on" ".output stdout" ".backup '$snap'"
qc="$(sqlite3 "$snap" 'PRAGMA quick_check;')"
[ "$qc" = ok ] || { echo "db-backup: the copy fails quick_check: $qc" >&2; exit 1; }
head="$(sqlite3 "$snap" "SELECT id || ' ' || entry_hash FROM submissions ORDER BY id DESC LIMIT 1;")"
lid="${head%% *}"; lhash="${head#* }"
gzip -1 "$snap"
sha="$(sha256sum "$snap.gz" | cut -d' ' -f1)"; size="$(du -h "$snap.gz" | cut -f1)"
key="backup/hourly/hawkeye-$now.db.gz"
aws --region "$REGION" s3 cp --only-show-errors "$snap.gz" "s3://$BUCKET/$key" \
  --metadata "sha256=$sha,ledger-id=${lid:-none},ledger-hash=${lhash:-none}"
dkey="backup/daily/hawkeye-${now:0:4}-${now:4:2}-${now:6:2}.db.gz"
if ! aws --region "$REGION" s3api head-object --bucket "$BUCKET" --key "$dkey" >/dev/null 2>&1; then
  aws --region "$REGION" s3 cp --only-show-errors "s3://$BUCKET/$key" "s3://$BUCKET/$dkey"   # metadata is copied too
fi
prune() { # PREFIX KEEP: delete all but the newest KEEP objects named hawkeye-*.db.gz under PREFIX
  local k
  aws --region "$REGION" s3api list-objects-v2 --bucket "$BUCKET" --prefix "$1" --query 'Contents[].Key' --output text \
    | tr '\t' '\n' | { grep -E "^$1hawkeye-[0-9TZ-]+\.db\.gz\$" || true; } | sort | head -n "-$2" \
    | while IFS= read -r k; do aws --region "$REGION" s3 rm --only-show-errors "s3://$BUCKET/$k"; echo "db-backup: pruned $k"; done
}
prune backup/hourly/ "$KEEP_HOURLY"
prune backup/daily/ "$KEEP_DAILY"
date -u +%FT%TZ > "$WORK/last-ok"
echo "db-backup: ok s3://$BUCKET/$key ($size, sha256 ${sha:0:12}, ledger head #${lid:-none})"
SH
  chmod 0755 /usr/local/libexec/hawkeye/db-backup

  cat > /usr/local/sbin/hawkeye-restore-test <<'SH'
#!/usr/bin/env bash
# Restore test from EACH copy of the database (plan §2.3; README "Restore and failover"):
#   A. the Litestream replica (R2; S3 until the R2 keys exist): litestream restore, then checks
#   B. the newest hourly backup on S3: download, sha256 against its metadata, gunzip, then checks
# Checks: PRAGMA integrity_check is ok, and the copy's ledger head row exists in the LIVE database
# with the same hash (it is the same chain, not merely a valid file). Nothing live is written; the
# scratch directory is removed on exit. Runs as hawkeye (root re-execs), so no root-owned -wal or
# -shm can ever appear beside the live database.
#   sudo hawkeye-restore-test [SECONDS]   keep retrying the Litestream restore for SECONDS (default 0)
set -uo pipefail
[ "$(id -u)" != 0 ] || exec runuser -u hawkeye -- "$0" "$@"
DB=/var/lib/hawkeye/storage/hawkeye.db
LSCONF=/run/hawkeye/litestream.yml
T=/var/lib/hawkeye/restore-test
BUCKET="$(cat /etc/hawkeye/replica-bucket)"
REGION=eu-west-1
WAIT="${1:-0}"
rm -rf "$T"; mkdir -p "$T"; chmod 0700 "$T"; trap 'rm -rf "$T"' EXIT
fails=0
bad() { echo "FAIL  $*"; fails=$((fails + 1)); }
# Read the live DB without ever checkpointing it on close (.dbconfig echoes its setting: muted).
live() { sqlite3 -cmd ".output /dev/null" -cmd ".dbconfig no_ckpt_on_close on" -cmd ".output stdout" -cmd ".timeout 10000" "$DB" "$1"; }
check_copy() { # NAME FILE STRICT(1 = an empty ledger in the copy is a failure when live has rows)
  local ic head id hash livehash livehead
  ic="$(sqlite3 "$2" 'PRAGMA integrity_check;' 2>&1 | head -3 | tr '\n' ' ')"
  [ "$ic" = "ok " ] || { bad "$1: integrity_check: $ic"; return; }
  head="$(sqlite3 "$2" "SELECT id || ' ' || entry_hash FROM submissions ORDER BY id DESC LIMIT 1;" 2>&1)" \
    || { bad "$1: cannot read the ledger: $head"; return; }
  livehead="$(live 'SELECT coalesce(max(id), 0) FROM submissions;')"
  if [ -z "$head" ]; then
    if [ "$3" = 1 ] && [ "$livehead" != 0 ]; then bad "$1: the copy has no ledger rows, live has up to #$livehead"
    else echo "PASS  $1: integrity ok, ledger empty in this copy (live head #$livehead)"; fi
    return
  fi
  id="${head%% *}"; hash="${head#* }"
  [[ "$id" =~ ^[0-9]+$ ]] || { bad "$1: odd ledger id '$id'"; return; }
  livehash="$(live "SELECT entry_hash FROM submissions WHERE id = $id;")"
  if [ -n "$livehash" ] && [ "$livehash" = "$hash" ]; then
    echo "PASS  $1: integrity ok, ledger head #$id matches live (live head #$livehead, $((livehead - id)) behind)"
  else bad "$1: ledger head #$id is not the live chain (live hash '${livehash:-none}')"; fi
}

where="S3 (no R2 keys yet: SAME provider as the hourly copy)"; grep -q '^ *endpoint:' "$LSCONF" && where="R2"
echo "== A. Litestream replica, $where"
end=$((SECONDS + WAIT))
until litestream restore -config "$LSCONF" -o "$T/litestream.db" "$DB" > "$T/ls.log" 2>&1; do
  rm -f "$T"/litestream.db*
  [ "$SECONDS" -lt "$end" ] || { bad "litestream restore: $(tail -3 "$T/ls.log" | tr '\n' ' ')"; break; }
  sleep 5
done
[ -f "$T/litestream.db" ] && check_copy "litestream replica" "$T/litestream.db" 1

echo "== B. newest hourly backup, s3://$BUCKET/backup/hourly/"
key="$(aws --region "$REGION" s3api list-objects-v2 --bucket "$BUCKET" --prefix backup/hourly/ --query 'Contents[].Key' --output text \
  | tr '\t' '\n' | { grep -E '^backup/hourly/hawkeye-[0-9]{8}T[0-9]{6}Z\.db\.gz$' || true; } | sort | tail -1)"
if [ -z "$key" ]; then bad "no hourly backup in s3://$BUCKET/backup/hourly/"
else
  want="$(aws --region "$REGION" s3api head-object --bucket "$BUCKET" --key "$key" --query 'Metadata.sha256' --output text)"
  aws --region "$REGION" s3 cp --only-show-errors "s3://$BUCKET/$key" "$T/hourly.db.gz"
  got="$(sha256sum "$T/hourly.db.gz" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then bad "$key: sha256 $got does not match its metadata ($want)"
  elif ! gunzip "$T/hourly.db.gz"; then bad "$key: gunzip failed"
  else check_copy "hourly ${key#backup/hourly/}" "$T/hourly.db" 0; fi
fi
echo
if [ "$fails" = 0 ]; then echo "restore test: both copies restore and carry the live ledger"; else echo "restore test: $fails FAILED"; fi
[ "$fails" = 0 ]
SH
  chmod 0755 /usr/local/sbin/hawkeye-restore-test

  log "systemd units"
  local COMMON="User=hawkeye
Group=hawkeye
WorkingDirectory=/opt/hawkeye/current/backend
EnvironmentFile=/etc/hawkeye/staging.env
EnvironmentFile=/run/hawkeye/app.env
ExecStart=/usr/local/bin/node src/server.js
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA"
  cat > /etc/systemd/system/hawkeye-prestart.service <<EOF
[Unit]
Description=Hawkeye: load secrets from SSM into /run/hawkeye
Wants=network-online.target
After=network-online.target
RequiresMountsFor=$DATA
PartOf=hawkeye.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/libexec/hawkeye/prestart
EOF
  cat > /etc/systemd/system/hawkeye-writer.service <<EOF
[Unit]
Description=Hawkeye writer (ROLE=writer, the only request-path writer)
Requires=hawkeye-prestart.service
After=hawkeye-prestart.service
PartOf=hawkeye.target
[Service]
Environment=ROLE=writer PORT=8430 HOST_ID=staging-writer
$COMMON
[Install]
WantedBy=hawkeye.target
EOF
  cat > /etc/systemd/system/hawkeye-reader@.service <<EOF
[Unit]
Description=Hawkeye reader %i (ROLE=reader, query_only)
Requires=hawkeye-prestart.service
After=hawkeye-prestart.service hawkeye-writer.service
PartOf=hawkeye.target
[Service]
Environment=ROLE=reader PORT=844%i HOST_ID=staging-reader-%i
$COMMON
EOF
  cat > /etc/systemd/system/hawkeye-worker.service <<EOF
[Unit]
Description=Hawkeye worker (ROLE=worker: every timer and queue)
Requires=hawkeye-prestart.service
After=hawkeye-prestart.service hawkeye-writer.service
PartOf=hawkeye.target
[Service]
Environment=ROLE=worker PORT=8450 HOST_ID=staging-worker
$COMMON
[Install]
WantedBy=hawkeye.target
EOF
  cat > /etc/systemd/system/hawkeye-readers.service <<EOF
[Unit]
Description=Hawkeye: start N readers (N = vCPUs/2 unless READERS is set)
Requires=hawkeye-prestart.service
After=hawkeye-writer.service
PartOf=hawkeye.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/libexec/hawkeye/start-readers
[Install]
WantedBy=hawkeye.target
EOF
  cat > /etc/systemd/system/hawkeye-litestream.service <<EOF
[Unit]
Description=Litestream 0.5: continuous SQLite replication, ONE replica (R2; S3 until the R2 keys exist)
Requires=hawkeye-prestart.service
After=hawkeye-writer.service
PartOf=hawkeye.target
[Service]
User=hawkeye
Group=hawkeye
ExecStart=/usr/local/bin/litestream replicate -config /run/hawkeye/litestream.yml
Restart=always
RestartSec=2
[Install]
WantedBy=hawkeye.target
EOF
  # Design D7: re-check the sync-interval hourly; it changes (and restarts Litestream) only on
  # the two switch days, or after `hawkeye-litestream-interval --set`.
  cat > /etc/systemd/system/hawkeye-litestream-interval.service <<EOF
[Unit]
Description=Hawkeye: Litestream sync-interval by date (1s from 13 to 24 Jan 2027 WAT, 10s otherwise)
After=hawkeye-prestart.service hawkeye-litestream.service
ConditionPathExists=/run/hawkeye/litestream.yml
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hawkeye-litestream-interval
EOF
  cat > /etc/systemd/system/hawkeye-litestream-interval.timer <<EOF
[Unit]
Description=Hawkeye: hourly check of the Litestream sync-interval, at :00:30
PartOf=hawkeye.target
[Timer]
OnCalendar=*-*-* *:00:30
Persistent=true
AccuracySec=1min
[Install]
WantedBy=hawkeye.target
EOF
  cat > /etc/systemd/system/hawkeye-db-backup.service <<EOF
[Unit]
Description=Hawkeye: independent DB copy to S3 (sqlite3 .backup; newest 48 hourly + 14 daily kept)
RequiresMountsFor=$DATA
[Service]
Type=oneshot
User=hawkeye
Group=hawkeye
Environment=HOME=$DATA
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
ExecStart=/usr/local/libexec/hawkeye/db-backup
TimeoutStartSec=45min
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$DATA
EOF
  cat > /etc/systemd/system/hawkeye-db-backup.timer <<EOF
[Unit]
Description=Hawkeye: hourly DB backup to S3, at :05
PartOf=hawkeye.target
[Timer]
OnCalendar=*-*-* *:05:00
Persistent=true
AccuracySec=1min
[Install]
WantedBy=hawkeye.target
EOF
  cat > /etc/systemd/system/hawkeye-caddy.service <<EOF
[Unit]
Description=Caddy: TLS (Cloudflare Origin CA) and role routing
Requires=hawkeye-prestart.service
After=hawkeye-prestart.service
PartOf=hawkeye.target
[Service]
User=caddy
Group=caddy
Environment=HOME=/var/lib/caddy XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
[Install]
WantedBy=hawkeye.target
EOF
  cat > /etc/systemd/system/hawkeye.target <<EOF
[Unit]
Description=Hawkeye staging (writer, readers, worker, litestream, hourly DB backup, caddy)
Wants=hawkeye-prestart.service hawkeye-writer.service hawkeye-readers.service hawkeye-worker.service hawkeye-litestream.service hawkeye-litestream-interval.timer hawkeye-db-backup.timer hawkeye-caddy.service
[Install]
WantedBy=multi-user.target
EOF

  # Caddy: public GETs and static files -> readers; everything else -> the writer.
  # Authenticated GETs (/api/observers/me, /notifications, /my/rooms...) stay on the
  # writer until the ROLE work (plan §5 item 6) confirms none of them writes.
  # The site is NAMED (Cloudflare sends SNI staging.hawkeye.com.ng; `tls internal` needs a
  # name to issue for); default_sni covers clients that send none.
  cat > /etc/caddy/Caddyfile <<'EOF'
{
	admin localhost:2019
	default_sni staging.hawkeye.com.ng
	auto_https disable_redirects
	skip_install_trust
}
staging.hawkeye.com.ng {
	import /run/hawkeye/caddy-tls.caddy
	encode gzip
	@reads {
		method GET HEAD
		path /api/national/* /api/contests /api/declarations /api/integrity/* /api/incidents /api/docket /api/anchors /api/ledger/* /api/results /api/results/* /api/register/* /api/polling-units*
	}
	@static {
		method GET HEAD
		not path /api/*
	}
	handle @reads {
		reverse_proxy {
			import /run/hawkeye/caddy-readers.caddy
			lb_policy least_conn
		}
	}
	handle @static {
		reverse_proxy {
			import /run/hawkeye/caddy-readers.caddy
			lb_policy least_conn
		}
	}
	handle {
		reverse_proxy 127.0.0.1:8430
	}
}
http:// {
	redir https://staging.hawkeye.com.ng{uri} 308
}
EOF

  # One command to re-read SSM (new keys, a new cert) and restart every role, writer first.
  cat > /usr/local/sbin/hawkeye-restart <<'SH'
#!/usr/bin/env bash
set -euo pipefail
systemctl restart hawkeye-prestart.service || { journalctl -u hawkeye-prestart -n 30 --no-pager; exit 1; }
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl restart hawkeye-writer.service
systemctl restart hawkeye-worker.service hawkeye-litestream.service hawkeye-caddy.service
systemctl stop 'hawkeye-reader@*.service' 2>/dev/null || true
systemctl restart hawkeye-readers.service
systemctl start hawkeye-db-backup.timer hawkeye-litestream-interval.timer
SH
  chmod 0755 /usr/local/sbin/hawkeye-restart

  log "start"
  systemctl daemon-reload
  systemctl enable hawkeye.target hawkeye-writer.service hawkeye-worker.service hawkeye-readers.service hawkeye-litestream.service hawkeye-litestream-interval.timer hawkeye-db-backup.timer hawkeye-caddy.service >/dev/null 2>&1
  /usr/local/sbin/hawkeye-restart || fail "start failed (prestart refusal or Caddyfile; see above)"

  log "verify by behaviour"
  local h ok=1 n
  local A=(-H @/run/hawkeye/origin-auth.hdr)   # the origin lock covers localhost too
  for _ in $(seq 1 60); do h="$(curl -fsS --max-time 2 "${A[@]}" http://127.0.0.1:8430/api/health 2>/dev/null)" && break; sleep 1; done
  echo "writer   ${h:-NO ANSWER}"
  grep -q '"env":"staging"' <<<"${h:-}" && grep -q '"role":"writer"' <<<"$h" || ok=0
  grep -q '"smsOtp":false' <<<"${h:-}" && grep -q '"waCloud":false' <<<"$h" || ok=0
  n="$(cat /run/hawkeye/readers)"
  for i in $(seq 1 "$n"); do
    h="$(curl -fsS --max-time 5 "${A[@]}" "http://127.0.0.1:844$i/api/health" 2>/dev/null || true)"
    echo "reader$i  ${h:-NO ANSWER}"; grep -q '"role":"reader"' <<<"$h" || ok=0
  done
  h="$(curl -fsS --max-time 5 "${A[@]}" http://127.0.0.1:8450/api/health 2>/dev/null || true)"
  echo "worker   ${h:-NO ANSWER}"; grep -q '"role":"worker"' <<<"$h" || ok=0
  h="$(curl -skS --max-time 5 "${A[@]}" -o /dev/null -w '%{http_code}' --resolve staging.hawkeye.com.ng:443:127.0.0.1 https://staging.hawkeye.com.ng/results.html || true)"
  echo "caddy    GET /results.html via :443 -> HTTP $h"; [ "$h" = 200 ] || ok=0
  systemctl is-active --quiet hawkeye-litestream.service && echo "litestream active" || { echo "litestream NOT active"; ok=0; }
  systemctl is-active --quiet hawkeye-db-backup.timer && echo "db backup timer active (hourly at :05)" || { echo "db backup timer NOT active"; ok=0; }
  systemctl is-active --quiet hawkeye-litestream-interval.timer && echo "litestream interval timer active (D7)" || { echo "litestream interval timer NOT active"; ok=0; }
  # D7: the running config must carry the interval the schedule says, not merely exist.
  n="$(/usr/local/sbin/hawkeye-litestream-interval --print)"; h="$(sed -n 's/^ *sync-interval: *//p' /run/hawkeye/litestream.yml | head -1)"
  echo "litestream sync-interval $h (schedule says $n)"; [ -n "$h" ] && [ "$h" = "$n" ] || ok=0
  # Both copies, proven by restoring them: take the first hourly backup now, then restore from the
  # Litestream replica (retrying up to 3 min while its first snapshot uploads) and from that backup.
  if systemctl start hawkeye-db-backup.service; then journalctl -u hawkeye-db-backup.service -n 1 --no-pager -o cat
  else echo "db backup FAILED"; journalctl -u hawkeye-db-backup.service -n 20 --no-pager -o cat; ok=0; fi
  /usr/local/sbin/hawkeye-restore-test 180 || ok=0
  [ "$ok" = 1 ] || fail "verification failed (journalctl -u 'hawkeye-*')"
  log "DONE: release $STAMP is live on staging"
}

if [ "${1:-}" = "--on-host" ]; then shift; on_host "$@"; exit 0; fi

# =====================================================================================
#  LOCAL MODE (your machine)
# =====================================================================================
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
REPO="$(cd "$HERE/../.." && pwd)"

DRY=""; DIRTY_OK=""; SEED_DB=""; READERS="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --allow-dirty) DIRTY_OK=1; shift ;;
    --seed-db) SEED_DB="${2:-}"; shift 2 ;;
    --readers) READERS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done
[ "$READERS" = auto ] || [[ "$READERS" =~ ^[1-8]$ ]] || die "--readers must be auto or 1..8"
[ -d "$REPO/backend/.git" ] || [ -f "$REPO/backend/.git" ] || die "$REPO/backend is not a git checkout (the private backend repo)"
if [ -n "$SEED_DB" ]; then
  [ -f "$SEED_DB" ] || die "--seed-db: $SEED_DB not found"
  [ "$(head -c 15 "$SEED_DB")" = "SQLite format 3" ] || die "--seed-db: $SEED_DB is not a SQLite database"
fi

# ---- 1. The code bundle: tracked + untracked-but-not-ignored files only -------------------
DIRTY="$( { git -C "$REPO" status --porcelain -- app scripts/loadtest scripts/staging
            git -C "$REPO/backend" status --porcelain -- src package.json package-lock.json | sed -E 's#^(...)#\1backend/#'; } | sed '/^$/d')"
if [ -n "$DIRTY" ] && [ -z "$DIRTY_OK" ]; then
  if [ -z "$DRY" ]; then die "uncommitted changes ($(wc -l <<<"$DIRTY") files); commit them or pass --allow-dirty:
$(head -10 <<<"$DIRTY")"; fi
  say "NOTE: $(wc -l <<<"$DIRTY") uncommitted file(s); a real run refuses without --allow-dirty. First few:"
  head -5 <<<"$DIRTY" | sed 's/^/    /' >&2
fi
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
MAIN_SHA="$(git -C "$REPO" rev-parse --short HEAD)"; BACK_SHA="$(git -C "$REPO/backend" rev-parse --short HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-${BACK_SHA}"
[ -n "$DIRTY" ] && STAMP="$STAMP-dirty"
mkdir -p "$WORK/backend"; printf '%s\n' "backend-$BACK_SHA+app-$MAIN_SHA${DIRTY:+-dirty}" > "$WORK/backend/REVISION"
git -C "$REPO" ls-files -z --cached --others --exclude-standard -- app scripts/loadtest scripts/staging > "$WORK/list"
git -C "$REPO/backend" ls-files -z --cached --others --exclude-standard -- src package.json package-lock.json eng.traineddata \
  | while IFS= read -r -d '' f; do printf 'backend/%s\0' "$f"; done >> "$WORK/list"
# Deleted-but-still-tracked files would make tar fail; keep only what exists.
while IFS= read -r -d '' f; do [ -e "$REPO/$f" ] && printf '%s\0' "$f"; done < "$WORK/list" > "$WORK/list.ok"
tar -czf "$WORK/bundle.tgz" -C "$REPO" --null -T "$WORK/list.ok" --no-null -C "$WORK" backend/REVISION
# Nothing secret or stateful may ship. Checked on the ARTIFACT, not on the file list.
BAD="$(tar -tzf "$WORK/bundle.tgz" | grep -E '(^|/)\.env($|\.)|(^|/)node_modules/|^backend/storage/|(^|/)\.fixtures/|\.(db|db-wal|db-shm|pem|key|p12|jks|keystore)$|anchor_key\.json$|google-services\.json$' | grep -v '\.env\.example$' || true)"
[ -z "$BAD" ] || die "the bundle would ship files it must not:
$BAD"
NFILES="$(tar -tzf "$WORK/bundle.tgz" | wc -l)"; SIZE="$(du -h "$WORK/bundle.tgz" | cut -f1)"
say "bundle: $NFILES files, $SIZE, revision $(cat "$WORK/backend/REVISION") (checked: no .env, keys, DBs, node_modules, fixtures)"

if [ -n "$DRY" ]; then
  cat <<EOF

== bootstrap DRY RUN (no AWS call). A real run would:
   1. check the account is $HAWKEYE_ACCOUNT, find the running instance tagged project=$TAG_PROJECT env=$TAG_ENV
   2. upload the bundle (and bootstrap.sh${SEED_DB:+, and the seed DB}) to s3://$BUCKET/deploy/$STAMP/
   3. run bootstrap.sh --on-host over SSM Run Command (no SSH), which installs Node $NODE_VERSION, Caddy $CADDY_VERSION,
      Litestream $LITESTREAM_VERSION (hash-pinned), formats/mounts the data volume at $DATA, npm ci on arm64
      (and checks ffmpeg runs), writes the systemd units + Caddyfile + the boot-time SSM loader + the hourly
      DB backup timer + the hourly Litestream interval timer (D7), starts hawkeye.target, and verifies /api/health of the writer, every reader and the
      worker, :443 through Caddy, and a restore from BOTH database copies (Litestream replica, hourly S3 backup)
   Top of the bundle by size:
EOF
  tar -tvzf "$WORK/bundle.tgz" | sort -k3 -nr | awk 'NR<=8 {printf "     %10s  %s\n", $3, $6}'
  exit 0
fi

# ---- 2. AWS: guard first --------------------------------------------------------------------
require_account
IID="$(aws_ ec2 describe-instances --filters Name=tag:project,Values="$TAG_PROJECT" Name=tag:env,Values="$TAG_ENV" \
  Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId' --output text)"
[ -n "$IID" ] || die "no running instance tagged env=staging (run provision.sh --apply, or start it)"
[ "$(wc -w <<<"$IID")" = 1 ] || die "more than one staging instance is running: $IID"
for _ in $(seq 1 30); do
  st="$(aws_ ssm describe-instance-information --filters Key=InstanceIds,Values="$IID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [ "$st" = Online ] && break; say "waiting for the SSM agent on $IID ($st)"; sleep 10
done
[ "$st" = Online ] || die "SSM agent on $IID is not Online"

say "uploading to s3://$BUCKET/deploy/$STAMP/"
aws_ s3 cp --only-show-errors "$WORK/bundle.tgz" "s3://$BUCKET/deploy/$STAMP/bundle.tgz"
aws_ s3 cp --only-show-errors "$HERE/bootstrap.sh" "s3://$BUCKET/deploy/$STAMP/bootstrap.sh"
EXTRA="--readers $READERS"
if [ -n "$SEED_DB" ]; then
  aws_ s3 cp --only-show-errors "$SEED_DB" "s3://$BUCKET/deploy/$STAMP/seed.db"; EXTRA="$EXTRA --seed-db"
fi

CMD1="aws --region $REGION s3 cp --only-show-errors s3://$BUCKET/deploy/$STAMP/bootstrap.sh /root/hawkeye-bootstrap.sh"
CMD2="bash /root/hawkeye-bootstrap.sh --on-host --bucket $BUCKET --stamp $STAMP $EXTRA"
CID="$(aws_ ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript \
  --comment "hawkeye staging bootstrap $STAMP" --timeout-seconds 600 \
  --parameters "{\"commands\":[\"set -euo pipefail\",\"$CMD1\",\"$CMD2\"],\"executionTimeout\":[\"3600\"]}" \
  --query Command.CommandId --output text)"
say "SSM command $CID running on $IID (log on the host: /var/log/hawkeye-bootstrap.log)"
errs=0; waited=0
while :; do
  sleep 15; waited=$((waited + 15))
  # Right after send-command the invocation may not exist yet (InvocationDoesNotExist): tolerate
  # a few errors, but never loop forever on a persistent one (permissions, a wrong id).
  if st="$(aws_ ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null)"; then errs=0
  else errs=$((errs + 1)); st=Pending; [ "$errs" -lt 8 ] || die "cannot read the status of SSM command $CID (8 errors in a row)"; fi
  [ "$waited" -lt 3900 ] || die "SSM command $CID still $st after 65 min"
  case "$st" in Pending|InProgress|Delayed) printf '.' >&2 ;; *) echo >&2; break ;; esac
done
aws_ ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardOutputContent --output text | tail -40
ERRS="$(aws_ ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query StandardErrorContent --output text | tail -20)"
[ -z "$ERRS" ] || { echo "--- stderr:"; echo "$ERRS"; }
[ "$st" = Success ] || die "bootstrap finished with status $st"
say "staging bootstrapped: release $STAMP. Shell: aws ssm start-session --region $REGION --target $IID"

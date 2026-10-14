#!/bin/bash
# THE CUTOVER, GO54 -> the Oracle election server (hosting plan §4.2), one checked step at a time.
# Run from the laptop (repo root). Each step prints what it proved; none runs the next by itself.
#
#   cutover.sh preflight      both sides healthy; GO54 has the snapshot route; production DORMANT
#   cutover.sh freeze         GO54 readOnly ON (writes 503 + Retry-After; phones hold their reports)
#   cutover.sh snapshot       GO54's final snapshot (POST /api/admin/backup/snapshot), downloaded, checksum checked
#   cutover.sh install FILE   that snapshot becomes the election server's database (still dormant); counts compared
#   cutover.sh files          top up incident media + training sheets (go54-files.sh)
#   cutover.sh live           /etc/hawkeye/live, rebuild (STANDBY off), writers/journal/photos overlay
#     -> OWNER: Cloudflare DNS, hawkeye.com.ng and www to the election server (proxied)
#   cutover.sh verify         the public site answers from the election server; GO54 still frozen
#   cutover.sh unfreeze-go54  ROLLBACK before DNS moves: GO54 writable again
#
# Secrets: GO54's login and ADMIN_CONSOLE_SECRET are read from backend/.env and never printed.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ENVF=backend/.env
UA='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36'
SITE=https://hawkeye.com.ng
. ~/.config/hawkeye/production-oracle.env
K="${STAGING_SSH_KEY/#\~/$HOME}"
PROD=(ssh -i "$K" -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 "ubuntu@$STAGING_HOST")
admin_secret() { grep '^ADMIN_CONSOLE_SECRET=' "$ENVF" | cut -d= -f2- | sed -e 's/[[:space:]]*#.*//' -e 's/^"\(.*\)"$/\1/'; }
health_go54() { curl -s -m 25 -A "$UA" "$SITE/api/health"; }
prod_health() { "${PROD[@]}" 'sudo curl -fsS --max-time 5 -H @/run/hawkeye/origin-auth.hdr http://127.0.0.1:8430/api/health'; }
post_code() { curl -s -m 25 -A "$UA" -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$SITE$1"; }
ops_upload() {   # $1 = true|false: GO54's ops-switches.json readOnly, keeping every other switch as it is
  local d; d="$(mktemp -d)"
  U=$(grep '^GO54_USERNAME=' "$ENVF" | cut -d= -f2- | awk '{print $1}')
  P=$(grep '^GO54_PASSWORD=' "$ENVF" | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
  curl -fsSk -m 60 -u "$U:$P" "https://da32.host-ww.net:2222/CMD_FILE_MANAGER/hawkeye/backend/src/data/ops-switches.json?action=download" -o "$d/ops-switches.json" 2>/dev/null || echo '{}' > "$d/ops-switches.json"
  python3 - "$d/ops-switches.json" "$1" <<'PY'
import json, sys
p, on = sys.argv[1], sys.argv[2] == "true"
try: j = json.load(open(p))
except Exception: j = {}
if not isinstance(j, dict): j = {}
j["readOnly"] = on
json.dump(j, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
  bash scripts/deploy_app.sh --path /hawkeye/backend/src/data "$d/ops-switches.json" 2>&1 | tail -1 | cut -c1-120
  rm -rf "$d"
}
case "${1:-}" in
  preflight)
    echo "GO54: $(health_go54 | python3 -c 'import json,sys; d=json.load(sys.stdin); print("env", d.get("env"), "| readOnly", d.get("readOnly"))')"
    c=$(curl -s -m 25 -A "$UA" -o /dev/null -w '%{http_code}' -X POST "$SITE/api/admin/backup/snapshot")
    echo "GO54 snapshot route without the secret: HTTP $c  (401/403 = it exists; 404 = deploy the backend first)"
    echo "election server: $(prod_health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("env", d.get("env"), "| readOnly", d.get("readOnly"), "| standby", bool(d.get("standby")))')"
    [ -n "$(admin_secret)" ] && echo "admin secret: present in backend/.env" || echo "admin secret: MISSING in backend/.env"
    ;;
  freeze)
    ops_upload true; sleep 3
    echo "GO54 write now answers HTTP $(post_code /api/practice/submit)  (want 503); health readOnly: $(health_go54 | python3 -c 'import json,sys; print(json.load(sys.stdin).get("readOnly"))')"
    ;;
  unfreeze-go54)
    ops_upload false; sleep 3
    echo "GO54 health readOnly: $(health_go54 | python3 -c 'import json,sys; print(json.load(sys.stdin).get("readOnly"))')  (want False)"
    ;;
  snapshot)
    r="$(curl -s -m 600 -A "$UA" -X POST -H "x-admin-secret: $(admin_secret)" "$SITE/api/admin/backup/snapshot")"
    echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("snapshot", d.get("name"), "| readOnly", d.get("readOnly"), "| counts", d.get("counts"), "| head", d.get("head"))'
    name="$(echo "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
    want="$(echo "$r" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha256"])')"
    echo "$r" > "$HOME/hawkeye-backups/${name%.db.gz}.json"
    bash backend/scripts/pull_backup.sh "$name" | tail -1
    got="$(sha256sum "$HOME/hawkeye-backups/$name" | cut -d' ' -f1)"
    [ "$got" = "$want" ] && echo "download checksum matches GO54's: $HOME/hawkeye-backups/$name" || { echo "CHECKSUM MISMATCH — do not install"; exit 1; }
    ;;
  install)
    f="${2:?usage: cutover.sh install ~/hawkeye-backups/hawkeye-cutover-<UTC>.db.gz}"; meta="${f%.db.gz}.json"
    [ -f "$meta" ] || { echo "no $meta (made by the snapshot step)"; exit 1; }
    t="$(mktemp)"; gunzip -c "$f" > "$t"
    scp -q -i "$K" -o IdentitiesOnly=yes "$t" "ubuntu@$STAGING_HOST:/tmp/cutover.db"; rm -f "$t"
    "${PROD[@]}" 'sudo bash -s' <<'R'
set -euo pipefail
D=/var/lib/hawkeye/storage
[ ! -f /etc/hawkeye/live ] || { echo "REFUSED: the election server is already live"; exit 1; }
[ "$(head -c 15 /tmp/cutover.db)" = "SQLite format 3" ] || { echo "not a database"; exit 1; }
systemctl stop hawkeye.target 'hawkeye-*.service' 2>/dev/null || true
mv "$D/hawkeye.db" "$D/hawkeye.db.pre-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
rm -f "$D/hawkeye.db-wal" "$D/hawkeye.db-shm"; rm -rf "$D/.hawkeye.db-litestream"
install -o hawkeye -g hawkeye -m 0640 /tmp/cutover.db "$D/hawkeye.db"; rm -f /tmp/cutover.db
/usr/local/sbin/hawkeye-restart >/dev/null 2>&1 || systemctl start hawkeye.target
q() { sqlite3 -readonly "file:$D/hawkeye.db?mode=ro" "$1"; }
echo "installed: submissions $(q 'SELECT COUNT(*) FROM submissions'), observers $(q 'SELECT COUNT(*) FROM observers'), incidents $(q 'SELECT COUNT(*) FROM incidents'), head $(q "SELECT id || ' ' || substr(entry_hash,1,12) FROM submissions ORDER BY id DESC LIMIT 1")"
R
    echo "GO54 said: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); h=d.get("head") or {}; print(d["counts"], "head", h.get("id"), str(h.get("hash") or "")[:12])' "$meta")"
    ;;
  files)
    bash scripts/staging/oracle/go54-files.sh ;;
  live)
    "${PROD[@]}" 'sudo bash -c "date -u +%FT%TZ > /etc/hawkeye/live"'
    bash scripts/staging/oracle.sh --site production > /tmp/oracle-production-run.log 2>&1 || { tail -5 /tmp/oracle-production-run.log; exit 1; }
    "${PROD[@]}" 'sudo JOURNAL=1 PHOTOS=2 REMOTE_PHOTOS=1 /usr/local/sbin/hk-writers-overlay 3 | tail -1'
    echo "election server: $(prod_health | python3 -c 'import json,sys; d=json.load(sys.stdin); print("env", d.get("env"), "| readOnly", d.get("readOnly"), "| standby", bool(d.get("standby")))')  (want readOnly False, standby False)"
    echo "NOW (owner): Cloudflare DNS — hawkeye.com.ng and www to the election server, proxied."
    ;;
  verify)
    h="$(health_go54)"; echo "public site: $(echo "$h" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("env", d.get("env"), "| role", d.get("role"), "| host", d.get("host"), "| readOnly", d.get("readOnly"))')"
    echo "  (role writer + readOnly False = the election server is answering; GO54 runs role all)"
    ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac

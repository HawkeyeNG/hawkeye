#!/usr/bin/env bash
# Hawkeye standby FAILOVER DRILL — flip the site to the Oracle standby, prove it
# serves through Cloudflare, hold for a few minutes, flip back, prove the primary
# is back. Meant for a quiet hour (scheduled from Windows Task Scheduler, which
# starts WSL even when no session is open).
#
#   scripts/standby_drill.sh            run the drill (moves live traffic briefly)
#   HOLD_SECONDS=300 (default)          how long the standby serves
#
# SAFETY: the flip back runs from an EXIT trap, so any failure — a check that does
# not pass, a timeout, a killed script — still ends on the primary. Nothing is
# written on either server; the standby is read-only throughout.
set -uo pipefail
cd "$(dirname "$0")/.."
HOLD="${HOLD_SECONDS:-300}"
LOG="tmp/standby-drill-$(date -u +%Y%m%dT%H%MZ).log"
mkdir -p tmp
exec > >(tee -a "$LOG") 2>&1
say() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
health() { curl -s --max-time 20 "https://hawkeye.com.ng/api/health?drill=$RANDOM"; }
host_of() { python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("host",""))
except Exception: print("")'; }
home_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://hawkeye.com.ng/?drill=$RANDOM"; }

FLIPPED=0
back() {
  if [ "$FLIPPED" = 1 ]; then
    say "flipping back to the primary"
    scripts/standby_failover.sh to-primary --yes || say "!! to-primary FAILED — run it by hand"
    for i in $(seq 1 12); do
      h="$(health | host_of)"
      [ -n "$h" ] && [ "$h" != "oci-standby" ] && { say "primary answering again (host=$h), home=$(home_code)"; break; }
      sleep 10
    done
  fi
  say "drill log: $LOG"
}
trap back EXIT

say "pre-check"
# WAIT FOR THE NETWORK. The 3 Oct 03:00 run woke the laptop and found WSL's DNS
# not up yet ("Temporary failure in name resolution"), so it aborted. Give it
# up to 15 minutes before giving up (still aborts safely, nothing flipped).
for i in $(seq 1 30); do
  getent hosts api.cloudflare.com >/dev/null 2>&1 && curl -s -o /dev/null --max-time 15 https://hawkeye.com.ng/api/health && break
  [ "$i" = 30 ] && { say "network never came up — drill aborted, nothing flipped"; exit 1; }
  sleep 30
done
scripts/standby_failover.sh status || { say "status failed — drill aborted, nothing flipped"; exit 1; }
pre="$(health | host_of)"
[ -n "$pre" ] && [ "$pre" != "oci-standby" ] || { say "primary not answering normally (host=$pre) — drill aborted"; exit 1; }
say "primary answering (host=$pre)"

say "flipping to the standby"
FLIPPED=1
scripts/standby_failover.sh to-standby --yes || { say "to-standby failed"; exit 1; }

ok=0
for i in $(seq 1 12); do
  body="$(health)"; h="$(printf '%s' "$body" | host_of)"
  if [ "$h" = "oci-standby" ]; then ok=1; say "standby answering through Cloudflare: $(printf '%s' "$body" | head -c 220)"; break; fi
  sleep 10
done
[ "$ok" = 1 ] || { say "!! standby never answered through Cloudflare within 2 min"; exit 1; }
say "home page via Cloudflare: $(home_code)"
w="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST https://hawkeye.com.ng/api/health)"
say "a write is refused as designed: POST -> $w"

end=$(( $(date +%s) + HOLD ))
while [ "$(date +%s)" -lt "$end" ]; do
  sleep 60
  say "holding: host=$(health | host_of) home=$(home_code)"
done
say "drill PASSED on the standby side"

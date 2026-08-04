#!/bin/bash
# Deploy files to the live site — ONE FILE PER REQUEST, then verify each one.
#
#   scripts/deploy_app.sh app/menu.js app/styles.css app/*.html
#   scripts/deploy_app.sh --path /hawkeye/backend/src/routes backend/src/routes/foo.js
#   scripts/deploy_app.sh --restart backend/src/routes/foo.js     # + backend restart
#
# WHY ONE FILE PER REQUEST. The ad-hoc scripts this replaces uploaded 8 files in
# a single multipart POST. On 2026-08-04 that dropped the connection mid-transfer
# (curl reported http=000) and DirectAdmin wrote a TRUNCATED file — app/menu.js
# landed as 0 bytes, taking out the menu, the INEC disclaimer bar, page titles
# and the assistant across the whole site. The response body still said
# "Upload successful", and the retry loop then re-sent the same doomed batch five
# times. Single-file uploads have never done this.
#
# WHY VERIFY. That failure was silent — error=0 in the body, a broken file on
# disk. Nothing short of re-fetching the file and checking its size catches it,
# so this script always does, and exits non-zero if anything is short.
set -uo pipefail

REMOTE_PATH=/hawkeye/app
RESTART=0
FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --path) REMOTE_PATH="$2"; shift 2 ;;
    --restart) RESTART=1; shift ;;
    *) FILES+=("$1"); shift ;;
  esac
done
[ ${#FILES[@]} -eq 0 ] && { echo "usage: $0 [--path REMOTE] [--restart] <file>..."; exit 2; }

cd "$(dirname "$0")/.." || exit 1
U=$(grep '^GO54_USERNAME=' backend/.env | cut -d= -f2- | awk '{print $1}')
P=$(grep '^GO54_PASSWORD=' backend/.env | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
API="https://da32.host-ww.net:2222/CMD_API_FILE_MANAGER"
SITE=https://hawkeye.com.ng
[ -z "$U" ] || [ -z "$P" ] && { echo "GO54 credentials not readable from backend/.env"; exit 1; }

upload() {                                     # upload <localfile>
  local f="$1" try code
  for try in 1 2 3 4 5; do
    code=$(curl -sk -m 180 -u "$U:$P" -o /tmp/da_deploy.txt -w '%{http_code}' \
      -F 'action=upload' -F "path=$REMOTE_PATH" -F "file1=@$f" "$API")
    if [ "$code" = "200" ] && grep -q 'error=0' /tmp/da_deploy.txt; then return 0; fi
    sleep $(( try * 4 ))
  done
  return 1
}

# Only files that live under app/ are fetchable for verification; backend files
# are not web-served, so they are uploaded but reported as unverified.
verify() {                                     # verify <localfile>  -> 0 ok
  local f="$1" rel local_b live_b
  case "$f" in app/*) rel="${f#app/}" ;; *) return 2 ;; esac
  local_b=$(wc -c < "$f")
  # A short read is usually the host throttling a burst, not a bad file, so give
  # it two paced attempts before calling it broken.
  for _ in 1 2; do
    live_b=$(curl -s -m 60 "$SITE/$rel?v=$RANDOM$RANDOM" | wc -c)
    # HTML comes back a few hundred bytes larger — the host injects into HTML
    # responses — so this is a "not truncated" test, not an equality test.
    [ "$live_b" -ge $(( local_b * 90 / 100 )) ] && return 0
    sleep 4
  done
  echo "    live=$live_b local=$local_b"
  return 1
}

ok=0; failed=(); unverified=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "  MISSING  $f"; failed+=("$f"); continue; }
  if ! upload "$f"; then echo "  UPLOAD   FAILED $f"; failed+=("$f"); continue; fi
  verify "$f"; rc=$?
  case $rc in
    0) echo "  ok       $f"; ok=$((ok+1)) ;;
    2) echo "  ok*      $f  (not web-served — upload accepted, not verified)"; ok=$((ok+1)); unverified=$((unverified+1)) ;;
    *) echo "  TRUNCATED $f — re-uploading once"
       if upload "$f" && verify "$f"; then echo "    recovered $f"; ok=$((ok+1)); else failed+=("$f"); fi ;;
  esac
  sleep 1                                      # pace: bursts get throttled
done

if [ "$RESTART" = 1 ]; then
  date +%s > /tmp/restart.txt
  REMOTE_PATH=/hawkeye/backend/tmp upload /tmp/restart.txt && echo "  ok       backend restart triggered"
  sleep 20
  echo -n "  health:  "; curl -s -m 25 "$SITE/api/health"; echo
fi

echo "deployed $ok/${#FILES[@]}${unverified:+ ($unverified unverified)}"
if [ ${#failed[@]} -gt 0 ]; then printf 'FAILED: %s\n' "${failed[*]}"; exit 1; fi

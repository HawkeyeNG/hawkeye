#!/usr/bin/env bash
#
# Poll an EAS build until it leaves the queue and finishes, then print the
# outcome. The free tier runs a low-priority queue, so "in queue" for a long
# while is normal, not a fault.
#
#   ./watch_eas_build.sh <build-id> [poll-seconds]
set -uo pipefail

ID="${1:?usage: watch_eas_build.sh <build-id> [seconds]}"
EVERY="${2:-60}"
cd /home/elrio/hawkeye/native

last=""
for i in $(seq 1 240); do   # 240 * 60s = 4 hours, well past any real queue
  json="$(npx eas-cli build:view "$ID" --json 2>/dev/null || true)"
  status="$(printf '%s' "$json" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get('status',''))
except Exception:
    print('')
" 2>/dev/null)"

  if [ -n "$status" ] && [ "$status" != "$last" ]; then
    printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$status"
    last="$status"
  fi

  case "$status" in
    FINISHED)
      printf '%s' "$json" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('artifact:', (d.get('artifacts') or {}).get('buildUrl') or (d.get('artifacts') or {}).get('applicationArchiveUrl'))
print('version :', d.get('appVersion'), 'build', d.get('appBuildVersion'))
"
      exit 0
      ;;
    ERRORED|CANCELED)
      printf '%s' "$json" | python3 -c "
import json,sys
d = json.load(sys.stdin)
e = d.get('error') or {}
print('errorCode :', e.get('errorCode'))
print('message   :', e.get('message'))
"
      exit 1
      ;;
  esac
  sleep "$EVERY"
done

echo "gave up waiting after 4 hours; build $ID is still $last" >&2
exit 2

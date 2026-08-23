#!/usr/bin/env bash
# Check the LIVE national boards through Cloudflare (never --resolve: the origin
# lock 403s a direct-origin request, which reads as an outage that is not one).
SITE=${1:-https://hawkeye.com.ng}
for c in REP_BYE_GOMBE_2026 SHA_BYE_DELTA_UDU_2026 SHA_BYE_KANO_DAWAKINKUDU_2026 PRES REP SHA GOV SEN; do
  printf '%-32s ' "$c"
  curl -s -m 30 "$SITE/api/national/$c" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('  no/bad JSON'); raise SystemExit
s = d.get('subunits') or []
print(str(len(s)).rjust(4), ' ', ', '.join(s[:3]))
"
done

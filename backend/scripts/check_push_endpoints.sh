#!/usr/bin/env bash
# The push endpoints must refuse an unauthenticated caller.
#   bash scripts/check_push_endpoints.sh [base]
#
# A file rather than an inline loop: the Bash tool expands $VAR before WSL sees
# it, so the same loop written inline probes the empty path and reports nothing.
BASE="${1:-http://127.0.0.1:8430}"

echo "these MUST NOT answer without the admin passphrase:"
for P in /api/push/audience /api/push/health; do
  CODE=$(curl -s -m 8 -o /tmp/hk_push.json -w '%{http_code}' "${BASE}${P}")
  printf '  GET  %-24s HTTP %s\n' "$P" "$CODE"
done

CODE=$(curl -s -m 8 -o /tmp/hk_push.json -w '%{http_code}' \
  -X POST -H 'content-type: application/json' \
  -d '{"title":"t","body":"b","dryRun":false,"confirm":"SEND"}' \
  "${BASE}/api/push/broadcast")
printf '  POST %-24s HTTP %s\n' "/api/push/broadcast" "$CODE"
head -c 200 /tmp/hk_push.json; echo

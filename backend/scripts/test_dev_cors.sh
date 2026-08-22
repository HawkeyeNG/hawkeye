#!/usr/bin/env bash
# Does the local backend allow a browser at localhost:8081, and refuse others?
#   bash scripts/test_dev_cors.sh [base]
#
# Both halves matter. Allowing loopback is what unblocks running the app in a
# desktop browser; refusing everything else is what keeps this from being a hole
# in a public election-integrity API.
BASE="${1:-http://127.0.0.1:8430}"
FAIL=0

hdr() { grep -i '^access-control-allow-origin' /tmp/hk_cors.txt | head -1; }

echo "loopback origin MUST be allowed:"
for O in http://localhost:8081 http://127.0.0.1:8081; do
  curl -s -i -m 8 "${BASE}/api/contests" -H "Origin: ${O}" > /tmp/hk_cors.txt
  GOT=$(hdr)
  if [ -n "$GOT" ]; then echo "  ok    ${O} -> ${GOT}"; else echo "  FAIL  ${O} -> no header"; FAIL=1; fi
done

echo
echo "the OPTIONS preflight MUST return 2xx, not the SPA 404:"
CODE=$(curl -s -o /tmp/hk_cors.txt -w '%{http_code}' -m 8 -X OPTIONS "${BASE}/api/observers/sign-in" \
  -H 'Origin: http://localhost:8081' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type')
if [ "$CODE" = "204" ] || [ "$CODE" = "200" ]; then echo "  ok    preflight HTTP ${CODE}"
else echo "  FAIL  preflight HTTP ${CODE} — the browser will reject the request"; FAIL=1; fi

echo
echo "a NON-loopback origin MUST NOT be allowed:"
for O in https://evil.test http://localhost.evil.test; do
  curl -s -i -m 8 "${BASE}/api/contests" -H "Origin: ${O}" > /tmp/hk_cors.txt
  GOT=$(hdr)
  if [ -z "$GOT" ]; then echo "  ok    ${O} -> no header"; else echo "  FAIL  ${O} -> ${GOT}"; FAIL=1; fi
done

echo
[ "$FAIL" = 0 ] && echo "PASS" || echo "FAIL"
exit "$FAIL"

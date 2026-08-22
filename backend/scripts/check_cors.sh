#!/usr/bin/env bash
# Does production allow a browser at localhost:8081 to call the API?
#   bash scripts/check_cors.sh [origin]
#
# The native app hardcodes BASE = https://hawkeye.com.ng. On a device that is
# fine — no browser, no same-origin policy. Running the same code through
# react-native-web makes it a cross-origin XHR, and a missing
# Access-Control-Allow-Origin surfaces to the app as a bare "network error"
# with no further detail, which is exactly what a real outage looks like.
ORIGIN="${1:-http://localhost:8081}"
API="https://hawkeye.com.ng"

echo "preflight (what the browser sends before a POST):"
curl -s -i -m 15 -X OPTIONS "${API}/api/observers/sign-in" \
  -H "Origin: ${ORIGIN}" \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  | sed -n '1p;/^[Aa]ccess-[Cc]ontrol/p;/^[Vv]ary/p'

echo
echo "simple GET, same question:"
curl -s -i -m 15 "${API}/api/contests" -H "Origin: ${ORIGIN}" \
  | sed -n '1p;/^[Aa]ccess-[Cc]ontrol/p'

echo
echo "If no Access-Control-Allow-Origin appears above, the browser blocks the"
echo "response and the app reports a network error it cannot explain."

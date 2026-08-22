#!/usr/bin/env bash
# Every check in one place, with the server lifecycle handled.
#
#   bash scripts/run_all_tests.sh
#
# The privacy test needs a running server, and a `set -e` script whose curl
# cannot connect exits before printing its verdict — which looks, in a tail,
# exactly like a partial pass. So the server is started here and its readiness
# is CONFIRMED before anything depends on it.
cd ~/hawkeye/backend || exit 1
FAIL=0
run() { echo; echo "--- $1"; shift; if "$@"; then :; else echo "    ^ FAILED"; FAIL=1; fi }

run "ec8a arithmetic verifier"  node scripts/test_ec8a_verify.mjs
run "words parser"              node scripts/test_ec8a_words.mjs
run "party-pass merge"          node scripts/test_party_merge.mjs
run "training routes"           node scripts/test_training_routes.mjs
run "push broadcast guards"     node scripts/test_push_broadcast.mjs
run "fetchData (Lite)"          node scripts/test_fetchdata.mjs
run "console scripts parse"     node scripts/check_html_scripts.mjs ../app/admin.html ../app/review.html

echo
echo "--- starting server for the privacy test"
SMS_PROVIDER=console nohup node src/server.js > /tmp/hk_test_server.log 2>&1 &
SRV=$!
READY=0
for _ in $(seq 1 20); do
  sleep 1
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:8430/training/truth.json"; then READY=1; break; fi
done
if [ "$READY" = 1 ]; then
  run "audit files are not public" bash scripts/test_audit_privacy.sh
  run "push endpoints are admin-gated" bash scripts/check_push_endpoints.sh
else
  echo "    server never became ready — privacy test NOT RUN"
  tail -5 /tmp/hk_test_server.log
  FAIL=1
fi
kill "$SRV" 2>/dev/null
wait "$SRV" 2>/dev/null

echo
[ "$FAIL" = 0 ] && echo "=== ALL CHECKS PASSED ===" || echo "=== SOMETHING FAILED (see above) ==="
exit "$FAIL"

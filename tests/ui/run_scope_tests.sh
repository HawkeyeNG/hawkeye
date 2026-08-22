#!/usr/bin/env bash
# Run the tests that exercise contest scoping, one at a time, and say which fail.
cd /home/elrio/hawkeye || exit 1
fails=0
for t in coverage_scope_test follow_scope_test results_payload_test \
         declared_result_test leaderboard_race_link_test seat_coverage_test; do
  f="tests/$t.mjs"
  [ -f "$f" ] || continue
  out="$(timeout 180 node "$f" 2>&1)"
  if printf '%s' "$out" | grep -qiE "all passed|ALL CHECKS PASSED"; then
    echo "PASS  $t"
  else
    echo "FAIL  $t"
    printf '%s\n' "$out" | tail -12 | sed 's/^/      /'
    fails=$((fails + 1))
  fi
done
echo
echo "$fails test file(s) failing"
exit $fails

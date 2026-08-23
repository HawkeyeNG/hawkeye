#!/usr/bin/env bash
# The race-page suite, in one command. Every test that touches a race page, its
# map, its card, the races index or the board links that reach it.
cd "$(dirname "$0")/.." || exit 1
fail=0
for t in \
  native_race_parity sha_page race_card byelection_page seat_pages seat_coverage \
  races_grouping race_render race_map race_map_inspect race_results_link \
  map_crop gov_disclaimer results_race_choice menu_races leaderboard_race_link
do
  f="tests/${t}_test.mjs"
  printf '%-26s ' "$t"
  if [ ! -f "$f" ]; then echo '(missing)'; fail=$((fail+1)); continue; fi
  if node "$f" >/tmp/race_suite.out 2>&1; then echo OK; else
    echo FAIL; fail=$((fail+1)); tail -12 /tmp/race_suite.out | sed 's/^/    /'
  fi
done
echo
if [ "$fail" -gt 0 ]; then echo "$fail suite(s) FAILED"; exit 1; fi
echo 'race suite: all green'

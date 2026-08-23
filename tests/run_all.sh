#!/usr/bin/env bash
# Every .mjs test in tests/, in one command. Some need a running backend and say
# so themselves; this reports what failed rather than stopping at the first.
cd "$(dirname "$0")/.." || exit 1
fail=0
for f in tests/*_test.mjs; do
  name=$(basename "$f" _test.mjs)
  printf '%-28s ' "$name"
  if node "$f" >/tmp/run_all.out 2>&1; then echo OK; else
    echo FAIL; fail=$((fail+1)); grep -E '^FAIL|Error' /tmp/run_all.out | head -6 | sed 's/^/    /'
  fi
done
echo
[ "$fail" -gt 0 ] && { echo "$fail FAILED"; exit 1; }
echo 'all green'

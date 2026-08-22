#!/usr/bin/env bash
# Find CRLF line endings in files git is about to record.
#
#   bash scripts/check_crlf.sh [--fix]
#
# Editing through the \\wsl.localhost UNC path rewrites files with Windows line
# endings. Committed, they show as a whole-file diff and make every later
# `git blame` useless. Checked before every commit, not after.
cd ~/hawkeye || exit 1
FIX=0
[ "$1" = "--fix" ] && FIX=1

FILES=$(git status --porcelain --untracked-files=all | awk '{print $2}' \
        | grep -E '\.(mjs|js|py|sh|json|md|html|css)$' || true)
BAD=0
for F in $FILES; do
  [ -f "$F" ] || continue
  if grep -qU $'\r$' "$F" 2>/dev/null; then
    BAD=$((BAD + 1))
    if [ "$FIX" = 1 ]; then
      sed -i 's/\r$//' "$F"
      echo "  fixed  $F"
    else
      echo "  CRLF   $F"
    fi
  fi
done

if [ "$BAD" = 0 ]; then
  echo "no CRLF found in the files to be committed"
elif [ "$FIX" = 1 ]; then
  echo "normalised $BAD file(s) to LF"
else
  echo "$BAD file(s) have CRLF — re-run with --fix"
  exit 1
fi

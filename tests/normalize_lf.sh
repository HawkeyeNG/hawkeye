#!/usr/bin/env bash
# Edits made through the \\wsl.localhost UNC path arrive CRLF. Strip it from
# every file this working tree has touched, before it reaches a commit.
cd "$(dirname "$0")/.." || exit 1
{ git diff --name-only; git ls-files -o --exclude-standard; } | sort -u | while read -r f; do
  [ -f "$f" ] || continue
  if grep -qU $'\r' "$f" 2>/dev/null; then
    echo "CRLF -> LF: $f"
    sed -i 's/\r$//' "$f"
  fi
done

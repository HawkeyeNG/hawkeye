#!/usr/bin/env bash
# Edits made through the \\wsl.localhost UNC path arrive CRLF. Strip it from
# every TEXT file this working tree has touched, before it reaches a commit.
#
# TEXT FILES ONLY, and that word is load-bearing. The first version of this
# script tested for a \r byte and ran `sed -i 's/\r$//'` on anything that had
# one — which is true of most binaries. It found a \r inside a PNG and stripped
# it, corrupting a 300 KB image that git then reported as "modified" with no
# visible reason. A tool that silently damages the thing it is tidying is worse
# than no tool.
#
# `grep -Iq .` is the test: -I means "treat a binary file as non-matching", so a
# binary fails it and is skipped.
cd "$(dirname "$0")/.." || exit 1
{ git diff --name-only; git ls-files -o --exclude-standard; } | sort -u | while read -r f; do
  [ -f "$f" ] || continue
  grep -Iq . "$f" 2>/dev/null || continue        # binary — never touch
  if grep -qU $'\r' "$f" 2>/dev/null; then
    echo "CRLF -> LF: $f"
    sed -i 's/\r$//' "$f"
  fi
done

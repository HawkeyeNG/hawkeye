#!/usr/bin/env bash
# Download an EAS build's Xcode log. The URL is signed and expires in 15
# minutes, so fetch it in the same breath as asking for it.
#   ./fetch_build_log.sh <build-id> [out]
set -euo pipefail
ID="${1:?usage: fetch_build_log.sh <build-id> [out]}"
OUT="${2:-/tmp/eas-$ID-xcode.txt}"
cd /home/elrio/hawkeye/native

URL="$(npx eas-cli build:view "$ID" --json 2>/dev/null \
  | python3 -c 'import json,sys; print((json.load(sys.stdin).get("artifacts") or {}).get("xcodeBuildLogsUrl") or "")')"

[ -n "$URL" ] || { echo "no xcode log url on build $ID" >&2; exit 1; }
curl -fsSL "$URL" -o "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT") lines)"

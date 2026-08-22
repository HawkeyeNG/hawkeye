#!/usr/bin/env bash
# Mint a local dev session and drive capture_store_shots.mjs with it.
#   ./run_capture.sh                 -> the full shot list
#   ./run_capture.sh --explore /practice
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

TOKEN="$(cd "$REPO/backend" && node scripts/dev_session.mjs --observer 111 \
  | sed -n 's/.*hawkeye\.auth\.token., "\(.*\)");/\1/p')"

if [ -z "$TOKEN" ]; then
  echo "could not mint a dev session token" >&2
  exit 1
fi
echo "token length: ${#TOKEN}"

cd "$HERE"
node capture_store_shots.mjs --token "$TOKEN" --out /tmp/raw "$@"

#!/usr/bin/env bash
# Mint a dev session and run check_routes.mjs with it.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TOKEN="$(cd "$REPO/backend" && node scripts/dev_session.mjs --observer 111 \
  | sed -n 's/.*hawkeye\.auth\.token., "\(.*\)");/\1/p')"
cd "$HERE"
node check_routes.mjs --token "$TOKEN" "$@"

#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
TOKEN="$(cd "$REPO/backend" && node scripts/dev_session.mjs --observer 111 \
  | sed -n 's/.*hawkeye\.auth\.token., "\(.*\)");/\1/p')"
cd "$HERE"
node probe_overlays.mjs "$TOKEN" "${1:-/osun}"

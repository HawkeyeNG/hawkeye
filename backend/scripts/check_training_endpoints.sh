#!/usr/bin/env bash
# Hit the Stage 2 training endpoints on a running local server.
#   bash scripts/check_training_endpoints.sh [base]
# Written as a file because the Bash tool expands $VAR before WSL sees it, so
# the same loop inline silently probes the empty path and gets the SPA shell
# back with a cheerful 200.
BASE="${1:-http://127.0.0.1:8430}"

for P in /api/training/streams /training/streams /api/training/items; do
  echo "== ${P}"
  CODE=$(curl -s -m 10 -o /tmp/hk_probe.json -w '%{http_code}' "${BASE}${P}")
  echo "  HTTP ${CODE}"
  head -c 300 /tmp/hk_probe.json
  echo
done

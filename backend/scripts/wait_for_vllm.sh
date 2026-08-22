#!/usr/bin/env bash
# Block until the pod's vLLM endpoint serves /v1/models, then exit 0.
# Exits non-zero on timeout so a stall is a FAILURE, never a quiet success —
# a watcher that cannot fail is a watcher that can lie.
#   bash wait_for_vllm.sh <podid> [max-minutes]
POD="$1"
MAX_MIN="${2:-60}"
[ -z "$POD" ] && { echo "usage: wait_for_vllm.sh <podid> [max-minutes]"; exit 2; }

URL="https://${POD}-8000.proxy.runpod.net/v1/models"
DEADLINE=$(( $(date +%s) + MAX_MIN * 60 ))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CODE=$(curl -s -m 20 -o /tmp/wait_vllm.json -w '%{http_code}' "$URL")
  if [ "$CODE" = "200" ]; then
    echo "UP after $(( ($(date +%s) - DEADLINE + MAX_MIN * 60) / 60 )) min"
    cat /tmp/wait_vllm.json
    echo
    exit 0
  fi
  sleep 30
done

echo "TIMED OUT after ${MAX_MIN} min — endpoint never answered 200 (last: ${CODE})"
exit 1

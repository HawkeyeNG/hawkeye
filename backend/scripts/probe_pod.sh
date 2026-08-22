#!/usr/bin/env bash
# Probe a RunPod pod's HTTP proxy for a live vLLM endpoint.
#   bash probe_pod.sh <podid>
POD="$1"
[ -z "$POD" ] && { echo "usage: probe_pod.sh <podid>"; exit 2; }

for P in 8000 8888; do
  URL="https://${POD}-${P}.proxy.runpod.net"
  echo "== ${URL} =="
  curl -s -m 25 -o /tmp/probe_pod.txt -w "  /v1/models  HTTP %{http_code}\n" "${URL}/v1/models"
  head -c 300 /tmp/probe_pod.txt; echo
  curl -s -m 25 -o /tmp/probe_pod2.txt -w "  /            HTTP %{http_code}\n" "${URL}/"
  head -c 200 /tmp/probe_pod2.txt; echo
done

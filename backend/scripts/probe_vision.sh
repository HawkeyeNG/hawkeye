#!/usr/bin/env bash
# Is a vision endpoint configured, and is anything answering on it?
# Prints the host only — never the key.
cd ~/hawkeye/backend || exit 1

if [ ! -f .env ]; then
  echo "no .env"
  exit 1
fi

BASE=$(grep -E '^VISION_API_BASE=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
if [ -z "$BASE" ]; then
  echo "VISION_API_BASE: not set"
  exit 0
fi

HOST=$(echo "$BASE" | sed -E 's#(https?://[^/]+).*#\1#')
echo "VISION_API_BASE host: $HOST"
echo "probing $HOST ..."
curl -s -m 15 -o /tmp/vision_probe.json -w "HTTP %{http_code} in %{time_total}s\n" "$BASE/models" || echo "unreachable"
if [ -s /tmp/vision_probe.json ]; then
  head -c 400 /tmp/vision_probe.json
  echo
fi

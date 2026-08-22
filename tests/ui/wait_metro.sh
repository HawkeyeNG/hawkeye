#!/usr/bin/env bash
# Block until the Metro web server answers, so a capture run does not race it.
URL="${1:-http://127.0.0.1:8092/}"
for i in $(seq 1 80); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$URL" || true)"
  if [ "$code" = "200" ]; then
    echo "metro ready (check $i)"
    exit 0
  fi
  sleep 3
done
echo "metro never became ready" >&2
exit 1

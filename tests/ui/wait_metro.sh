#!/usr/bin/env bash
# Wait for Metro, with a LANDMARK. The repo's wait_metro.sh checks only for HTTP
# 200 and reported ready while nothing was listening on the port at all — so this
# one requires the body to actually look like the Expo web bundle, and says which
# of the two failed. A checker that cannot tell "serving" from "not there" is not
# a checker.
URL=http://127.0.0.1:8092/
for i in $(seq 1 100); do
  BODY=$(curl -s -m 8 "$URL" 2>/dev/null)
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$URL" 2>/dev/null)
  if [ "$CODE" = "200" ] && printf '%s' "$BODY" | grep -qiE 'expo|root|<script'; then
    echo "metro READY after ${i} checks (http $CODE, $(printf '%s' "$BODY" | wc -c) bytes)"
    exit 0
  fi
  [ $((i % 10)) -eq 0 ] && echo "  ...check $i: http=$CODE body=$(printf '%s' "$BODY" | wc -c) bytes"
  sleep 3
done
echo "metro NEVER became ready (last http=$CODE)" >&2
exit 1

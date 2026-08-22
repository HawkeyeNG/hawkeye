#!/bin/bash
cd /home/elrio/hawkeye/backend || { echo "WATCH ERROR: cannot cd"; exit 1; }
PID=$(ps -eo pid,cmd | grep 'audit_irev.mjs fetch' | grep -v grep | awk '{print $1}' | head -1)
if [ -z "$PID" ]; then echo "WATCH ERROR: no fetch process at arm time"; exit 1; fi
echo "watching pid $PID"
last=-1
while true; do
  line=$(node scripts/audit_irev.mjs status 2>/dev/null | grep '^sheets')
  if [ -z "$line" ]; then echo "WATCH WARN: empty status"; sleep 60; continue; fi
  n=$(echo "$line"    | grep -oE '[0-9]+ downloaded'  | grep -oE '^[0-9]+')
  f=$(echo "$line"    | grep -oE '[0-9]+ failed'      | grep -oE '^[0-9]+')
  todo=$(echo "$line" | grep -oE '[0-9]+ not started' | grep -oE '^[0-9]+')
  # numeric comparison — NOT a substring grep ("1970 not started" contains "0 not started")
  if [ -n "$todo" ] && [ "$todo" -eq 0 ] 2>/dev/null; then echo "DONE — $line"; exit 0; fi
  if [ ! -d "/proc/$PID" ]; then echo "FETCH DIED (pid $PID) — $line"; exit 1; fi
  if [ "$last" -lt 0 ] || [ $((n - last)) -ge 250 ]; then echo "$line"; last=$n; fi
  if [ -n "$f" ] && [ "$f" -gt 20 ]; then echo "FAILURES CLIMBING — $line"; fi
  sleep 60
done

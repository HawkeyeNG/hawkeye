#!/bin/bash
# Second half of run_all.sh, parallelised: Lite + native capture run beside the
# (already running) web capture; flows, Lighthouse and sheets once all are done.
#   WEB_PID=<pid of the running web capture> bash run_rest.sh
cd /home/elrio/hawkeye/tests/design-audit || exit 1
export CHROME_PATH=/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export NATIVE_DIR=/home/elrio/hawkeye/tmp/design-audit-native-web
exec >> out/run.log 2>&1
echo "== run_rest start $(date -Is) (web capture pid ${WEB_PID:-none})"
node capture.mjs --surface native --workers 3 > out/capture-native.log 2>&1 &
NPID=$!
node capture.mjs --surface lite --workers 3 > out/capture-lite.log 2>&1 &
LPID=$!
wait $NPID; echo "== native capture done $(date -Is): $(tail -1 out/capture-native.log)"
wait $LPID; echo "== lite capture done $(date -Is): $(tail -1 out/capture-lite.log)"
echo "== flows $(date -Is)"
node flows.mjs --surface web,lite,native --langs en,ha --themes dark,light > out/flows.log 2>&1 || echo "flows exited $?"
tail -30 out/flows.log
if [ -n "$WEB_PID" ]; then while kill -0 "$WEB_PID" 2>/dev/null; do sleep 15; done; fi
echo "== web capture finished $(date -Is)"
echo "== lighthouse $(date -Is)"
node lighthouse.mjs || echo "lighthouse exited $?"
echo "== sheets $(date -Is)"
node contact-sheet.mjs && node contact-sheet.mjs --parity && node contact-sheet.mjs --langs web,lite,native
echo "== done $(date -Is)"

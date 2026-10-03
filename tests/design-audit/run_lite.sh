#!/bin/bash
# Lite capture on its own (restartable), then the sheets that depend on it.
cd /home/elrio/hawkeye/tests/design-audit || exit 1
export CHROME_PATH=/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
node capture.mjs --surface lite --workers "${WORKERS:-6}" > out/capture-lite.log 2>&1
echo "lite capture exit $? $(date -Is)" >> out/capture-lite.log

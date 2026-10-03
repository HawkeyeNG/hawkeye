#!/bin/bash
# Retry blips on every surface, then rebuild every sheet. Background-safe.
cd /home/elrio/hawkeye/tests/design-audit || exit 1
export CHROME_PATH=/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export NATIVE_DIR=/home/elrio/hawkeye/tmp/design-audit-native-web
exec > out/finish.log 2>&1
for s in web lite native; do echo "== retry $s $(date -Is)"; timeout 900 node capture.mjs --surface "$s" --retry-failed --workers 2 | tail -2; done
echo "== sheets $(date -Is)"
timeout 600 node contact-sheet.mjs && timeout 600 node contact-sheet.mjs --parity && timeout 600 node contact-sheet.mjs --langs web,lite,native
echo "== done $(date -Is)"

#!/bin/bash
# The whole design audit, in order. Read-only against production (see lib.mjs).
#   bash tests/design-audit/run_all.sh            # export native, capture, flows, Lighthouse, sheets
#   SKIP_EXPORT=1 bash tests/design-audit/run_all.sh
# Log: tests/design-audit/out/run.log
cd /home/elrio/hawkeye/tests/design-audit || exit 1
mkdir -p out
exec > >(tee out/run.log) 2>&1
export CHROME_PATH=/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome
export NATIVE_DIR=/home/elrio/hawkeye/tmp/design-audit-native-web
echo "== start $(date -Is)  repo HEAD $(git -C /home/elrio/hawkeye log -1 --format='%h %s')"
if [ -z "$SKIP_EXPORT" ]; then bash export_native.sh || { echo "native export failed — falling back to tmp/e2e-native-web"; export NATIVE_DIR=/home/elrio/hawkeye/tmp/e2e-native-web; }; fi
[ -d "$NATIVE_DIR" ] || export NATIVE_DIR=/home/elrio/hawkeye/tmp/e2e-native-web
echo "== native export: $NATIVE_DIR"
rm -rf out/web out/lite out/native out/sheets out/lighthouse
for s in web lite native; do
  echo "== capture $s $(date -Is)"
  node capture.mjs --surface "$s" --workers "${WORKERS:-5}" || echo "capture $s exited $?"
done
echo "== flows $(date -Is)"
node flows.mjs --surface web,lite,native --langs en,ha --themes dark,light || echo "flows exited $?"
echo "== lighthouse $(date -Is)"
node lighthouse.mjs || echo "lighthouse exited $?"
echo "== sheets $(date -Is)"
node contact-sheet.mjs && node contact-sheet.mjs --parity && node contact-sheet.mjs --langs web,lite,native
echo "== done $(date -Is)"

#!/bin/bash
# Export the native app through react-native-web for the design audit.
# Separate output dir so tests/e2e's tmp/e2e-native-web is left alone.
set -e
OUTDIR=/home/elrio/hawkeye/tmp/design-audit-native-web
cd /home/elrio/hawkeye/native
export NODE_OPTIONS="--max-old-space-size=6144"
export APP_VARIANT=production
rm -rf "$OUTDIR.tmp"
start=$(date +%s)
npx expo export --platform web --output-dir "$OUTDIR.tmp" > /tmp/design-audit-export.log 2>&1 || { echo "EXPORT FAILED"; tail -20 /tmp/design-audit-export.log; exit 1; }
rm -rf "$OUTDIR"
mv "$OUTDIR.tmp" "$OUTDIR"
echo "exported in $(( $(date +%s) - start ))s to $OUTDIR; native HEAD $(git -C /home/elrio/hawkeye log -1 --format=%h -- native/src)"
ls "$OUTDIR" | head -5

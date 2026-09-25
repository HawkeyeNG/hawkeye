#!/usr/bin/env bash
# Publish the current app/ as a live web update for Hawkeye Lite (Capgo updater,
# self-hosted — see "LIVE WEB UPDATES" in app/native.js).
#
#   scripts/publish_lite_bundle.sh <min-ios-build> <min-android-versionCode>
#
# The minimums are the OLDEST Lite binaries this web code can run on: raise them
# whenever app/ starts relying on a native plugin a store build added. 0 for a
# platform means "do not offer this bundle there". Run AFTER the web deploy, so
# the bundle is the same code the site is serving. Version = SW cache number.
set -euo pipefail
cd "$(dirname "$0")/.."
IOS=${1:?min iOS build}; AND=${2:?min Android versionCode (0 = none)}
V=$(grep -o "hawkeye-v[0-9]*" app/sw.js | head -1 | sed 's/hawkeye-v//')
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# (A full browser UA — the edge 403s a bare "Mozilla/5.0".)
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
# SAME VERSION ALREADY LIVE → only the minimums change: keep the live zip and
# its checksum. Rebuilding would give bundle-$V.zip a new hash (zip timestamps)
# under devices that already hold the old manifest, and their download would
# fail its checksum.
PREV=$(curl -s -A "$UA" "https://hawkeye.com.ng/lite/bundle.json?x=$RANDOM" || true)
if [[ "$PREV" == *"\"version\":\"$V\""* ]]; then
  SUM=$(echo "$PREV" | grep -o '"checksum":"[a-f0-9]*' | cut -d'"' -f4)
  echo "bundle $V is already live — reusing its zip (sha256 ${SUM:0:12}…), updating minBuild only"
  REUSE=1
else
REUSE=0
cp -r app "$T/public"
# From mobile/, as every store build runs it: it reads capacitor.config.json
# relative to the working directory.
OUT=$(cd mobile && bash scripts/strip_web_assets.sh "$T/public" package.json 2>&1) \
  || { echo "$OUT" | tail -8; echo "strip/gates FAILED — not publishing"; exit 1; }
test -f "$T/public/index.html" || { echo "no index.html after strip — not publishing"; exit 1; }
# index.html at the zip ROOT. python's zipfile when `zip` is not installed
# (WSL has none): with "." as the source it writes root-relative entries.
if command -v zip >/dev/null; then (cd "$T/public" && zip -qr "$T/bundle-$V.zip" .)
else (cd "$T/public" && python3 -m zipfile -c "$T/bundle-$V.zip" .); fi
unzip -l "$T/bundle-$V.zip" 2>/dev/null | grep -q ' index.html$' \
  || python3 -c "import zipfile,sys; sys.exit(0 if 'index.html' in zipfile.ZipFile('$T/bundle-$V.zip').namelist() else 1)" \
  || { echo "index.html is not at the zip root — not publishing"; exit 1; }
SUM=$(sha256sum "$T/bundle-$V.zip" | cut -d' ' -f1)
fi
cat > "$T/bundle.json" <<EOF
{"version":"$V","url":"https://hawkeye.com.ng/lite/bundle-$V.zip","checksum":"$SUM","minBuild":{"ios":$IOS,"android":$AND}}
EOF
echo "bundle $V: sha256 ${SUM:0:12}…, minBuild ios=$IOS android=$AND"
# Zip first, manifest last: a manifest must never point at a file not yet there.
[ "$REUSE" = 1 ] || scripts/deploy_app.sh --path /hawkeye/app/lite "$T/bundle-$V.zip" | tail -1
scripts/deploy_app.sh --path /hawkeye/app/lite "$T/bundle.json" | tail -1
# Prove the LIVE pair, not the upload's exit code: the zip the manifest points
# at must hash to the manifest's checksum, or every device rejects the download.
LIVE=$(curl -s -A "$UA" "https://hawkeye.com.ng/lite/bundle.json?x=$RANDOM")
LSUM=$(curl -s -A "$UA" "https://hawkeye.com.ng/lite/bundle-$V.zip?x=$RANDOM" | sha256sum | cut -d' ' -f1)
echo "live manifest: $LIVE"
[[ "$LIVE" == *"\"checksum\":\"$SUM\""* && "$LSUM" == "$SUM" ]] \
  && echo "LIVE OK: manifest and zip both match $SUM" \
  || { echo "LIVE MISMATCH: manifest/zip do not match $SUM (zip hashes to $LSUM)"; exit 1; }

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
cp -r app "$T/public"
bash mobile/scripts/strip_web_assets.sh "$T/public" mobile/package.json >/dev/null
(cd "$T/public" && zip -qr "$T/bundle-$V.zip" .)
SUM=$(sha256sum "$T/bundle-$V.zip" | cut -d' ' -f1)
cat > "$T/bundle.json" <<EOF
{"version":"$V","url":"https://hawkeye.com.ng/lite/bundle-$V.zip","checksum":"$SUM","minBuild":{"ios":$IOS,"android":$AND}}
EOF
echo "bundle $V: $(du -h "$T/bundle-$V.zip" | cut -f1), sha256 ${SUM:0:12}…, minBuild ios=$IOS android=$AND"
# Zip first, manifest last: a manifest must never point at a file not yet there.
scripts/deploy_app.sh --path /hawkeye/app/lite "$T/bundle-$V.zip" | tail -1
scripts/deploy_app.sh --path /hawkeye/app/lite "$T/bundle.json" | tail -1
curl -s -A Mozilla/5.0 "https://hawkeye.com.ng/lite/bundle.json?x=$RANDOM" | head -c 200; echo

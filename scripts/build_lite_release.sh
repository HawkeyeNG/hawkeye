#!/bin/bash
# Build the Hawkeye Lite RELEASE AAB (for Play) and the matching website APK in
# ONE run, from one source tree, carrying one version number.
#
#   scripts/build_lite_release.sh                # build both, rewrite the links
#   scripts/build_lite_release.sh --bump         # ask Play for the next code first
#   scripts/build_lite_release.sh --deploy       # ...and push the APK + pages live
#
# WHY THIS EXISTS. The AAB and the site's APK were built by different routes at
# different times, and they drifted: on 2026-09-05 the site was serving
# hawkeye-1.2-8.apk from 14 August while Lite 1.2 was live on both stores. Worse,
# the two were not even the same artifact — scripts/build_capacitor_apk.sh
# refreshed app/download/hawkeye.apk, while both pages linked the versioned
# hawkeye-<name>-<code>.apk that nothing updated. A download link nobody rebuilds
# is a link that quietly ships August's bugs forever.
#
# The fix is not discipline, it is co-location: the bundle and the APK are built
# by the same gradle invocation off the same synced web assets, so they cannot
# disagree about what "current" means.
#
# WHY THE APK IS A DEBUG BUILD. Deliberate, see mobile/android/app/build.gradle:
# the Play bundle ships each device only its own ABI, but a direct download has
# to run on whatever phone fetched it, so the debug type carries arm64-v8a AND
# armeabi-v7a. Do not "fix" this to assembleRelease without re-reading that
# comment and re-testing on a 32-bit handset.
#
# WHY THE FILENAME CARRIES THE VERSION. app/download/.htaccess is INERT on this
# host (nginx serves static files before Apache sees it), so the APK's 4-hour
# max-age cannot be shortened from this repo. A URL that has never held older
# bytes is the only reliable cache defence. Never reuse a name.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
BUMP=0; DEPLOY=0
for a in "$@"; do
  case "$a" in
    --bump) BUMP=1 ;;
    --deploy) DEPLOY=1 ;;
    *) echo "usage: $0 [--bump] [--deploy]"; exit 2 ;;
  esac
done

export JAVA_HOME="$HOME/android/jdk21"
export ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"

node --check app/native.js || exit 1
node --check app/app.js    || exit 1

if [ "$BUMP" = 1 ]; then
  echo "== asking Play for the next versionCode =="
  node scripts/play_next_version.mjs --app lite --write || exit 1
fi

echo "== cap sync =="
cd "$ROOT/mobile" || exit 1
npx cap sync android 2>&1 | tail -2

# Web-only payloads the native shell never loads, plus anything app/ carries for
# the WEBSITE to serve. cap sync copies webDir wholesale, so without these the
# APK ends up containing a complete copy of itself (31 MB -> 54 MB, seen 2026-08).
rm -rf android/app/src/main/assets/public/vendor/tesseract
rm -f  android/app/src/main/assets/public/opencv.js
rm -rf android/app/src/main/assets/public/download
rm -rf android/app/src/main/assets/public/play-shots
rm -rf android/app/src/main/assets/public/ios-shots
rm -f  android/app/src/main/assets/public/play-feature-graphic.png

cd android || exit 1
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew

# ONE invocation, so the bundle and the APK cannot come from different trees.
# --max-workers=2: a release bundle runs R8 and resource shrinking, and this VM
# has 12 GB. The native AAB died two runs in three without this cap.
echo "== gradle bundleRelease + assembleDebug =="
./gradlew --no-daemon --no-watch-fs --console=plain --max-workers=2 \
  bundleRelease assembleDebug 2>&1 \
  | grep -avE "Unzipping|Download.*%|EXCLUDE_TELEMETRY|^\s*$" | tail -18

AAB="$ROOT/mobile/android/app/build/outputs/bundle/release/app-release.aab"
APK="$ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$AAB" ] || { echo "FAIL: no AAB at $AAB"; exit 1; }
[ -f "$APK" ] || { echo "FAIL: no APK at $APK"; exit 1; }

# ANCHOR TO THE DECLARATION, NOT THE WORD. `grep -m1 versionCode` matched the
# COMMENT above it ("// 2026-08-31 - Play rejects a duplicate versionCode ...")
# and pulled the YEAR out of that date: the first run of this script produced
# hawkeye-1.2-2026-<sha>.apk. Require start-of-line and a value straight after.
VN=$(grep -m1 -E '^[[:space:]]*versionName[[:space:]]+"' "$ROOT/mobile/android/app/build.gradle" | cut -d'"' -f2)
VC=$(grep -m1 -E '^[[:space:]]*versionCode[[:space:]]+[0-9]+' "$ROOT/mobile/android/app/build.gradle" | grep -oE '[0-9]+')
[ -n "$VN" ] && [ -n "$VC" ] || { echo "FAIL: could not read version from build.gradle"; exit 1; }
SHA=$(sha256sum "$APK" | cut -c1-8)
# NAME CARRIES A CONTENT HASH, not just the version. The old scheme was
# hawkeye-<name>-<serial>.apk where the serial was a per-rebuild counter kept
# nowhere — so hawkeye-1.2-4.apk through -8.apk all exist, and versionCode is
# still 4. Deriving the name from versionCode alone would have RE-USED
# hawkeye-1.2-4.apk, a URL that already held different bytes in August, which is
# the one thing app/download/.htaccess says must never happen. A content hash
# changes exactly when the bytes change and can never collide with a past build.
NAME="hawkeye-$VN-$VC-$SHA.apk"
DEST="$ROOT/app/download/$NAME"

cp "$APK" "$DEST" || exit 1
MB=$(( ( $(stat -c%s "$DEST") + 524288 ) / 1048576 ))
cp "$APK" /mnt/c/Users/HP/Downloads/hawkeye-debug.apk 2>/dev/null

# BOTH pages link the APK — download.html and index.html's install dialog. They
# drifted apart before precisely because updating one was a manual step.
for f in "$ROOT/app/download.html" "$ROOT/app/index.html"; do
  sed -i -E "s#download/hawkeye-[0-9a-f._-]+[.]apk#download/$NAME#g" "$f"
  sed -i -E "s#download=\"hawkeye-[0-9a-f._-]+\.apk\"#download=\"$NAME\"#g" "$f"
done
# The stated size, in both the chip on download.html and the sentence in index.
sed -i -E "s#(<span class=\"dl-size-plat\">Android</span> )[0-9]+(&nbsp;MB)#\1${MB}\2#" "$ROOT/app/download.html"
sed -i -E "s#^([[:space:]]*<p class=\"pwa-note\">)[0-9]+&nbsp;MB#\1${MB}\&nbsp;MB#" "$ROOT/app/index.html"

echo
echo "  version : $VN ($VC)"
echo "  AAB     : $(du -h "$AAB" | cut -f1)  $AAB"
echo "  APK     : $(du -h "$DEST" | cut -f1)  app/download/$NAME"
echo "  linked  : $(grep -c "$NAME" "$ROOT/app/download.html" "$ROOT/app/index.html" | tr '\n' ' ')"

if [ "$DEPLOY" = 1 ]; then
  echo "== deploying APK + pages =="
  cd "$ROOT" || exit 1
  scripts/deploy_app.sh "app/download/$NAME" app/download.html app/index.html || exit 1
  echo "== verifying the live link resolves =="
  code=$(curl -s -o /dev/null -w '%{http_code}' -I "https://hawkeye.com.ng/download/$NAME")
  size=$(curl -s -o /dev/null -w '%{size_download}' "https://hawkeye.com.ng/download/$NAME")
  local_size=$(stat -c%s "$DEST")
  echo "  HTTP $code   served ${size}B vs local ${local_size}B"
  if [ "$code" = "200" ] && [ "$size" = "$local_size" ]; then echo "  APK LIVE AND COMPLETE"
  else echo "  FAIL: served bytes do not match — do NOT announce this build"; exit 1; fi
fi
echo "=== DONE ==="

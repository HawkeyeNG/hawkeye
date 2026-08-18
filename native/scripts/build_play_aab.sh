#!/usr/bin/env bash
# Build the Play Store AAB for the native app.
#
# Distinct from build_team_apk.sh in four ways that all matter:
#   package   ng.com.hawkeye.observer  (not .dev) — the listing's identity
#   Maps key  GOOGLE_MAPS_API_KEY_PROD, switched with the package by
#             app.config.js so the two cannot drift apart
#   signing   the UPLOAD keystore, not debug
#   ABIs      ALL of them. The team APK drops to arm64 to stay small, which is
#             right for a file people sideload and WRONG here: Play splits an
#             AAB per device itself, so restricting architectures does not
#             shrink anyone's download, it just makes the app uninstallable on
#             the devices left out.
#
# Secrets are read from ~/hawkeye-secrets at build time and handed to gradle as
# properties. They are never written into the repo and never printed.
set -uo pipefail

cd "$(dirname "$0")/.."
SECRETS="${HAWKEYE_SECRETS:-$HOME/hawkeye-secrets}"
NOTE="$SECRETS/keystore-password.txt"
LOG=/tmp/gradle_play_aab.log
OUT_DIR="$(pwd)/android/app/build/outputs/bundle/release"

# The toolchain the other two builds proved out on this host.
export JAVA_HOME="$HOME/android/jdk21"
export ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"
# This host preloads Datadog's APM injector system-wide, attaching a java agent
# to every JVM. Its -Xshare warning lands on the stderr of AGP's CMake configure
# task, and AGP fails any task that writes to stderr.
export DD_TRACE_ENABLED=false DD_PROFILING_ENABLED=false DD_INJECTION_ENABLED=false

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

step "Preflight"
[ -x "$JAVA_HOME/bin/java" ] || die "no JDK at $JAVA_HOME"
[ -d "$ANDROID_HOME" ] || die "no Android SDK at $ANDROID_HOME"
echo "  jdk       : $("$JAVA_HOME/bin/java" -version 2>&1 | head -1)"
[ -f "$NOTE" ] || die "no keystore note at $NOTE"
# `field name` pulls one value out of the note without ever echoing it.
field() { sed -n "s/^$1:[[:space:]]*//p" "$NOTE" | head -1; }
KS_FILE=$(field file); KS_ALIAS=$(field alias); KS_PASS=$(field password)
case "$KS_FILE" in /*) ;; *) KS_FILE="$SECRETS/$KS_FILE" ;; esac
[ -f "$KS_FILE" ] || die "keystore not found at the path in the note"
[ -n "$KS_ALIAS" ] && [ -n "$KS_PASS" ] || die "alias or password missing from the note"
echo "  keystore  : found ($(basename "$KS_FILE")), alias ${KS_ALIAS:0:2}***"
[ -f .env.local ] && grep -q '^GOOGLE_MAPS_API_KEY_PROD=' .env.local \
  || die "GOOGLE_MAPS_API_KEY_PROD not set in native/.env.local"
echo "  prod maps : present"

VC=$(node -p "require('./app.json').expo.android.versionCode")
VN=$(node -p "require('./app.json').expo.version")
echo "  version   : $VN (versionCode $VC)"
[ "$VC" -ge 5 ] || die "versionCode $VC would be rejected — the live listing is at 4"

step "Prebuild (production variant)"
# --clean because the tree normally holds a .dev build: a stale android/ would
# keep the old applicationId and the dev Maps key. It is also what regenerates
# the launcher icons from assets/images/android-icon-foreground.png.
APP_VARIANT=production npx expo prebuild --platform android --no-install --clean 2>&1 | tail -4

PKG=$(grep -m1 'applicationId' android/app/build.gradle | sed "s/.*'\(.*\)'.*/\1/")
[ "$PKG" = "ng.com.hawkeye.observer" ] || die "applicationId is $PKG, expected ng.com.hawkeye.observer"
grep -q 'HAWKEYE_UPLOAD_STORE_FILE' android/app/build.gradle \
  || die "the signing plugin did not apply — this build would carry the DEBUG key"
grep -q "versionCode $VC" android/app/build.gradle \
  || die "versionCode did not reach build.gradle"
echo "  package   : $PKG"
echo "  signing   : upload config injected"
echo "  maps key  : $(grep -c 'com.google.android.geo.API_KEY' android/app/src/main/AndroidManifest.xml) manifest entry"

# Guard: react-native-compressor pulls TAndroidLame, which declares
# allowBackup="true"; ours is "false" and the merger aborts without a
# tools:replace. The config plugin adds it, but prebuild has proven flaky about
# re-applying manifest mods, so this makes it deterministic. Idempotent.
MANIFEST="android/app/src/main/AndroidManifest.xml"
if grep -q 'android:allowBackup="false"' "$MANIFEST" \
   && ! grep -q 'tools:replace="[^"]*android:allowBackup' "$MANIFEST"; then
  sed -i 's/\(<application [^>]*android:allowBackup="false"\)/\1 tools:replace="android:allowBackup"/' "$MANIFEST"
  echo "  manifest  : injected tools:replace=android:allowBackup"
fi
# Guard: the same prebuild flakiness loses the SPLASH mod, and the build then
# dies seven minutes in on a missing drawable.
[ -f android/app/src/main/res/drawable-hdpi/splashscreen_logo.png ] \
  || die "splashscreen_logo missing after prebuild — re-run, the mod did not apply"

step "Bundle (this takes a while)"
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew
# Stamp first: a gradle failure leaves any PREVIOUS bundle sitting in the output
# directory, and reporting that one as the build's result would ship a stale AAB.
STAMP=/tmp/aab_start.$$
touch "$STAMP"
./gradlew --no-daemon --no-watch-fs --console=plain \
  -Pandroid.enableMinifyInReleaseBuilds=true \
  -Pandroid.enableShrinkResourcesInReleaseBuilds=true \
  -Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=512m -Xshare:off" \
  -PHAWKEYE_UPLOAD_STORE_FILE="$KS_FILE" \
  -PHAWKEYE_UPLOAD_STORE_PASSWORD="$KS_PASS" \
  -PHAWKEYE_UPLOAD_KEY_ALIAS="$KS_ALIAS" \
  -PHAWKEYE_UPLOAD_KEY_PASSWORD="$KS_PASS" \
  bundleRelease > "$LOG" 2>&1
GRADLE=$?
cd ..
if [ $GRADLE -ne 0 ]; then
  echo "--- the part of $LOG that says why ---"
  grep -E -A6 'FAILURE|What went wrong|error:|Caused by' "$LOG" | head -40
  die "gradle exited $GRADLE (full log: $LOG)"
fi
tail -3 "$LOG"

step "Verify the artefact"
AAB=$(find "$OUT_DIR" -name '*.aab' -newer "$STAMP" 2>/dev/null | head -1)
[ -n "${AAB:-}" ] || die "no .aab newer than this run — gradle reported success but produced nothing"
echo "  file      : $AAB"
echo "  size      : $(du -h "$AAB" | cut -f1)"

# WHO SIGNED IT. A debug-signed bundle is the one failure this script exists to
# prevent, and it is invisible unless asked.
SUBJECT=$(keytool -printcert -jarfile "$AAB" 2>/dev/null | sed -n 's/^Owner: //p' | head -1)
SHA=$(keytool -printcert -jarfile "$AAB" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -1)
echo "  signed by : ${SUBJECT:-unknown}"
echo "  cert SHA256: ${SHA:-unknown}"
case "$SUBJECT" in
  *Android\ Debug*) die "SIGNED WITH THE DEBUG KEY — do not upload this" ;;
  '') die "could not read a certificate from the bundle — do not upload it" ;;
esac

# Copy where Windows can reach it for the Console upload.
DEST="/mnt/c/Users/HP/Downloads/$(basename "$AAB" .aab)-v$VN-$VC.aab"
if cp "$AAB" "$DEST" 2>/dev/null; then echo "  copied to : $DEST"; fi

cat <<DONE

Next, by hand:
  1. Play Console -> Test and release -> Production -> Create new release
  2. Upload the .aab above (versionCode $VC)
  3. BEFORE rolling out, confirm the map works on a real install. The prod Maps
     key must be restricted to ng.com.hawkeye.observer + PLAY'S app-signing
     SHA-1 (Console -> Test and release -> App signing), NOT the upload key's
     printed above. Bound to the upload cert it works in a local build and
     shows a blank grey map to every real user.
  4. The short description edit staged in the Console goes out with this release.
DONE

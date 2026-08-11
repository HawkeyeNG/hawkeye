#!/bin/bash
# Build the Hawkeye NATIVE (Expo/RN) dev-client debug APK headlessly in WSL,
# same JDK21/SDK36 toolchain the Capacitor app proved out. Copies the result to
# Windows Downloads. Log: /tmp/native_apk.log
exec > /tmp/native_apk.log 2>&1
set -e
export JAVA_HOME="$HOME/android/jdk21"
export ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"
# This host preloads Datadog's APM injector system-wide, attaching a java agent
# to every JVM. Its -Xshare warning lands on the stderr of AGP's CMake configure
# task, and AGP fails any task that writes to stderr.
export DD_TRACE_ENABLED=false DD_PROFILING_ENABLED=false DD_INJECTION_ENABLED=false

cd "$HOME/hawkeye/native"
# Keep the generated project in sync with app.json / plugin changes.
npx expo prebuild --platform android --no-install 2>&1 | tail -3

# Guard: the same prebuild flakiness that loses the manifest mod (below) also
# loses the SPLASH mod. When it does, styles.xml still points at
# @drawable/splashscreen_logo while the density folders are empty, and the build
# dies late in mergeDebugResources with "resource drawable/splashscreen_logo not
# found" — 7 minutes in, for a missing PNG. expo-splash-screen only writes those
# files on a fresh native dir, so a re-run with --clean is the only fix.
if [ ! -f android/app/src/main/res/drawable-hdpi/splashscreen_logo.png ]; then
  echo "splash guard: splashscreen_logo missing after prebuild — re-running with --clean"
  npx expo prebuild --platform android --no-install --clean 2>&1 | tail -3
fi

# Guard: react-native-compressor pulls TAndroidLame, which declares
# allowBackup="true"; ours is "false" and the merger aborts without a
# tools:replace. The config plugin (plugins/with-allow-backup-override) adds it,
# but `expo prebuild` has proven flaky about re-applying manifest mods across
# consecutive runs, so this makes the override deterministic right before gradle.
# Idempotent: only patches when allowBackup is present but the replace is not.
MANIFEST="android/app/src/main/AndroidManifest.xml"
if grep -q 'android:allowBackup="false"' "$MANIFEST" \
   && ! grep -q 'tools:replace="[^"]*android:allowBackup' "$MANIFEST"; then
  sed -i 's/\(<application [^>]*android:allowBackup="false"\)/\1 tools:replace="android:allowBackup"/' "$MANIFEST"
  echo "manifest guard: injected tools:replace=android:allowBackup"
fi
grep -o '<application[^>]*allowBackup[^>]*' "$MANIFEST" | head -1

cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew
# arm64-v8a ONLY. A four-ABI debug APK is ~314 MB and three of those ABIs are
# dead weight on a real phone — this drops it to ~100-130 MB with no behaviour
# change. Re-add armeabi-v7a for a pre-2018 device, or x86_64 for an emulator.
# NOT minified on purpose: R8 renames the classes expo-dev-client looks up
# reflectively, so a minified dev build fails to launch and loses stack traces.
APK="app/build/outputs/apk/debug/app-debug.apk"
# Stamp before building: a gradle failure leaves the PREVIOUS apk sitting here,
# and copying that one out reports success while shipping a stale build.
STAMP=/tmp/dev_apk_start.$$
touch "$STAMP"

set +e
./gradlew --no-daemon --no-watch-fs --console=plain -PreactNativeArchitectures=arm64-v8a -Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=512m -Xshare:off" assembleDebug 2>&1 | tail -20
GRADLE=${PIPESTATUS[0]}
set -e
echo "gradle_exit=$GRADLE"
[ "$GRADLE" -eq 0 ] || { echo "GATE_FAIL: gradle exited $GRADLE"; exit 1; }

# `| tail` makes $? the status of tail, so `set -e` cannot see gradle fail —
# this is exactly how a team APK once shipped as the unmodified RN template.
# Hence PIPESTATUS above, and freshness + identity checks below.
if [ ! -f "$APK" ]; then echo "APK_MISSING"; exit 1; fi
if [ ! "$APK" -nt "$STAMP" ]; then
  echo "GATE_FAIL: $APK is older than this build — stale artifact, not rebuilt"
  exit 1
fi
rm -f "$STAMP"

# Identity: the dev build MUST stay the .dev package. The Google Maps key is
# registered against that package plus the debug SHA-1, so a build that came out
# as the production variant (or as the bare RN template) blanks every map.
BADGING=$("$ANDROID_HOME/build-tools/35.0.0/aapt2" dump badging "$APK" 2>/dev/null | head -3)
echo "$BADGING"
echo "$BADGING" | grep -q "ng.com.hawkeye.observer.dev" || {
  echo "GATE_FAIL: wrong package — expected ng.com.hawkeye.observer.dev"; exit 1; }

cp "$APK" /mnt/c/Users/HP/Downloads/hawkeye-native-dev.apk
ls -la /mnt/c/Users/HP/Downloads/hawkeye-native-dev.apk
echo "APK_OK"
echo "=== DONE $(date +%T) ==="

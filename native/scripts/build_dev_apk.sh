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
./gradlew --no-daemon --console=plain -Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=512m -Xshare:off" assembleDebug 2>&1 | tail -20

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  cp "$APK" /mnt/c/Users/HP/Downloads/hawkeye-native-dev.apk
  ls -la /mnt/c/Users/HP/Downloads/hawkeye-native-dev.apk
  echo "APK_OK"
else
  echo "APK_MISSING"
fi
echo "=== DONE $(date +%T) ==="

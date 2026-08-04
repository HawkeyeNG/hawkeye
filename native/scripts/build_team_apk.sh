#!/bin/bash
# Build the Hawkeye NATIVE (Expo/RN) TEAM-TEST APK — release, arm64-only, minified +
# resource-shrunk (~76 MB, vs the ~300 MB dev-client debug build). It is signed with
# the DEBUG keystore on purpose (android/app/build.gradle release{} -> signingConfigs.debug),
# so the package stays ng.com.hawkeye.observer.dev — the one the dev Google Maps key
# is registered against. Do NOT set APP_VARIANT=production or maps go blank.
# Copies the result to Windows Downloads. Log: /tmp/team_apk.log
exec > /tmp/team_apk.log 2>&1
set -e
export JAVA_HOME="$HOME/android/jdk21"
export ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"
# Neutralise Datadog's system-wide APM injector: its -Xshare JVM warning lands on the
# stderr of AGP's CMake configure task, and AGP fails any task that writes to stderr.
# The env vars cover an active injector; the guarded pause covers a repopulated
# /etc/ld.so.preload (currently empty, so this branch is skipped and no sudo runs).
export DD_TRACE_ENABLED=false DD_PROFILING_ENABLED=false DD_INJECTION_ENABLED=false
if [ -s /etc/ld.so.preload ]; then
  sudo cp /etc/ld.so.preload /etc/ld.so.preload.tb && sudo truncate -s 0 /etc/ld.so.preload && echo PRELOAD_PAUSED
fi

cd "$HOME/hawkeye/native"
# Keep the generated android/ project in sync with app.config.js / plugin changes.
npx expo prebuild --platform android --no-install 2>&1 | tail -3

# Guard: react-native-compressor pulls TAndroidLame, which declares
# allowBackup="true"; ours is "false" and the manifest merger aborts without a
# tools:replace. The config plugin adds it, but `expo prebuild` is flaky about
# re-applying manifest mods across runs, so this makes it deterministic. Idempotent.
MANIFEST="android/app/src/main/AndroidManifest.xml"
if grep -q 'android:allowBackup="false"' "$MANIFEST" \
   && ! grep -q 'tools:replace="[^"]*android:allowBackup' "$MANIFEST"; then
  sed -i 's/\(<application [^>]*android:allowBackup="false"\)/\1 tools:replace="android:allowBackup"/' "$MANIFEST"
  echo "manifest guard: injected tools:replace=android:allowBackup"
fi

cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew
# What makes it small, in order of impact:
#   -PreactNativeArchitectures=arm64-v8a        drop 3 of 4 native ABIs
#   -Pandroid.enableMinifyInReleaseBuilds=true   R8/ProGuard (proguard-rules.pro exists)
#   -Pandroid.enableShrinkResourcesInReleaseBuilds=true   strip unused resources
# --no-watch-fs: without it gradle throws "Cannot start managing file contention"
# on the WSL/NTFS mount and dies at "32 up-to-date".
./gradlew --no-daemon --no-watch-fs --console=plain \
  -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.enableMinifyInReleaseBuilds=true \
  -Pandroid.enableShrinkResourcesInReleaseBuilds=true \
  -Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=512m -Xshare:off" \
  assembleRelease 2>&1 | tail -20

APK="app/build/outputs/apk/release/app-release.apk"
if [ -f "$APK" ]; then
  cp "$APK" /mnt/c/Users/HP/Downloads/hawkeye-team-test.apk
  ls -la /mnt/c/Users/HP/Downloads/hawkeye-team-test.apk
  echo "APK_OK"
else
  echo "APK_MISSING"
fi
# Restore the Datadog preload if we paused it.
if [ -f /etc/ld.so.preload.tb ]; then
  sudo cp /etc/ld.so.preload.tb /etc/ld.so.preload && sudo rm -f /etc/ld.so.preload.tb && echo PRELOAD_RESTORED
fi
echo "=== DONE $(date +%T) ==="

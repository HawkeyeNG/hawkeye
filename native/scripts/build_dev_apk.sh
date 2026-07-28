#!/bin/bash
# Build the Hawkeye NATIVE (Expo/RN) dev-client debug APK headlessly in WSL,
# same JDK21/SDK36 toolchain the Capacitor app proved out. Copies the result to
# Windows Downloads. Log: /tmp/native_apk.log
exec > /tmp/native_apk.log 2>&1
set -e
export JAVA_HOME="$HOME/android/jdk21"
export ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"

cd "$HOME/hawkeye/native"
# Keep the generated project in sync with app.json / plugin changes.
npx expo prebuild --platform android --no-install 2>&1 | tail -3

cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew
./gradlew --no-daemon --console=plain assembleDebug 2>&1 | tail -20

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  cp "$APK" /mnt/c/Users/HP/Downloads/hawkeye-native-dev.apk
  ls -la /mnt/c/Users/HP/Downloads/hawkeye-native-dev.apk
  echo "APK_OK"
else
  echo "APK_MISSING"
fi
echo "=== DONE $(date +%T) ==="

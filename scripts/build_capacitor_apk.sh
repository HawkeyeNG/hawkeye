#!/bin/bash
# Rebuild the Hawkeye debug APK (Capacitor 8 toolchain: JDK 21, SDK 36,
# project gradlew 8.14). Copies result to Windows Downloads.
exec > /tmp/rebuild_apk.log 2>&1
export JAVA_HOME="$HOME/android/jdk21"
export ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"
node --check "$HOME/hawkeye/app/native.js" || exit 1
node --check "$HOME/hawkeye/app/app.js" || exit 1
cd "$HOME/hawkeye/mobile" || exit 1
npx cap sync android 2>&1 | tail -2
# Web-only helpers the NATIVE shell never loads — it uses ML Kit for the doc
# scanner and OCR, so opencv.js (~13 MB) and Tesseract (~14 MB) are dead weight
# inside the APK. Strip both (the web build keeps them).
rm -rf android/app/src/main/assets/public/vendor/tesseract
rm -f android/app/src/main/assets/public/opencv.js
# app/download/ hosts the Android APK for the website's "Download the Android
# App" link. webDir is ../app, so cap sync happily copies that 31 MB APK INTO
# this APK — the build went 31.6 MB -> 54.2 MB with a complete copy of itself at
# assets/public/download/hawkeye.apk. Anything added to app/ for the WEB to
# serve gets bundled here unless it is stripped.
rm -rf android/app/src/main/assets/public/download
cd android || exit 1
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew
./gradlew --no-daemon --console=plain assembleDebug 2>&1 | grep -avE "Unzipping|Download.*%|EXCLUDE_TELEMETRY|^\s*$" | tail -14
APK="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  cp "$APK" /mnt/c/Users/HP/Downloads/hawkeye-debug.apk
  # ALSO refresh the copy the WEBSITE serves. This was a manual step, so it kept
  # drifting behind — the public download sat two days stale while the local
  # build was current. It is stripped from the bundle before cap sync above, so
  # writing it here cannot end up inside the next APK.
  # NOTE the name: the site serves it as hawkeye.apk. Only this local test copy
  # carries the -debug suffix.
  cp "$APK" "$HOME/hawkeye/app/download/hawkeye.apk"
  ls -la /mnt/c/Users/HP/Downloads/hawkeye-debug.apk "$HOME/hawkeye/app/download/hawkeye.apk"; echo "APK_OK"
else echo "APK_MISSING"; fi
echo "=== DONE $(date +%T) ==="

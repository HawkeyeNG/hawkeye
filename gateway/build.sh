#!/usr/bin/env bash
# Builds the debug-signed gateway APK into build-out/hawkeye-callgate.apk.
# WSL/Linux, with the JDK and SDK the Lite build already uses
# (scripts/build_capacitor_apk.sh); override with JAVA_HOME / ANDROID_HOME.
#   bash gateway/build.sh
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$HOME/android/jdk21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android/sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
[ -x "$JAVA_HOME/bin/java" ] || { echo "no JDK at $JAVA_HOME" >&2; exit 1; }
[ -d "$ANDROID_HOME/platforms" ] || { echo "no Android SDK at $ANDROID_HOME" >&2; exit 1; }

# --no-watch-fs: Gradle's file watcher fails on WSL mounts. Two workers: a
# small app, and it leaves the machine for everything else.
bash ./gradlew --no-daemon --no-watch-fs --console=plain --max-workers=2 assembleDebug

mkdir -p build-out
cp app/build/outputs/apk/debug/app-debug.apk build-out/hawkeye-callgate.apk
ls -l build-out/hawkeye-callgate.apk

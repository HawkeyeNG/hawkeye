#!/bin/bash
# Team-test APK (release, arm64-only, minified + shrunk ~76MB) WITH a live progress
# bar driven by gradle task completion. Debug-signed (keeps the .dev package the
# Maps key needs). Copies to Windows Downloads. Do NOT set APP_VARIANT=production.
export JAVA_HOME="$HOME/android/jdk21"
export ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"
export DD_TRACE_ENABLED=false DD_PROFILING_ENABLED=false DD_INJECTION_ENABLED=false

cd "$HOME/hawkeye/native" || exit 1
echo "▶ [1/3] expo prebuild (sync android project)…"
if ! npx expo prebuild --platform android --no-install >/tmp/team_prebuild.log 2>&1; then
  echo "❌ prebuild FAILED"; tail -6 /tmp/team_prebuild.log; exit 1
fi
# Same splash guard as build_dev_apk.sh: prebuild sometimes drops the
# expo-splash-screen mod, leaving styles.xml pointing at a drawable that no
# longer exists, and the build then dies in mergeResources minutes later.
if [ ! -f android/app/src/main/res/drawable-hdpi/splashscreen_logo.png ]; then
  echo "▶ splash guard: splashscreen_logo missing — prebuild --clean"
  npx expo prebuild --platform android --no-install --clean >>/tmp/team_prebuild.log 2>&1
fi
M=android/app/src/main/AndroidManifest.xml
if grep -q 'android:allowBackup="false"' "$M" && ! grep -q 'tools:replace="[^"]*android:allowBackup' "$M"; then
  sed -i 's/\(<application [^>]*android:allowBackup="false"\)/\1 tools:replace="android:allowBackup"/' "$M"
fi
cd android || exit 1
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew
echo "▶ [2/3] gradle assembleRelease — arm64 + R8 minify + resource shrink, no lintVital…"

# ~340 actionable tasks in this project; count "> Task :" lines for a rough %.
TOTAL=340
./gradlew --no-daemon --no-watch-fs --console=plain \
  -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.enableMinifyInReleaseBuilds=true \
  -Pandroid.enableShrinkResourcesInReleaseBuilds=true \
  \
  `# lintVital ran across ~30 Expo modules and took 34 of this build's 36` \
  `# minutes (2026-08-04). It is a fatal-severity gate for STORE releases, so` \
  `# it stays on in tmp/build_aab.sh (bundleRelease) — this APK only ever goes` \
  `# to the team by hand, so skip it here.` \
  -x lintVitalRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease \
  \
  assembleRelease 2>&1 | {
    n=0
    while IFS= read -r line; do
      case "$line" in
        "> Task "*)
          n=$((n+1)); p=$((n*100/TOTAL)); [ $p -gt 99 ] && p=99
          bars=$((p/4)); bar=$(printf '%*s' "$bars" '' | tr ' ' '#'); pad=$(printf '%*s' $((25-bars)) '')
          printf "\r  [%s%s] %3d%%  %-42.42s" "$bar" "$pad" "$p" "${line#> Task :}" ;;
        *"R8"*|*"minifyReleaseWithR8"*|*"shrinkReleaseRes"*)
          printf "\r  [#########################] ..  %-42.42s" "minifying (R8) — the slow one" ;;
        *"BUILD SUCCESSFUL"*)
          printf "\r  [#########################] 100%%  build successful%-26s\n" " " ;;
        *"BUILD FAILED"*|"FAILURE:"*)
          printf "\n  ❌ %s\n" "$line" ;;
      esac
    done
  }

echo "▶ [3/3] copying APK to Downloads…"
APK=app/build/outputs/apk/release/app-release.apk
if [ -f "$APK" ]; then
  cp "$APK" /mnt/c/Users/HP/Downloads/hawkeye-team-test.apk
  ls -la /mnt/c/Users/HP/Downloads/hawkeye-team-test.apk
  echo "✅ APK_OK — hawkeye-team-test.apk"
else
  echo "❌ APK_MISSING — see the gradle output above"; exit 1
fi

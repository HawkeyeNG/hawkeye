#!/bin/bash
# Hawkeye LITE — signed release AAB + APK for the ng.com.hawkeye.lite Play listing.
# Rebrand of the Capacitor build. Separate package + separate upload keystore
# from native. Lives here, NOT in the gitignored tmp/ it was written in: every
# gate below (ML Kit latin-only, the strip list, the download ceiling) is the
# only thing standing between Lite and a silent size regression, and none of it
# was in version control.
# Log: /tmp/build_aab_lite.log
exec > /tmp/build_aab_lite.log 2>&1
export JAVA_HOME="$HOME/android/jdk21" ANDROID_HOME="$HOME/android/sdk"
export PATH="$JAVA_HOME/bin:$PATH"
export DD_TRACE_ENABLED=false DD_PROFILING_ENABLED=false DD_INJECTION_ENABLED=false

node --check "$HOME/hawkeye/app/native.js" || exit 1
node --check "$HOME/hawkeye/app/app.js"    || exit 1
node --check "$HOME/hawkeye/app/menu.js"   || exit 1

cd "$HOME/hawkeye/mobile" || exit 1

# ML KIT MUST BE LATIN-ONLY, and this gate is why.
#
# @capacitor-mlkit/text-recognition declares text-recognition-{chinese,
# devanagari,japanese,korean} in its OWN build.gradle. Those four artifacts carry
# 2.4 MB of line-recognition models — Hani, Jpan, Kore, Beng, Deva — for scripts
# a Nigerian EC8A form is never written in. Hawkeye calls processImage({path})
# with no script argument, so it has only ever used the Latin default.
#
# patches/ + the postinstall hook remove them, but `npm install --no-scripts`, a
# lockfile refresh or a plugin bump would put them back, and NOTHING would look
# wrong: the app would work perfectly and the download would quietly be 2.4 MB
# heavier. So it is asserted here, where a release cannot get past it.
MLKIT_GRADLE=node_modules/@capacitor-mlkit/text-recognition/android/build.gradle
[ -f "$MLKIT_GRADLE" ] || { echo "GATE_FAIL: $MLKIT_GRADLE not found — did npm install run?"; exit 1; }
for s in chinese devanagari japanese korean; do
  grep -q "text-recognition-$s" "$MLKIT_GRADLE" && {
    echo "GATE_FAIL: ML Kit $s script pack is back — run 'npx patch-package' in mobile/ (adds ~2.4MB)"; exit 1; }
done
grep -q "com.google.mlkit:text-recognition:" "$MLKIT_GRADLE" || {
  echo "GATE_FAIL: the LATIN ML Kit artifact is missing — OCR would not work at all"; exit 1; }
echo "  ok: ML Kit is latin-only"

npx cap sync android 2>&1 | tail -2

# ---------------------------------------------------------------------------
# @capacitor-firebase/messaging IS FOR iOS ONLY. IT MUST NOT REACH ANDROID.
#
# Not a size decision — it costs nothing measurable here (9.77 MB either way,
# because @capacitor/push-notifications already pulls firebase-messaging). It is
# a CORRECTNESS one. Both plugins declare a service filtering the same intent:
#
#   @capacitor/push-notifications   com.capacitorjs.plugins.pushnotifications.MessagingService
#   @capacitor-firebase/messaging   io.capawesome…firebase.messaging.MessagingService
#                                   both: com.google.firebase.MESSAGING_EVENT
#
# Firebase delivers to ONE of them. With both present, messages can go to the
# service app/native.js never listens to — and Android Lite is LIVE on Play, so
# the failure would be silent push loss on a shipping app. iOS needs the plugin
# because @capacitor/push-notifications returns an APNs token there while the
# backend sends via FCM; Android has no such problem.
#
# Cut from all THREE files cap sync writes, then asserted below.
# ---------------------------------------------------------------------------
node -e '
  const fs = require("fs");
  const p = "android/app/src/main/assets/capacitor.plugins.json";
  const before = JSON.parse(fs.readFileSync(p, "utf8"));
  const after = before.filter((x) => !String(x.pkg).startsWith("@capacitor-firebase/"));
  fs.writeFileSync(p, JSON.stringify(after, null, 2) + "\n");
  console.log("  android plugins: " + before.length + " -> " + after.length);
' || exit 1
sed -i "/capacitor-firebase-messaging/d" android/capacitor.settings.gradle
sed -i "/capacitor-firebase-messaging/d" android/app/capacitor.build.gradle

for f in android/capacitor.settings.gradle android/app/capacitor.build.gradle \
         android/app/src/main/assets/capacitor.plugins.json; do
  grep -qi 'capacitor-firebase\|@capacitor-firebase' "$f" && {
    echo "GATE_FAIL: @capacitor-firebase survived in $f — Android push would break silently"; exit 1; }
done
# ...and the one that must still be there, so the cut above cannot take the
# wrong plugin and pass by removing everything.
grep -q 'pushnotifications.PushNotificationsPlugin' android/app/src/main/assets/capacitor.plugins.json \
  || { echo "GATE_FAIL: @capacitor/push-notifications is gone — Android would have no push at all"; exit 1; }
echo "  ok: firebase messaging excluded from android, push-notifications intact"

# The strip list and the web-asset gates now live in scripts/strip_web_assets.sh,
# because iOS syncs from the same webDir and needs every one of them. They were
# 160 lines of this file; a second copy for iOS would have passed on the day it
# was written and drifted from this one by the next release.
PUB="android/app/src/main/assets/public"
bash scripts/strip_web_assets.sh "$PUB" android/app/src/main/assets/capacitor.plugins.json || exit 1

# --- LITE identity gates ---
grep -q 'applicationId "ng.com.hawkeye.lite"' android/app/build.gradle || { echo "GATE_FAIL: applicationId is not ng.com.hawkeye.lite"; exit 1; }
# A FLOOR, not an equality — and read, not grepped for.
#
# This was `grep -q "versionCode 1"`, which had two faults. It pinned Lite to
# release 1 forever, so the first real update failed its own build; and being a
# substring match it would have accepted "versionCode 12" as "1" anyway. The
# native script already does it this way (build_play_aab.sh) — same shape here.
#
# Bump the floor WITH the versionCode, every release. A guard naming the release
# before last has quietly stopped guarding anything.
# COMMENTS STRIPPED FIRST. Without that, a comment above the declaration that
# happens to mention a number wins — the note explaining "release 1 is in review"
# sits directly above `versionCode 2` and made this read 1 and fail the build.
LITE_VC=$(grep -v '^\s*//' android/app/build.gradle | grep -oP 'versionCode\s+\K[0-9]+' | head -1)
[ -n "$LITE_VC" ] || { echo "GATE_FAIL: could not read versionCode from build.gradle"; exit 1; }
[ "$LITE_VC" -ge 3 ] || { echo "GATE_FAIL: versionCode $LITE_VC would be rejected — 2 is LIVE on Play (published 2026-08-27)"; exit 1; }
echo "  ok: versionCode $LITE_VC"
grep -q "Hawkeye Lite" android/app/src/main/res/values/strings.xml || { echo "GATE_FAIL: app label is not Hawkeye Lite"; exit 1; }
grep -q "/open" android/app/src/main/AndroidManifest.xml && { echo "GATE_FAIL: /open App Link filter still present (native owns it)"; exit 1; }
# push: google-services.json must carry the lite package or the FCM SDK is dead
if grep -q "ng.com.hawkeye.lite" android/app/google-services.json 2>/dev/null; then
  echo "  ok: FCM client present for ng.com.hawkeye.lite"
else
  echo "GATE_FAIL: google-services.json has no ng.com.hawkeye.lite client (push chosen ON)"; exit 1
fi
# lite upload keystore wired
grep -q "hawkeye-lite-release.keystore" android/keystore.properties || { echo "GATE_FAIL: keystore.properties not pointing at the lite keystore"; exit 1; }
# GATE: no register packs may ship. They cannot be read from the bundle (see
# above), so anything here is dead weight at best and a frozen register at worst.
if [ -d "$PUB/reg" ]; then
  echo "GATE_FAIL: $PUB/reg still exists — the register must be fetched, not bundled"
  exit 1
fi
echo "  ok: register not bundled (fetched on first run)"

echo "GATE_OK: lite identity + compliance + size sane"

cd android || exit 1
echo "sdk.dir=$ANDROID_HOME" > local.properties
chmod +x ./gradlew
./gradlew --no-daemon --no-watch-fs --console=plain bundleRelease assembleRelease 2>&1 \
  | grep -avE "Unzipping|Download.*%|EXCLUDE_TELEMETRY|^[[:space:]]*$" | tail -18
echo "gradle_exit=${PIPESTATUS[0]}"

AAB="app/build/outputs/bundle/release/app-release.aab"
APK="app/build/outputs/apk/release/app-release.apk"
BT="$ANDROID_HOME/build-tools/35.0.0"
DL="/mnt/c/Users/HP/Downloads"

if [ -f "$AAB" ]; then
  cp "$AAB" "$DL/hawkeye-lite-release.aab"; ls -la "$DL/hawkeye-lite-release.aab"
  echo "--- ABIs (armeabi-v7a must be present) ---"; unzip -l "$AAB" | grep -oE 'lib/[a-z0-9_-]+/' | sort -u

  # WHAT A PHONE ACTUALLY DOWNLOADS — and a ceiling on it.
  #
  # Neither the AAB's own size nor the universal APK's is the number that
  # matters: Play splits by ABI and density, so an arm64 phone gets roughly
  # (everything ABI-neutral) + (lib/arm64-v8a) + (one density bucket). That
  # estimate landed within 1% of the 13.7 MB Play reported for release 1, which
  # is why it is trustworthy enough to gate on.
  #
  # Lite exists FOR small phones on metered data. Without a ceiling the size can
  # only drift upward — one bundled model, one un-stripped folder at a time —
  # and nobody would notice until Play printed a bigger number after upload.
  echo "--- estimated per-device download (arm64-v8a, xxhdpi) ---"
  python3 - "$AAB" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
DENS = ("ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi")
KEEP_DENS, cats, total = "xxhdpi", {}, 0
for i in z.infolist():
    n = i.filename
    if not n.startswith("base/"):
        continue                      # BUNDLE-METADATA/META-INF never ship
    p = n[len("base/"):]
    if p.startswith("lib/"):
        abi = p.split("/")[1]
        if abi != "arm64-v8a":
            continue                  # other ABIs go to other phones
        cat = "native libs"
    elif p.startswith("res/"):
        d = p.split("/")[1]
        if any(d.endswith("-" + x) for x in DENS) and not d.endswith("-" + KEEP_DENS):
            continue                  # other density buckets
        cat = "android res"
    elif p.startswith("dex/"):
        cat = "dex"
    elif p.startswith("assets/public/"):
        cat = "web app"
    elif p.startswith("assets/"):
        cat = "other assets (ML Kit models)"
    else:
        cat = "manifest/arsc/misc"
    cats[cat] = cats.get(cat, 0) + i.compress_size
    total += i.compress_size
for k, v in sorted(cats.items(), key=lambda x: -x[1]):
    print("  %-30s %7.2f MB" % (k, v / 1e6))
print("  %-30s %7.2f MB" % ("ESTIMATED DOWNLOAD", total / 1e6))
open("/tmp/lite_download_bytes", "w").write(str(total))
PY
  EST=$(cat /tmp/lite_download_bytes 2>/dev/null || echo 0)
  # 10 MB. Release 1 shipped at 13.7; this build measures 9.68, so the ceiling
  # sits ~330 KB above it — room for ordinary content growth, and tight enough
  # that putting back any ONE of the things this script strips fails the build.
  # Move it DOWN as the app gets smaller, never up without saying why.
  if [ "$EST" -gt 10000000 ]; then
    echo "GATE_FAIL: estimated download $((EST / 1000000)) MB exceeds the 10 MB ceiling"
    echo "  Lite is FOR small phones on metered data — find the regression, do not raise the gate."
    exit 1
  fi
  echo "  ok: under the 10 MB ceiling"
  echo "--- AAB signer (must be hawkeye-lite / CN=Hawkeye Lite) ---"
  "$JAVA_HOME/bin/keytool" -printcert -jarfile "$AAB" 2>&1 | grep -E "Owner:|SHA256:" | head -2
  echo "AAB_OK"
else echo "AAB_MISSING"; fi

if [ -f "$APK" ]; then
  cp "$APK" "$DL/hawkeye-lite-release.apk"; ls -la "$DL/hawkeye-lite-release.apk"
  "$BT/aapt2" dump badging "$APK" 2>/dev/null | grep -E "^package:|application-label:|launchable-activity:" | head -3
  echo "APK_OK"
else echo "APK_MISSING"; fi
echo "=== DONE $(date +%T) ==="

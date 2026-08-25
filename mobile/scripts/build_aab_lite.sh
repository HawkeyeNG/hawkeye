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

PUB="android/app/src/main/assets/public"
rm -rf "$PUB/vendor/tesseract" "$PUB/download" "$PUB/play-shots" "$PUB/ios-shots"
rm -f  "$PUB/opencv.js" "$PUB/play-feature-graphic.png" "$PUB/nga_wards.geojson"

# ---------------------------------------------------------------------------
# DEAD WEIGHT — measured, not guessed. Every path below was checked for a
# reference across the whole of app/ before it was added here; the counts are in
# the comments. Nothing here is a judgement call about what Lite "needs" — these
# are files nothing asks for, or files a WebView cannot use.
#
#   senate_map.png          0 references anywhere in app/
#   email-banner.png        0 references — it is the Roundcube signature banner,
#                           served off the WEBSITE by absolute URL. Stays on the
#                           site; has no business in an APK.
#   logos/sources.json      0 references — a provenance record (party site URL +
#                           a base64 copy of each emblem). Kept in the repo for
#                           audit, never read at runtime.
#   icon-512*.png           referenced ONLY by manifest.webmanifest, and a
#                           Capacitor WebView never consumes a web app manifest —
#                           the launcher icon comes from res/mipmap. icon-192.png
#                           is NOT in this list: menu.js and native.js use it.
#   fonts/lora-*.woff2      0 references; styles.css names Lora in a COMMENT
#                           only, there is no @font-face for it. Dead on the
#                           website too, and the two files are identical.
#   fonts/inter-{5,6,7}00   byte-identical to inter-400 (same md5); styles.css
#                           now points all four weights at the 400 file.
#   logos/{AA,APGA,LP,ZLP}.png  the manifest names the .jpg for all four. The
#                           three 65 KB PNGs are the same file three times.
#   photos/candidates/…     adebayo/datti/jonathan are referenced only by their
#                           own manifest.json, which nothing reads.
#                           political_data.json names tinubu/atiku/obi only.
# ---------------------------------------------------------------------------
rm -f "$PUB/senate_map.png" "$PUB/email-banner.png" "$PUB/logos/sources.json" \
      "$PUB/icon-512.png" "$PUB/icon-512-maskable.png" \
      "$PUB/fonts/lora-600.woff2" "$PUB/fonts/lora-700.woff2" \
      "$PUB/fonts/inter-500.woff2" "$PUB/fonts/inter-600.woff2" "$PUB/fonts/inter-700.woff2" \
      "$PUB/logos/AA.png" "$PUB/logos/APGA.png" "$PUB/logos/LP.png" "$PUB/logos/ZLP.png" \
      "$PUB/photos/candidates/adebayo.jpg" "$PUB/photos/candidates/datti.jpg" \
      "$PUB/photos/candidates/jonathan.jpg" "$PUB/photos/candidates/manifest.json"

# THE BIG THREE GEO LAYERS — 1.7 MB, fetched live instead of bundled.
#
# They draw the leaderboard's map, and EVERY FIGURE on that board comes from
# /api/national — so the screen they serve cannot render offline no matter what
# is in the APK. Shipping the geometry buys an outline for a board that would
# have no numbers on it.
#
# results.html:loadGeo and race.js:getGeo now go through native.js:fetchData,
# which off-origin fetches the live file; both already degrade to no-map on
# failure (see tests/geo_failure_test.mjs). The honest cost is one decorative
# seat outline on race.html for an observer with no signal — the candidates,
# emblems, ballot and every figure still render.
#
# states_geo.json STAYS. It is 23 KB and carries the shared viewBox every other
# layer is projected into, so without it there is no map at any level, online or
# off. Not worth 23 KB to lose the state-level map offline.
rm -f "$PUB/lga_geo.json" "$PUB/constituency_geo.json" "$PUB/district_geo.json"
[ -f "$PUB/states_geo.json" ] || { echo "GATE_FAIL: states_geo.json was stripped — it is the shared viewBox, every map needs it"; exit 1; }
grep -q "window.fetchData" "$PUB/results.html" || { echo "GATE_FAIL: results.html does not route geo through fetchData — the stripped layers would never load"; exit 1; }
grep -q "window.fetchData" "$PUB/race.js" || { echo "GATE_FAIL: race.js does not route geo through fetchData — the stripped layers would never load"; exit 1; }
echo "  ok: big-three geo fetched live, states_geo kept"

# THE REASON RELEASE 2 EXISTS. Lite has no `server.url` (webDir: "../app"), so a
# relative fetch reads the copy baked into the APK — which only changes with a
# store release. INEC amended its 2023 candidate list SEVEN times after
# publication; that is seven store releases for a JSON file.
#
# native.js's fetchData() reads those files from the live site off-origin and
# falls back to the bundled copy when there is no signal. If it is ever missing
# from the packaged bundle, Lite silently goes back to frozen data and looks
# perfectly healthy while doing it — so it is asserted, not assumed.
grep -q "window.fetchData = function" "$PUB/native.js" \
  || { echo "GATE_FAIL: native.js has no fetchData — Lite would ship frozen candidate data"; exit 1; }
# It only works because CapacitorHttp routes fetch natively; the live files send
# no access-control-allow-origin, so a plain cross-origin fetch would be blocked
# and the fallback would quietly serve the bundle forever.
grep -q '"CapacitorHttp"' capacitor.config.json \
  || { echo "GATE_FAIL: CapacitorHttp is not configured — fetchData would fail CORS and silently use the bundle"; exit 1; }
echo "  ok: fetchData present, CapacitorHttp on"

# The bundled political_data.json is the OFFLINE FALLBACK. It should not ship
# months stale just because the live copy is what usually gets read.
node -e '
  const fs = require("fs");
  const p = process.argv[1] + "/political_data.json";
  const age = (Date.now() - fs.statSync(p).mtimeMs) / 86400000;
  console.log("  political_data.json fallback is " + age.toFixed(0) + " days old");
  if (age > 120) { console.log("GATE_FAIL: offline fallback is stale — refresh app/political_data.json"); process.exit(1); }
' "$PUB" || exit 1

# EVERY EMBLEM THE MANIFEST NAMES MUST STILL BE HERE. The strip above deletes
# four .png files the manifest does not reference — if a future edit repoints a
# party at one of them, the emblem would silently render as a blank disc
# (results.html's badge has no onerror), and nothing else would notice.
node -e '
  const fs = require("fs"), p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p + "/logos/manifest.json", "utf8"));
  const missing = Object.values(m).filter((f) => !fs.existsSync(p + "/" + f));
  if (missing.length) { console.log("GATE_FAIL: manifest names files the strip removed: " + missing.join(", ")); process.exit(1); }
  console.log("  ok: all " + Object.keys(m).length + " party emblems present");
' "$PUB" || exit 1

# styles.css must not still ask for a font the strip deleted.
for f in inter-500 inter-600 inter-700 lora-600 lora-700; do
  grep -q "fonts/$f.woff2" "$PUB/styles.css" && { echo "GATE_FAIL: styles.css still references fonts/$f.woff2, which is stripped"; exit 1; }
done
echo "  ok: styles.css references no stripped font"

# REGISTER PACKS (docs/PU-SEARCH-2027.md). Not bundled, deliberately.
#
# Two reasons. Android's asset packer renames `index.<sha>.pack.gz` to `.pack`
# and inflates it, so the file the client asks for is not the file that ships.
# And the store now fetches the register with ABSOLUTE urls, because a manifest
# read out of the APK would freeze Lite on whatever register shipped with it —
# a correction would reach every platform except the one that needs a store
# review to update.
#
# So Lite fetches the ~56 KB index on first run like any other client. That
# costs first-run-offline browse and buys a register that can actually be
# corrected.
rm -rf "$PUB/reg"

gate() { if grep -q "$1" "$PUB/$2"; then echo "  ok: $3"; else echo "GATE_FAIL: $3 missing from $2"; exit 1; fi; }
# WHAT PLAY REJECTED THIS APP FOR, TWICE, gated on the CLAIMS rather than on one
# sentence's wording.
#
# This used to grep "Figures are crowd reports", which was a phrase on the face
# of the disclaimer bar. On 2026-08-25 the bar was shortened to match the native
# app's — one line, claim then Details, with the full statement in the modal —
# and this gate failed, correctly: it noticed. But the compliance substance had
# not gone anywhere, only that phrasing had, so gating on the phrase was gating
# on a style decision.
#
# These three are the facts a reviewer is looking for, and they live in the modal
# where they cannot be shortened away by a layout change:
gate "not affiliated with"      menu.js "non-affiliation statement"
gate "unofficial crowd reports" menu.js "figures-are-unofficial statement"
gate "inecnigeria.org"          menu.js "official source link"

KB=$(du -sk "$PUB" | cut -f1)
echo "  packaged web assets: $((KB / 1024)) MB"
[ "$KB" -gt 15360 ] && { echo "GATE_FAIL: packaged assets ${KB}KB exceed 15MB"; du -ah "$PUB" | sort -rh | head -8; exit 1; }

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
[ "$LITE_VC" -ge 2 ] || { echo "GATE_FAIL: versionCode $LITE_VC would be rejected — 1 is in Play review"; exit 1; }
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

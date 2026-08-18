#!/usr/bin/env bash
# Build the Play Store AAB for the native app.
#
# Distinct from build_team_apk.sh in three ways that all matter:
#   package   ng.com.hawkeye.observer  (not .dev) — the listing's identity
#   Maps key  GOOGLE_MAPS_API_KEY_PROD, switched with the package by
#             app.config.js so the two cannot drift apart
#   signing   the UPLOAD keystore, not debug
#
# Secrets are read from ~/hawkeye-secrets at build time and handed to gradle as
# properties. They are never written into the repo and never printed.
set -euo pipefail

cd "$(dirname "$0")/.."
SECRETS="${HAWKEYE_SECRETS:-$HOME/hawkeye-secrets}"
NOTE="$SECRETS/keystore-password.txt"
OUT_DIR="$(pwd)/android/app/build/outputs/bundle/release"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31mFAIL: %s\033[0m\n' "$1" >&2; exit 1; }

step "Preflight"
[ -f "$NOTE" ] || die "no keystore note at $NOTE"
# `field name` pulls one value out of the note without ever echoing it.
field() { sed -n "s/^$1:[[:space:]]*//p" "$NOTE" | head -1; }
KS_FILE=$(field file); KS_ALIAS=$(field alias); KS_PASS=$(field password)
# A relative path in the note resolves against the secrets dir.
case "$KS_FILE" in /*) ;; *) KS_FILE="$SECRETS/$KS_FILE" ;; esac
[ -f "$KS_FILE" ] || die "keystore not found at the path in the note"
[ -n "$KS_ALIAS" ] || die "no alias in the note"
[ -n "$KS_PASS" ] || die "no password in the note"
echo "  keystore  : found ($(basename "$KS_FILE"))"
echo "  alias     : ${KS_ALIAS:0:2}***"
[ -f .env.local ] || die "native/.env.local missing — it carries GOOGLE_MAPS_API_KEY_PROD"
grep -q '^GOOGLE_MAPS_API_KEY_PROD=' .env.local || die "GOOGLE_MAPS_API_KEY_PROD not set in .env.local"
echo "  prod maps : present"

VC=$(node -p "require('./app.json').expo.android.versionCode")
VN=$(node -p "require('./app.json').expo.version")
echo "  version   : $VN (versionCode $VC)"
[ "$VC" -ge 5 ] || die "versionCode $VC would be rejected — the live listing is at 4"

step "Prebuild (production variant)"
# --clean because the tree currently holds a .dev build: a stale android/ would
# keep the old applicationId and the dev Maps key. This is also what regenerates
# the launcher icons from assets/images/android-icon-foreground.png.
APP_VARIANT=production npx expo prebuild --platform android --clean

PKG=$(grep -m1 'applicationId' android/app/build.gradle | sed "s/.*'\(.*\)'.*/\1/")
[ "$PKG" = "ng.com.hawkeye.observer" ] || die "applicationId is $PKG, expected ng.com.hawkeye.observer"
grep -q 'HAWKEYE_UPLOAD_STORE_FILE' android/app/build.gradle \
  || die "the signing plugin did not apply — the build would be signed with the DEBUG key"
echo "  package   : $PKG"
echo "  signing   : upload config injected"

step "Bundle"
cd android
# --no-watch-fs: inotify is unreliable over the WSL/Windows boundary and gradle
# hangs on file watching rather than failing.
./gradlew --no-watch-fs bundleRelease \
  -PHAWKEYE_UPLOAD_STORE_FILE="$KS_FILE" \
  -PHAWKEYE_UPLOAD_STORE_PASSWORD="$KS_PASS" \
  -PHAWKEYE_UPLOAD_KEY_ALIAS="$KS_ALIAS" \
  -PHAWKEYE_UPLOAD_KEY_PASSWORD="$KS_PASS"
cd ..

step "Verify the artefact"
AAB=$(ls -1 "$OUT_DIR"/*.aab 2>/dev/null | head -1) || true
[ -n "${AAB:-}" ] || die "no .aab produced"
SIZE=$(du -h "$AAB" | cut -f1)
echo "  file      : $AAB ($SIZE)"

# WHO SIGNED IT. A debug-signed AAB is the one failure this script exists to
# prevent, and it is invisible without asking.
if command -v jarsigner >/dev/null; then
  if jarsigner -verify -verbose:summary "$AAB" 2>/dev/null | grep -qi 'jar verified'; then
    echo "  signature : verified"
  fi
  SUBJECT=$(keytool -printcert -jarfile "$AAB" 2>/dev/null | sed -n 's/^Owner: //p' | head -1)
  echo "  signed by : ${SUBJECT:-unknown}"
  case "$SUBJECT" in
    *Android\ Debug*) die "SIGNED WITH THE DEBUG KEY — do not upload this" ;;
  esac
fi

cat <<DONE

Next, by hand:
  1. Play Console -> Test and release -> Production -> Create new release
  2. Upload:  $AAB
  3. BEFORE rolling out, confirm the map works on a real install. The prod Maps
     key must be restricted to ng.com.hawkeye.observer + PLAY'S app-signing
     SHA-1 (Console -> Test and release -> App signing), NOT the upload key's.
     Bound to the upload cert it works locally and shows a blank grey map to
     every real user.
  4. The short description edit staged in the Console goes out with this release.
DONE

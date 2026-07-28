#!/bin/bash
# Encrypted off-host backup of the Android release signing keystore.
#
# WHY THIS EXISTS: ng.com.hawkeye.observer can only ever be updated by an AAB
# signed with this key. Google cannot reissue it. Losing it means the listing is
# frozen forever and the app must be republished under a new package name.
#
# The keystore is encrypted LOCALLY with a passphrase you type; only the
# ciphertext is uploaded. gdrive: is a plain (unencrypted) rclone remote, so the
# raw keystore must never be copied there. The password file travels inside the
# encrypted bundle, so the passphrase is the single thing you must not lose —
# put it in your password manager, not in this repo.
#
# Usage: bash backend/scripts/backup_keystore.sh
# gpg prompts for the passphrase twice. Run it in a terminal, not from a script.
set -euo pipefail

SECRETS="$HOME/hawkeye-secrets"
KEYSTORE="$SECRETS/hawkeye-release.keystore"
PWFILE="$SECRETS/keystore-password.txt"
PROPS="$HOME/hawkeye/mobile/android/keystore.properties"
OUTDIR="$HOME/hawkeye-backups"
RCLONE="$HOME/bin/rclone"
STAMP=$(date -u +%Y%m%d)
BUNDLE="$OUTDIR/hawkeye-release-keystore-$STAMP.tar.gz"
ENC="$BUNDLE.gpg"

[ -f "$KEYSTORE" ] || { echo "FATAL: no keystore at $KEYSTORE"; exit 1; }
mkdir -p "$OUTDIR"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/hawkeye-release-keystore-$STAMP"
mkdir -p "$STAGE"

cp "$KEYSTORE" "$STAGE/"
[ -f "$PWFILE" ] && cp "$PWFILE" "$STAGE/"
[ -f "$PROPS" ]  && cp "$PROPS"  "$STAGE/keystore.properties"

cat > "$STAGE/README.txt" <<'EOF'
Hawkeye Android release signing keystore.

Package name : ng.com.hawkeye.observer
Key alias    : hawkeye
Original path: ~/hawkeye-secrets/hawkeye-release.keystore
Consumed by  : mobile/android/keystore.properties -> app/build.gradle
               (release signingConfig applies only when that file exists)

To restore:
  mkdir -p ~/hawkeye-secrets
  cp hawkeye-release.keystore keystore-password.txt ~/hawkeye-secrets/
  chmod 600 ~/hawkeye-secrets/*
  cp keystore.properties ~/hawkeye/mobile/android/keystore.properties

Google Play cannot reissue this key. Without it, ng.com.hawkeye.observer can
never be updated again.
EOF

sha256sum "$STAGE"/* > "$WORK/manifest.sha256"
cp "$WORK/manifest.sha256" "$STAGE/"

tar -czf "$BUNDLE" -C "$WORK" "hawkeye-release-keystore-$STAMP"

echo
echo "Choose a strong passphrase and save it in your password manager NOW."
echo "It is the only thing standing between a lost laptop and a lost app."
echo
rm -f "$ENC"
gpg --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-count 65011712 \
    --s2k-digest-algo SHA512 --output "$ENC" "$BUNDLE"

# Round-trip verify before the plaintext bundle is destroyed or uploaded.
echo
echo "Verifying the encrypted copy actually decrypts (enter the same passphrase):"
VERIFY="$WORK/verify"
mkdir -p "$VERIFY"
gpg --decrypt --output "$VERIFY/roundtrip.tar.gz" "$ENC"
tar -xzf "$VERIFY/roundtrip.tar.gz" -C "$VERIFY"
if ! cmp -s "$VERIFY/hawkeye-release-keystore-$STAMP/hawkeye-release.keystore" "$KEYSTORE"; then
  echo "FATAL: round-trip mismatch — NOT uploading."; exit 1
fi
echo "Round-trip OK: decrypted keystore is byte-identical to the original."

shred -u "$BUNDLE" 2>/dev/null || rm -f "$BUNDLE"
chmod 600 "$ENC"

if [ -x "$RCLONE" ] && "$RCLONE" listremotes 2>/dev/null | grep -q '^gdrive:'; then
  "$RCLONE" copy "$ENC" gdrive:hawkeye-backups/keystore/
  echo
  echo "Uploaded to gdrive:hawkeye-backups/keystore/$(basename "$ENC")"
  "$RCLONE" lsl gdrive:hawkeye-backups/keystore/
else
  echo "rclone gdrive remote unavailable — encrypted copy kept at $ENC only."
fi

echo
echo "Local encrypted copy: $ENC"
sha256sum "$ENC"

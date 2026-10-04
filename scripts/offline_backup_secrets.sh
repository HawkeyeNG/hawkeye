#!/usr/bin/env bash
# The SECRETS half of the offline backup — run by the OWNER in his own terminal.
# Packs every key and .env into one tar and encrypts it with a passphrase that
# gpg asks for (twice) on this terminal. Nothing is written unencrypted to the
# drive, and the passphrase never passes through Claude. Older archives are kept.
#
#   bash ~/hawkeye/scripts/offline_backup_secrets.sh /mnt/d/Hawkeye-Backup
#
# LOSING THE PASSPHRASE LOSES THIS COPY. Keep it in your password manager.
set -euo pipefail
DEST="${1:?usage: offline_backup_secrets.sh /mnt/<drive>/Hawkeye-Backup}"
[ -t 0 ] && [ -t 1 ] || { echo "run this in your own terminal (gpg asks for the passphrase)"; exit 2; }
case "$DEST" in /mnt/[d-z]/*) ;; *) echo "refusing: DEST must be on the backup drive (/mnt/<letter>/..., not C:)"; exit 2 ;; esac
mkdir -p "$DEST/secrets"
OUT="$DEST/secrets/hawkeye-secrets-$(date +%F).tar.gpg"
cd "$HOME"
LIST=()
for p in hawkeye-secrets .config/hawkeye .ssh hawkeye/backend/.env hawkeye/backend/.env.tiktok-sandbox \
         hawkeye/native/.env.local hawkeye/native/credentials.json hawkeye/native/google-services.json \
         hawkeye/native/GoogleService-Info.plist hawkeye/native/ios/Hawkeye/GoogleService-Info.plist \
         hawkeye/native/android/app/google-services.json hawkeye/mobile/android/app/google-services.json \
         inixien-site/.env .config/.wrangler/config/default.toml .oci; do
  [ -e "$p" ] && LIST+=("$p")
done
echo "Packing ${#LIST[@]} items (names only): ${LIST[*]}"
echo "gpg will ask for a passphrase twice. Use a long one and save it in your password manager."
tar -cf - "${LIST[@]}" | gpg --symmetric --cipher-algo AES256 --pinentry-mode loopback -o "$OUT.tmp"
mv -f "$OUT.tmp" "$OUT"
echo "Checking the archive opens (gpg may ask once more)…"
gpg --pinentry-mode loopback -d "$OUT" 2>/dev/null | tar -t >/dev/null && echo "OK: $(basename "$OUT") opens and lists $(gpg --pinentry-mode loopback -d "$OUT" 2>/dev/null | tar -t | wc -l) files" \
  || { echo "!! the archive did not open — keep the previous one"; exit 1; }
echo "Done. Clear this terminal (clear) when you are finished."

#!/bin/bash
# Full redeploy snapshot of the Hawkeye repo (code + .git history + .env + live
# data), excluding regenerables (node_modules, tesseract vendor, build caches).
# Output: ~/hawkeye-backups/hawkeye-repo-YYYY-MM-DD.tar.gz[.gpg]
#
# ⚠ THE ARCHIVE CONTAINS SECRETS (backend/.env: GO54 creds, API tokens) and live
# submission data. Store ONLY in a PRIVATE, offsite location. Set BACKUP_PASSPHRASE
# to produce an encrypted .gpg (recommended before any cloud upload):
#   BACKUP_PASSPHRASE='...' bash backend/scripts/backup_repo.sh
set -e
SRC="/home/elrio/hawkeye"
DEST="$HOME/hawkeye-backups"
mkdir -p "$DEST"
TS=$(date -u +%Y-%m-%d)
OUT="$DEST/hawkeye-repo-$TS.tar.gz"

tar \
  --exclude='node_modules' \
  --exclude='app/vendor/tesseract' \
  --exclude='.gradle' \
  --exclude='*/build' \
  --exclude='.cache' \
  --exclude='venv' \
  --exclude='hawkeye-backups' \
  -czf "$OUT" -C "$(dirname "$SRC")" "$(basename "$SRC")"

if [ -n "$BACKUP_PASSPHRASE" ] && command -v gpg >/dev/null; then
  gpg --batch --yes --passphrase "$BACKUP_PASSPHRASE" -c "$OUT"
  rm -f "$OUT"
  OUT="$OUT.gpg"
  echo "encrypted snapshot: $OUT"
else
  echo "PLAINTEXT snapshot (contains secrets — encrypt before any cloud upload): $OUT"
fi
ls -lh "$OUT"
# retain last 8 snapshots
ls -1t "$DEST"/hawkeye-repo-*.tar.gz* 2>/dev/null | tail -n +9 | xargs -r rm -f

#!/bin/bash
# Full redeploy snapshot of the Hawkeye repo (code + .git history + .env + live
# data), excluding regenerables (node_modules, tesseract vendor, build caches).
# Output: ~/hawkeye-backups/hawkeye-repo-YYYY-MM-DD.tar.gz[.gpg]
#
# ⚠ THE ARCHIVE CONTAINS SECRETS (backend/.env: GO54 creds, API tokens) and live
# submission data. Store ONLY in a PRIVATE, offsite location.
#
# Env (set in ~/.config/hawkeye-backup.env for the systemd timer):
#   BACKUP_PASSPHRASE   symmetric passphrase -> encrypts to .gpg (REQUIRED for upload)
#   RCLONE_REMOTE       e.g. "gdrive:HawkeyeBackups" -> offsite upload target
#   RCLONE              path to rclone binary (default ~/bin/rclone)
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

ENCRYPTED=0
if [ -n "$BACKUP_PASSPHRASE" ] && command -v gpg >/dev/null; then
  gpg --batch --yes --passphrase "$BACKUP_PASSPHRASE" -c "$OUT"
  rm -f "$OUT"; OUT="$OUT.gpg"; ENCRYPTED=1
  echo "encrypted snapshot: $OUT"
else
  echo "PLAINTEXT snapshot (contains secrets — encrypt before any cloud upload): $OUT"
fi
ls -lh "$OUT"

# Offsite upload — only if the archive is ENCRYPTED (never push plaintext secrets).
RCLONE="${RCLONE:-$HOME/bin/rclone}"
if [ -n "$RCLONE_REMOTE" ]; then
  if [ "$ENCRYPTED" != "1" ]; then
    echo "SKIP upload: refusing to upload an unencrypted archive — set BACKUP_PASSPHRASE." >&2
  elif [ -x "$RCLONE" ] || command -v rclone >/dev/null; then
    [ -x "$RCLONE" ] || RCLONE=rclone
    "$RCLONE" copy "$OUT" "$RCLONE_REMOTE"
    echo "uploaded -> $RCLONE_REMOTE"
    # keep only last 8 remote snapshots
    "$RCLONE" lsf "$RCLONE_REMOTE" --include 'hawkeye-repo-*.tar.gz.gpg' 2>/dev/null \
      | sort | head -n -8 | while read -r f; do "$RCLONE" deletefile "$RCLONE_REMOTE/$f"; done
  else
    echo "SKIP upload: rclone not found at $RCLONE" >&2
  fi
fi

# keep only last 8 local snapshots
ls -1t "$DEST"/hawkeye-repo-*.tar.gz* 2>/dev/null | tail -n +9 | xargs -r rm -f

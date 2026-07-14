#!/bin/bash
# Weekly off-host backup: pull the latest server DB snapshot to ~/hawkeye-backups/
# then push it to Google Drive (rclone remote "gdrive", one-time `rclone config`).
# Cron-run; logs to ~/hawkeye-backups/offsite.log.
set -e
cd "$(dirname "$0")/.."
bash scripts/pull_backup.sh
LATEST=$(ls -1 "$HOME"/hawkeye-backups/hawkeye-*.db.gz 2>/dev/null | sort | tail -1)
[ -z "$LATEST" ] && { echo "[offsite] no local snapshot found"; exit 1; }
RCLONE="$HOME/bin/rclone"
if [ -x "$RCLONE" ] && "$RCLONE" listremotes 2>/dev/null | grep -q '^gdrive:'; then
  # overwrite a stable name (weekly rotation) + keep a dated copy alongside
  "$RCLONE" copyto "$LATEST" gdrive:hawkeye-backups/hawkeye-latest.db.gz
  "$RCLONE" copy "$LATEST" gdrive:hawkeye-backups/archive/
  echo "[offsite] $(date -u +%FT%TZ) pushed $(basename "$LATEST") to gdrive:hawkeye-backups/"
else
  echo "[offsite] $(date -u +%FT%TZ) rclone gdrive remote not configured (run: rclone config) — local copy only"
fi

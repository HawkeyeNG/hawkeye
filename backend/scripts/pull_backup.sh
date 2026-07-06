#!/bin/bash
# Download the latest server DB snapshot to ~/hawkeye-backups/ (off-host copy).
# Run from any machine with backend/.env creds: bash scripts/pull_backup.sh
set -e
cd "$(dirname "$0")/.."
U=$(grep '^GO54_USERNAME=' .env | cut -d= -f2- | awk '{print $1}')
P=$(grep '^GO54_PASSWORD=' .env | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
B="https://da32.host-ww.net:2222"
LATEST=$(curl -sk -u "$U:$P" "$B/CMD_API_FILE_MANAGER?path=/hawkeye/backend/storage/backups" \
  | tr '&' '\n' | grep -oP 'hawkeye-\d{4}-\d{2}-\d{2}\.db\.gz' | sort -u | tail -1)
[ -z "$LATEST" ] && { echo "no backups on server yet"; exit 1; }
mkdir -p ~/hawkeye-backups
curl -sk -u "$U:$P" "$B/CMD_FILE_MANAGER/hawkeye/backend/storage/backups/$LATEST?action=download" \
  -o ~/hawkeye-backups/"$LATEST"
ls -la ~/hawkeye-backups/"$LATEST"
echo "restore with: gunzip -k ~/hawkeye-backups/$LATEST  (then replace storage/hawkeye.db)"

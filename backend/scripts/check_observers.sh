#!/bin/bash
# Show the observer identities stored on the LIVE server (numbers are HMAC-hashed,
# never stored in readable form). The local storage/hawkeye.db is empty — the real
# data is on GO54, so this downloads it (read-only) and queries it.
#   bash scripts/check_observers.sh
set -e
cd "$(dirname "$0")/.."               # backend/
U=$(grep '^GO54_USERNAME=' .env | cut -d= -f2- | awk '{print $1}')
P=$(grep '^GO54_PASSWORD=' .env | sed -e 's/^GO54_PASSWORD=//' -e 's/[[:space:]]*$//' -e 's/[[:space:]]*#.*//')
B="https://da32.host-ww.net:2222"
D=$(mktemp -d)
for f in hawkeye.db hawkeye.db-wal hawkeye.db-shm; do
  curl -sk -m 300 -u "$U:$P" "$B/CMD_FILE_MANAGER/hawkeye/backend/storage/$f?action=download" -o "$D/$f" || true
done
echo "== Observers (phone numbers are hashes, not reversible) =="
sqlite3 -header -column "$D/hawkeye.db" "
SELECT o.id,
       substr(o.phone_hash,1,16) AS phone_hash,
       CASE WHEN t.chat_id IS NOT NULL THEN 'yes' ELSE 'no' END AS tg_linked,
       CASE WHEN o.device_id IS NOT NULL THEN 'yes' ELSE 'no' END AS device,
       datetime(o.created_at/1000,'unixepoch') AS registered
FROM observers o
LEFT JOIN telegram_links t ON t.phone_hash = o.phone_hash
ORDER BY o.id;"
echo
sqlite3 -header -column "$D/hawkeye.db" "
SELECT (SELECT COUNT(*) FROM observers)      AS observers,
       (SELECT COUNT(*) FROM telegram_links) AS tg_linked,
       (SELECT COUNT(*) FROM otps)           AS pending_otps;"
rm -rf "$D"

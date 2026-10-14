#!/bin/bash
# Put STAGING back to the pre-test snapshot: database, uploaded test photos, report journal,
# Litestream replica. Installed by bootstrap.sh as /usr/local/sbin/hk-reset-staging; the load tests
# run it before every run. DELETES DATA, so it refuses to run on anything but a staging host.
#
#   sudo hk-reset-staging              (KEEP_LS_STATE=1 keeps Litestream's saved position)
set -euo pipefail
grep -q '^APP_ENV=staging$' /etc/hawkeye/staging.env 2>/dev/null \
  || { echo "REFUSED: /etc/hawkeye/staging.env does not say APP_ENV=staging; this is not a staging host" >&2; exit 1; }
D=/var/lib/hawkeye; SNAP="$(ls -1t $D/snapshots/pre-test-*.db 2>/dev/null | head -1)"
[ -f "$SNAP" ] || { echo "no pre-test snapshot in $D/snapshots"; exit 1; }
U=/etc/systemd/system
# Every process that holds the database open must stop, or it keeps writing to the replaced file:
# the extra writers and the photos processes come and go with hk-writers-overlay.
extra_writers="$(cd $U && ls hawkeye-writer[0-9]*.service 2>/dev/null || true)"
photos="$(cd $U && ls hawkeye-photos[0-9]*.service 2>/dev/null || true)"
systemctl stop $photos $extra_writers hawkeye-writer.service hawkeye-worker.service 'hawkeye-reader@*.service' hawkeye-litestream.service
rm -f $D/storage/hawkeye.db-wal $D/storage/hawkeye.db-shm
# Litestream keeps its position in a folder beside the database; left behind, it cannot follow the swapped file.
[ -n "${KEEP_LS_STATE:-}" ] || rm -rf $D/storage/.hawkeye.db-litestream
install -o hawkeye -g hawkeye -m 0640 "$SNAP" $D/storage/hawkeye.db
find $D/storage/uploads -mindepth 1 -delete 2>/dev/null || true
rm -rf $D/storage/journal
find $D/litestream-replica -mindepth 1 -delete 2>/dev/null || true
# Peak mode keeps Litestream down (its unit refuses to start while the flag exists).
systemctl start hawkeye-litestream.service hawkeye-writer.service hawkeye-worker.service
sleep 2; [ -z "$extra_writers$photos" ] || systemctl start $extra_writers $photos
systemctl restart hawkeye-readers.service
for _ in $(seq 1 60); do curl -fsS --max-time 2 -H @/run/hawkeye/origin-auth.hdr http://127.0.0.1:8441/api/health >/dev/null 2>&1 && break; sleep 1; done
echo "reset to $(basename "$SNAP"): submissions $(sqlite3 "file:$D/storage/hawkeye.db?mode=ro" 'SELECT COUNT(*) FROM submissions;'), uploads $(du -sh $D/storage/uploads | cut -f1)"

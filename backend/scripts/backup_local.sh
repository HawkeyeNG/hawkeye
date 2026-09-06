#!/bin/bash
# Pull everything that matters onto a local drive.
#
#   scripts/backup_local.sh /mnt/hawkeye-backup            # sync
#   scripts/backup_local.sh /mnt/hawkeye-backup --dry-run
#
# WHY A LOCAL COPY AT ALL. Once UPLOAD_MODE=direct is on, R2 is the ONLY copy of
# every result sheet, and the weekly off-host job ships the SQLite database and
# nothing else. That matters more here than ordinary data loss: the ledger binds
# CONTENT HASHES, so losing the bytes makes every entry referencing them
# permanently unverifiable — the chain still asserts a photo it can no longer
# produce, and an audit that cannot show its evidence is not an audit.
#
# WHAT IT COPIES, in the order they are hard to replace:
#   evidence/   the R2 bucket — irreplaceable, and the reason this exists
#   db/         the server database snapshot
#   audits/     the Osun corpus and its derived registers
#
# CREDENTIALS NEVER REACH THE COMMAND LINE. rclone reads RCLONE_CONFIG_* from the
# environment, so nothing sensitive appears in `ps` or a shell history. That also
# means no `rclone config` step and no second copy of the keys on disk.
set -uo pipefail

DEST="${1:-}"
DRY=""
[ "${2:-}" = "--dry-run" ] && DRY="--dry-run"
if [ -z "$DEST" ]; then
  echo "usage: $0 <destination-dir> [--dry-run]"
  exit 2
fi

cd "$(dirname "$0")/.." || exit 1        # backend/
ENV=.env
RCLONE="${RCLONE:-$HOME/bin/rclone}"

val() { grep -m1 "^$1=" "$ENV" 2>/dev/null | cut -d= -f2- | tr -d '\r' | sed -e 's/[[:space:]]*#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

BUCKET=$(val S3_BUCKET)
ENDPOINT=$(val S3_ENDPOINT)
AKID=$(val S3_ACCESS_KEY_ID)
SECRET=$(val S3_SECRET_ACCESS_KEY)

if [ ! -x "$RCLONE" ]; then
  echo "rclone not found at $RCLONE — install it or set RCLONE=/path/to/rclone"
  exit 2
fi
for v in BUCKET ENDPOINT AKID SECRET; do
  [ -n "${!v}" ] || { echo "missing S3_* value for $v in backend/.env"; exit 2; }
done
case "$ENDPOINT" in
  *'<'*|*'>'*) echo "S3_ENDPOINT still contains a <placeholder>"; exit 2 ;;
esac

# A drive that is not mounted looks exactly like an empty directory, and syncing
# into the mount POINT instead of the mount fills the system disk while
# reporting success. Refuse unless the destination already exists.
if [ ! -d "$DEST" ]; then
  echo "destination $DEST does not exist — mount the drive first."
  echo "(refusing to create it: an unmounted drive looks like an empty directory,"
  echo " and syncing into the mount point fills the system disk instead.)"
  exit 2
fi

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AKID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$SECRET"
export RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

mkdir -p "$DEST/evidence" "$DEST/db" "$DEST/audits"
STAMP=$(date -u +%FT%TZ)
echo "=== hawkeye local backup  $STAMP ==="
echo "destination: $DEST"
df -h "$DEST" | tail -1 | sed 's/^/  /'
echo

# ---- 1. the bucket ---------------------------------------------------------
# COPY, NOT SYNC. `sync` deletes local files that are gone from the source, and
# for content-addressed evidence that is the wrong default: an object deleted in
# R2 — by the orphan sweeper, by accident, by someone with the key — would take
# the local copy with it, which is precisely what a backup is for.
echo "--- evidence (R2 -> $DEST/evidence) ---"
"$RCLONE" copy "R2:$BUCKET" "$DEST/evidence" \
  --transfers 8 --checkers 16 --progress --stats-one-line --stats 30s $DRY
RC=$?
echo "  rclone exit: $RC"

# ---- 2. the database -------------------------------------------------------
echo
echo "--- database ---"
if bash scripts/pull_backup.sh >/dev/null 2>&1; then
  LATEST=$(ls -1 "$HOME"/hawkeye-backups/hawkeye-*.db.gz 2>/dev/null | sort | tail -1)
  if [ -n "$LATEST" ]; then
    [ -n "$DRY" ] || cp -p "$LATEST" "$DEST/db/"
    echo "  $(basename "$LATEST") ($(du -h "$LATEST" | cut -f1))"
  else
    echo "  no snapshot produced"
  fi
else
  echo "  pull_backup.sh failed — the DB is NOT in this backup"
fi

# ---- 3. the audit corpus ---------------------------------------------------
echo
echo "--- audits ---"
if [ -d ../audits ]; then
  "$RCLONE" copy ../audits "$DEST/audits" --transfers 8 --checkers 16 --stats-one-line $DRY
  echo "  rclone exit: $?"
else
  echo "  no audits/ directory"
fi

echo
echo "=== totals ==="
du -sh "$DEST"/* 2>/dev/null | sed 's/^/  /'
df -h "$DEST" | tail -1 | sed 's/^/  /'
echo
echo "Now VERIFY it. A copy nobody checked is a copy nobody can rely on:"
echo "  node scripts/verify_local_backup.mjs $DEST"

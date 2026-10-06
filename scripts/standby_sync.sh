#!/usr/bin/env bash
# Hawkeye WARM STANDBY — re-sync code (and optionally a DB snapshot) on demand.
#
#   scripts/standby_sync.sh                 = --code --check
#   scripts/standby_sync.sh --setup         copy scripts/standby/ to the host, run setup_host.sh (idempotent)
#   scripts/standby_sync.sh --code          rsync app/ + backend/, npm ci when the lockfile changed, restart, prove it
#   scripts/standby_sync.sh --db [FILE]     push a snapshot (default: newest ~/hawkeye-backups/hawkeye-*.db.gz)
#                                           into the host's inbox and run the verified pull/install
#   scripts/standby_sync.sh --db --fresh    first fetch today's snapshot from GO54 (backend/scripts/pull_backup.sh:
#                                           one list + one download, nothing else)
#   scripts/standby_sync.sh --check         health through Caddy on the host + pull status
#
# The standby's address is NOT in this repository (the repo is public and an origin
# IP is never published). It lives in ~/.config/hawkeye/standby.env:
#   STANDBY_HOST=<ip>   STANDBY_USER=ubuntu   STANDBY_SSH_KEY=~/.ssh/hawkeye_oracle
#
# Never copied: .env files, storage/, tmp/, node_modules, databases, keys and
# keystores, backend/audits. Secrets reach the standby ONLY via
# scripts/standby_env_sync.sh, with the owner's approval.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONF="${HAWKEYE_STANDBY_CONF:-$HOME/.config/hawkeye/standby.env}"
# 1Password first (vault Infrastructure, Windows Hello), the file above as fallback.
. "$REPO/scripts/lib/hk_secrets.sh"
CONF=$(hk_secret_path standby.env "$CONF")
die() { echo "standby_sync: $*" >&2; exit 2; }
say() { echo "standby_sync: $*"; }
[ -r "$CONF" ] || die "missing $CONF (STANDBY_HOST, STANDBY_USER, STANDBY_SSH_KEY). The address is never kept in the repo."
# shellcheck disable=SC1090
. "$CONF"
: "${STANDBY_HOST:?}" "${STANDBY_USER:=ubuntu}" "${STANDBY_SSH_KEY:=$HOME/.ssh/hawkeye_oracle}"
STANDBY_SSH_KEY="${STANDBY_SSH_KEY/#\~/$HOME}"
SSH_OPTS=(-i "$STANDBY_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o StrictHostKeyChecking=accept-new)
TARGET="$STANDBY_USER@$STANDBY_HOST"
rssh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
RSYNC_RSH="ssh ${SSH_OPTS[*]}"

DO_SETUP=0; DO_CODE=0; DO_DB=0; DO_CHECK=0; FRESH=0; DBFILE=""
[ $# -eq 0 ] && { DO_CODE=1; DO_CHECK=1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --setup) DO_SETUP=1 ;;
    --code) DO_CODE=1; DO_CHECK=1 ;;
    --db) DO_DB=1; if [ -n "${2:-}" ] && [ "${2#--}" = "$2" ]; then DBFILE="$2"; shift; fi ;;
    --fresh) FRESH=1 ;;
    --check) DO_CHECK=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

# Files that must never leave this laptop, whatever directory they sit in.
COMMON_EXCLUDES=(
  --exclude=.git/ --exclude=.env --exclude='.env.*' --exclude=tmp/ --exclude=storage/ --exclude=node_modules/
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db.gz' --exclude='*.sqlite'
  --exclude=anchor_key.json --exclude='*.pem' --exclude='*.key' --exclude='*.p8' --exclude='*.p12'
  --exclude='*.jks' --exclude='*.keystore' --exclude=google-services.json --exclude=GoogleService-Info.plist
  --exclude=credentials.json --exclude='*.gpg' --exclude=__pycache__/
)

if [ "$DO_SETUP" = 1 ]; then
  say "setup: copying scripts/standby/ to the host"
  rsync -a --delete -e "$RSYNC_RSH" "$REPO/scripts/standby/" "$TARGET:hawkeye-standby-setup/"
  rssh 'sudo bash hawkeye-standby-setup/setup_host.sh'
fi

if [ "$DO_CODE" = 1 ]; then
  [ -f "$REPO/backend/src/server.js" ] || die "no backend/ checkout at $REPO/backend"
  bsha="$(git -C "$REPO/backend" rev-parse --short=12 HEAD)"
  [ -n "$(git -C "$REPO/backend" status --porcelain --untracked-files=no)" ] && bsha="$bsha+dirty"
  asha="$(git -C "$REPO" rev-parse --short=8 HEAD)"
  [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no -- app)" ] && asha="$asha+dirty"
  REV="$bsha.$asha"

  # app/download holds every APK ever built (600+ MB). Send only the ones a page links to.
  APK_FILTER=()
  while read -r apk; do [ -n "$apk" ] && APK_FILTER+=("--include=/download/$apk"); done < <(
    { echo hawkeye.apk; grep -rhoE 'download/[A-Za-z0-9._-]+\.apk' "$REPO"/app/*.html "$REPO"/app/*.js 2>/dev/null | sed 's#^download/##'; } | sort -u)
  say "code: app ($asha) + backend ($bsha) -> /srv/hawkeye; APKs: ${#APK_FILTER[@]}"
  rsync -az --delete --delete-excluded -e "$RSYNC_RSH" "${COMMON_EXCLUDES[@]}" \
    "${APK_FILTER[@]}" --exclude='/download/*.apk' --exclude=/ios-shots/ \
    "$REPO/app/" "$TARGET:/srv/hawkeye/app/"
  # backend: protect the host-side files rsync must never delete (.env symlink, REVISION, lock stamp).
  rsync -az --delete -e "$RSYNC_RSH" "${COMMON_EXCLUDES[@]}" \
    --exclude=/REVISION --exclude=/.lock.sha256 --exclude=/audits/ --exclude=/_archive_social/ --exclude=/tests/ \
    "$REPO/backend/" "$TARGET:/srv/hawkeye/backend/"
  lock="$(sha256sum "$REPO/backend/package-lock.json" | cut -d' ' -f1)"
  rssh "bash -s" <<EOF
set -euo pipefail
cd /srv/hawkeye/backend
printf '%s\n' '$REV' > REVISION
if [ ! -d node_modules ] || [ "\$(cat .lock.sha256 2>/dev/null)" != '$lock' ]; then
  echo "standby_sync: npm ci (lockfile changed or first run)"
  /usr/local/bin/npm ci --omit=dev --no-audit --no-fund --loglevel=error
  /usr/local/bin/node --input-type=module -e "const D=(await import('better-sqlite3')).default; new D(':memory:').prepare('select 1').get(); await import('sharp'); console.log('standby_sync: native modules load (better-sqlite3, sharp)')"
  echo '$lock' > .lock.sha256
fi
sudo systemctl restart hawkeye-standby
EOF
  # Prove the NEW process by behaviour: it must report the revision just written.
  ok=0
  for _ in $(seq 1 45); do
    HJ="$(rssh 'sudo hawkeye-standby-mode health' 2>/dev/null || true)"
    if grep -qF "\"gitSha\":\"$REV\"" <<<"$HJ"; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] && say "code: standby is serving $REV" || die "code: the standby did not come up on $REV (journalctl -u hawkeye-standby on the host)"
fi

if [ "$DO_DB" = 1 ]; then
  if [ "$FRESH" = 1 ]; then
    say "db: fetching the newest GO54 snapshot (pull_backup.sh)"
    bash "$REPO/backend/scripts/pull_backup.sh" >/dev/null
  fi
  if [ -z "$DBFILE" ]; then DBFILE="$(ls -1 "$HOME"/hawkeye-backups/hawkeye-*.db.gz 2>/dev/null | sort | tail -1)"; fi
  [ -f "$DBFILE" ] || die "db: no snapshot found (give a FILE or use --fresh)"
  base="$(basename "$DBFILE")"
  [[ "$base" =~ ^hawkeye-[0-9]{4}-[0-9]{2}-[0-9]{2}\.db\.gz$ ]] || die "db: name must be hawkeye-YYYY-MM-DD.db.gz"
  say "db: pushing $base ($(du -h "$DBFILE" | cut -f1)) to the inbox"
  rsync -a --partial -e "$RSYNC_RSH" "$DBFILE" "$TARGET:/srv/hawkeye-inbox/.$base.part"
  rssh "mv /srv/hawkeye-inbox/.$base.part /srv/hawkeye-inbox/$base && sudo /usr/local/sbin/hawkeye-standby-pull"
fi

if [ "$DO_CHECK" = 1 ]; then
  rssh 'sudo hawkeye-standby-mode health; sudo hawkeye-standby-pull --status | head -20'
fi

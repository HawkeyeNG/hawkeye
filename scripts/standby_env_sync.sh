#!/usr/bin/env bash
# Hawkeye WARM STANDBY — move production's runtime env to the standby.
#
#   *** OWNER APPROVAL REQUIRED. Without --approved this prints the plan and exits. ***
#
#   scripts/standby_env_sync.sh                         plan only (no network call)
#   scripts/standby_env_sync.sh --approved              do it
#       --with-key-files    also anchor_key.json and the DeviceCheck .p8 (needed only
#                           before a FULL promotion; the standby never signs anything)
#       --no-pull-creds     do not give the standby the GO54 login for its hourly pull
#
# WHAT MOVES, AND HOW
#   1. GO54:/hawkeye/backend/.env  -> standby:/etc/hawkeye/secrets.env (0640 root:hawkeye)
#      Downloaded through the DirectAdmin file API and PIPED straight into ssh: the
#      values never touch this laptop's disk, never appear in argv, and are never
#      printed. The standby validates it and prints the key NAMES only.
#   2. The GO54 login for the hourly snapshot pull -> standby:/etc/hawkeye/pull.env (0600 root)
#      Uses GO54_STANDBY_KEY from backend/.env when present — a DirectAdmin LOGIN KEY
#      the owner creates with only CMD_API_FILE_MANAGER + CMD_FILE_MANAGER allowed and
#      the standby's IP allow-listed (much smaller blast radius than the panel
#      password). Falls back to GO54_PASSWORD, with a warning.
#   3. (--with-key-files) GO54:/hawkeye/backend/storage/anchor_key.json and the
#      DEVICECHECK_KEY_FILE .p8, same piping, to /var/lib/hawkeye/storage/ and
#      /etc/hawkeye/keys/.
#
# WHAT IT CHANGES ON THE STANDBY: STANDBY stays 1 (systemd's environment beats the
# .env file). With the real JWT_SECRET present, credentialed reads are served
# (STANDBY_AUTH_READS=1) instead of 503. Writes stay 503, background jobs stay off,
# outbound connections stay refused (in-process guard + firewall).
# It changes NOTHING on production: two reads from the file API.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONF="${HAWKEYE_STANDBY_CONF:-$HOME/.config/hawkeye/standby.env}"
ENVF="$REPO/backend/.env"
die() { echo "standby_env_sync: $*" >&2; exit 2; }
say() { echo "standby_env_sync: $*"; }

APPROVED=0; KEYFILES=0; PULLCREDS=1
for a in "$@"; do
  case "$a" in
    --approved) APPROVED=1 ;;
    --with-key-files) KEYFILES=1 ;;
    --no-pull-creds) PULLCREDS=0 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) die "unknown option $a" ;;
  esac
done

if [ "$APPROVED" != 1 ]; then
  cat <<EOF
standby_env_sync: PLAN (nothing done; re-run with --approved once the owner has said yes)
  1. GO54 /hawkeye/backend/.env  ->  standby /etc/hawkeye/secrets.env   (piped, never on this disk, never printed)
  2. $( [ "$PULLCREDS" = 1 ] && echo "GO54 login for the hourly pull -> standby /etc/hawkeye/pull.env (login key if GO54_STANDBY_KEY is set, else the panel password)" || echo "(skipped: --no-pull-creds)")
  3. $( [ "$KEYFILES" = 1 ] && echo "anchor_key.json + DeviceCheck .p8 -> standby" || echo "(key files not included; add --with-key-files before a FULL promotion)")
  then: restart the standby, check /api/health shows envFile=true, standby.authReads=true, readOnly=true.
EOF
  exit 0
fi

[ -r "$CONF" ] || die "missing $CONF"
# shellcheck disable=SC1090
. "$CONF"
: "${STANDBY_HOST:?}" "${STANDBY_USER:=ubuntu}" "${STANDBY_SSH_KEY:=$HOME/.ssh/hawkeye_oracle}"
STANDBY_SSH_KEY="${STANDBY_SSH_KEY/#\~/$HOME}"
rssh() { ssh -i "$STANDBY_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=20 "$STANDBY_USER@$STANDBY_HOST" "$@"; }
[ -r "$ENVF" ] || die "no $ENVF (the GO54 login lives there)"

# Read single values from backend/.env without echoing them (same parsing as pull_backup.sh).
# `|| true`: an ABSENT optional key (GO54_DA_BASE) made grep fail, and under
# `set -euo pipefail` that exited the whole script silently before step 1.
envval() { { grep -E "^$1=" "$ENVF" || true; } | tail -1 | sed -e "s/^$1=//" -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }
U="$(envval GO54_USERNAME)"; P="$(envval GO54_PASSWORD)"; K="$(envval GO54_STANDBY_KEY)"
DA="$(envval GO54_DA_BASE)"; DA="${DA:-https://da32.host-ww.net:2222}"
[ -n "$U" ] && [ -n "$P" ] || die "GO54_USERNAME / GO54_PASSWORD missing from backend/.env"

# curl reads the login from a 0600 file in a private tmpfs dir — not argv, not env.
PRIV="$(mktemp -d -p "${XDG_RUNTIME_DIR:-/dev/shm}" hk-envsync.XXXXXX 2>/dev/null || mktemp -d)"
chmod 700 "$PRIV"; trap 'rm -rf "$PRIV"' EXIT
esc() { local v="${1//\\/\\\\}"; printf '%s' "${v//\"/\\\"}"; }
( umask 077; printf 'user = "%s:%s"\n' "$(esc "$U")" "$(esc "$P")" > "$PRIV/da.cfg" )
dl() { curl -sS --fail --max-time 120 -K "$PRIV/da.cfg" "$DA/CMD_FILE_MANAGER$1?action=download"; }

say "1/4 production env: GO54 -> standby (piped; the standby prints key names only)"
dl /hawkeye/backend/.env | rssh 'sudo /usr/local/sbin/hawkeye-standby-mode env-in secrets'

if [ "$PULLCREDS" = 1 ]; then
  if [ -n "$K" ]; then SECRET="$K"; say "2/4 pull login: DirectAdmin login key (GO54_STANDBY_KEY)"
  else SECRET="$P"; say "2/4 pull login: WARNING using the panel PASSWORD — create a restricted DirectAdmin login key (GO54_STANDBY_KEY) and re-run"; fi
  printf 'GO54_USERNAME=%s\nGO54_SECRET=%s\nDA_BASE=%s\n' "$U" "$SECRET" "$DA" | rssh 'sudo /usr/local/sbin/hawkeye-standby-mode env-in pull'
  unset SECRET
else
  say "2/4 pull login: skipped"
fi

if [ "$KEYFILES" = 1 ]; then
  say "3/4 key files"
  dl /hawkeye/backend/storage/anchor_key.json | rssh 'sudo /usr/local/sbin/hawkeye-standby-mode env-in anchor'
  P8="$(rssh 'sudo /usr/local/sbin/hawkeye-standby-mode env-path DEVICECHECK_KEY_FILE' || true)"
  if [ -n "$P8" ]; then
    # DirectAdmin paths are relative to the account home.
    rel="/${P8#/home/*/}"; [ "$rel" = "/$P8" ] && rel="$P8"
    dl "$rel" | rssh "sudo /usr/local/sbin/hawkeye-standby-mode env-in p8 $(basename "$P8")"
  else
    say "   no DEVICECHECK_KEY_FILE in production's env; skipped"
  fi
else
  say "3/4 key files: not requested"
fi

say "4/4 restart and check"
rssh 'sudo systemctl restart hawkeye-standby && sleep 4 && sudo hawkeye-standby-mode health'

#!/usr/bin/env bash
# Set CALL_HOOK_SECRET on PRODUCTION — the key the missed-call gateway phone
# signs every hook with (backend services/callVerify.js, gateway/README.md).
#
#   *** THE OWNER RUNS THIS, IN HIS OWN TERMINAL. Never an agent: it prints
#   *** the secret, once, and it writes production's .env.
#
#   bash scripts/set_call_hook_secret.sh
#
# WHAT IT DOES
#   1. Makes 24 random base32 characters (A-Z, 2-7; 120 bits) from /dev/urandom.
#   2. Downloads production's /hawkeye/backend/.env through the DirectAdmin file
#      API into a private tmpfs directory (never this laptop's disk), replaces or
#      adds the CALL_HOOK_SECRET line (written WITHOUT dashes), uploads it back,
#      then downloads it again and compares byte for byte. Any mismatch puts the
#      original back and stops.
#   3. Does NOT restart the backend: the new secret is read at the next restart.
#   4. Prints the secret ONCE as XXXX-XXXX-XXXX-XXXX-XXXX-XXXX, to type into the
#      Hawkeye call gate app. Dashes, spaces and case do not matter on either end.
#
# The GO54 login comes from backend/.env (GO54_USERNAME, GO54_PASSWORD, optional
# GO54_DA_BASE) and reaches curl through a 0600 file in tmpfs (-K): never argv,
# never the environment, never printed. Nothing else from either .env is printed.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="$REPO/backend/.env"
REMOTE_DIR=/hawkeye/backend
die() { echo "set_call_hook_secret: $*" >&2; exit 2; }
say() { echo "set_call_hook_secret: $*"; }

# Optional: the gateway SIM's number, shown to observers (public, not a secret).
#   scripts/set_call_hook_secret.sh +2347042248544
NUMBER="${1:-}"
if [ -n "$NUMBER" ]; then [[ "$NUMBER" =~ ^\+234[789][01][0-9]{8}$ ]] || die "number must look like +234XXXXXXXXXX"; fi

[ -t 0 ] && [ -t 1 ] || die "run this in your own terminal (it asks before replacing, and prints the secret once)"
[ -r "$ENVF" ] || die "no $ENVF (the GO54 login lives there)"

# Same parsing as standby_env_sync.sh / pull_backup.sh; values are never echoed.
envval() { { grep -E "^$1=" "$ENVF" || true; } | tail -1 | sed -e "s/^$1=//" -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"; }
U="$(envval GO54_USERNAME)"; P="$(envval GO54_PASSWORD)"
DA="$(envval GO54_DA_BASE)"; DA="${DA:-https://da32.host-ww.net:2222}"
[ -n "$U" ] && [ -n "$P" ] || die "GO54_USERNAME / GO54_PASSWORD missing from backend/.env"

# Everything sensitive lives here, in memory, and goes on exit.
TMPFS="${XDG_RUNTIME_DIR:-/dev/shm}"
[ -d "$TMPFS" ] || die "no tmpfs at $TMPFS (set XDG_RUNTIME_DIR)"
PRIV="$(mktemp -d -p "$TMPFS" hk-callsecret.XXXXXX)" || die "cannot make a private dir in $TMPFS"
chmod 700 "$PRIV"; trap 'rm -rf "$PRIV"' EXIT
esc() { local v="${1//\\/\\\\}"; printf '%s' "${v//\"/\\\"}"; }
( umask 077; printf 'user = "%s:%s"\n' "$(esc "$U")" "$(esc "$P")" > "$PRIV/da.cfg" )
unset P

dl() {   # dl <remote path> <local file>
  curl -sS --fail --max-time 120 -K "$PRIV/da.cfg" -o "$2" "$DA/CMD_FILE_MANAGER$1?action=download"
}
up() {   # up <local file named .env>  -> 0 when DirectAdmin says error=0
  local code
  code="$(curl -sS --max-time 120 -K "$PRIV/da.cfg" -o "$PRIV/up.txt" -w '%{http_code}' \
    -F 'action=upload' -F "path=$REMOTE_DIR" -F "file1=@$1;filename=.env" "$DA/CMD_API_FILE_MANAGER")" || return 1
  [ "$code" = 200 ] && grep -q 'error=0' "$PRIV/up.txt"
}

say "1/4 downloading production's backend/.env (kept in $TMPFS only)"
mkdir -m 700 "$PRIV/old" "$PRIV/new"
dl "$REMOTE_DIR/.env" "$PRIV/old/.env" || die "download failed — nothing changed"
# A login page or an error body must never be uploaded over the real file.
grep -q '^JWT_SECRET=' "$PRIV/old/.env" && grep -q '^PHONE_SALT=' "$PRIV/old/.env" \
  || die "what came back does not look like production's .env — nothing changed"

if grep -qE '^CALL_HOOK_SECRET=[^[:space:]]' "$PRIV/old/.env"; then
  echo
  echo "  Production ALREADY HAS a CALL_HOOK_SECRET. Replacing it means typing the new"
  echo "  one into EVERY gateway phone; until then their calls are refused (401)."
  read -r -p "  Type REPLACE to replace it, anything else to stop: " ans
  [ "$ans" = REPLACE ] || die "stopped — nothing changed"
fi

say "2/4 making the secret and the new .env"
ALPHA=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567
SECRET=""
# 256 is a multiple of 32, so byte % 32 is uniform.
for b in $(od -An -tu1 -N24 /dev/urandom); do SECRET+="${ALPHA:$((b % 32)):1}"; done
[ "${#SECRET}" -eq 24 ] || die "could not read /dev/urandom — nothing changed"

# Rewritten line by line with shell builtins only: the secret is never in a
# process's argv. Every other line, its order and its bytes are kept as they were.
replaced=0
( umask 077
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      CALL_HOOK_SECRET=*)
        if [ "$replaced" = 0 ]; then printf 'CALL_HOOK_SECRET=%s\n' "$SECRET"; replaced=1; fi ;;
      CALL_VERIFY_NUMBER=*)
        if [ -n "$NUMBER" ]; then printf 'CALL_VERIFY_NUMBER=%s\n' "$NUMBER"; else printf '%s\n' "$line"; fi ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$PRIV/old/.env"
  if [ "$replaced" = 0 ]; then
    printf '\n# Missed-call gateway hook key (scripts/set_call_hook_secret.sh)\nCALL_HOOK_SECRET=%s\n' "$SECRET"
  fi
  if [ -n "$NUMBER" ] && ! grep -q '^CALL_VERIFY_NUMBER=' "$PRIV/old/.env"; then
    printf 'CALL_VERIFY_NUMBER=%s\n' "$NUMBER"
  fi
) > "$PRIV/new/.env"
[ "$(grep -c '^CALL_HOOK_SECRET=' "$PRIV/new/.env")" = 1 ] || die "the new .env came out wrong — nothing changed"
[ "$(grep -vc '^CALL_HOOK_SECRET=\|^CALL_VERIFY_NUMBER=' "$PRIV/new/.env")" -ge "$(grep -vc '^CALL_HOOK_SECRET=\|^CALL_VERIFY_NUMBER=' "$PRIV/old/.env")" ] \
  || die "the new .env lost lines — nothing changed"

say "3/4 uploading, then checking the upload byte for byte"
if ! up "$PRIV/new/.env" || ! dl "$REMOTE_DIR/.env" "$PRIV/check.env" || ! cmp -s "$PRIV/new/.env" "$PRIV/check.env"; then
  say "   the upload did not land intact — putting the original back"
  if up "$PRIV/old/.env" && dl "$REMOTE_DIR/.env" "$PRIV/check.env" && cmp -s "$PRIV/old/.env" "$PRIV/check.env"; then
    die "original restored; the secret was NOT changed"
  fi
  die "COULD NOT RESTORE production's .env — check /hawkeye/backend/.env in DirectAdmin NOW, before any restart"
fi

say "4/4 done. The backend was NOT restarted: the new secret takes effect at the next restart."
if [ -n "$NUMBER" ]; then say "    CALL_VERIFY_NUMBER set to $NUMBER"; else say "    CALL_VERIFY_NUMBER unchanged (pass +234... to set it)."; fi
echo
echo "  Type this into the Hawkeye Callgate app (Shared secret), then tap Save:"
echo
printf '      %s-%s-%s-%s-%s-%s\n' "${SECRET:0:4}" "${SECRET:4:4}" "${SECRET:8:4}" "${SECRET:12:4}" "${SECRET:16:4}" "${SECRET:20:4}"
echo
echo "  It is shown ONCE. Letters A-Z and digits 2-7 only (O is a letter, never zero)."
echo "  Clear this terminal when it is typed in."
unset SECRET

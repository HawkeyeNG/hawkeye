#!/usr/bin/env bash
# Prove the 1Password copies of the secret files match the files on disk —
# run by the OWNER in his own terminal (Windows Hello approves 1Password there;
# an agent's session cannot). Compares bytes only; nothing is printed.
#
#   bash ~/hawkeye/scripts/lib/hk_secrets_check.sh
#
# FALLBACK means the helper could not read 1Password and used the file — that is
# reported as a failure here, so a match can never be a file compared with itself.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/scripts/lib/hk_secrets.sh"
bad=0
check() {
  local doc="$1" file="$2" p
  p=$(hk_secret_path "$doc" "$file" 2>/dev/null)
  if [ "$p" = "$file" ]; then echo "FALLBACK  $doc — not read from 1Password"; bad=1; return; fi
  if cmp -s <(tr -d '\r' < "$p") <(tr -d '\r' < "$file"); then echo "MATCH     $doc"; else echo "DIFFERS   $doc — the 1Password copy is not the file on disk"; bad=1; fi
  rm -f "$p"
}
check standby.env "$HOME/.config/hawkeye/standby.env"
check cf_failover.env "$HOME/.config/hawkeye/cf_failover.env"
check "Backend .env (server)" "$REPO/backend/.env"
[ "$bad" = 0 ] && echo "All three read from 1Password and match." || echo "Not all matched — tell Claude which line failed."

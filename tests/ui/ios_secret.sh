#!/usr/bin/env bash
#
# Put one iOS signing secret on the Windows clipboard, ready to paste into
# GitHub → Settings → Secrets and variables → Actions → New repository secret.
#
#   ./ios_secret.sh                       list the eight names
#   ./ios_secret.sh APPLE_TEAM_ID         copy that one
#   ./ios_secret.sh --all                 walk all eight, pausing between each
#
# The value goes to the clipboard, never to the terminal: a secret echoed once
# stays in scrollback, in the session log, and in any transcript of it.
set -euo pipefail

OUT="$HOME/hawkeye-secrets/ios/github-secrets"
[ -d "$OUT" ] || { echo "not built yet — run build_ios_secrets.sh first" >&2; exit 1; }

NAMES=(
  BUILD_CERTIFICATE_BASE64
  P12_PASSWORD
  PROVISIONING_PROFILE_BASE64
  KEYCHAIN_PASSWORD
  APPSTORE_KEY_ID
  APPSTORE_ISSUER_ID
  APPSTORE_PRIVATE_KEY
  APPLE_TEAM_ID
)

copy_one() {
  local n="$1"
  [ -f "$OUT/$n" ] || { echo "no such secret: $n" >&2; return 1; }
  # -n on the password/id values would be wrong for APPSTORE_PRIVATE_KEY, whose
  # trailing newline is part of a valid PEM. Copy each file byte for byte.
  clip.exe < "$OUT/$n"
  printf 'copied %s (%s bytes) to the clipboard\n' "$n" "$(stat -c %s "$OUT/$n")"
}

if [ $# -eq 0 ]; then
  echo "secrets available (values are never printed):"
  for n in "${NAMES[@]}"; do
    printf '  %-30s %6s bytes\n' "$n" "$(stat -c %s "$OUT/$n" 2>/dev/null || echo '?')"
  done
  echo
  echo "usage: ./ios_secret.sh <NAME>   |   ./ios_secret.sh --all"
  exit 0
fi

if [ "$1" = "--all" ]; then
  for n in "${NAMES[@]}"; do
    copy_one "$n"
    printf '  -> paste it as %s, then press Enter for the next one: ' "$n"
    read -r _ </dev/tty
  done
  echo "all eight done"
  exit 0
fi

copy_one "$1"

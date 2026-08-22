#!/usr/bin/env bash
#
# Push all eight iOS signing secrets to the GitHub repo in one go.
#
#   gh auth login          (once — needs a human; it opens a browser)
#   ./set_ios_secrets.sh
#
# Each value is piped from its file straight into `gh secret set`, so no secret
# is ever an argument (arguments show up in `ps` and in shell history) and none
# is ever printed.
set -euo pipefail

REPO="${REPO:-HawkeyeNG/hawkeye}"
OUT="$HOME/hawkeye-secrets/ios/github-secrets"

command -v gh >/dev/null || {
  cat >&2 <<'MSG'
gh is not installed.

  Debian/Ubuntu:  sudo apt install gh
  or:             https://github.com/cli/cli/releases  (single binary, no root)

Then run `gh auth login` once and re-run this script. If you would rather not
install it, ./ios_secret.sh --all walks the same eight values onto the
clipboard for pasting into the GitHub UI.
MSG
  exit 1
}

gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }
[ -d "$OUT" ] || { echo "not built yet — run build_ios_secrets.sh first" >&2; exit 1; }

for f in "$OUT"/*; do
  n="$(basename "$f")"
  gh secret set "$n" --repo "$REPO" < "$f"
  printf 'set %s\n' "$n"
done

echo
echo "now on $REPO:"
gh secret list --repo "$REPO"

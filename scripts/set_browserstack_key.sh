#!/usr/bin/env bash
# Store the BrowserStack credentials for Claude's test runs — run by the OWNER
# in his own terminal, so the access key never passes through Claude.
#
#   bash ~/hawkeye/scripts/set_browserstack_key.sh
#
# Where to find them: browserstack.com → sign in as security@hawkeye.com.ng →
# Account (top right) → "Access Key" (or Automate dashboard → the key icon).
# It asks for the USERNAME (shown) and the ACCESS KEY (hidden), checks them
# against BrowserStack's API, and only then writes
#   ~/.config/hawkeye/browserstack.env   (mode 600, never committed)
# Re-run it any time the key is regenerated.
set -euo pipefail
[ -t 0 ] && [ -t 1 ] || { echo "run this in your own terminal (it asks for the key)"; exit 2; }
OUT="$HOME/.config/hawkeye/browserstack.env"
read -r -p "BrowserStack username: " BS_USER
read -r -s -p "BrowserStack access key (hidden): " BS_KEY; echo
[ -n "$BS_USER" ] && [ -n "$BS_KEY" ] || { echo "both are needed"; exit 1; }

# The key goes to curl on stdin (-K -), so it is never on a command line or in ps.
probe() { printf 'user = "%s:%s"\n' "$BS_USER" "$BS_KEY" | curl -s -o /tmp/bs_probe.$$ -w '%{http_code}' -K - "$1"; }
ok=0
for u in https://api.browserstack.com/automate/plan.json https://api-cloud.browserstack.com/app-automate/plan.json; do
  code=$(probe "$u" || true)
  if [ "$code" = 200 ]; then
    ok=1
    echo "OK  $(basename "$(dirname "$u")"): $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print({k: v for k, v in d.items() if "plan" in k or "parallel" in k})' /tmp/bs_probe.$$ 2>/dev/null)"
  else
    echo "--  $(basename "$(dirname "$u")"): HTTP $code"
  fi
done
rm -f /tmp/bs_probe.$$
[ "$ok" = 1 ] || { echo "!! BrowserStack refused both checks — wrong username or key? Nothing was saved."; exit 1; }

umask 077
mkdir -p "$(dirname "$OUT")"
printf 'BROWSERSTACK_USERNAME=%s\nBROWSERSTACK_ACCESS_KEY=%s\n' "$BS_USER" "$BS_KEY" > "$OUT.tmp"
chmod 600 "$OUT.tmp"; mv -f "$OUT.tmp" "$OUT"
unset BS_KEY
echo "Saved to $OUT (mode 600). Tell Claude it's done. Then clear this terminal: clear"

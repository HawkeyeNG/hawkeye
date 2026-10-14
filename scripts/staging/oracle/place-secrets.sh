#!/bin/bash
# THE OWNER RUNS THIS, on the election server, to put the live site's secrets in place. Claude never
# sees them: paste the production .env (KEY=VALUE lines, as GO54 holds them) into this script's
# prompt in YOUR terminal, then press Ctrl-D. Each secret becomes one root-only file in
# /etc/hawkeye/params/env/, which the boot loader reads (bootstrap.sh prestart). Only the NAMES
# are printed. Settings the build writes itself (APP_ENV, DB_PATH, PORT...) are skipped.
#
#   sudo bash place-secrets.sh            then paste, then Ctrl-D
#   sudo bash place-secrets.sh --pem DEVICECHECK_KEY
#        paste a multi-line key file (the Apple AuthKey_*.p8); stored as ONE line with literal \n,
#        the form the backend reads (services/devicecheck.js), so no file has to be copied
#   sudo bash place-secrets.sh --tls cert      (then --tls key)
#        paste the Cloudflare Origin CA certificate / its private key for hawkeye.com.ng
#   sudo bash place-secrets.sh --litestream-from-bucket
#        the database's continuous copy uses the bucket keys already placed (no paste)
#
# The secrets MUST be the live site's own: a new PHONE_SALT or JWT_SECRET locks every observer out.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
name="$(curl -fsS -m 5 -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/displayName || true)"
[ "$name" = hawkeye-production ] || { echo "REFUSED: this machine is '$name', not hawkeye-production" >&2; exit 1; }
D=/etc/hawkeye/params/env
install -d -m 0700 /etc/hawkeye/params "$D"
# Echo off ONCE for the whole paste: `read -s` turns it off line by line, and a paste that arrives
# over ssh in pieces was shown in the gaps between lines (14 Oct). Restored however this exits.
t=""
if [ -t 0 ]; then
  TTY_SAVED="$(stty -g)"; stty -echo
  trap 'stty "$TTY_SAVED"; [ -z "$t" ] || rm -f "$t"' EXIT
else
  trap '[ -z "$t" ] || rm -f "$t"' EXIT
fi
case "${1:-}" in
  --pem)
    n="${2:-}"; [[ "$n" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "usage: --pem NAME" >&2; exit 2; }
    echo "Paste the key file now, then press Ctrl-D (nothing you paste is shown back):"
    t="$(mktemp)"
    while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "${l%$'\r'}"; done > "$t"; echo
    grep -q -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$t" && grep -q -- '-----END [A-Z ]*PRIVATE KEY-----' "$t" \
      || { echo "REFUSED: that is not a PEM private key (no BEGIN/END PRIVATE KEY lines)" >&2; exit 1; }
    (umask 077; awk 'NF { printf "%s\\n", $0 }' "$t" > "$D/$n.tmp"); mv "$D/$n.tmp" "$D/$n"
    echo "written: $n (one line, $(wc -c < "$D/$n") characters)"; exit 0 ;;
  --tls)
    w="${2:-}"; case "$w" in cert) f=origin_cert; want=CERTIFICATE ;; key) f=origin_key; want="PRIVATE KEY" ;; *) echo "usage: --tls cert|key" >&2; exit 2 ;; esac
    install -d -m 0700 /etc/hawkeye/params/tls
    echo "Paste the Origin CA $w now, then press Ctrl-D (nothing you paste is shown back):"
    t="$(mktemp)"
    while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "${l%$'\r'}"; done > "$t"; echo
    grep -q -- "-----BEGIN [A-Z ]*$want-----" "$t" || { echo "REFUSED: that does not look like a $w (no BEGIN ... $want line)" >&2; exit 1; }
    (umask 077; cp "$t" "/etc/hawkeye/params/tls/$f.tmp"); mv "/etc/hawkeye/params/tls/$f.tmp" "/etc/hawkeye/params/tls/$f"
    echo "written: tls/$f"; exit 0 ;;
  --litestream-from-bucket)
    L=/etc/hawkeye/params/litestream; install -d -m 0700 "$L"
    for k in BUCKET ENDPOINT ACCESS_KEY_ID SECRET_ACCESS_KEY; do
      [ -s "$D/S3_$k" ] || { echo "REFUSED: $D/S3_$k is missing; place the bucket keys first" >&2; exit 1; }
      (umask 077; cp "$D/S3_$k" "$L/R2_$k")
    done
    echo "written: litestream/R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY (from the bucket keys; the copy lives under its own path in that bucket)"; exit 0 ;;
  "") ;;
  *) echo "usage: place-secrets.sh [--pem NAME | --tls cert|key | --litestream-from-bucket]" >&2; exit 2 ;;
esac
SKIP=" APP_ENV NODE_ENV PORT HOST DB_PATH UPLOAD_DIR PUBLIC_BASE_URL UV_THREADPOOL_SIZE READERS ROLE HOST_ID "
echo "Paste the production .env now, then press Ctrl-D (nothing you paste is shown back):"
written=""; skipped=""; bad=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  k="${line%%=*}"; v="${line#*=}"
  k="${k#export }"; k="${k// /}"
  [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || { bad="$bad ${k:0:20}"; continue; }
  case "$SKIP" in *" $k "*) skipped="$skipped $k"; continue ;; esac
  # One layer of surrounding quotes is .env syntax, not part of the value. Escapes inside stay
  # literal: FCM_PRIVATE_KEY must keep its \n sequences (backend services/push.js).
  if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  (umask 077; printf '%s' "$v" > "$D/$k.tmp"); mv "$D/$k.tmp" "$D/$k"
  written="$written $k"
done
echo
echo "written ($(wc -w <<<"$written")):$written"
[ -z "$skipped" ] || echo "skipped (the build sets these):$skipped"
[ -z "$bad" ] || echo "NOT understood (fix and paste again):$bad"
miss=""
for p in JWT_SECRET ORACLE_SECRET PHONE_SALT ORIGIN_AUTH_SECRET S3_BUCKET S3_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  [ -s "$D/$p" ] || miss="$miss $p"
done
[ -z "$miss" ] && echo "all the secrets the server needs to start are present" || echo "STILL MISSING (the server will refuse to start):$miss"

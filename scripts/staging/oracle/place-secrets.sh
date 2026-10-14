#!/bin/bash
# THE OWNER RUNS THIS, on the election server, to put the live site's secrets in place. Claude never
# sees them: paste the production .env (KEY=VALUE lines, as GO54 holds them) into this script's
# prompt in YOUR terminal, then press Ctrl-D. Each secret becomes one root-only file in
# /etc/hawkeye/params/env/, which the boot loader reads (bootstrap.sh prestart). Only the NAMES
# are printed. Settings the build writes itself (APP_ENV, DB_PATH, PORT...) are skipped.
#
#   sudo bash place-secrets.sh            then paste, then Ctrl-D
#
# The secrets MUST be the live site's own: a new PHONE_SALT or JWT_SECRET locks every observer out.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
name="$(curl -fsS -m 5 -H 'Authorization: Bearer Oracle' http://169.254.169.254/opc/v2/instance/displayName || true)"
[ "$name" = hawkeye-production ] || { echo "REFUSED: this machine is '$name', not hawkeye-production" >&2; exit 1; }
D=/etc/hawkeye/params/env
install -d -m 0700 /etc/hawkeye/params "$D"
SKIP=" APP_ENV NODE_ENV PORT HOST DB_PATH UPLOAD_DIR PUBLIC_BASE_URL UV_THREADPOOL_SIZE READERS ROLE HOST_ID "
echo "Paste the production .env now, then press Ctrl-D (nothing you paste is shown back):"
written=""; skipped=""; bad=""
while IFS= read -r -s line || [ -n "$line" ]; do
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

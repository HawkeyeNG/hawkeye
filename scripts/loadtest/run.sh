#!/usr/bin/env bash
# Hawkeye load-test wrapper. The k6 scripts guard themselves too; this is the
# first of three locks (wrapper -> k6 init context -> /api/health in setup()).
#
#   scripts/loadtest/run.sh <read|upload|auth|ramp> --base-url URL [options]
#
#   --base-url URL           target (required). Staging: https://staging.hawkeye.com.ng
#   --profile NAME           smoke (default) | origin | stress | edge
#   --scale N                multiply every rate in the profile (default 1)
#   --time-scale N           stretch/compress the ramp shape (0.2 = ~6 min)
#   --fixtures FILE          seed output (upload, auth, ramp; optional for read)
#   --sheet FILE --venue FILE  synthetic JPEGs (defaults: .fixtures/sheet.jpg, venue.jpg)
#   --direct-origin          target is the staging ORIGIN (no Cloudflare): send
#                            synthetic CF-Connecting-IP from 198.18.0.0/15
#   --legacy                 also hit the shapes shipped clients use today
#                            (1,000-row ledger default, unbounded /api/results)
#   --upload-path direct|proxy
#   --out DIR                results directory (default results/<timestamp>)
#   --i-know-this-is-prod    allow the READ scenario, capped, against production
#
# Production = hawkeye.com.ng or any subdomain except staging.hawkeye.com.ng,
# OR any server whose /api/health says env=production.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "run.sh: $*" >&2; exit 2; }

[ $# -ge 1 ] || die "usage: run.sh <read|upload|auth|ramp> --base-url URL [options]"
SCENARIO="$1"; shift
case "$SCENARIO" in
  read)   SCRIPT="$HERE/scenarios/read-storm.js" ;;
  upload) SCRIPT="$HERE/scenarios/report-upload.js" ;;
  auth)   SCRIPT="$HERE/scenarios/auth-otp.js" ;;
  ramp)   SCRIPT="$HERE/scenarios/ramp.js" ;;
  *) die "unknown scenario '$SCENARIO' (read|upload|auth|ramp)" ;;
esac

BASE_URL=""; PROFILE="smoke"; SCALE="1"; TIME_SCALE="1"; FIXTURES=""; SHEET=""; VENUE=""
DIRECT=""; LEGACY=""; UPLOAD_PATH="direct"; OUT=""; PROD_FLAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --scale) SCALE="${2:-}"; shift 2 ;;
    --time-scale) TIME_SCALE="${2:-}"; shift 2 ;;
    --fixtures) FIXTURES="${2:-}"; shift 2 ;;
    --sheet) SHEET="${2:-}"; shift 2 ;;
    --venue) VENUE="${2:-}"; shift 2 ;;
    --direct-origin) DIRECT=1; shift ;;
    --legacy) LEGACY=1; shift ;;
    --upload-path) UPLOAD_PATH="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --i-know-this-is-prod) PROD_FLAG=1; shift ;;
    *) die "unknown option '$1'" ;;
  esac
done

[ -n "$BASE_URL" ] || die "--base-url is required"
BASE_URL="${BASE_URL%/}"
HOST="$(printf '%s' "$BASE_URL" | sed -E 's#^[a-zA-Z]+://##; s#[/:?].*$##' | tr 'A-Z' 'a-z')"
[ -n "$HOST" ] || die "cannot parse host from $BASE_URL"

is_prod_name() {
  case "$1" in
    staging.hawkeye.com.ng) return 1 ;;
    hawkeye.com.ng|*.hawkeye.com.ng) return 0 ;;
    *) return 1 ;;
  esac
}

PROD=""
if is_prod_name "$HOST"; then
  PROD=1
  # Refuse on the NAME before sending production a single request.
  [ -n "$PROD_FLAG" ] || die "REFUSED: $HOST is PRODUCTION. Point --base-url at staging. (Read-only smoke: add --i-know-this-is-prod.)"
  [ "$SCENARIO" = "read" ] || die "REFUSED: only the read scenario may run against production, even with --i-know-this-is-prod."
fi

# Ask the server what it is. A production server behind an IP or another name
# is still production.
HEALTH="$(curl -fsS --max-time 15 -H 'X-Loadtest: 1' "$BASE_URL/api/health" 2>/dev/null || true)"
[ -n "$HEALTH" ] || die "cannot reach $BASE_URL/api/health (check the URL; the k6 setup() check would refuse too)"
if printf '%s' "$HEALTH" | grep -Eq '"env"[[:space:]]*:[[:space:]]*"production"'; then PROD=1; fi

if [ -n "$PROD" ]; then
  [ -n "$PROD_FLAG" ] || die "REFUSED: $HOST is PRODUCTION. Point --base-url at staging. (Read-only smoke: add --i-know-this-is-prod.)"
  [ "$SCENARIO" = "read" ] || die "REFUSED: only the read scenario may run against production, even with --i-know-this-is-prod."
  [ -z "$DIRECT" ] || die "REFUSED: --direct-origin is staging-only."
  [ -z "$LEGACY" ] || die "REFUSED: --legacy is staging-only."
  [ -z "$FIXTURES" ] || die "REFUSED: fixtures are staging-only."
  case "$PROFILE" in smoke|edge) ;; *) die "REFUSED: production allows --profile smoke or edge only." ;; esac
  [ -z "${ORIGIN_AUTH:-}" ] || die "REFUSED: unset ORIGIN_AUTH; never send an origin secret to production."
  echo "run.sh: PRODUCTION read smoke against $HOST, capped at ${PROD_MAX_RPS:-25} req/s for 3 min." >&2
  export I_KNOW_THIS_IS_PROD="$HOST"
else
  unset I_KNOW_THIS_IS_PROD || true
  if [ "$SCENARIO" != "read" ]; then
    printf '%s' "$HEALTH" | grep -Eq '"smsOtp"[[:space:]]*:[[:space:]]*false' \
      || die "REFUSED: $HOST does not report smsOtp=false."
    printf '%s' "$HEALTH" | grep -Eq '"waCloud"[[:space:]]*:[[:space:]]*false' \
      || die "REFUSED: $HOST does not report waCloud=false."
  fi
fi

command -v k6 >/dev/null 2>&1 || die "k6 not found (https://grafana.com/docs/k6/latest/set-up/install-k6/). k6 >= 1.0 is required."

abspath() { [ -z "$1" ] && return 0; (cd "$(dirname "$1")" && printf '%s/%s' "$(pwd)" "$(basename "$1")"); }
if [ -n "$FIXTURES" ]; then [ -f "$FIXTURES" ] || die "fixtures not found: $FIXTURES"; FIXTURES="$(abspath "$FIXTURES")"; fi
if [ "$SCENARIO" = "upload" ] || [ "$SCENARIO" = "ramp" ]; then
  SHEET="${SHEET:-$HERE/.fixtures/sheet.jpg}"; VENUE="${VENUE:-$HERE/.fixtures/venue.jpg}"
  [ -f "$SHEET" ] && [ -f "$VENUE" ] || die "synthetic JPEGs missing (run seed/make_sample_jpegs.mjs)"
  SHEET="$(abspath "$SHEET")"; VENUE="$(abspath "$VENUE")"
fi

OUT="${OUT:-$HERE/results/$(date -u +%Y%m%dT%H%M%SZ)-$SCENARIO-$PROFILE}"
mkdir -p "$OUT"
echo "run.sh: $SCENARIO / $PROFILE x$SCALE -> $BASE_URL  (results: $OUT)" >&2

exec k6 run \
  -e BASE_URL="$BASE_URL" -e PROFILE="$PROFILE" -e SCALE="$SCALE" -e TIME_SCALE="$TIME_SCALE" \
  -e FIXTURES="$FIXTURES" -e SHEET_JPEG="$SHEET" -e VENUE_JPEG="$VENUE" \
  -e DIRECT_ORIGIN="$DIRECT" -e LEGACY="$LEGACY" -e UPLOAD_PATH="$UPLOAD_PATH" \
  -e PROD_MAX_RPS="${PROD_MAX_RPS:-25}" -e I_KNOW_THIS_IS_PROD="${I_KNOW_THIS_IS_PROD:-}" \
  --summary-export "$OUT/summary.json" \
  "$SCRIPT"

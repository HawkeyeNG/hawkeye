#!/usr/bin/env bash
# Publish a native OTA update to Hawkeye's OWN Expo Updates server on R2 (design D9), instead of
# EAS Update (billed per device updated). DRY RUN BY DEFAULT: builds, signs and verifies locally;
# only --apply touches R2. Runbook: docs/OTA-SELF-HOSTED.md.
#
#   scripts/ota_publish_self.sh [--platform ios|android|all] [--message "what changed"]      publish
#   scripts/ota_publish_self.sh --rollback-embedded --platform ios|android|all                every device on
#                                          this runtime goes back to the bundle inside its store build
#   scripts/ota_publish_self.sh --republish <update-id> --platform ios|android                re-issue an
#                                          earlier update as the newest (the "roll back to X" path)
#   scripts/ota_publish_self.sh --unpublish --platform ios|android|all                        remove the
#                                          current pointer: the server answers 204, devices keep what they run
#   scripts/ota_publish_self.sh --status [--platform ...]     fetch the LIVE manifest as a phone does and verify it
#   scripts/ota_publish_self.sh --history --platform ios|android      list published updates (needs R2 keys)
# Options: --apply (write to R2) · --channel production · --runtime X (default: resolved from app config)
#          --dist DIR (publish an existing `expo export` output instead of exporting again)
#
# Env (never printed):
#   EXPO_UPDATES_PRIVATE_KEY_FILE  default ~/hawkeye-secrets/expo-updates/private-key.pem
#   EXPO_UPDATES_PRIVATE_KEY       the PEM itself (GitHub secret of the same name), wins over the file
#   OTA_R2_ENDPOINT                https://<account-id>.r2.cloudflarestorage.com      (only for --apply/--history)
#   OTA_R2_ACCESS_KEY_ID / OTA_R2_SECRET_ACCESS_KEY    R2 Account API token, Object Read & Write, THIS bucket only
#   OTA_R2_BUCKET                  default hawkeye-updates (never the evidence bucket, never hawkeye-tiles)
#   OTA_BASE_URL                   default https://updates.hawkeye.com.ng (where asset URLs and /manifest point)
#   OTA_OUT                        default /tmp/hawkeye-ota/<UTC stamp>
#   OTA_ALLOW_OLD_RUNTIME=1        TESTS ONLY (scripts/ota_test.sh): skip the "runtime >= 1.0.9" guard
#
# ONLY builds whose native config carries the self-hosted updates.url read this server: 1.0.9 and
# later. 1.0.8 and earlier read EAS; publishing their runtime here would reach nobody, so it is refused.
set -euo pipefail
set +x   # never trace: the R2 keys are in the environment

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$REPO/native"
TOOL="$REPO/scripts/ota_manifest.mjs"
FIRST_SELF_HOSTED_RUNTIME="1.0.9"
APP_URL="https://updates.hawkeye.com.ng/manifest"   # must equal native/app.json updates.url
BASE="${OTA_BASE_URL:-https://updates.hawkeye.com.ng}"; BASE="${BASE%/}"
VERIFY_EXTRA=(); case "$BASE" in http://127.0.0.1:*) VERIFY_EXTRA=(--allow-http) ;; esac   # the local test server
BUCKET="${OTA_R2_BUCKET:-hawkeye-updates}"
export EXPO_UPDATES_PRIVATE_KEY_FILE="${EXPO_UPDATES_PRIVATE_KEY_FILE:-$HOME/hawkeye-secrets/expo-updates/private-key.pem}"

die() { echo "ota_publish_self: $*" >&2; exit 1; }
say() { echo "== $*" >&2; }

MODE=publish APPLY="" PLATFORM=all MESSAGE="" CHANNEL=production RUNTIME="${OTA_RUNTIME:-}" REPUB_ID="" DIST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --message) MESSAGE="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --rollback-embedded) MODE=rollback; shift ;;
    --republish) MODE=republish; REPUB_ID="${2:-}"; shift 2 ;;
    --unpublish) MODE=unpublish; shift ;;
    --status) MODE=status; shift ;;
    --history) MODE=history; shift ;;
    --dist) DIST="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
case "$PLATFORM" in ios|android) PLATFORMS=("$PLATFORM") ;; all) PLATFORMS=(ios android) ;; *) die "--platform ios|android|all" ;; esac
[[ "$CHANNEL" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "bad --channel"
if [ "$MODE" = republish ] || [ "$MODE" = history ]; then [ "${#PLATFORMS[@]}" = 1 ] || die "--$MODE needs one --platform"; fi
[ "$MODE" != republish ] || [[ "$REPUB_ID" =~ ^[0-9a-f-]{36}$ ]] || die "--republish needs an update id (a UUID)"
command -v node >/dev/null || die "node not found"

# ---- the app config this publish is for ------------------------------------------------------
URL_IN_APP="$(node -e 'const u=require(process.argv[1]).expo.updates||{};process.stdout.write(u.url||"")' "$NATIVE/app.json")"
[ "$URL_IN_APP" = "$APP_URL" ] || die "native/app.json updates.url is '$URL_IN_APP', not $APP_URL.
  If eas-cli rewrote it (\"Overwrote updates.url\"), restore it: git checkout native/app.json"
if [ -z "$RUNTIME" ]; then
  RUNTIME="$(cd "$NATIVE" && APP_VARIANT=production npx --no-install expo-updates runtimeversion:resolve --platform "${PLATFORMS[0]}" --workflow managed \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).runtimeVersion||""))')" \
    || die "expo-updates runtimeversion:resolve failed (run it in native/ to see why)"
fi
[[ "$RUNTIME" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]] || die "could not resolve the runtime version ('$RUNTIME')"
if [ -z "${OTA_ALLOW_OLD_RUNTIME:-}" ] && [ "$(printf '%s\n%s\n' "$FIRST_SELF_HOSTED_RUNTIME" "$RUNTIME" | sort -V | head -1)" != "$FIRST_SELF_HOSTED_RUNTIME" ]; then
  die "runtime $RUNTIME: builds up to 1.0.8 read EAS, not this server. Publish for them with EAS from a checkout of that release (docs/OTA-SELF-HOSTED.md), or bump native/app.json version first."
fi

need_key() {
  if [ -n "${EXPO_UPDATES_PRIVATE_KEY:-}" ]; then return; fi
  [ -r "$EXPO_UPDATES_PRIVATE_KEY_FILE" ] || die "no signing key: $EXPO_UPDATES_PRIVATE_KEY_FILE (or EXPO_UPDATES_PRIVATE_KEY)"
  case "$(realpath "$EXPO_UPDATES_PRIVATE_KEY_FILE")" in "$REPO"/*) die "the private key must not live inside the repository" ;; esac
  [ -z "$(find "$EXPO_UPDATES_PRIVATE_KEY_FILE" -perm /077 2>/dev/null)" ] || echo "ota_publish_self: WARNING $EXPO_UPDATES_PRIVATE_KEY_FILE is readable by others (chmod 600)" >&2
}
need_r2() {
  for v in OTA_R2_ENDPOINT OTA_R2_ACCESS_KEY_ID OTA_R2_SECRET_ACCESS_KEY; do [ -n "${!v:-}" ] || die "$v is not set"; done
  [[ "$OTA_R2_ENDPOINT" =~ ^https://[0-9a-f]{32}\.(eu\.)?r2\.cloudflarestorage\.com/?$ ]] || die "OTA_R2_ENDPOINT is not an R2 S3 endpoint"
  case "$BUCKET" in *evidence*|*tiles*|*db*|*backup*) die "refusing bucket '$BUCKET': OTA objects go in their own bucket" ;; esac
  command -v aws >/dev/null || die "aws CLI not found (it speaks R2's S3 API)"
}
r2() {   # the keys go to aws through its environment only; never on a command line, never echoed
  env -u AWS_PROFILE -u AWS_SESSION_TOKEN \
    AWS_ACCESS_KEY_ID="$OTA_R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$OTA_R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION=auto AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    aws --endpoint-url "${OTA_R2_ENDPOINT%/}" --no-cli-pager "$@"
}
live() {   # $1 platform, rest: extra verify args. Prints the verifier's JSON; exit 2 = verification failed.
  local p="$1"; shift
  node "$TOOL" verify --url "$BASE/manifest" --platform "$p" --runtime "$RUNTIME" --channel "$CHANNEL" ${VERIFY_EXTRA[@]+"${VERIFY_EXTRA[@]}"} "$@"
}
upload_plan() {   # $1 plan.tsv: assets first (skipped when present: content-addressed), archive, pointer LAST
  local phase key file ctype cache n=0 skipped=0
  while IFS=$'\t' read -r phase key file ctype cache; do
    if [ "$phase" = asset ] && r2 s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1; then skipped=$((skipped + 1)); continue; fi
    r2 s3api put-object --bucket "$BUCKET" --key "$key" --body "$file" --content-type "$ctype" --cache-control "$cache" >/dev/null \
      || die "upload failed at $key (nothing after it was written; the pointer switch is always last)"
    n=$((n + 1))
  done < "$1"
  say "uploaded $n objects ($skipped assets already present)"
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OTA_OUT:-/tmp/hawkeye-ota/$STAMP}"

case "$MODE" in
status)
  for p in "${PLATFORMS[@]}"; do echo "$p $RUNTIME/$CHANNEL: $(live "$p" || true)"; done
  exit 0 ;;
history)
  need_r2
  r2 s3api list-objects-v2 --bucket "$BUCKET" --prefix "updates/$CHANNEL/$RUNTIME/${PLATFORMS[0]}/" \
    --query 'Contents[?ends_with(Key, `/response`)].[LastModified, Key]' --output text | sort
  echo "current: $(live "${PLATFORMS[0]}" || true)"
  exit 0 ;;
esac

# ---- build the objects locally ---------------------------------------------------------------
mkdir -p "$OUT"
[ "$MODE" = unpublish ] || need_key
declare -A NEWID PREV
for p in "${PLATFORMS[@]}"; do
  # What is live now, so a failure below comes with a ready rollback command.
  PREV[$p]="$(live "$p" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok?(j.id||j.kind):"unverifiable")}catch{process.stdout.write("unreachable")}})' || true)"
done

case "$MODE" in
publish)
  if [ -n "$DIST" ]; then
    [ -f "$DIST/metadata.json" ] || die "--dist $DIST has no metadata.json (not an expo export output)"
    say "using the existing export $DIST (not re-exporting)"
  else
    DIST="$OUT/dist"
    say "export (APP_VARIANT=production, $RUNTIME, ${PLATFORMS[*]}) -> $DIST"
    EXPORT_ARGS=(); for p in "${PLATFORMS[@]}"; do EXPORT_ARGS+=(--platform "$p"); done
    (cd "$NATIVE" && APP_VARIANT=production npx --no-install expo export "${EXPORT_ARGS[@]}" --output-dir "$DIST" --clear > "$OUT/export.log" 2>&1) \
      || { tail -30 "$OUT/export.log" >&2; die "expo export failed (log: $OUT/export.log)"; }
  fi
  (cd "$NATIVE" && APP_VARIANT=production npx --no-install expo config --type public --json > "$OUT/expo-config.json" 2>"$OUT/config.log") \
    || die "expo config failed (log: $OUT/config.log)"
  for p in "${PLATFORMS[@]}"; do
    rm -f "$OUT/plan.tsv"
    j="$(node "$TOOL" build --dist "$DIST" --expo-config "$OUT/expo-config.json" --platform "$p" --runtime "$RUNTIME" \
         --channel "$CHANNEL" --base "$BASE" --out "$OUT" --message "$MESSAGE")" || die "build failed for $p"
    echo "$j"; NEWID[$p]="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$j")"
    cp "$OUT/plan.tsv" "$OUT/plan-$p.tsv"
  done ;;
rollback)
  for p in "${PLATFORMS[@]}"; do
    rm -f "$OUT/plan.tsv"
    node "$TOOL" rollback --platform "$p" --runtime "$RUNTIME" --channel "$CHANNEL" --out "$OUT" || die "rollback directive failed for $p"
    NEWID[$p]=directive; cp "$OUT/plan.tsv" "$OUT/plan-$p.tsv"
  done ;;
republish)
  p="${PLATFORMS[0]}"; old="$OUT/republish-source.json"
  curl -fsS --max-time 30 -o "$old" "$BASE/updates/$CHANNEL/$RUNTIME/$p/$REPUB_ID/manifest.json" \
    || die "cannot fetch the archived manifest $REPUB_ID for $p/$RUNTIME/$CHANNEL (see --history)"
  j="$(node "$TOOL" republish --manifest "$old" --platform "$p" --runtime "$RUNTIME" --channel "$CHANNEL" --base "$BASE" --out "$OUT")" || die "republish failed"
  echo "$j"; NEWID[$p]="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$j")"
  cp "$OUT/plan.tsv" "$OUT/plan-$p.tsv" ;;
unpublish)
  for p in "${PLATFORMS[@]}"; do NEWID[$p]=none; done ;;
esac

# ---- verify locally what would be uploaded ----------------------------------------------------
if [ "$MODE" != unpublish ]; then
  for p in "${PLATFORMS[@]}"; do
    f="$OUT/r2/manifests/$CHANNEL/$RUNTIME/$p"
    ct="$(node -e 'process.stdout.write((require(process.argv[1])[process.argv[2]]||{}).contentType||"")' "$OUT/r2/.meta.json" "manifests/$CHANNEL/$RUNTIME/$p")"
    node "$TOOL" verify --file "$f" --content-type "$ct" --platform "$p" --runtime "$RUNTIME" --channel "$CHANNEL" --expect-id "${NEWID[$p]}" \
      ${VERIFY_EXTRA[@]+"${VERIFY_EXTRA[@]}"} >/dev/null \
      || die "local verification of $p failed; nothing uploaded"
  done
  say "signed and verified locally: $OUT"
fi

if [ -z "$APPLY" ]; then
  echo
  echo "DRY RUN: nothing was written to R2."
  for p in "${PLATFORMS[@]}"; do
    echo "  $p $RUNTIME/$CHANNEL: live now ${PREV[$p]}  ->  would become ${NEWID[$p]}"
    if [ "$MODE" = unpublish ]; then echo "    would delete s3://$BUCKET/manifests/$CHANNEL/$RUNTIME/$p"
    else awk -F'\t' '{n[$1]++} END {printf "    objects: %d assets, %d archive, %d pointer\n", n["asset"], n["archive"], n["pointer"]}' "$OUT/plan-$p.tsv"; fi
  done
  echo "  re-run with --apply to publish (bucket $BUCKET, served at $BASE)."
  exit 0
fi

# ---- apply ----------------------------------------------------------------------------------
need_r2
for p in "${PLATFORMS[@]}"; do
  if [ "$MODE" = unpublish ]; then
    r2 s3api delete-object --bucket "$BUCKET" --key "manifests/$CHANNEL/$RUNTIME/$p" >/dev/null
    say "$p: pointer removed (the archive stays)"
  else
    say "$p: uploading (assets, archive, then the pointer)"; upload_plan "$OUT/plan-$p.tsv"
  fi
done

# The edge keeps each manifest up to 60 s (ota_worker/worker.js): poll until the live answer is
# the new one, then check every asset of it by hash, as a phone would.
fails=0
for p in "${PLATFORMS[@]}"; do
  ok=""
  for i in $(seq 1 "${OTA_VERIFY_TRIES:-20}"); do
    if r="$(live "$p" --expect-id "${NEWID[$p]}" --assets)"; then ok=1; break; fi
    [ "$i" = "${OTA_VERIFY_TRIES:-20}" ] || sleep 6
  done
  if [ -n "$ok" ]; then echo "LIVE $p: $r"
  else
    fails=$((fails + 1))
    echo "FAILED $p: the live answer is not the verified ${NEWID[$p]}: $r" >&2
    echo "  before this run the live update was: ${PREV[$p]}" >&2
    case "${PREV[$p]}" in
      directive) echo "  to restore the rollback: scripts/ota_publish_self.sh --rollback-embedded --platform $p --apply" >&2 ;;
      none|unreachable|unverifiable) echo "  to stop devices taking it: scripts/ota_publish_self.sh --unpublish --platform $p --apply" >&2 ;;
      *) echo "  to put the previous one back: scripts/ota_publish_self.sh --republish ${PREV[$p]} --platform $p --apply" >&2 ;;
    esac
  fi
done
[ "$fails" = 0 ] || exit 1

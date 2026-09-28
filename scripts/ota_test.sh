#!/usr/bin/env bash
# Local end-to-end test of the self-hosted OTA path (design D9). Touches NO R2 and no Cloudflare.
#   scripts/ota_test.sh              full run: real `expo export` of both platforms (a few minutes)
#   OTA_TEST_DIST=DIR scripts/ota_test.sh    reuse an `expo export` output (e.g. <old work dir>/pub/dist)
# What it proves, each with a control that must fail:
#   1. prebuild will embed the certificate, keyid/alg and the new URL (Expo's own config-plugin code)
#   2. ota_publish_self.sh (dry run) exports, builds, signs and verifies both platforms
#   3. the real worker.js, served locally over the bucket layout, answers curl sending the headers
#      expo-updates sends: signature verifies against native/certs, every asset matches its hash
#   4. tampered manifest, foreign key, unsigned part, tampered asset, wrong/missing headers are refused
#   5. rollBackToEmbedded directive, republish (new id, same assets) and unpublish (204) behave
#   6. --apply end to end against a stand-in aws CLI: upload order, asset skipping, no secret in argv,
#      the post-publish live check, and a corrupted pointer failing the run with a rollback hint
# Needs the signing key (EXPO_UPDATES_PRIVATE_KEY_FILE, default ~/hawkeye-secrets/expo-updates/private-key.pem).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOL="$REPO/scripts/ota_manifest.mjs"
PORT="${OTA_TEST_PORT:-18787}"
BASE="http://127.0.0.1:$PORT"
export EXPO_UPDATES_PRIVATE_KEY_FILE="${EXPO_UPDATES_PRIVATE_KEY_FILE:-$HOME/hawkeye-secrets/expo-updates/private-key.pem}"
T="$(mktemp -d /tmp/hawkeye-ota-test.XXXXXX)"
PUB="$T/pub"; R2="$PUB/r2"
DISTDIR="${OTA_TEST_DIST:-$PUB/dist}"
fails=0; SRV=""
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; }
trap cleanup EXIT
v() { node "$TOOL" verify --allow-http "$@"; }   # prints JSON, exit 2 on a failed check
openssl genrsa -out "$T/foreign.pem" 2048 2>/dev/null

# ---- 1. what prebuild embeds -------------------------------------------------------------------
( cd "$REPO/native" && APP_VARIANT=production node -e '
  const { getConfig } = require("@expo/config");
  const U = require("@expo/config-plugins").Updates;
  const { exp } = getConfig(process.cwd(), { skipSDKVersionRequirement: true });
  const cert = U.getUpdatesCodeSigningCertificate(process.cwd(), exp);
  const out = { url: U.getUpdateUrl(exp), meta: U.getUpdatesCodeSigningMetadataStringified(exp),
    headers: U.getUpdatesRequestHeadersStringified(exp), certBegins: (cert || "").slice(0, 27), runtime: exp.version };
  console.log(JSON.stringify(out));' ) > "$T/prebuild.json" 2>"$T/prebuild.err" || { cat "$T/prebuild.err"; }
if grep -q '"url":"https://updates.hawkeye.com.ng/manifest"' "$T/prebuild.json" && grep -q 'BEGIN CERTIFICATE' "$T/prebuild.json" \
   && grep -q 'keyid' "$T/prebuild.json" && grep -q 'expo-channel-name' "$T/prebuild.json"; then
  pass "prebuild embeds url, certificate, codeSigningMetadata, channel header: $(cat "$T/prebuild.json")"
else fail "prebuild config: $(cat "$T/prebuild.json" "$T/prebuild.err")"; fi

# ---- 2. dry-run publish (real export) ----------------------------------------------------------
DARGS=(); [ -n "${OTA_TEST_DIST:-}" ] && DARGS=(--dist "$OTA_TEST_DIST")
echo "== dry-run publish of both platforms into $PUB (${OTA_TEST_DIST:-with a real expo export: a few minutes})"
OTA_OUT="$PUB" OTA_BASE_URL="$BASE" OTA_ALLOW_OLD_RUNTIME=1 "$REPO/scripts/ota_publish_self.sh" --platform all --message "local test"   ${DARGS[@]+"${DARGS[@]}"} > "$T/publish.log" 2>&1
rc=$?
if [ $rc = 0 ] && grep -q 'DRY RUN: nothing was written to R2' "$T/publish.log"; then pass "dry-run publish (exit 0, no R2)"; else fail "dry-run publish rc=$rc: $(tail -20 "$T/publish.log")"; fi
# CONTROL: with a foreign key the publish must refuse to sign.
if EXPO_UPDATES_PRIVATE_KEY_FILE="$T/foreign.pem" node "$TOOL" rollback --platform ios --runtime 1.0.8 --out "$T/foreign-out" > "$T/foreign.log" 2>&1; then
  fail "a key that does not match native/certs was accepted"
else pass "control: a foreign key is refused before signing ($(tail -1 "$T/foreign.log" | cut -c1-90))"; fi
# CONTROL: the dry run must refuse a runtime that only EAS builds carry (1.0.8) without the test override.
if OTA_OUT="$T/guard" "$REPO/scripts/ota_publish_self.sh" --rollback-embedded --platform ios > "$T/guard.log" 2>&1; then
  fail "runtime 1.0.8 was accepted without OTA_ALLOW_OLD_RUNTIME"
else grep -q 'builds up to 1.0.8 read EAS' "$T/guard.log" && pass "control: runtime 1.0.8 (EAS builds) is refused" || fail "guard: $(cat "$T/guard.log")"; fi
RT="$(node -e 'process.stdout.write(require(process.argv[1]).runtime)' "$PUB/plan.json" 2>/dev/null || echo 1.0.8)"
grep -h '"kind":"manifest"' "$T/publish.log" 2>/dev/null | head -2

# ---- 3. serve locally, fetch as expo-updates does ----------------------------------------------
node "$TOOL" serve --root "$R2" --port "$PORT" 2> "$T/serve.log" & SRV=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "$BASE/nothing" && break; sleep 0.2; done
fetch() {   # $1 platform, $2 out-prefix, rest: header overrides "name: value"
  local p="$1" o="$2"; shift 2
  local H=(-H 'accept: multipart/mixed,application/expo+json,application/json' -H "expo-platform: $p" -H 'expo-protocol-version: 1'
           -H 'expo-api-version: 1' -H 'expo-updates-environment: BARE' -H 'expo-json-error: true'
           -H "eas-client-id: $(cat /proc/sys/kernel/random/uuid)" -H "expo-runtime-version: $RT" -H 'expo-channel-name: production'
           -H 'expo-expect-signature: sig, keyid="main", alg="rsa-v1_5-sha256"')
  for x in "$@"; do H+=(-H "$x"); done
  curl -sS -D "$o.h" -o "$o.b" "${H[@]}" "$BASE/manifest"
}
declare -A ID
for p in ios android; do
  fetch "$p" "$T/$p"
  # A 204 would also "verify": the check is that a SIGNED MANIFEST came back.
  if r="$(v --file "$T/$p.b" --headers "$T/$p.h" --platform "$p" --runtime "$RT" --assets)" && grep -q '"kind":"manifest"' <<<"$r"; then
    ID[$p]="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).id)' "$r")"
    pass "$p: curl with client headers -> signed manifest verifies, every asset hash matches: $r"
  else fail "$p: $r"; fi
  grep -qi '^expo-protocol-version: 1' "$T/$p.h" && grep -qi '^cache-control: private, max-age=0' "$T/$p.h" \
    && pass "$p: protocol and cache headers present" || fail "$p: headers: $(cat "$T/$p.h")"
done
[ "${ID[ios]:-a}" != "${ID[android]:-a}" ] && pass "ios and android get different updates (header routing)" || fail "same update for both platforms"
# Deployment option B: the Worker as the hostname's Custom Domain serves the objects itself.
PORT3=$((PORT + 2))
node "$TOOL" serve --root "$R2" --port "$PORT3" --worker-all 2> "$T/serve3.log" & SRV3=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT3/nothing" && break; sleep 0.2; done
if node -e '
  const f=require("fs"),c=require("crypto");const [mf,port]=process.argv.slice(1);const m=JSON.parse(f.readFileSync(mf,"utf8"));
  (async()=>{for(const a of [m.launchAsset,...m.assets]){const r=await fetch("http://127.0.0.1:"+port+new URL(a.url).pathname);
    const b=Buffer.from(await r.arrayBuffer());const h=c.createHash("sha256").update(b).digest("base64url");
    if(r.status!==200||h!==a.hash||r.headers.get("content-type")!==a.contentType||!/immutable/.test(r.headers.get("cache-control")||"")) {console.log("bad",a.url,r.status);process.exit(1)}}})()' \
  "$R2/updates/production/$RT/ios/${ID[ios]:-x}/manifest.json" "$PORT3"; then
  pass "option B (Worker serves every path): all ios assets through worker.js match their hashes, types and immutable caching"
else fail "option B asset serving"; fi
[ "$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT3/assets/../manifests/production/$RT/ios")" = 404 ] \
  && pass "control: /assets/../manifests/... through the worker -> 404" || fail "worker object traversal"
kill "$SRV3" 2>/dev/null

# ---- 4. controls: each must be refused ---------------------------------------------------------
sed 's/"createdAt":"20/"createdAt":"19/' "$T/ios.b" > "$T/tamper.b"
v --file "$T/tamper.b" --headers "$T/ios.h" --platform ios --runtime "$RT" > "$T/r" && fail "tampered manifest accepted" \
  || pass "control: one changed byte in the manifest -> $(grep -o '"error":"[^"]*"' "$T/r")"
grep -v '^expo-signature:' "$T/ios.b" > "$T/unsigned.b"
v --file "$T/unsigned.b" --headers "$T/ios.h" --platform ios --runtime "$RT" > "$T/r" && fail "unsigned manifest accepted" \
  || pass "control: part without expo-signature -> $(grep -o '"error":"[^"]*"' "$T/r")"
rm -f "$T/foreign.b"
node -e '   // re-sign the SAME manifest body with a foreign key: well-formed, wrong signer
  const fs=require("fs"),c=require("crypto");const [bf,kf,of]=process.argv.slice(1);
  const s=fs.readFileSync(bf,"latin1");const k=fs.readFileSync(kf,"utf8");
  const out=s.replace(/(expo-signature: sig=")([^"]+)(")([^]*?\r\n\r\n)([^\r]+)/, (all,a,sig,b,rest,body)=>
    a+c.sign("sha256",Buffer.from(Buffer.from(body,"latin1").toString("utf8"),"utf8"),k).toString("base64")+b+rest+body);
  if(out===s) process.exit(3); fs.writeFileSync(of,out,"latin1");' "$T/ios.b" "$T/foreign.pem" "$T/foreign.b"
if [ -f "$T/foreign.b" ]; then
  v --file "$T/foreign.b" --headers "$T/ios.h" --platform ios --runtime "$RT" > "$T/r" && fail "foreign-key signature accepted" \
    || pass "control: well-formed signature by another key -> $(grep -o '"error":"[^"]*"' "$T/r")"
else fail "could not build the foreign-key control"; fi
v --file "$T/ios.b" --headers "$T/ios.h" --platform android --runtime "$RT" --expect-id "${ID[android]:-x}" > "$T/r" && fail "expect-id mismatch accepted" \
  || pass "control: the wrong update id is caught"
v --file "$T/ios.b" --headers "$T/ios.h" --platform ios --runtime 9.9.9 > "$T/r" && fail "wrong runtime accepted" \
  || pass "control: a manifest for another runtime is caught"
# a tampered bundle in the bucket (restored afterwards)
la="$(node -e 'process.stdout.write(new URL(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).launchAsset.url).pathname.slice(1))' "$R2/updates/production/$RT/ios/${ID[ios]:-x}/manifest.json" 2>/dev/null)"
if [ -n "$la" ] && [ -f "$R2/$la" ]; then
  cp "$R2/$la" "$T/asset.bak"; printf 'x' >> "$R2/$la"
  if v --url "$BASE/manifest" --platform ios --runtime "$RT" --assets > "$T/r"; then fail "tampered bundle accepted"
  elif grep -q 'SHA-256 does not match' "$T/r"; then pass "control: one byte appended to the bundle in the bucket -> hash mismatch caught"
  else fail "tampered bundle: $(cat "$T/r")"; fi
  cp "$T/asset.bak" "$R2/$la"
else fail "could not locate the ios launch asset"; fi
code() { curl -s -o /dev/null -w '%{http_code}' "$@" "$BASE/manifest"; }
H1=(-H 'accept: multipart/mixed' -H 'expo-protocol-version: 1' -H "expo-runtime-version: $RT")
[ "$(code "${H1[@]}" -H 'expo-platform: web')" = 400 ] && pass "control: expo-platform web -> 400" || fail "platform web"
[ "$(code -H 'accept: multipart/mixed' -H 'expo-platform: ios' -H "expo-runtime-version: $RT")" = 406 ] && pass "control: no expo-protocol-version -> 406" || fail "no protocol header"
[ "$(code -H 'accept: application/json' -H 'expo-protocol-version: 1' -H 'expo-platform: ios' -H "expo-runtime-version: $RT")" = 406 ] && pass "control: accept without multipart -> 406" || fail "accept json"
[ "$(code "${H1[@]}" -H 'expo-platform: ios' -H 'expo-runtime-version: ../manifests')" = 400 ] && pass "control: runtime '../manifests' -> 400" || fail "runtime traversal"
[ "$(code -H 'accept: multipart/mixed' -H 'expo-protocol-version: 1' -H 'expo-platform: ios' -H 'expo-runtime-version: 9.9.9')" = 204 ] && pass "unpublished runtime -> 204 (no update)" || fail "unknown runtime"
[ "$(code "${H1[@]}" -H 'expo-platform: ios' -H 'expo-channel-name: staging')" = 204 ] && pass "other channel -> 204" || fail "channel"
v --url "$BASE/manifest" --platform ios --runtime 9.9.9 --expect-id none >/dev/null && pass "204 carries expo-protocol-version (the client accepts it as no-op)" || fail "204 headers"

# ---- 5. rollback, republish, unpublish -----------------------------------------------------------
node "$TOOL" rollback --platform ios --runtime "$RT" --out "$PUB" > "$T/rb.json" 2>&1 || fail "rollback build: $(cat "$T/rb.json")"
r="$(v --url "$BASE/manifest" --platform ios --runtime "$RT" --expect-id directive)" \
  && pass "rollBackToEmbedded directive is served and its signature verifies: $r" || fail "rollback: $r"
src="$R2/updates/production/$RT/ios/${ID[ios]:-x}/manifest.json"
if node "$TOOL" republish --manifest "$src" --platform ios --runtime "$RT" --base "$BASE" --out "$PUB" > "$T/rp.json" 2>&1; then
  nid="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).id)' "$T/rp.json")"
  r="$(v --url "$BASE/manifest" --platform ios --runtime "$RT" --expect-id "$nid" --assets)" && [ "$nid" != "${ID[ios]}" ] \
    && pass "republish of ${ID[ios]} is live as NEW id $nid, same assets, all hashes match" || fail "republish: $r"
  node -e 'const f=require("fs");const[a,b]=process.argv.slice(1).map(p=>JSON.parse(f.readFileSync(p,"utf8")));
    process.exit(a.launchAsset.hash===b.launchAsset.hash && Date.parse(b.createdAt)>Date.parse(a.createdAt)?0:1)' \
    "$src" "$R2/updates/production/$RT/ios/$nid/manifest.json" && pass "republished update: same bundle hash, newer createdAt" || fail "republish content"
else fail "republish: $(cat "$T/rp.json")"; fi
rm -f "$R2/manifests/production/$RT/android"
[ "$(code "${H1[@]}" -H 'expo-platform: android')" = 204 ] && pass "unpublish (pointer removed) -> 204" || fail "unpublish"
grep -c ' /manifest ' "$T/serve.log" | xargs -I{} echo "   (server answered {} manifest requests; log $T/serve.log)"

# ---- 6. --apply end to end, against a stand-in `aws` whose "bucket" is a local directory -------
# Proves the upload order (assets, archive, pointer LAST), asset skipping, credentials passed only
# through the environment, the post-publish live check, and the failure path with its rollback hint.
STUB="$T/stub"; BKT="$T/bucket"; rm -rf "$STUB" "$BKT"; mkdir -p "$STUB" "$BKT"
cat > "$STUB/aws" <<'AWS'
#!/usr/bin/env bash
# Stand-in for the aws CLI used by ota_publish_self.sh: the "R2 bucket" is $STUB_ROOT. Logs argv.
set -euo pipefail
echo "$*" >> "$STUB_LOG"
[ "${AWS_ACCESS_KEY_ID:-}" = "$STUB_EXPECT_ID" ] && [ "${AWS_SECRET_ACCESS_KEY:-}" = "$STUB_EXPECT_SECRET" ] || { echo "stub: credentials not in the environment" >&2; exit 9; }
op="" key="" body="" ctype="" cache=""
while [ $# -gt 0 ]; do case "$1" in
  put-object|head-object|delete-object) op="$1"; shift ;;
  --key) key="$2"; shift 2 ;; --body) body="$2"; shift 2 ;; --content-type) ctype="$2"; shift 2 ;; --cache-control) cache="$2"; shift 2 ;;
  *) shift ;; esac; done
case "$op" in
  head-object) [ -f "$STUB_ROOT/$key" ] || exit 254 ;;
  put-object)
    mkdir -p "$(dirname "$STUB_ROOT/$key")"; cp "$body" "$STUB_ROOT/$key"
    # Corrupt one byte INSIDE the signed manifest (bytes after the closing delimiter are a legal
    # multipart epilogue and rightly ignored, so appending would prove nothing).
    if [ -n "${STUB_CORRUPT_POINTER:-}" ] && [[ "$key" == manifests/* ]]; then sed -i 's/"createdAt":"20/"createdAt":"19/' "$STUB_ROOT/$key"; fi
    node -e 'const f=require("fs");const[m,k,t,c]=process.argv.slice(1);let j={};try{j=JSON.parse(f.readFileSync(m,"utf8"))}catch{};j[k]={contentType:t,cacheControl:c};f.writeFileSync(m,JSON.stringify(j))' \
      "$STUB_ROOT/.meta.json" "$key" "$ctype" "$cache"
    echo '{"ETag":"\"stub\""}' ;;
  delete-object) rm -f "$STUB_ROOT/$key" ;;
  *) exit 3 ;;
esac
AWS
chmod +x "$STUB/aws"
PORT2=$((PORT + 1)); BASE2="http://127.0.0.1:$PORT2"
node "$TOOL" serve --root "$BKT" --port "$PORT2" 2> "$T/serve2.log" & SRV2=$!
trap 'cleanup; kill "$SRV2" 2>/dev/null' EXIT
for _ in $(seq 1 50); do curl -s -o /dev/null "$BASE2/nothing" && break; sleep 0.2; done
export STUB_LOG="$T/stub.log" STUB_ROOT="$BKT" STUB_EXPECT_ID="stub-access-key-id" STUB_EXPECT_SECRET="stub-secret-NEVER-PRINTED"
: > "$STUB_LOG"
ap() {   # ota_publish_self.sh --apply against the stub, output in $T/ap.log
  env PATH="$STUB:$PATH" OTA_BASE_URL="$BASE2" OTA_ALLOW_OLD_RUNTIME=1 OTA_OUT="$T/ap-$RANDOM" OTA_VERIFY_TRIES=2 \
    OTA_R2_ENDPOINT="https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com" \
    OTA_R2_ACCESS_KEY_ID="$STUB_EXPECT_ID" OTA_R2_SECRET_ACCESS_KEY="$STUB_EXPECT_SECRET" \
    "$REPO/scripts/ota_publish_self.sh" "$@" --apply > "$T/ap.log" 2>&1
}
if ap --platform ios --dist "$DISTDIR" --message "apply test" && grep -q '^LIVE ios: {"ok":true' "$T/ap.log"; then
  AID="$(grep -o '"id":"[0-9a-f-]*"' "$T/ap.log" | head -1 | cut -d'"' -f4)"
  pass "--apply publish: uploaded, then verified LIVE through the worker with every asset hash ($AID)"
else fail "--apply publish: $(tail -15 "$T/ap.log")"; fi
node -e '   // order: every asset before any archive object, the pointer after both
  const L=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l.includes("put-object"));
  const k=L.map(l=>/--key (\S+)/.exec(l)[1]);const last=(p)=>Math.max(...k.map((x,i)=>x.startsWith(p)?i:-1));
  const first=(p)=>k.findIndex(x=>x.startsWith(p));
  process.exit(k.length>2 && last("assets/")<first("updates/") && last("updates/")<first("manifests/") && first("manifests/")===k.length-1 ? 0 : 1)' "$STUB_LOG" \
  && pass "upload order: assets, then archive, then the pointer last" || fail "upload order: $(grep -o -- '--key [^ ]*' "$STUB_LOG" | head -40)"
if [ ! -s "$STUB_LOG" ]; then fail "secret check: aws was never called, nothing to check"
elif grep -q "$STUB_EXPECT_SECRET" "$STUB_LOG" "$T/ap.log"; then fail "the R2 secret appears on a command line or in the output"
else pass "the R2 secret never appears in aws argv or in the script output"; fi
: > "$STUB_LOG"
ap --platform ios --dist "$DISTDIR" && grep -q 'uploaded 3 objects (28 assets already present)' "$T/ap.log" \
  && pass "second publish skips the 28 assets already in the bucket (content-addressed)" || fail "asset skip: $(grep uploaded "$T/ap.log")"
ap --republish "${AID:-x}" --platform ios && grep -q '^LIVE ios: {"ok":true' "$T/ap.log" \
  && pass "--apply republish ${AID:-x}: live as a new id" || fail "--apply republish: $(tail -8 "$T/ap.log")"
ap --rollback-embedded --platform ios && grep -q '"kind":"directive"' "$T/ap.log" \
  && pass "--apply rollback-embedded: the signed directive is live" || fail "--apply rollback: $(tail -8 "$T/ap.log")"
ap --unpublish --platform ios && grep -q '^LIVE ios: {"ok":true,"status":204' "$T/ap.log" \
  && pass "--apply unpublish: 204 live" || fail "--apply unpublish: $(tail -8 "$T/ap.log")"
# CONTROL: a pointer that arrives corrupted must fail the run and print the way back.
STUB_CORRUPT_POINTER=1 ap --platform ios --dist "$DISTDIR"; rc=$?
if [ $rc != 0 ] && grep -q '^FAILED ios' "$T/ap.log" && grep -q 'ota_publish_self.sh --unpublish --platform ios --apply' "$T/ap.log"; then
  pass "control: a corrupted live pointer fails the run (exit $rc) and prints the rollback command"
else fail "corrupted pointer not caught (rc=$rc): $(tail -6 "$T/ap.log")"; fi

echo "fails=$fails  (work dir $T)"
[ "$fails" = 0 ]

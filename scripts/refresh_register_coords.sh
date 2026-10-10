#!/bin/bash
# Refresh the offline near-me coordinates from the newest PRODUCTION snapshot,
# and deploy them if — and only if — something changed and every gate passes.
#
#   bash scripts/refresh_register_coords.sh            # build, gate, deploy, commit, push
#   bash scripts/refresh_register_coords.sh --dry-run  # build and gate only; the tree is restored
#
# WHY THIS EXISTS. app/reg/<SS>c.*.pack.gz are a SNAPSHOT of the server's pins
# (backend/scripts/build_register_packs.mjs --coords). A unit that gains or loses
# a trusted pin on the server is wrong on every phone until these are rebuilt.
# Weekly from cron; run it by hand the evening before an election.
#
# WHAT IT WILL NOT DO, each a stop with a non-zero exit and nothing deployed:
#   - deploy when a NAME changed (registerVersion moved): that needs the offline
#     search gate, which needs two local servers and a browser —
#       cd backend && node scripts/diff_register_search.mjs --queries 60
#     (see docs/PU-SEARCH-2027.md), then deploy by hand;
#   - deploy a snapshot that lost more than 2% of its pins or whose unit count
#     moved by more than 1% — a truncated or wrong database, not a refresh;
#   - deploy the manifest before every file it names is up and verified.
#
# Runs where the secrets are: GO54 credentials (backend/.env) for the snapshot,
# the register signing key (~/hawkeye-secrets). Neither is ever printed.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
DRY=""; [ "${1:-}" = "--dry-run" ] && DRY=1
say() { echo "[coords-refresh $(date -u +%FT%TZ)] $*"; }
die() { say "STOP: $1"; exit "${2:-1}"; }
# git, with the index lock dealt with. The desktop app polls this repository
# with a Windows git that takes .git/index.lock for a moment at a time, and a
# hung one leaves a 0-byte lock behind for good. Either way a bare `git
# checkout` here fails — measured on the first dry run, which reported success
# while leaving manifest.json modified. So: retry, and clear a lock that is empty.
g() {
  local i
  for i in 1 2 3 4 5 6; do
    git "$@" 2>/tmp/coords-refresh-git.err && return 0
    grep -q "index.lock" /tmp/coords-refresh-git.err || { cat /tmp/coords-refresh-git.err >&2; return 1; }
    sleep 3
    [ -f .git/index.lock ] && [ ! -s .git/index.lock ] && mv .git/index.lock "/tmp/hawkeye-index.lock.$(date +%s)"
  done
  cat /tmp/coords-refresh-git.err >&2
  return 1
}
# By CONTENT, not `git status`: while that lock is held git cannot refresh its
# index, and a file rewritten with identical bytes still shows as modified.
reg_clean() { git diff --quiet -- app/reg 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard app/reg)" ]; }
restore() {
  g checkout -q -- app/reg && g clean -fdq app/reg
  reg_clean || say "WARNING: app/reg was NOT restored — run: git checkout -- app/reg && git clean -fd app/reg"
}

reg_clean || die "app/reg has uncommitted changes; not touching it"

if [ -n "${HAWKEYE_REFRESH_DB:-}" ]; then
  # TEST HOOK, dry runs only: a prepared database instead of the snapshot, so the
  # "something changed" and "refuse this snapshot" paths can be exercised.
  [ -n "$DRY" ] || die "HAWKEYE_REFRESH_DB is for --dry-run only"
  DB="$HAWKEYE_REFRESH_DB"; SNAP="test-$(basename "$DB")"
  [ -f "$DB" ] || die "no database at $DB"
else
  say "pulling the newest production snapshot"
  ok=""; for i in 1 2 3; do bash backend/scripts/pull_backup.sh >/tmp/coords-refresh-pull.log 2>&1 && { ok=1; break; }; sleep 20; done
  [ -n "$ok" ] || { tail -2 /tmp/coords-refresh-pull.log; die "pull_backup.sh failed three times"; }
  SNAP=$(ls -t "$HOME"/hawkeye-backups/hawkeye-*.db.gz 2>/dev/null | head -1)
  [ -n "$SNAP" ] || die "no snapshot found"
  mkdir -p "$HOME/hawkeye-backups/work"
  DB="$HOME/hawkeye-backups/work/prod.db"
  gunzip -c "$SNAP" > "$DB" || die "could not unpack $SNAP"
fi
say "snapshot $(basename "$SNAP")"

cp app/reg/manifest.json /tmp/reg-manifest.prev
HAWKEYE_DB="$DB" node backend/scripts/build_register_packs.mjs --coords --verify > /tmp/coords-refresh-build.log 2>&1 \
  || { tail -5 /tmp/coords-refresh-build.log; restore; die "build or its round-trip gate failed"; }

VERDICT=$(node -e '
  const fs = require("fs");
  const a = JSON.parse(fs.readFileSync("/tmp/reg-manifest.prev", "utf8")), b = JSON.parse(fs.readFileSync("app/reg/manifest.json", "utf8"));
  const sum = (m, k) => Object.values((m.coords || {}).states || {}).reduce((n, s) => n + (s[k] || 0), 0);
  const strip = (m) => JSON.stringify({ ...m, generated: null });
  const pa = sum(a, "pins"), pb = sum(b, "pins"), ua = a.index.units, ub = b.index.units;
  const changed = Object.keys(b.coords.states).filter((c) => !a.coords || !a.coords.states[c] || a.coords.states[c].sha256 !== b.coords.states[c].sha256);
  let v = "changed";
  if (strip(a) === strip(b)) v = "same";
  else if (a.registerVersion !== b.registerVersion) v = "names";
  else if (pa && pb < pa * 0.98) v = "pins-dropped";
  else if (Math.abs(ub - ua) > ua * 0.01) v = "units-moved";
  console.log(v, pa, pb, ua, ub, changed.join(","));
')
set -- $VERDICT
say "pins $2 -> $3, units $4 -> $5, states changed: ${6:-none}"
case "$1" in
  same) restore; say "no change; nothing deployed"; exit 0 ;;
  names) restore; die "a unit NAME changed (registerVersion moved). Run the offline search gate and deploy by hand." 3 ;;
  pins-dropped) restore; die "more than 2% of pins disappeared — refusing this snapshot" 4 ;;
  units-moved) restore; die "the unit count moved by more than 1% — refusing this snapshot" 4 ;;
esac

node backend/scripts/sign_register_manifest.mjs > /tmp/coords-refresh-sign.log 2>&1 || { restore; die "signing failed"; }
PUB=$(grep -o "BPEt[A-Za-z0-9+/=]*" native/src/lib/register.ts | head -1)
node backend/scripts/sign_register_manifest.mjs --check --pub "$PUB" 2>&1 | grep -q "signature OK" || { restore; die "the signature does not verify against the key pinned in the apps"; }
for impl in "" "--web"; do
  HAWKEYE_DB="$DB" node native/scripts/verify_register_coords_ts.mjs $impl > /tmp/coords-refresh-gate.log 2>&1 \
    || { tail -4 /tmp/coords-refresh-gate.log; restore; die "offline near-me gate failed (${impl:-native})"; }
done
say "gates passed (round trip, signature, offline == server for native and web)"

if [ -n "$DRY" ]; then restore; say "dry run: the tree is restored, nothing deployed"; exit 0; fi

NEW=$(git ls-files --others --exclude-standard app/reg)
if [ -n "$NEW" ]; then
  # shellcheck disable=SC2086
  bash scripts/deploy_app.sh --path /hawkeye/app/reg $NEW > /tmp/coords-refresh-deploy.log 2>&1 \
    || { tail -3 /tmp/coords-refresh-deploy.log; die "file upload failed — manifest NOT uploaded (the old one still names the old files)" 5; }
fi
bash scripts/deploy_app.sh --path /hawkeye/app/reg app/reg/manifest.sig app/reg/manifest.json >> /tmp/coords-refresh-deploy.log 2>&1 \
  || die "manifest upload failed — check the live manifest and signature by hand" 5
# PURGE, then check the URL A BROWSER ASKS FOR. A cache-busted or uncompressed
# fetch reaches the origin and proves nothing about the edge: on 2026-10-10 that
# check passed while browsers were served the old manifest beside the new
# signature. So: no query string, compressed, with a browser's User-Agent (the
# response varies on both), and no escape hatch if it differs.
python3 scripts/cf_purge.py https://hawkeye.com.ng/reg/manifest.json https://hawkeye.com.ng/reg/manifest.sig >> /tmp/coords-refresh-deploy.log 2>&1 \
  || die "edge purge failed — browsers may be holding the old manifest; purge by hand NOW" 5
sleep 5
UA='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'
for f in manifest.json manifest.sig; do
  for ua in "$UA" "okhttp/4.12.0" "curl/8"; do
    curl -fsS -m 60 --compressed -H 'accept-encoding: gzip' -A "$ua" "https://hawkeye.com.ng/reg/$f" -o "/tmp/reg-live-$f" \
      && cmp -s "/tmp/reg-live-$f" "app/reg/$f" || die "live $f (as '$ua') is not what was deployed — purge and re-check by hand" 5
  done
done
say "deployed, purged and verified live as a browser would fetch it"

g add -A app/reg
g commit -q -m "Register coordinates refreshed from $(basename "$SNAP" .db.gz)" \
  -m "pins $2 -> $3; states changed: ${6:-none}. Built by scripts/refresh_register_coords.sh (round-trip, signature and offline==server gates passed)." \
  || die "commit failed (the files ARE live)" 6
for i in 1 2 3 4 5; do git push -q origin main 2>/dev/null && break; sleep 20; done
say "committed $(git rev-parse --short HEAD)"

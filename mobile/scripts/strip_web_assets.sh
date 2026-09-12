#!/bin/bash
# Strip and gate the packaged web assets of a Capacitor build.
#
# SHARED BY BOTH PLATFORMS ON PURPOSE. `cap sync` copies everything under app/
# into the native project — including app/download/, which is six ~30 MB copies
# of a different app and once produced a 173 MB "Lite". Android has been guarding
# against that with the list below since release 1; iOS syncs from the same
# webDir and needs exactly the same treatment.
#
# Cloning these 160 lines into an iOS script would have worked today and drifted
# by the second release: the gates encode WHY each file goes (measured reference
# counts, two Play rejections, a stale-fallback trap), and a copy diverges
# silently because both halves keep passing. One file, two callers.
#
#   usage: strip_web_assets.sh <public-dir> <capacitor.plugins.json>
#
# Run from mobile/. Exits non-zero on any GATE_FAIL; every echo it makes is
# consumed by the caller's log.
set -u

PUB="${1:?usage: strip_web_assets.sh <public-dir> <capacitor.plugins.json>}"
PLUGINS="${2:?usage: strip_web_assets.sh <public-dir> <capacitor.plugins.json>}"

[ -d "$PUB" ] || { echo "GATE_FAIL: $PUB does not exist — run 'npx cap sync' first"; exit 1; }
[ -f "$PLUGINS" ] || { echo "GATE_FAIL: $PLUGINS does not exist — run 'npx cap sync' first"; exit 1; }

rm -rf "$PUB/vendor/tesseract" "$PUB/download" "$PUB/play-shots" "$PUB/ios-shots"
rm -f  "$PUB/opencv.js" "$PUB/play-feature-graphic.png" "$PUB/nga_wards.geojson"

# ---------------------------------------------------------------------------
# DEAD WEIGHT — measured, not guessed. Every path below was checked for a
# reference across the whole of app/ before it was added here; the counts are in
# the comments. Nothing here is a judgement call about what Lite "needs" — these
# are files nothing asks for, or files a WebView cannot use.
#
#   senate_map.png          0 references anywhere in app/
#   email-banner.png        0 references — it is the Roundcube signature banner,
#                           served off the WEBSITE by absolute URL. Stays on the
#                           site; has no business in an APK.
#   logos/sources.json      0 references — a provenance record (party site URL +
#                           a base64 copy of each emblem). Kept in the repo for
#                           audit, never read at runtime.
#   icon-512*.png           referenced ONLY by manifest.webmanifest, and a
#                           Capacitor WebView never consumes a web app manifest —
#                           the launcher icon comes from res/mipmap. icon-192.png
#                           is NOT in this list: menu.js and native.js use it.
#   (no fonts)              THIS LIST USED TO STRIP FONTS. IT NO LONGER DOES.
#                           inter-{5,6,7}00 were once byte-identical copies of
#                           inter-400, so dropping them cost nothing. The web
#                           font rebuild replaced them with REAL per-weight
#                           instances — four md5s, four sizes — so stripping
#                           them now would cost three genuine weights and leave
#                           the WebView synthesising 500/600/700 from the 400
#                           file. ~154 KB is the honest price of real type.
#                           The Lora pair is gone from app/fonts/ altogether,
#                           so there is nothing left of it to remove.
#   logos/{AA,APGA,LP,ZLP}.png  the manifest names the .jpg for all four. The
#                           three 65 KB PNGs are the same file three times.
#   photos/candidates/…     adebayo/datti/jonathan are referenced only by their
#                           own manifest.json, which nothing reads.
#                           political_data.json names tinubu/atiku/obi only.
#   install-card.png        200 KB of PNG telling a reader HOW TO INSTALL the
#                           app — inside the app they have already installed.
#                           It is for the website and the outreach deck. No
#                           file in the bundle references it.
#   admin.html              the admin console, shipped to every observer. Not
#                           merely dead weight: it is the operator UI, and the
#                           people who use it reach it on the website. Nothing
#                           links to it from the app.
#   post.html               the internal social-media poster.
#   bench/meta/preview.html internal tools; two of them carry <meta noindex>,
#                           which is the giveaway that they were never meant
#                           to face users at all.
#   qr/generate.py          the script that GENERATED the donation QR codes.
#                           The codes themselves stay (support.html draws
#                           them); the generator is a build-time tool.
# ---------------------------------------------------------------------------
rm -f "$PUB/senate_map.png" "$PUB/email-banner.png" "$PUB/logos/sources.json" \
      "$PUB/icon-512.png" "$PUB/icon-512-maskable.png" \
      "$PUB/install-card.png" "$PUB/admin.html" "$PUB/post.html" \
      "$PUB/bench.html" "$PUB/meta.html" "$PUB/preview.html" "$PUB/qr/generate.py" \
      "$PUB/logos/AA.png" "$PUB/logos/APGA.png" "$PUB/logos/LP.png" "$PUB/logos/ZLP.png" \
      "$PUB/photos/candidates/adebayo.jpg" "$PUB/photos/candidates/datti.jpg" \
      "$PUB/photos/candidates/jonathan.jpg" "$PUB/photos/candidates/manifest.json"

# Those pages were safe to drop because NOTHING in the bundle linked to them.
# That is a fact about today's code, not a law, so it is asserted rather than
# trusted: the day a page adds a link to the admin console, this fails here
# instead of shipping a link that 404s on the observer's phone.
# It looks for a LINK, not a mention. Bare-name matching was tried first and
# failed honestly: authgate.js keeps a no-auth-required allowlist that names
# meta.html and preview.html, and several files discuss preview.html in prose
# comments. Naming a page that no longer ships breaks nothing; NAVIGATING to
# one is what leaves an observer staring at a 404.
for gone in install-card.png admin.html post.html bench.html meta.html preview.html; do
  esc=$(echo "$gone" | sed 's/\./\\./g')
  hit=$(grep -rnE "(href|src)=[\"'][^\"']*$esc|location([.]href)?[[:space:]]*=[[:space:]]*[\"'][^\"']*$esc" \
        "$PUB" --include='*.js' --include='*.html' 2>/dev/null | head -3)
  [ -z "$hit" ] || { echo "GATE_FAIL: $gone was stripped but is still LINKED from: $hit"; exit 1; }
done
echo "  ok: no shipped page links to a stripped tool page"

# members.json — 100 KB, and political.html ALREADY reads it through
# fetchData(), the same live-fetch path the big three geo layers go through,
# with an explicit .catch(() => null). So the bundled copy is a fallback for
# an offline reader of a browsing page, not the source of truth, and the page
# is written to render without it. Same trade the geo layers already took.
rm -f "$PUB/members.json"
grep -q "fetchData('members.json')" "$PUB/political.html" \
  || { echo "GATE_FAIL: political.html no longer fetches members.json live — stripping it would leave that page permanently empty"; exit 1; }
echo "  ok: members.json fetched live, not bundled"

# THE BIG THREE GEO LAYERS — 1.7 MB, fetched live instead of bundled.
#
# They draw the leaderboard's map, and EVERY FIGURE on that board comes from
# /api/national — so the screen they serve cannot render offline no matter what
# is in the APK. Shipping the geometry buys an outline for a board that would
# have no numbers on it.
#
# results.html:loadGeo and race.js:getGeo now go through native.js:fetchData,
# which off-origin fetches the live file; both already degrade to no-map on
# failure (see tests/geo_failure_test.mjs). The honest cost is one decorative
# seat outline on race.html for an observer with no signal — the candidates,
# emblems, ballot and every figure still render.
#
# states_geo.json STAYS. It is 23 KB and carries the shared viewBox every other
# layer is projected into, so without it there is no map at any level, online or
# off. Not worth 23 KB to lose the state-level map offline.
rm -f "$PUB/lga_geo.json" "$PUB/constituency_geo.json" "$PUB/district_geo.json"
[ -f "$PUB/states_geo.json" ] || { echo "GATE_FAIL: states_geo.json was stripped — it is the shared viewBox, every map needs it"; exit 1; }
grep -q "window.fetchData" "$PUB/results.html" || { echo "GATE_FAIL: results.html does not route geo through fetchData — the stripped layers would never load"; exit 1; }
grep -q "window.fetchData" "$PUB/race.js" || { echo "GATE_FAIL: race.js does not route geo through fetchData — the stripped layers would never load"; exit 1; }
echo "  ok: big-three geo fetched live, states_geo kept"

# THE REASON RELEASE 2 EXISTS. Lite has no `server.url` (webDir: "../app"), so a
# relative fetch reads the copy baked into the APK — which only changes with a
# store release. INEC amended its 2023 candidate list SEVEN times after
# publication; that is seven store releases for a JSON file.
#
# native.js's fetchData() reads those files from the live site off-origin and
# falls back to the bundled copy when there is no signal. If it is ever missing
# from the packaged bundle, Lite silently goes back to frozen data and looks
# perfectly healthy while doing it — so it is asserted, not assumed.
grep -q "window.fetchData = function" "$PUB/native.js" \
  || { echo "GATE_FAIL: native.js has no fetchData — Lite would ship frozen candidate data"; exit 1; }
# It only works because CapacitorHttp routes fetch natively; the live files send
# no access-control-allow-origin, so a plain cross-origin fetch would be blocked
# and the fallback would quietly serve the bundle forever.
grep -q '"CapacitorHttp"' capacitor.config.json \
  || { echo "GATE_FAIL: CapacitorHttp is not configured — fetchData would fail CORS and silently use the bundle"; exit 1; }
echo "  ok: fetchData present, CapacitorHttp on"

# SHARE — another one that fails invisibly, in the same shape as fetchData.
#
# Android WebView does NOT expose navigator.share; it is a browser-UI feature.
# So Lite is the one surface that needs @capacitor/share to open a real OS share
# sheet, and without it "Share Hawkeye" still WORKS — app/share.js falls through
# to its own WhatsApp/Telegram/X/Facebook sheet. The app looks healthy; the
# button just quietly stops offering Instagram, iMessage and everything else the
# phone knows about, on the one platform that most needed them.
#
# Checked in the SYNCED output, not package.json: `npx cap sync` is the step that
# registers a plugin with the native project, and a dependency present in
# package.json but never synced is exactly this failure.
grep -q '@capacitor/share' "$PLUGINS" \
  || { echo "GATE_FAIL: @capacitor/share is not registered — run 'npm i && npx cap sync' in mobile/ (Lite would lose the OS share sheet)"; exit 1; }
grep -q 'Cap.Plugins.Share' "$PUB/share.js" \
  || { echo "GATE_FAIL: share.js does not reach for the Capacitor plugin — the OS sheet would never be used"; exit 1; }
echo "  ok: @capacitor/share registered and reached for"

# The bundled political_data.json is the OFFLINE FALLBACK. It should not ship
# months stale just because the live copy is what usually gets read.
node -e '
  const fs = require("fs");
  const p = process.argv[1] + "/political_data.json";
  const age = (Date.now() - fs.statSync(p).mtimeMs) / 86400000;
  console.log("  political_data.json fallback is " + age.toFixed(0) + " days old");
  if (age > 120) { console.log("GATE_FAIL: offline fallback is stale — refresh app/political_data.json"); process.exit(1); }
' "$PUB" || exit 1

# EVERY EMBLEM THE MANIFEST NAMES MUST STILL BE HERE. The strip above deletes
# four .png files the manifest does not reference — if a future edit repoints a
# party at one of them, the emblem would silently render as a blank disc
# (results.html's badge has no onerror), and nothing else would notice.
node -e '
  const fs = require("fs"), p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p + "/logos/manifest.json", "utf8"));
  const missing = Object.values(m).filter((f) => !fs.existsSync(p + "/" + f));
  if (missing.length) { console.log("GATE_FAIL: manifest names files the strip removed: " + missing.join(", ")); process.exit(1); }
  console.log("  ok: all " + Object.keys(m).length + " party emblems present");
' "$PUB" || exit 1

# EVERY FONT styles.css ASKS FOR MUST ACTUALLY SHIP.
#
# This replaces a hardcoded list of names that must NOT be referenced. That
# list rotted silently: it named the three Inter weights as strippable because
# they were once byte-identical to inter-400, and when the font rebuild made
# them real, the gate was still asserting a fact that had stopped being true.
# Reading the references out of the CSS instead of restating them means a new
# @font-face, or a newly stripped file, is caught without editing this script.
fonts_wanted=$(grep -o "fonts/[A-Za-z0-9_-]*\.woff2" "$PUB/styles.css" | sort -u)
# Without this, a styles.css that stopped naming fonts — or a grep that silently
# stopped matching — would make the loop below pass over nothing and report ok.
[ -n "$fonts_wanted" ] || { echo "GATE_FAIL: no font references found in styles.css — the gate would have passed vacuously"; exit 1; }
for f in $fonts_wanted; do
  [ -f "$PUB/$f" ] || { echo "GATE_FAIL: styles.css references $f, which is not in the bundle"; exit 1; }
done
echo "  ok: all $(echo "$fonts_wanted" | wc -l) fonts styles.css references are present"

# REGISTER PACKS (docs/PU-SEARCH-2027.md). Not bundled, deliberately.
#
# Two reasons. Android's asset packer renames `index.<sha>.pack.gz` to `.pack`
# and inflates it, so the file the client asks for is not the file that ships.
# And the store now fetches the register with ABSOLUTE urls, because a manifest
# read out of the APK would freeze Lite on whatever register shipped with it —
# a correction would reach every platform except the one that needs a store
# review to update.
#
# So Lite fetches the ~56 KB index on first run like any other client. That
# costs first-run-offline browse and buys a register that can actually be
# corrected.
rm -rf "$PUB/reg"

gate() { if grep -q "$1" "$PUB/$2"; then echo "  ok: $3"; else echo "GATE_FAIL: $3 missing from $2"; exit 1; fi; }
# WHAT PLAY REJECTED THIS APP FOR, TWICE, gated on the CLAIMS rather than on one
# sentence's wording.
#
# This used to grep "Figures are crowd reports", which was a phrase on the face
# of the disclaimer bar. On 2026-08-25 the bar was shortened to match the native
# app's — one line, claim then Details, with the full statement in the modal —
# and this gate failed, correctly: it noticed. But the compliance substance had
# not gone anywhere, only that phrasing had, so gating on the phrase was gating
# on a style decision.
#
# These three are the facts a reviewer is looking for, and they live in the modal
# where they cannot be shortened away by a layout change:
gate "not affiliated with"      menu.js "non-affiliation statement"
gate "unofficial crowd reports" menu.js "figures-are-unofficial statement"
gate "inecnigeria.org"          menu.js "official source link"

KB=$(du -sk "$PUB" | cut -f1)
echo "  packaged web assets: $((KB / 1024)) MB"
[ "$KB" -gt 15360 ] && { echo "GATE_FAIL: packaged assets ${KB}KB exceed 15MB"; du -ah "$PUB" | sort -rh | head -8; exit 1; }

exit 0

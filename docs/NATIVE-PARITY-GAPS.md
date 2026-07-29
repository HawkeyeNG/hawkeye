# PWA → native parity gaps

Machine audit of every user-facing PWA page against its native counterpart, each claimed gap then handed to a second reviewer whose job was to refute it by searching the whole native tree. 34 confirmed, 15 refuted.

Standing requirement: the native app must have EVERY feature the PWA has — only the build and delivery method differ.

## Blocker (1)

### Reporting flows

**Offline outbox — a signed report that fails to upload is queued on the device and sent automatically when connectivity returns**

- PWA: /home/elrio/hawkeye/app/outbox.js:26-57 (IndexedDB queue, flush on 'online', 409/4xx handling) + /home/elrio/hawkeye/app/app.js:1013-1022 (queue on network failure, "Saved offline — your signed report will send automatically")
- Native: missing entirely — native/src/lib/submit.ts:274-280 returns "Upload failed — your report was NOT sent. Retry." and nothing is persisted; grep for outbox/queue in native/src returns no store. Leaving the screen loses the captured photos and the signature.
- Fix: Persist {fields, sheet uri, venue uri, signature} to a local queue (expo-file-system + SQLite/AsyncStorage), retry on NetInfo reconnect and app foreground, applying outbox.js's rules (2xx/409 → drop, other 4xx except 429 → drop, 5xx/429 → keep).


## Major (22)

### Reporting flows

**Published incidents feed — the public list of approved incidents (type, state, time-ago, description, photo/video thumbnails) that every visitor can read on incidents.html**

- PWA: /home/elrio/hawkeye/app/incidents.html:111 (section) + :243-260 (loadFeed renders kind/state/timeAgo/description/media)
- Native: missing entirely — no native screen renders incidents; api.incidents() is declared at native/src/lib/api.ts:66 and never called anywhere (grep: zero call sites). report/incident.tsx is the submit form only and is gated behind sign-in (incident.tsx:166), while the web feed is public.
- Fix: Add an incidents feed screen (or a section on the incident route / a tab entry) that calls the existing api.incidents(), renders kind label + state + relative time + description + media (expo-image for photos, expo-av/video for clips), and is reachable while signed out.

**"Find polling units near me" — GPS discovery of nearby units, with distance in metres, instead of drilling state → LGA → ward**

- PWA: /home/elrio/hawkeye/app/observe.html:161 (#btn-locate) + /home/elrio/hawkeye/app/app.js:512-540 (getPosition → /api/polling-units?lat&lng, renders name, pu_code, ward/lga, distanceM, tier)
- Native: missing entirely — report/result.tsx:53-87 only does the cascading register browse (states → lgas → wards → units chips); /api/polling-units is never called (grep 'polling-units' in native/src returns nothing). The PWA treats browse as the fallback (observe.html:165 "Can't see your unit?"); native has only the fallback.
- Fix: Add a "Find units near me" step to result.tsx that uses the existing getSubmitFix()/getQuickFix() (native/src/lib/location.ts) to hit /api/polling-units?lat=&lng= and lists the returned units with distanceM, with the ward drill-down kept as the fallback.

**Choosing which election you are reporting (contest picker: Presidential / Governorship / Senate / Reps / State Assembly), with the FCT exclusion rule**

- PWA: /home/elrio/hawkeye/app/observe.html:186 (#sel-contest) + /home/elrio/hawkeye/app/app.js:598-601 (options filtered by contestApplies) ; same control on /home/elrio/hawkeye/app/collation.html:77
- Native: missing entirely — report/result.tsx:57 and report/collation.tsx:67 both do `api.contests().then((cs) => setContest(cs[0] ?? null))`, hard-selecting the first contest with no UI to change it. Latent today (backend/src/data/contests.json holds one contest) but the observer cannot file a second race from the same unit on a general-election day.
- Fix: Render the contests list as a selectable step (chips, same pattern as the level picker in collation.tsx:320-334), filtering with the contestApplies rule from app.js:173 (FCT has no GOV/SHA; honour contest.states).

**Submission receipt — ledger entry hash, status (VERIFIED/PENDING), confidence %, matching-of-total reports, location-verification status, venue-photo matches, OCR cross-check score, and the per-party breakdown, plus a link to the public dashboard**

- PWA: /home/elrio/hawkeye/app/observe.html:238-247 (#result-summary, #entry-hash, dashboard link) + /home/elrio/hawkeye/app/app.js:1047-1066
- Native: missing entirely — native/src/lib/submit.ts:264 throws the response body away (`return { ok: true, submissionId: body.submissionId }`, never reading body.entryHash / body.result / body.ocr), and report/result.tsx:176-180 shows a fixed "Report filed / queued for review" line. The observer never receives the ledger entry hash that is the product's proof-of-record.
- Fix: Widen SubmitResult to carry entryHash, result{status,confidence,matchingReports,totalReports,locationStatus,locationConfidence,venueMatches,votes,scope} and ocr{matched,total}; render them on the done step with a copyable entry hash and a link into reports-log.

**Document auto-detection on the sheet/form capture — live edge outline, auto-capture when the sheet is held steady, perspective de-skew/crop of the captured frame, and blur/glare quality warnings with a "use it anyway?" confirmation**

- PWA: /home/elrio/hawkeye/app/scan.js:121-187 (DocScanner.start/capture) + /home/elrio/hawkeye/app/scan-worker.js:89-119 (warp + Laplacian blur var + glare share); wired at /home/elrio/hawkeye/app/app.js:693-695 and /home/elrio/hawkeye/app/collation.html:227-236
- Native: partial: a static dashed rectangle guide (components/capture-camera.tsx:364-371) and an ML-Kit legibility hint on the preview (capture-camera.tsx:302-321 via lib/ocr.ts:83). No edge detection, no auto-capture, no perspective crop/de-skew, and no blur/glare measurement — the uploaded EC8A is the raw frame including background. report/collation.tsx:221-235 doesn't even pass readDocument, so the collation form gets no on-device check at all.
- Fix: Add a native doc-scan step (e.g. react-native-vision-camera frame processor / an OpenCV or ML Kit document-scanner module) producing the same quad-detect → warp → blur+glare warning path as scan-worker.js, and pass readDocument to CaptureCamera on the collation form step.

**Incident is tied to the reporter's saved polling unit (puCode), which is what gives the incident its state on the public feed and triggers Telegram alerts to watchers of that unit**

- PWA: /home/elrio/hawkeye/app/incidents.html:216-219 (GET /api/observers/my-unit → fd.set('puCode', …))
- Native: missing entirely — report/incident.tsx:106-125 builds the form with kind/description/lat/lng/media only; grep 'my-unit' in native/src returns nothing. Backend then stores pu_code and state as null (backend/src/routes/incidents.js:76-77,114-118), so a natively filed incident never alerts unit watchers and shows with no state on the feed.
- Fix: Before posting, call /api/observers/my-unit with the bearer token (authedGet in lib/auth.ts:175) and append puCode when present, exactly as incidents.html does.

**"Attach my current location" opt-out on an incident report**

- PWA: /home/elrio/hawkeye/app/incidents.html:102-104 (checked-by-default checkbox #use-gps; unchecking sends no lat/lng)
- Native: missing entirely — report/incident.tsx:102 always calls getQuickFix() and appends lat/lng whenever a fix resolves (incident.tsx:110-113). The observer has no way to file an incident without their coordinates attached.
- Fix: Add a toggle above the submit CTA, default on, and skip the lat/lng append (and the getQuickFix call) when it is off.

**"Report this content" flag on each published incident (Play UGC / App Store 1.2 requirement)**

- PWA: /home/elrio/hawkeye/app/incidents.html:255 (per-card .flag-btn) + :262-281 (flagContent → POST /api/flags with reason abuse/false/privacy/other + detail)
- Native: partial: components/report-content.tsx implements the flag control and the /api/flags call, but it is only mounted for result evidence (app/case.tsx:336, kind="result"). No incident is flaggable natively because no incident is displayed.
- Fix: When the incidents feed lands, mount <ReportContent kind="incident" targetId={i.id} /> on each card — the component already accepts kind 'incident' (report-content.tsx:41).

**Reporting-not-open state — the submit button is disabled before poll-open and the exact opening date/time is shown up front**

- PWA: /home/elrio/hawkeye/app/app.js:196-213 (selectedContestClosed + "Result reporting opens when polls open — Saturday, 15 August 2026, 8:00") and /home/elrio/hawkeye/app/collation.html:272-279
- Native: missing entirely — Contest.open/opensAt are typed at native/src/lib/api.ts:14-15 but never read (grep 'opensAt' in native/src: type declaration only). The observer walks the whole flow, captures both photos and submits before learning it is closed, then gets "Dry run complete" (report/result.tsx:181-185, report/collation.tsx:182-185) with no date.
- Fix: Read contest.open/opensAt on the first step: show the formatted opening datetime and either label the run as practice up front or disable the submit CTA, matching updateScopeNotice().

**Silent session re-mint and automatic retry when the token expires mid-submission**

- PWA: /home/elrio/hawkeye/app/app.js:1030-1034 (on 401: drop token, tryResume() via /api/observers/resume, re-POST the identical submission once)
- Native: partial: lib/auth.ts:136-163 does device-resume at app boot only. native/src/lib/submit.ts:252-254 returns session_expired on a 401 and report/result.tsx:188 just prints "Session expired — sign in again." with no sign-in control on the screen; auth.status is still 'signedIn' so the guard doesn't fire, and leaving the screen loses the captured photos.
- Fix: Extract the resume call from bootstrapAuth into a reusable refresh, and in submitResult/submitCollation retry once after a successful resume before surfacing session_expired; otherwise show a sign-in button on the review screen.

### Results & data

**Follow a race / subscribe to alerts for a contest + region**

- PWA: app/results.html:112 (btn-follow) and :413-426 — token-gated POST /api/subscriptions {contest, state}, with the "verify your phone first" fallback message at :416
- Native: missing entirely
- Fix: No POST to /api/subscriptions exists anywhere under native/src (profile.tsx:410-421 only *lists* subscriptions already created elsewhere). Worse, the native onboarding card at lib/content.ts:70-73 advertises "Follow races & get alerts" with cta "Follow a race" href '/(tabs)/results' — a screen with no follow control, so the promise dead-ends. Add a Follow button on results.tsx wired to POST /api/subscriptions with the observer bearer token from lib/auth.ts, plus the unverified-user fallback. Backend already supports it (backend/src/routes/subscriptions.js:15).

**Map of Nigeria showing the leading party per region, with tap-for-details and a legend**

- PWA: app/results.html:117-126 (map card + legend), :193-281 (renderMap — state / LGA / senatorial / federal-constituency levels, party emblems at each shape's bbox centre, diagonal split fills for exact ties), :400-411 (tap a region → "📍 <region>: X leads · N unit(s)" in #map-info)
- Native: missing entirely
- Fix: results.tsx renders only a flat FlashList of national party totals; the per-region payload is never consumed. Note lib/api.ts:31 types National.regions as `{name, rows}[]`, but backend/src/routes/national.js:62-75 actually returns `{region, leader, leaders, votes, unitsReporting, unitsVerified}` — fix the type first. Then either draw the SVG with react-native-svg from states_geo.json / lga_geo.json / district_geo.json / constituency_geo.json + logos/manifest.json, or at minimum render a tappable per-region list showing leader and units reporting.

**Live-updating leaderboard: "N unit(s) reporting · updated HH:MM:SS" line and 30-second auto-refresh**

- PWA: app/results.html:113 (#updated), written at :358-360, and setInterval(refresh, 30000) at :394
- Native: partial: units-reporting count shown (results.tsx:43), but no updated-at time and no timer — pull-to-refresh only
- Fix: results.tsx:22-24 loads once on mount; the RefreshControl at :49-58 is the only way to update. Add the same 30s interval (reports-log.tsx:92-96 already does exactly this) and render data.updatedAt.

**"Tentative and unofficial — these are not official results, only INEC declares those" disclaimer on the leaderboard itself**

- PWA: app/results.html:103-104 (.unofficial banner above the board)
- Native: missing entirely
- Fix: The results tab header (results.tsx:40-45) carries no disclaimer; the equivalent sentence only appears on the home tab ((tabs)/index.tsx:97-101) and in more.tsx:87-90. Add the banner to the results screen where the tallies actually are.

### Account & alerts

**Tapping a notification opens what it is about**

- PWA: /home/elrio/hawkeye/app/notifications.html:95-97
- Native: partial: the feed lists title/body/time, but rows are inert — `url` is in the Notification type (alerts.tsx:17) and is returned by the API, and is never read or rendered. /home/elrio/hawkeye/native/src/app/(tabs)/alerts.tsx:114-128 renders a plain <View> with no onPress.
- Fix: Wrap the row in a Pressable and map the server's absolute URL to a native route. The backend emits `https://hawkeye.com.ng/case.html?id=N` (backend/src/services/docket.js:73,102,173) and `https://hawkeye.com.ng/dashboard.html` (backend/src/routes/submissions.js:328,334), so a small url→route table (case.html?id=N → /case?id=N, dashboard.html → /reports-log) covers every kind the server currently produces; fall back to WebBrowser.openBrowserAsync for anything unmapped.

**Push notifications on the lock screen, with deep-link on tap**

- PWA: /home/elrio/hawkeye/app/native.js:153-173
- Native: missing entirely — expo-notifications is a dependency (native/package.json:26) and a config plugin (native/app.json:99) but nothing in native/src imports or uses it: no permission prompt, no device-token POST to /api/push/register, no notification-response handler. The server already fires FCM for every in-app note (backend/src/services/notifications.js:13, sendToObserver with data.url), so the native app silently receives nothing.
- Fix: On sign-in, request notification permission, get the device push token, POST it to /api/push/register with {token, platform} (endpoint: backend/src/routes/push.js:9-13), and add addNotificationResponseReceivedListener to route data.url through the same url→route mapping as the in-feed tap.

### Home, map & static

**Save / unsave "my polling unit" (⭐) — the subscription that turns on alerts for every result and approved incident at one unit**

- PWA: app/map-unit.html:115 ("⭐ Save as my polling unit" button) + :314-326 (POST /api/observers/my-unit), :120-125 + :303-312 ("My polling unit" card), :328-334 ("Stop watching" → POST /api/observers/my-unit/clear); entry point also at app/index.html:112 ("Save your polling unit" chip)
- Native: missing entirely — no call to /api/observers/my-unit anywhere in native/src (grep clean). native/src/app/map-unit.tsx only POSTs /api/mappings (:112-125). Worse, native/src/app/profile.tsx:402-408 renders a "My polling unit — None saved" row that routes to /map-unit, a screen with no way to save one, so the loop is dead-ended.
- Fix: Add save/clear actions to map-unit.tsx (POST /api/observers/my-unit with the selected pu_code, POST /api/observers/my-unit/clear), plus a "My polling unit" state card showing the saved unit with a Stop-watching action; wire profile.tsx's row to it.

**Polling-unit map & locator — an actual map with unit markers colour-coded by location status, a legend, and tap-a-marker-to-select**

- PWA: app/map-unit.html:86 (#lmap), :193-205 (Leaflet + OSM tiles), :87-91 (legend: Location confirmed / Crowd-mapped / Needs mapping), :207-213 (selectFromMap), :276-293 (markers, popups with distance + fix count, approx-radius circle)
- Native: missing entirely — native/src/app/map-unit.tsx:215-306 renders only a state→LGA→ward→unit chip drilldown; no map component is imported or rendered anywhere in the file.
- Fix: Add a map view (react-native-maps or MapLibre) to map-unit.tsx rendering /api/mapping/nearby units with the same three status colours, legend and tap-to-select behaviour.

**"📍 Near me" — find your polling unit by GPS instead of drilling through the register**

- PWA: app/map-unit.html:83 (button) + :264-298 (geolocate → /api/mapping/nearby?radiusM=5000, plots units, "N unit(s) within 5 km", tapping a non-verified unit selects it for mapping)
- Native: missing entirely — native/src/app/map-unit.tsx has no /api/mapping/nearby call; the only path to a unit is the three-step register drilldown (:234-303), which requires the observer to know their state, LGA and ward by name.
- Fix: Call /api/mapping/nearby with the device fix on entry (or behind a "Near me" button) and present the returned units as a selectable list/map layer.

**"Ask Hawkeye" assistant — the floating chat that answers questions about the crowd-reported results**

- PWA: app/menu.js:525-593 (mounts on every page when /api/assistant/health reports enabled — includes the signed-in index, how/guide/faq/about/privacy, practice and map-unit; POSTs to /api/assistant)
- Native: missing entirely — no reference to "assistant" anywhere in native/src (grep clean); no equivalent screen or control in (tabs)/index.tsx, (tabs)/more.tsx or page.tsx.
- Fix: Add an assistant screen or bottom-sheet chat that gates on /api/assistant/health and POSTs questions to /api/assistant, with the same "crowd-reported, unofficial figures" disclaimer line.

**Terms of Service**

- PWA: app/terms.html:1-123 (full page: what Hawkeye is, acceptable use, content licence & public ledger, social-media/third-party platforms, no warranty, limitation of liability, changes & contact); linked from app/privacy.html:112
- Native: missing entirely — native/src/lib/content.ts:47-437 defines PAGES for how/guide/about/privacy only, native/src/app/page.tsx:23-29 maps only those five slugs, native/src/app/(tabs)/more.tsx:40-49 omits it, and native/src/app/_layout.tsx:23-42 registers no terms route. No native surface links to it (grep for /terms|Terms/ over native/src returns nothing). NOTE: the web entry point is itself broken — app/menu.js:283-289 overwrites .gov-footer nav on every page, wiping privacy.html's Terms link, so on the live site the page is reachable only by direct URL.
- Fix: Add a `terms` entry to PAGES + the WEB slug map, list it under "Learn & about" in more.tsx, and fix the web footer link while you are there (app-store review expects a reachable EULA/terms link).

**Browsing the polling-unit map, coverage stats and register without an account**

- PWA: app/map-unit.html:336-342 — a signed-out visitor still gets the coverage stats and the live map; only the capture step is gated (:95-98 "need-auth" card), and the map is initialised unconditionally at :300
- Native: missing entirely — native/src/app/map-unit.tsx:168-186 returns a full-screen "Sign in to map a polling unit" wall before anything renders, so a signed-out user sees no stats, no unit list and no map at all.
- Fix: Render the stats/browse/map layer for everyone and gate only the "I am standing here — record fix" action on auth.status === 'signedIn'.


## Minor (11)

### Reporting flows

**Contest scope note — "You are reporting: Ekiti Central Senatorial District, Ekiti State — <election name> · <date>"**

- PWA: /home/elrio/hawkeye/app/observe.html:187 (#contest-scope) + /home/elrio/hawkeye/app/app.js:176-214 (contestScope + updateScopeNotice)
- Native: missing entirely — report/result.tsx:320-323 shows only `contest.election` as a heading; senatorial district / federal constituency / state-assembly scoping is never surfaced, and the Unit type (result.tsx:26) doesn't even carry senatorial/federal_constituency.
- Fix: Port contestScope() from app.js:176 into a shared helper, extend the native Unit type with senatorial/federal_constituency (the register endpoints already return them), and show the line under the contest heading and on the review step.

**Location-tier disclosure — nearby/browse results badged "location verified / crowd-confirmed / located from map data / not yet verified", and the warning notice on the submit screen that the report will stay "location unverified"**

- PWA: /home/elrio/hawkeye/app/observe.html:182 (#tier-notice) + /home/elrio/hawkeye/app/app.js:216-223 (TIER_LABEL/tierOf), :536 and :577 (badge per unit), :588-592 (notice text)
- Native: missing entirely — report/result.tsx:359-388 renders each unit as name + pu_code + ward, lga only; no tier badge, and no equivalent of #tier-notice anywhere in the flow. The observer is never told their unit's location is unverified or crowd-confirmed.
- Fix: Carry locationTier/lat/crowd_lat through the Unit type, badge each row with the TIER_LABEL wording, and show the unverified/crowd notice on the review step.

### Results & data

**"Data at a glance" charts — vote-share donut with party legend, and a bar chart of the most-reporting regions**

- PWA: app/results.html:128-131 (card) and :309-328 (renderGlance — conic-gradient donut, top-6 party legend with %, top-8 regions by unitsReporting as bars)
- Native: missing entirely
- Fix: Add a donut (react-native-svg arcs) over data.national and a top-8 bar list over data.regions sorted by unitsReporting, with the region word driven by data.level as the web does at results.html:306/345.

**"Help cover these states" — states with zero reports for the selected election, plus a become-an-observer prompt**

- PWA: app/results.html:133-137 (gaps card + "Become an observer →" link) and :330-339 (loadGaps → GET /api/coverage/gaps?contest=)
- Native: missing entirely
- Fix: Nothing under native/src calls /api/coverage/gaps (backend/src/routes/pollingUnits.js:80-89 returns {contest, statesTotal, statesReported, missing[]}). Add the call on contest change, render `missing` as chips, hide the card when empty, and link the CTA to /report/result.

**"States led" / "Districts led" column on the party totals table**

- PWA: app/results.html:144 (<th id="led-col">), computed at :285-286 and rendered at :302, relabelled per contest level at :352-354
- Native: missing entirely
- Fix: results.tsx:69-88 renders rank, party code, party name, a share bar and the vote count only. Derive the count of regions where each party is `leader` from data.regions and show it as a column or secondary line.

### Account & alerts

**Marking notifications read (auto on open + explicit "Mark all read")**

- PWA: /home/elrio/hawkeye/app/notifications.html:56 (button), :99-105 (auto-mark on open), :107-112 (handler)
- Native: missing entirely — no call to /api/notifications/read anywhere in native/src (verified by grep). alerts.tsx:37-45 GETs the feed and discards the `unread` field it already destructures at line 40-41, so every notification stays unread forever and the emerald 'unread' row tint (alerts.tsx:116) never clears.
- Fix: POST /api/notifications/read {all:true} on screen focus (useFocusEffect) after a successful load, and add a 'Mark all read' header action shown when unread > 0. The endpoint already exists and returns the new unread count: backend/src/routes/notifications.js:17-28.

**Unread-count badge on the Alerts tab**

- PWA: /home/elrio/hawkeye/app/menu.js:247-253 (tab-bar dot with count, capped at "9+"); same badge on the header bell at menu.js:152-157
- Native: missing entirely — /home/elrio/hawkeye/native/src/app/(tabs)/_layout.tsx:77-83 declares the Alerts tab with no tabBarBadge, and no shared store holds the unread count. Unread is only visible after opening the tab (row background tint, alerts.tsx:116).
- Fix: Hoist the unread count into a small subscribable store (same pattern as lib/auth.ts), refresh it on app foreground and after each feed load, and set `tabBarBadge` on the alerts Tabs.Screen (capped display at 9+).

**Full polling-unit identification on the profile**

- PWA: /home/elrio/hawkeye/app/profile.html:173 (unit: name, pu_code, ward, LGA, state); :177-180 (result-report rows include pu_code in the sub line)
- Native: partial: profile.tsx:402-408 shows the unit as a single right-aligned row value `name || pu_code`, numberOfLines={1} inside max-w-[45%] — ward, LGA, state and (when a name exists) the PU code are never rendered. Same omission in the result-report accordion rows, profile.tsx:450-461, which show only LGA/state and drop pu_code.
- Fix: Give 'My polling unit' its own card (or a two-line row) showing pu_code plus ward/LGA/state, and add pu_code to the report row's secondary line.

### Home, map & static

**Mapping-coverage statistics (units with a verified location, crowd-mapped count, register totals)**

- PWA: app/map-unit.html:75 + :139-142 ("X of Y units have a verified location · N crowd-mapped so far" from /api/mapping/stats); same data drives the landing stats band at app/index.html:207-214 + :302-308 (176,846 units on the register, units with a confirmed location, 9,307 wards mapped)
- Native: missing entirely — no call to /api/mapping/stats anywhere in native/src. native/src/app/(tabs)/index.tsx:84-93 shows only integrity.reports and integrity.unitsFlagged; native/src/app/map-unit.tsx shows no stats line.
- Fix: Fetch /api/mapping/stats and render the coverage line on map-unit.tsx (and optionally as a stat tile on the Home tab).

**Unread-alert badge on the bell / Alerts tab**

- PWA: app/menu.js:247-253 (tab-bar bell dot with unread count, "9+" cap) and :154-157 (header bell badge), both from /api/notifications.unread
- Native: missing entirely — native/src/app/(tabs)/_layout.tsx:77-83 sets no tabBarBadge, and native/src/app/(tabs)/alerts.tsx:40-41 discards the `unread` field it already receives. Nothing tells an observer an alert is waiting until they open the tab.
- Fix: Surface the unread count as a tabBarBadge on the alerts screen options, fed by the same /api/notifications response.

**Manual light/dark theme toggle**

- PWA: app/menu.js:113-130 — a theme button beside the hamburger on every page, toggling from the effective mode and persisting to localStorage (applied pre-paint at :3-6)
- Native: missing entirely — native/src/app/_layout.tsx:15-21 follows the OS colour scheme only, with no user override and no persisted preference (native screens are also hard-coded to the light palette, so a toggle needs dark styling to land against).
- Fix: Persist a theme preference (SecureStore/AsyncStorage) and honour it over useColorScheme; requires dark variants for the hard-coded hawk-mist/white surfaces.

## Refuted

Claimed but present, equivalent, or out of scope — do not "fix" these:

- **Confirming OCR-suggested counts before the report is signed — a blocking dialog listing every auto-filled party/count that must be acknowledged** — REFUTED — the capability exists in native, implemented as a mandatory confirmation *screen* instead of a modal dialog ("does it DIFFERENTLY but equivalently"). PWA (the thing being compared): /home/elrio/hawkeye/app/app.js:931-936 is the O
- **"Report another unit" — start a fresh report immediately after a successful submission** — Refuted as a different-but-equivalent navigation shape, not a missing capability. PWA side (confirmed): /home/elrio/hawkeye/app/observe.html:246 renders `<button id="btn-another">Report another unit</button>` on #screen-result, and /home/e
- **Incident types come from the server (/api/incidents/kinds)** — REFUTED — not a user-facing gap; sourcing-mechanism difference only, and the premise that the server list is dynamic is false. (1) Both sides offer the identical eight options. Native renders all eight as selectable chips: /home/elrio/hawk
- **Open the raw Rekor log entry for an anchor** — Mechanically the reviewer is right that native has no second "raw" link, but the capability itself is not missing. PWA app/ledger.html:151 offers two anchors to the SAME Rekor log entry: "View in Rekor" -> rekorSearchUrl || rekorUrl, plus "
- **See a case's outcome by colour on the docket list and case header (upheld / cleared / unresolved)** — Refuted — this is a styling difference, not a missing capability. The reviewer's code reading is accurate (native/src/components/tally.tsx:19-24 STATUS_TONE keys on open|fraudulent|legit|inconclusive, while backend case statuses are open|up
- **Pick which election the leaderboard shows (Presidential / Governorship / Senate / Reps / State Assembly)** — REFUTED — the claimed capability does not exist on the PWA either, so there is nothing for native to be missing. The reviewer's five-race list is fabricated from a sort comparator, not from available data: 1. The web `<select id="sel-cont
- **Filter the leaderboard by state / senatorial district / federal constituency ("Everywhere" scope picker)** — Refuted: the PWA has no leaderboard scope filter. app/results.html:111's #sel-scope carries a misleading aria-label ("Filter the leaderboard by state or district"), but the code never filters with it — refresh() (app/results.html:341-361) a
- **Party emblem and numeric vote share on each leaderboard row** — Refuted as a presentation difference, not a missing capability. Native leaderboard row (native/src/app/(tabs)/results.tsx:69-88) renders every datum the web row does: rank (:71), party identity (:73-76), vote share (:77-82), votes (:84-86).
- **2027 presidential race candidate cards shown inline on the Political Data page (portrait, party pill with emblem, incumbent badge, one-line bio) plus the "election · note (as of date)" line** — The 2027 presidential candidate cards are fully implemented natively, just on the linked screen instead of inline. /home/elrio/hawkeye/native/src/app/candidates.tsx:21,47 loads data.race2027 and renders it via RaceView; /home/elrio/hawkeye/
- **"See also" cross-links from the candidates page to Political Data and the live leaderboard** — Refuted — navigation chrome, not a missing capability. The PWA line at app/candidates.html:103-104 ("See also: who holds power now · the live leaderboard") is a wayfinding shortcut needed because the web page has no persistent nav (it relie
- **Notification type icon per row** — Refuted as a gap (the code claim is accurate, the consequence is not). Native alerts.tsx:114-128 does render no icon and never reads the `kind` field typed at alerts.tsx:14 — I searched the whole native tree and no component/lib/route rende
- **Signed-in Observer Home (greeting, saved-unit chip, latest-alerts preview, my-activity counters, live ledger preview)** — Refuted — this is an IA/layout difference, not a missing capability. The web's Observer Home (app/index.html:106-152, :335-372) is a set of previews that each link out to a real screen; native renders every one of those screens in fuller fo
- **Inline links inside explainer copy, and the Observer Guide's closing call to action** — REFUTED — this is a presentation difference in a deliberately redesigned surface, not a missing user-facing capability. Every destination the inline links point at is reachable natively, several of them from within the same explainer-conten
- **Practice-run contest details and the closed-state escape links** — REFUTED — both halves fall under "NOT a gap". (1) cfg.office / cfg.note. Factually the reviewer is right that native/src/app/practice.tsx types them at :27-28 and never renders them (only cfg.name at :295, unit at :299/:350). But this is a
- **"Try a practice run first" on the welcome/auth screen** — Refuted — placement difference, not a missing capability. The native app has a complete Practice Run: native/src/app/practice.tsx:55-450 implements the full flow (sheet photo → venue photo → counts → review → sign & submit), registered as a

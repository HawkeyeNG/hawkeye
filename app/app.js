/* Hawkeye observer PWA — no framework, no build step.
 * Security-relevant invariants:
 *  - the private key is generated NON-EXTRACTABLE and never leaves this device
 *  - BOTH photos (EC8A sheet + polling-unit surroundings) come only from live
 *    camera captures (no <input type="file"> anywhere)
 *  - nearby list offers only geofenceable units (verified or crowd tier); register
 *    browse reaches the rest, whose reports stay badged location-unverified
 *  - canonicalPayload() must stay byte-identical to backend/src/services/signatures.js
 */
const $ = (id) => document.getElementById(id);
const API = ''; // same origin

// ---------- tiny IndexedDB key-value store (holds the CryptoKeyPair) ----------
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('hawkeye', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const rq = db.transaction('kv').objectStore('kv').get(key);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function kvSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- observer identity ----------
async function ensureKeys() {
  let pair = await kvGet('keypair');
  if (!pair) {
    pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // non-extractable: the private key can sign but never be exported
      ['sign', 'verify'],
    );
    await kvSet('keypair', pair);
  }
  return pair;
}

async function signPayload(pair, payloadString) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(payloadString),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Mirror of backend/src/services/signatures.js — keep byte-identical.
function canonicalVotes(votes) {
  return votes
    .map((v) => ({ party: String(v.party), count: Number(v.count) }))
    .sort((a, b) => (a.party < b.party ? -1 : a.party > b.party ? 1 : 0));
}
function canonicalPayload({
  puCode, contest, votes, imageSha256, venueImageSha256, capturedAt, venueCapturedAt,
  lat, lng, sheetLat, sheetLng, venueLat, venueLng,
}) {
  return JSON.stringify({
    puCode,
    contest,
    votes: canonicalVotes(votes),
    imageSha256,
    venueImageSha256,
    capturedAt,
    venueCapturedAt,
    lat,
    lng,
    sheetLat,
    sheetLng,
    venueLat,
    venueLng,
  });
}

// ---------- helpers ----------
async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'x-device-id': await getDeviceId() };
  const res = await fetch(API + path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
/**
 * ONE RETRY, AND A REAL DEADLINE — the rule native/src/app/report/result.tsx
 * already applies, ported here rather than written a third time.
 *
 * A bare `await api()` has no timeout: /api/polling-units measures ~6.4 s from a
 * good link, close enough to a mobile socket timeout that a slow election-day
 * network can leave the promise pending forever. The rejection then escaped the
 * click handler entirely, so "Looking up nearby units…" stayed on screen for the
 * rest of the session with no error and no second chance.
 *
 * Never throws. Returns { status, body, error } — `error` set means the call did
 * not complete, and it NAMES the failure, because "lookup_failed" could not be
 * told apart from a timeout, a DNS failure or a 500.
 */
async function apiTry(path, { tries = 2, timeoutMs = 20000, ...opts } = {}) {
  let err = '';
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await api(path, { ...opts, signal: ctl.signal });
    } catch (e) {
      err = e && e.name === 'AbortError'
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : (e && e.message) || String(e);
    } finally { clearTimeout(t); }
  }
  return { status: 0, body: {}, error: err || 'network unreachable' };
}
/**
 * A blocking refusal, shown as a dialog. Reuses menu.js's info modal so there is
 * one dialog implementation, and degrades to alert() if menu.js has not loaded
 * (the shell is cached separately, so that is a real possibility) — a refusal
 * must never fail silently, which is the whole reason it stopped being a line of
 * text under the submit button.
 */
function notifyBlocked(title, body) {
  if (window.HAWKEYE_MODAL) window.HAWKEYE_MODAL(title, body, '');
  else alert(body);
  const s = $('submit-status');
  if (s) s.textContent = body; // still recorded in place for screen readers
}
let autoLocateRan = false;
function show(screenId) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== screenId;
  window.scrollTo(0, 0); // each screen starts at the top, not the old scroll pos
  // GPS FIRST, EVERY FLOW, EVERY PLATFORM: arriving at "which unit?" IS the
  // request to find it, so the lookup runs itself rather than waiting on a
  // press. btn-locate's handler already ends every failure somewhere usable —
  // a message plus the register browser opened — so firing it unprompted cannot
  // strand anyone. It SUGGESTS only; selecting a unit is still a deliberate tap.
  // Once per session: a return trip to this screen (changing unit, a rejected
  // submit) must not re-trigger a lookup the observer did not ask for.
  // The unit picker now lives on the report screen (step 2), so that is where
  // the lookup arms. Once per session: a return trip — changing unit, a rejected
  // submit — must not re-trigger a search the observer did not ask for.
  if (screenId === 'screen-submit' && !autoLocateRan && $('btn-locate')) {
    autoLocateRan = true;
    // The button is NOT renamed here. It used to read "Search near me again"
    // before any search had run — offering to repeat something that had never
    // happened once. The handler renames it after a search actually completes.
    setTimeout(() => $('btn-locate').onclick(), 0); // after this screen paints
  }
  // Mark the auth step so the app can strip its chrome: nothing in the shell
  // should be reachable before sign-in, and a header/tab bar around a sign-in
  // form makes it look like a web page rather than an app screen. Scoped to the
  // register screen only — the report flow that follows still needs navigation.
  document.documentElement.classList.toggle('auth-screen', screenId === 'screen-register');
}
let lastFix = null; // most recent successful GPS fix
// maximumAge 30s, not 0: the keeper is already feeding lastFix, and demanding a
// brand-new satellite fix made the FIRST lookup race a cold GPS start and lose
// — the observer saw "failed", tapped the button, and won only because the
// first attempt had warmed the chip. A 30s-old fix is ample to shortlist units.
// On failure, fall back to whatever the keeper last saw before giving up.
function getPosition() {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastFix = pos;
        resolve(pos);
      },
      (err) => (lastFix ? resolve(lastFix) : reject(err)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    ),
  );
}
// Capture-time fix: fast (accepts a <30 s old reading), falls back to the last
// known fix — each photo gets GPS-stamped the moment it is taken.
async function getCaptureFix() {
  // A FIX THE KEEPER TOOK MOMENTS AGO IS AS GOOD AS ONE TAKEN NOW — the observer
  // has not moved between the shutter and this line.
  //
  // This used to always ask for a fresh high-accuracy lock. Indoors that burns
  // the entire 8 s timeout and then falls back to `lastFix` ANYWAY — the same
  // value this returns immediately — so the shutter appeared dead for 5-7 s and
  // step 1 could not fold until it resolved. It really was faster by a window:
  // outdoors the lock returned quickly, indoors it always timed out.
  if (lastFix && Date.now() - lastFix.timestamp < 30000) return lastFix;
  try {
    return await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lastFix = pos;
          resolve(pos);
        },
        reject,
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
      ),
    );
  } catch {
    return lastFix;
  }
}
/**
 * LATENT LOCATION KEEPER — keeps `lastFix` warm for as long as the app is in use.
 *
 * Every expensive moment in this product needs a fix: both photos are
 * GPS-stamped at the shutter, the submission carries its own fix, and the
 * near-me lookup cannot start without one. A cold `getCurrentPosition` on a
 * phone can take many seconds, and it was being paid at exactly the wrong times
 * — at the shutter, with a crowd forming, or on arriving at the unit step.
 *
 * watchPosition rather than a polling interval: the OS is already tracking
 * position for other apps and coalesces subscribers, so this rides along with
 * what the platform is doing anyway instead of forcing a fresh fix on a timer.
 *
 * Suspended whenever the page is hidden, so a backgrounded tab is never holding
 * the GPS open. Resumed on return, because a fix from before the observer
 * travelled is worse than no cached fix at all.
 */
let geoWatchId = null;
function startLocationKeeper() {
  keeperWanted = true;
  if (geoWatchId != null || !navigator.geolocation) return;
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastFix = pos;
      prefetchNearby(); // first fix arms the unit list before its turn comes
    },
    () => { /* denied/unavailable — every caller already has its own fallback */ },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 },
  );
}
function stopLocationKeeper() {
  if (geoWatchId == null) return;
  navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = null;
}
let keeperWanted = false; // only true once the report flow has asked for it
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLocationKeeper();
  // Resume ONLY if the flow had it running. Without this guard, backgrounding
  // and returning to the sign-in screen would start the keeper there — exactly
  // the context-free permission prompt moving it out of page load avoided.
  else if (keeperWanted) startLocationKeeper();
});

/**
 * NEAR-ME PREFETCH. The unit list is fetched as soon as a fix exists, not when
 * the observer reaches the unit step, so the step opens already populated
 * instead of spending its first seconds on a round trip.
 *
 * Cached against the position it was fetched from and re-fetched once the
 * observer has moved past the staleness bounds — a list from 500 m ago is the
 * wrong list, and silently showing it would be worse than a short wait.
 */
let nearbyCache = null; // { lat, lng, at, body }
const NEARBY_MAX_AGE_MS = 120000;
const NEARBY_MAX_MOVE_M = 150;
// Metres between two fixes. The server has its own haversine; this side had
// none, and the cache is only sound if it can tell that the observer moved.
function fixDistanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function nearbyCacheUsable() {
  if (!nearbyCache || !lastFix) return false;
  if (Date.now() - nearbyCache.at > NEARBY_MAX_AGE_MS) return false;
  return fixDistanceM(
    lastFix.coords.latitude, lastFix.coords.longitude,
    nearbyCache.lat, nearbyCache.lng,
  ) <= NEARBY_MAX_MOVE_M;
}
async function prefetchNearby() {
  if (!lastFix || nearbyCacheUsable()) return;
  const { latitude: lat, longitude: lng } = lastFix.coords;
  try {
    const { body } = await api(`/api/polling-units?lat=${lat}&lng=${lng}`);
    nearbyCache = { lat, lng, at: Date.now(), body };
  } catch { /* best-effort warm-up; btn-locate still does the real fetch */ }
}

const ERRORS = {
  outside_geofence: 'You are too far from this polling unit to report it.',
  too_far_from_unit: 'You are too far from this polling unit — report only while standing there.',
  sms_send_failed: 'Could not deliver your code just now — wait a minute and tap Resend code.',
  otp_incorrect: 'That code is not right — check it and try again.',
  otp_expired: 'That code has expired — tap "Resend code" to get a fresh one.',
  too_many_attempts: 'Too many wrong tries — tap "Resend code" and enter the fresh code.',
  too_many_requests: 'Too many requests from your connection — wait a few minutes and try again.',
  gps_accuracy_too_low: 'GPS signal too weak — move to open sky and retry.',
  photo_not_fresh: 'Photos too old — capture them again and submit immediately.',
  photo_required: 'The result sheet photo is missing.',
  venue_photo_required: 'A distinct photo of the polling unit surroundings is required.',
  duplicate_image: 'One of these exact photos was already submitted by someone.',
  near_duplicate_image: 'A near-identical copy of one of these photos was already submitted.',
  already_submitted: 'You have already reported this election for this polling unit.',
  unknown_contest: 'Select which election you are reporting.',
  contest_not_applicable: 'That election does not take place at this polling unit (the FCT has no governorship or state assembly).',
  photo_location_mismatch: 'Your photos were taken somewhere else — capture both here and submit immediately.',
  bad_signature: 'Signature check failed — refresh and try again.',
  invalid_votes: 'Check the counts — whole numbers only.',
  device_already_reported_race: 'This device has already reported this election — one report per race per device.',
  device_too_fast: 'This device just submitted a report — wait a few minutes and try again.',
  reporting_not_open: 'Result reporting opens on election day, when polls open. Come back then.',
};
const explain = (body) => body.hint || ERRORS[body.error] || body.error || 'Something went wrong.';

// Mirror of backend/src/services/scope.js — the polling unit determines the race.
// The FCT has an appointed minister: no governorship, no state assembly.
const stateLabel = (s) => (s === 'FCT' ? 'the FCT' : `${s} State`);
// `states` (optional) = a single-state election's allowlist (e.g. Osun 2026
// pilot); absent/empty ⇒ nationwide. Mirror of backend scope.js.
const contestApplies = (u, contest, states) =>
  !(u.state === 'FCT' && (contest === 'GOV' || contest === 'SHA'))
  && (!states || !states.length || states.includes(u.state));
function contestScope(u, contest) {
  switch (contest) {
    case 'SEN':
      return u.senatorial
        ? `${u.senatorial} Senatorial District, ${stateLabel(u.state)}`
        : `${stateLabel(u.state)} — senatorial district not on register`;
    case 'REP':
      return u.federal_constituency
        ? `${u.federal_constituency} Federal Constituency, ${stateLabel(u.state)}`
        : `${stateLabel(u.state)} — federal constituency not on register`;
    case 'GOV':
      return `${u.state} State Governorship`;
    case 'SHA':
      return `${u.state} State House of Assembly (constituency covering ${u.lga} LGA)`;
    default:
      return 'Presidential — national contest';
  }
}
// A scheduled election (server sends open:false + opensAt until poll-open on
// election day) cannot be reported early — submit stays disabled with a notice.
const selectedContestClosed = () => {
  const c = contests.find((x) => x.code === $('sel-contest').value);
  return Boolean(c && c.open === false);
};
function updateScopeNotice() {
  if (!selectedPu) return;
  const contest = $('sel-contest').value;
  const c = contests.find((x) => x.code === contest);
  const when = c?.date
    ? ` · ${new Date(c.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
    : '';
  const notYet = c && c.open === false && c.opensAt
    ? ` Result reporting opens when polls open — ${new Date(c.opensAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })}.`
    : '';
  $('contest-scope').textContent = contest
    ? `You are reporting: ${contestScope(selectedPu, contest)}${c?.election ? ` — ${c.election}${when}` : ''}.${notYet}`
    : 'Choose which election you are reporting before continuing.';
  updateSubmitState();
}

const TIER_LABEL = {
  verified: '📍 location verified',
  crowd: '◌ crowd-confirmed location',
  geocoded: '◌ located from map data (unconfirmed)',
  unmapped: '⚠ location not yet verified',
};
// `crowd_mapped` is graded FIRST, ahead of the server's own tier: /api/polling-units
// runs pollingUnits.js:tierOf(), which calls any row holding `lat` 'verified' — including
// a promoted crowd median (mapping.js writes the clustered median into `lat` alongside
// coords_source='crowd_mapped'). Matches native's rowTier (native/src/app/map-unit.tsx),
// so a crowd-confirmed location is never overstated as verified.
const tierOf = (u) =>
  u.coords_source === 'crowd_mapped'
    ? 'crowd'
    : u.locationTier || (u.lat != null ? 'verified' : u.crowd_lat != null ? 'crowd' : 'unmapped');

// ---------- state ----------
let selectedPu = null;
let parties = [];
/**
 * THE COUNTS STEP MUST NEVER BE EMPTY.
 *
 * If /api/parties yielded nothing — offline, a bad response, anything —
 * buildVoteRows() rendered an empty div, and step 4 became a card with a filter
 * box, a serial field and NOWHERE TO TYPE A SINGLE NUMBER. That shipped: an
 * observer reached the counts step with no count to enter, and "Verify counts"
 * then refused because it could find no inputs, which read as a broken button.
 *
 * INEC's register of parties changes between cycles, not between deploys, so a
 * bundled copy is a safe floor. The live list still wins whenever it arrives,
 * and a good response is cached so the next run starts from real data.
 */
const FALLBACK_PARTIES = [
  ['A', 'Accord'], ['AA', 'Action Alliance'], ['AAC', 'African Action Congress'],
  ['ADC', 'African Democratic Congress'], ['ADP', 'Action Democratic Party'],
  ['APC', 'All Progressives Congress'], ['APGA', 'All Progressives Grand Alliance'],
  ['APM', 'Allied Peoples Movement'], ['APP', 'Action Peoples Party'], ['BP', 'Boot Party'],
  ['DLA', 'Democratic Leadership Alliance'], ['LP', 'Labour Party'],
  ['NNPP', 'New Nigeria Peoples Party'], ['NRM', 'National Rescue Movement'],
  ['PDP', 'Peoples Democratic Party'], ['PRP', 'Peoples Redemption Party'],
  ['SDP', 'Social Democratic Party'], ['YP', 'Youth Party'],
  ['YPP', 'Young Progressives Party'], ['ZLP', 'Zenith Labour Party'],
].map(([code, name]) => ({ code, name }));

/** The last good /api/parties response. Same idea as cachedContests(). */
function cachedParties() {
  try {
    const v = JSON.parse(localStorage.getItem('hawkeye_parties') || 'null');
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}
let contests = [];
let logos = null; // party code -> official emblem path (logos/manifest.json)
// cameraStream/capturing now live in capture.js — the single camera owner.
const shots = { sheet: null, venue: null }; // { blob, capturedAt }

// ---------- registration (single pane: phone first, then OTP in the same input) ----------
let authMode = 'phone';
let pendingPhone = '';

// Why the user is registering, from the CTA (?intent=observe|map|incident).
// Drives the verification heading and where we send them once verified.
const RAW_INTENT = new URLSearchParams(location.search).get('intent'); // null = plain sign-in
const AUTH_INTENT = RAW_INTENT || 'observe';
const INTENT_LABEL = { observe: 'Become an Observer', map: 'Map a Polling Unit', incident: 'Report an Incident' };
const INTENT_DEST = { map: 'map-unit.html', incident: 'incidents.html' };
// 'signin' = a RETURNING observer from the header/hero link. It opens straight in
// password mode and lands on index.html (their dashboard) once authenticated —
// afterVerified() already routes every non-'observe' intent there, so returning
// users no longer get dropped into the report flow's unit picker.
const IS_SIGNIN = AUTH_INTENT === 'signin';

// Telegram hybrid /report handoff: PU + votes were chosen in chat; prefill and
// jump straight to the live-capture screen (the photo + signature must happen here).
const QP = new URLSearchParams(location.search);
const PREFILL = (QP.get('pu') && QP.get('contest')) ? {
  pu: QP.get('pu'), contest: QP.get('contest'),
  votes: (() => { try { return JSON.parse(QP.get('votes') || '[]'); } catch { return []; } })(),
} : null;
// The signed-out access guard (authgate.js) sends users here with ?next=<page> —
// the gated page they were trying to open. Honour it once authenticated. Relative
// .html paths only, so it can never be turned into an open redirect.
const NEXT_DEST = (() => {
  const n = QP.get('next');
  return n && /^[a-z0-9_\-]+\.html(?:\?[^#]*)?$/i.test(n) ? n : null;
})();
// The "To Become an Observer, verify your phone below." banner is gone: the
// heading and lede already say it, and a tinted notice above them made the
// sign-up screen look cluttered. Kept as a no-op so the intent plumbing (which
// still drives the destination after verifying) doesn't need unpicking.
function applyIntentCopy() { /* intentionally empty — see note above */ }
// Sign-in mode (?intent=signin): password field up front for returning observers,
// OTP still one tap away via #pw-link, and a "Sign up" escape hatch so someone
// without an account isn't stranded on a password field. Re-applied by
// resetAuthPane so "use a different number" doesn't silently become sign-up.
function applySignInMode() {
  if (!IS_SIGNIN) return;
  authMode = 'password';
  const title = $('register-title');
  if (title) title.textContent = 'Sign In';
  // "One number, one observer" is a sign-UP promise; a returning observer has
  // already made it.
  const lede = $('register-lede');
  if (lede) lede.textContent = 'Welcome back — sign in to your observer account.';
  if ($('pw-signin-wrap')) $('pw-signin-wrap').hidden = false;
  if ($('channel-pick')) $('channel-pick').hidden = true;   // password sign-in sends no code
  syncChannelGate();
  $('btn-auth').textContent = 'Sign In';
  if ($('pw-link')) {
    $('pw-link').hidden = false;                            // reset path, sign-in only
    $('pw-link').textContent = 'Forgot your password?';
  }
  if ($('signin-line')) $('signin-line').hidden = true;     // they ARE on sign-in
  if ($('signup-line')) $('signup-line').hidden = false;
  if ($('pw-opt')) $('pw-opt').hidden = true;               // creating one is a sign-up job
  // A returning observer doesn't need the big practice pitch card — but a light
  // practice link still belongs here (a practice link on every auth screen).
  if ($('starter-card')) $('starter-card').hidden = true;
  if ($('practice-line')) $('practice-line').hidden = false;
}
// Sign-up mode (everything that isn't ?intent=signin). Mirror image of the above:
// no "have a password?" toggle (a new observer can't have one), a link across to
// sign-in instead, and the create-a-password option offered up front rather than
// only appearing once a code has been sent.
function applySignUpMode() {
  if (IS_SIGNIN) return;
  if ($('pw-link')) $('pw-link').hidden = true;
  if ($('signup-line')) $('signup-line').hidden = true;
  if ($('signin-line')) $('signin-line').hidden = false;
  if ($('pw-opt')) $('pw-opt').hidden = false;
}

function afterVerified() {
  if (NEXT_DEST) { location.href = NEXT_DEST; return; }
  if (INTENT_DEST[AUTH_INTENT]) { location.href = INTENT_DEST[AUTH_INTENT]; return; }
  // Default intent is 'observe' (AUTH_INTENT), so a fresh verification on this
  // page continues into the report flow even when a shared/og link dropped the
  // ?intent=observe param — matching the signed-in boot path below.
  if (AUTH_INTENT === 'observe') { enterReportFlow(); return; }
  location.href = 'index.html';
}

function resetAuthPane() {
  authMode = 'phone';
  pendingPhone = '';
  const input = $('auth-input');
  input.value = '';
  input.placeholder = 'Enter Phone Number';
  input.type = 'tel';
  input.inputMode = 'tel';
  $('btn-auth').textContent = 'Request OTP';
  $('otp-hint').textContent = '';
  $('auth-reset').hidden = true;
  if ($('otp-resend')) $('otp-resend').hidden = true;
  if ($('otp-phone')) $('otp-phone').hidden = true;
  if ($('channel-pick')) {
    $('channel-pick').hidden = false;
    // NO DEFAULT CHANNEL: a pre-selected route meant a mistap could send on a
    // channel the user never chose (and cost us a paid message). Clear every
    // radio and keep Request OTP disabled until one is picked.
    for (const r of document.querySelectorAll('input[name="otp-channel"]')) r.checked = false;
    syncChannelGate();
  }
  pendingChannel = '';
  if ($('pw-signin-wrap')) {
    $('pw-signin-wrap').hidden = true;
    $('pw-signin-input').value = '';
  }
  if ($('pw-opt-input')) $('pw-opt-input').value = '';
  // Whichever mode this visit is in owns the links and the password controls —
  // exactly one of these two does anything.
  applySignUpMode();
  applySignInMode();   // keep a sign-in visit in sign-in mode after a reset
}

// Password (#pw-opt-input) is REQUIRED and shown whenever a code is in flight —
// no checkbox to toggle. It's applied right after a successful OTP verify (fresh
// phone proof, so no current password is needed), on both sign-up and reset.

// SIGN-IN ONLY (the link is hidden on sign-up): "Forgot your password?" flips the
// pane into the OTP flow, which then forces a NEW password on verify — a proper
// reset. OTP is thus only ever a sign-up or password-reset tool, never a way to
// sign in around a password.
if ($('pw-link')) $('pw-link').onclick = (e) => {
  e.preventDefault();
  const toPw = authMode !== 'password';
  authMode = toPw ? 'password' : 'phone';
  $('pw-signin-wrap').hidden = !toPw;
  if (!toPw) $('pw-signin-input').value = '';
  if ($('channel-pick')) $('channel-pick').hidden = toPw; // password sign-in sends no code
  syncChannelGate();
  $('btn-auth').textContent = toPw ? 'Sign In' : 'Request OTP';
  $('pw-link').textContent = toPw ? 'Forgot your password?' : 'Sign in with your password instead';
  $('otp-hint').textContent = '';
};

// The delivery channel picked on the form ('telegram' | 'whatsapp'; 'sms' is
// retired until a sender ID is approved); remembered for "Resend code". Radios
// are required — no silent default.
// Request OTP stays disabled (and greyed) until a delivery channel is chosen.
/**
 * Offer SMS only when the server can actually send it.
 *
 * Nigerian carriers drop SMS from unapproved sender IDs, so the option was
 * hard-removed from the page while approval was pending — which meant the
 * website, the APK and every cached copy each carried their own answer, and
 * turning SMS on later needed a redeploy AND an APK rebuild. /api/health
 * publishes the switch instead, so the server decides once for all of them.
 *
 * Fails closed: no answer, no SMS option. Never awaited by anything on the
 * critical path — the radio simply appears a moment later if it applies.
 */
function revealSmsOptionIfEnabled(tries = 2) {
  const opt = document.getElementById('otp-sms-opt');
  if (!opt) return;
  // ADDRESS THE API HOST EXPLICITLY. In the Capacitor shell the page origin is
  // localhost, so a leading-slash URL only reaches the server because native.js
  // rewrites window.fetch — which makes this option depend on script order
  // between two files that have no other reason to care about each other. The
  // shell already publishes the host it uses; read it.
  const base = (window.HAWKEYE && window.HAWKEYE.apiBase) || API || '';
  fetch(base + '/api/health')
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => {
      if (h && h.smsOtp === true) { opt.hidden = false; return; }
      // A null body means the request completed but said nothing useful; only a
      // THROWN failure is worth a second attempt.
    })
    .catch(() => {
      // One retry. This is the first request the app makes on a cold start, so
      // it is the one most likely to land while the radio is still warming up —
      // and the cost of losing it is an option that silently never appears.
      if (tries > 1) setTimeout(() => revealSmsOptionIfEnabled(tries - 1), 2500);
    });
}

let smsProbed = false;
function probeSmsOnce() {
  if (smsProbed) return;
  smsProbed = true;
  revealSmsOptionIfEnabled();
}
/**
 * Probe at LOAD, not only from syncChannelGate().
 *
 * syncChannelGate() runs on the returning-user branch and on auth-mode toggles,
 * but NOT on first paint for a signed-out visitor — who is exactly the person
 * being offered a delivery channel. Hanging the probe off it looked right and
 * fired zero times: the option stayed hidden with the server answering
 * smsOtp:true. revealSmsOptionIfEnabled() no-ops when the radio is absent, so
 * this is safe on every page that loads app.js.
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', probeSmsOnce, { once: true });
} else {
  probeSmsOnce();
}

function syncChannelGate() {
  probeSmsOnce();
  const btn = document.getElementById('btn-auth');
  const pick = document.getElementById('channel-pick');
  if (!btn) return;
  // No picker on screen (password sign-in sends no code) => nothing to gate.
  if (!pick || pick.hidden) { btn.disabled = false; return; }
  btn.disabled = !document.querySelector('input[name="otp-channel"]:checked');
}
document.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'otp-channel') syncChannelGate();
});

const pickedChannel = () => document.querySelector('input[name="otp-channel"]:checked')?.value || '';
let pendingChannel = '';

// Keep the entered number visible while the pane is in OTP mode — a typo should
// be obvious the whole time they wait, not only in the flipped input.
// The number used to be echoed in a SECOND line that also told people to tap
// "← Use a different number" — a link already sitting right below it. Three
// stacked sentences for one fact. The number now appears once, in the sent
// confirmation, and the existing link is the escape hatch.
function showOtpPhone() {
  const el = $('otp-phone');
  if (el) el.hidden = true;
}

// Re-issue the code on a chosen channel — powers both "Resend code" and the
// "get it on WhatsApp instead" switch shown under a Telegram send.
async function resendVia(channel) {
  pendingChannel = channel;
  $('otp-hint').textContent = 'Sending a fresh code…';
  try {
    const { status, body } = await api('/api/observers/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: pendingPhone, channel }),
    });
    if (status !== 200) { $('otp-hint').textContent = explain(body); return; }
    renderOtpSent(body);
  } catch { $('otp-hint').textContent = 'Network problem — check your connection and try again.'; }
}

// How the code was delivered — shared by the first send and "Resend code".
// The user needs a single fact — where the code went — and the number so they can
// spot a typo. Telegram is the default, so a Telegram send also offers WhatsApp.
function renderOtpSent(body) {
  const to = `<strong>${pendingPhone.replace(/</g, '&lt;')}</strong>`;
  const hint = $('otp-hint');
  const waSwitch = ' <a class="btn-link" id="switch-wa" href="#">Prefer WhatsApp? Get the code there instead.</a>';
  if (body.devOtp) {
    hint.textContent = `DEV MODE — your code is ${body.devOtp}`;
  } else if (body.viaWhatsapp) {
    hint.innerHTML = `Code sent on WhatsApp to ${to}.`;
  } else if (body.viaSms) {
    // Telegram stays a quiet alternative on its own line, never auto-launched.
    hint.innerHTML = `Code sent by SMS to ${to}.${body.telegramLink
      ? ` <a class="btn-link" href="${body.telegramLink}" target="_blank" rel="noopener">Use Telegram instead</a>` : ''}`;
  } else if (body.telegramLink) {
    // The bot can only message someone who has opened it, so we send them
    // straight there; the two taps inside the bot are the whole instruction.
    hint.innerHTML = `<a class="btn-link" id="tg-open" href="${body.telegramLink}" target="_blank" rel="noopener">Open Telegram</a> — tap <strong>Start</strong>, then <strong>Share my phone number</strong>.` + waSwitch;
    $('tg-open').click(); // fresh gesture-linked click dodges popup blockers
  } else if (body.viaTelegram) {
    // Telegram is the default — say so plainly, and offer WhatsApp as the switch.
    hint.innerHTML = `Code sent on Telegram to ${to}.` + waSwitch;
  } else {
    hint.innerHTML = `Code sent to ${to}.`;
  }
  const sw = $('switch-wa');
  if (sw) sw.onclick = (e) => { e.preventDefault(); resendVia('whatsapp'); };
  showOtpPhone();
}

// A code that never arrived or expired is recoverable in place — the server
// happily re-issues on a fresh /register call for the same number.
if ($('otp-resend')) $('otp-resend').onclick = async (e) => {
  e.preventDefault();
  $('otp-hint').textContent = 'Sending a fresh code…';
  try {
    const { status, body } = await api('/api/observers/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: pendingPhone, channel: pendingChannel }),
    });
    if (status !== 200) { $('otp-hint').textContent = explain(body); return; }
    renderOtpSent(body);
  } catch {
    $('otp-hint').textContent = 'Network problem — check your connection and tap Resend code again.';
  }
};

$('btn-auth').onclick = async () => {
  const input = $('auth-input');
  const btn = $('btn-auth');
  if (btn.disabled) return;
  btn.disabled = true; // busy state — no double-sends that self-invalidate codes
  try {

  if (authMode === 'phone') {
    const phone = input.value.trim();
    const channel = pickedChannel();
    if (!channel) return alert('Choose where to receive your code — WhatsApp or Telegram.');
    const { status, body } = await api('/api/observers/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, channel }),
    });
    if (status !== 200) return alert(explain(body));
    // same pane flips to OTP entry
    pendingPhone = phone;
    pendingChannel = channel;
    authMode = 'otp';
    input.value = '';
    input.placeholder = 'Enter OTP';
    input.inputMode = 'numeric';
    // The LABEL has to move with the field. It kept saying "Nigerian Mobile
    // Number" over an input that now wants a code, which is the one thing on
    // this screen the observer reads before typing.
    if ($('auth-input-label')) $('auth-input-label').textContent = 'Enter OTP';
    $('btn-auth').textContent = 'Verify OTP';
    $('auth-reset').hidden = false;
    if ($('otp-resend')) $('otp-resend').hidden = false;
    // A code is in flight — every "go somewhere else to sign in" link is noise
    // now. The create-a-password option stays (it applies on verify).
    if ($('pw-link')) $('pw-link').hidden = true;
    if ($('signin-line')) $('signin-line').hidden = true;
    if ($('signup-line')) $('signup-line').hidden = true;
    if ($('pw-opt')) $('pw-opt').hidden = false;
    if ($('channel-pick')) $('channel-pick').hidden = true;
    renderOtpSent(body);
    return;
  }

  // A password is REQUIRED whenever we finish via OTP — a sign-up OR a forgotten-
  // password reset. Validate BEFORE burning the OTP attempt. Password sign-in
  // (authMode 'password') sets nothing; it uses the existing password.
  const settingPw = authMode !== 'password';
  const newPw = settingPw && $('pw-opt-input') ? $('pw-opt-input').value : '';
  if (settingPw && newPw.length < 8) return alert('Your password must be at least 8 characters.');

  if (authMode === 'password') {
    if (!input.value.trim()) return alert('Enter your phone number.');
    if (!$('pw-signin-input').value) return alert('Enter your password.');
  }

  const pair = await ensureKeys();
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const endpoint = authMode === 'password' ? '/api/observers/login' : '/api/observers/verify';
  const payload = authMode === 'password'
    ? { phone: input.value.trim(), password: $('pw-signin-input').value, publicKeyJwk }
    : { phone: pendingPhone, otp: input.value.trim(), publicKeyJwk };
  const { status, body } = await api(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (status !== 200) return alert(explain(body));
  localStorage.setItem('hawkeye_token', body.token);
  // Register for push NOW. initPush ran once at launch and never again,
  // so signing in afterwards left this install permanently unregistered —
  // no token, no server row, and nothing anywhere said so.
  try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
  if (settingPw) {
    const r = await api('/api/observers/set-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ password: newPw }),
    });
    if (r.status !== 200) alert('Signed in, but saving your password failed (' + explain(r.body) + '). Set one on My Profile so you can sign in with it next time.');
  }
  resetAuthPane();
  afterVerified();

  } catch {
    alert('Network problem — check your connection and try again.');
  } finally {
    $('btn-auth').disabled = false;
  }
};

$('auth-reset').onclick = (e) => {
  e.preventDefault();
  resetAuthPane();
};

/**
 * The one-sentence reason a location attempt failed.
 *
 * geo-msg.js owns the wording, because incidents.html and map-unit.html print
 * the same line and three copies of it drifted into three explanations of one
 * condition. It is the web port of native's describeFixFailure, and it keeps
 * native's rule that a TIMEOUT never mentions permission — the commonest caller
 * has already granted location and is simply standing indoors.
 *
 * The inline fallback covers observe.html failing to load the script and nothing
 * else, so it must stay exactly as short as the real thing: a fallback that
 * reintroduces the paragraph would quietly undo the fix on the one page that
 * needed it most.
 */
function geoLine(err) {
  if (window.HAWKEYE_GEO && typeof window.HAWKEYE_GEO.line === 'function') return window.HAWKEYE_GEO.line(err);
  const code = err && err.code;
  if (code === 1) return 'Hawkeye needs your location — allow Location for this site and try again.';
  if (code === 2) return 'Your device could not work out where it is — try again in a moment.';
  if (code === 3) return 'Could not get a GPS fix — move near a window or step outside and try again.';
  return 'This device could not report its location just now — try again.';
}
/** The branch that fired, for the console only — never for the status line. */
function geoLog(where, err) {
  try {
    const code = (window.HAWKEYE_GEO && window.HAWKEYE_GEO.code) ? window.HAWKEYE_GEO.code(err) : 'unknown';
    console.warn(`[hawkeye] geolocation ${where}: ${code}`);
  } catch { /* logging must never break a report */ }
}

// ---------- locate: geofenced discovery ----------
$('btn-locate').onclick = async () => {
  $('locate-status').textContent = 'Getting your location…';
  $('pu-list').innerHTML = '';
  let pos;
  try {
    pos = await getPosition();
  } catch (err) {
    // ONE SENTENCE. This used to be a 43-word paragraph that diagnosed, blamed
    // and then gave an address-bar tour — and it said the same thing whether the
    // observer had refused permission or was simply indoors with no lock yet.
    geoLog('near-me', err);
    $('locate-status').textContent = geoLine(err);
    return;
  }
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  // Use the warm list when it was fetched from close enough, recently enough
  // (see nearbyCacheUsable) — that is the whole point of the prefetch: this
  // step opens populated rather than spending its first seconds on a round trip.
  const warm = nearbyCacheUsable() ? nearbyCache.body : null;
  if (!warm) {
    $('locate-status').textContent = `Location fixed (±${Math.round(accuracy)} m). Looking up nearby units…`;
  }
  /**
   * TWO ENDPOINTS, MERGED — the same pair native asks, for the same reason.
   *
   * /api/polling-units is pinned server-side to config.discoveryRadiusM (500 m)
   * and ignores a radiusM parameter, so Lite could never see past 500 m however
   * it asked. /api/mapping/nearby DOES take a radius and reaches the 800 m the
   * report screens use, and it includes units placed only by their GRID3
   * envelope. Asking either alone leaves real observers with an empty list:
   * the first knows a unit's state and caps early, the second reaches further
   * but never reads crowd_lat. native/src/app/report/result.tsx carries the
   * long version of this note and the evidence behind it.
   */
  const merged = async () => {
    const [reg, near] = await Promise.all([
      apiTry(`/api/polling-units?lat=${lat}&lng=${lng}`),
      apiTry(`/api/mapping/nearby?lat=${lat}&lng=${lng}&radiusM=800`),
    ]);
    // A failure on either side is survivable; a failure on both is not, and is
    // reported as one, so the caller's error path still fires.
    if (reg.error && near.error) return reg;
    /**
     * ONE SHAPE OUT. The two endpoints do not agree on field names — the
     * register answers `pu_code` with `lga` and `state`, the mapping index
     * answers `puCode` and carries NEITHER, because a GRID3-envelope unit is
     * known by position rather than by register row. Merging them raw handed
     * the renderer two shapes, and every mapping-only row drew as
     *   "Lasigun / Irerinde — undefined · Akogun, undefined · 453 m away"
     * in the live report flow. Normalising here rather than at each render
     * site keeps the next reader of this list from having to know any of it.
     */
    const rows = [];
    const seen = new Set();
    for (const u of [...(reg.body?.units || []), ...(near.body?.units || [])]) {
      const code = u.pu_code || u.puCode || u.code;
      if (!code || seen.has(code)) continue;
      seen.add(code);
      rows.push({ ...u, pu_code: code, ward: u.ward || '', lga: u.lga || '', state: u.state || '' });
    }
    rows.sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
    return { body: { ...(reg.body || {}), radiusM: 800, units: rows } };
  };
  const r = warm ? { body: warm } : await merged();
  // Every exit from here on leaves the observer somewhere usable — a named
  // failure and an open register browser, never a status line that just stops.
  if (r.error) {
    // Point at SEARCH first. Both paths survive here — refApi() consults the
    // shipped register bundle before the network, so the cascade below works
    // offline for Osun too — but search is one field against four sequential
    // steps, and this line is read by someone whose connection just died.
    //
    // NOT TRUE ON NATIVE, where the cascade is a bare fetch of /lgas, /wards,
    // /units with no bundle fallback and genuinely cannot work offline. Same
    // sentence there, different and stronger reason. Closing that gap is the
    // post-election "native browse offline" item.
    $('locate-status').textContent =
      'Could not check nearby units. Search by name below.';
    $('browse-block').open = true;
    $('btn-locate').textContent = 'Try Searching Near Me Again';
    return;
  }
  const body = r.body;
  if (!body.units || body.units.length === 0) {
    $('locate-status').textContent =
      'No units found — search or browse the register below.';
    $('browse-block').open = true;
    return;
  }
  $('locate-status').textContent = 'Select the unit you are standing at:';
  for (const u of body.units) {
    const btn = document.createElement('button');
    btn.className = 'pu-option';
    // Join what EXISTS. A unit placed only by its GRID3 envelope has a ward but
    // no LGA, and "Akogun, " with a dangling comma reads as broken in a list
    // someone is scanning under time pressure.
    const where = [u.ward, u.lga].filter(Boolean).join(', ');
    const facts = [u.pu_code, where, `${u.distanceM} m away`, TIER_LABEL[tierOf(u)]]
      .filter(Boolean).join(' · ');
    btn.innerHTML = `<strong>${u.name}</strong><br /><small>${facts}</small>`;
    btn.onclick = () => selectUnit(u);
    $('pu-list').appendChild(btn);
  }
  // A search has now genuinely run, so offering to repeat it is honest.
  $('btn-locate').textContent = 'Search Near Me Again';
};

// ---------- locate: register browse (units without coordinates) ----------
async function fillSelect(sel, items, placeholder) {
  // A non-array here USED TO THROW and take the whole handler down with it, so
  // one bad payload emptied every dropdown in the cascade rather than just its
  // own. Degrade to an empty, disabled select instead: visibly nothing to pick,
  // and the steps after it still run.
  const list = Array.isArray(items) ? items : [];
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    list.map((i) => `<option>${i}</option>`).join('');
  sel.disabled = list.length === 0;
}

// Free-text unit search, above the cascade. selectUnit() is the same handler the
// near-me list and the browse cascade use, so a searched unit takes the identical
// path through the wizard.
if ($('pu-search-host') && window.puSearch) {
  window.puSearch.mount($('pu-search-host'), { onSelect: selectUnit });
}

/**
 * REGISTER REFERENCE DATA IS IMMUTABLE — cache it in the browser.
 *
 * States, LGAs, wards and a ward's units do not change during an election, yet
 * every visit re-fetched them, and the register browser walks them in sequence:
 * states, then LGAs, then wards, then units. Measured against production each
 * leg costs ~1-2.5 s, so picking a unit by hand meant four serial round trips
 * before the first tap — which is why "select state" felt like it hung.
 *
 * Cached, only the first walk pays; after that the dropdowns fill instantly and
 * keep working with no signal at all, which matters more on election day than
 * any of this does on a desk. Falls through to the network on any storage error,
 * and never caches a failed response.
 */
/**
 * CACHE ONLY A USABLE ANSWER, AND NEVER TRUST WHAT COMES BACK OUT.
 *
 * The first version cached whenever `!r.error` — but apiTry only sets `error`
 * for NETWORK failures. A 500, or an HTML error page, still resolves with
 * `body = {}` (api() falls back to {} when the JSON parse fails), and `{}` is
 * truthy, so the empty object was written to localStorage. From then on every
 * call returned it, fillSelect did `{}.map(...)`, threw, and killed the handler:
 * State, LGA and Ward all sat empty, on every launch, permanently — a poisoned
 * cache survives restarts and reinstalls of the page.
 *
 * So: store only a 200 carrying real data, and re-validate on the way out, so a
 * cache poisoned by an older build heals itself instead of needing a hard reset.
 * The `hk_ref2:` prefix retires any entry the buggy version already wrote.
 */
const refUsable = (b) => Array.isArray(b) ? b.length > 0 : !!(b && Array.isArray(b.units) && b.units.length);

/**
 * THE BROWSE CASCADE READS THE TIER-0 PACK (docs/PU-SEARCH-2027.md).
 *
 * This used to fetch app/register-osun.json — one state, 1.7 MB, and the same
 * file pu-search.js fetched separately into a second copy. Two problems for
 * 2027: it covers one state out of 37, and 176,846 units cannot arrive that way
 * at all.
 *
 * The ~56 KB index pack carries every state, LGA and ward in the country with a
 * unit count on each, and it is precached — so state -> LGA -> ward now works
 * offline ANYWHERE from install, not just in the election state. Only the last
 * step needs more: the units inside a ward come from that state's own pack
 * (~32 KB, fetched once), or the server if it is not held.
 *
 * The hk_ref2 localStorage layer is gone with it. It cached one payload per
 * /api/register/* path, which could never cover 8,432 wards inside a ~5 MB
 * origin quota — it degraded quietly instead of failing, which is worse.
 */
const regStore = () => (typeof window !== 'undefined' ? window.registerStore : null);
let regIndexPending = null;
function loadRegisterIndex() {
  const st = regStore();
  if (!st || !st.available()) return Promise.resolve(null);
  if (!regIndexPending) {
    regIndexPending = st.loadIndex().catch(() => null); // offline first-run: fall through to the API
  }
  return regIndexPending;
}

/** Answer a /api/register/* path from the packs, or null if they cannot. */
function registerFromPacks(path) {
  const st = regStore();
  if (!st) return null;
  const u = new URL(path, location.origin);
  const p = u.pathname;
  const state = u.searchParams.get('state');
  const lga = u.searchParams.get('lga');
  const ward = u.searchParams.get('ward');
  if (p.endsWith('/states')) return st.states();
  if (p.endsWith('/lgas')) return st.lgas(state);
  if (p.endsWith('/wards')) return st.wards(state, lga);
  if (p.endsWith('/units')) {
    const units = st.units(state, lga, ward);
    if (units) return { units };
    // We know the state but not its units yet — pull the pack for next time.
    const code = st.stateCode(state);
    if (code && !st.isLoaded(code)) st.loadState(code).catch(() => {});
    return null;
  }
  return null;
}

async function refApi(path) {
  await loadRegisterIndex();
  const local = registerFromPacks(path);
  if (refUsable(local)) return { status: 200, body: local };
  return apiTry(path);
}


$('browse-block').addEventListener('toggle', async () => {
  if ($('browse-block').open && $('sel-state').options.length <= 1) {
    const { body } = await refApi('/api/register/states');
    fillSelect($('sel-state'), body, '— select state —');
  }
});
$('sel-state').onchange = async () => {
  $('register-units').innerHTML = '';
  fillSelect($('sel-ward'), [], '— select —');
  const { body } = await refApi(`/api/register/lgas?state=${encodeURIComponent($('sel-state').value)}`);
  fillSelect($('sel-lga'), body, '— select LGA —');
};
$('sel-lga').onchange = async () => {
  $('register-units').innerHTML = '';
  const { body } = await refApi(
    `/api/register/wards?state=${encodeURIComponent($('sel-state').value)}&lga=${encodeURIComponent($('sel-lga').value)}`,
  );
  fillSelect($('sel-ward'), body, '— select ward —');
};
$('sel-ward').onchange = async () => {
  const { body } = await refApi(
    `/api/register/units?state=${encodeURIComponent($('sel-state').value)}` +
      `&lga=${encodeURIComponent($('sel-lga').value)}&ward=${encodeURIComponent($('sel-ward').value)}`,
  );
  $('register-units').innerHTML = '';
  for (const u of body.units || []) {
    const btn = document.createElement('button');
    btn.className = 'pu-option';
    btn.innerHTML = `<strong>${u.name}</strong><br /><small>${u.pu_code} · ${TIER_LABEL[tierOf(u)]}</small>`;
    btn.onclick = () => selectUnit(u);
    $('register-units').appendChild(btn);
  }
};

// ---------- submit screen ----------
/**
 * STEP 1 of the capture-first web restructure (docs/REPORT-FLOW-CAPTURE-FIRST.md).
 *
 * selectUnit() used to do seven things at once, only three of which actually
 * need a unit. That coupling is what pins unit selection ahead of capture on
 * the web, so it is split before any markup moves:
 *
 *   prepareReportUI()  parties, contests, logos, vote rows, OCR warm-up, and
 *                      the shot reset — none of it unit-dependent, all of it
 *                      safe to run on entering the flow.
 *   bindUnit(u)        name, tier notice, contest filtering — the genuinely
 *                      unit-dependent remainder.
 *
 * THE SHOT RESET IS THE REASON THIS SPLIT COMES FIRST. `shots.sheet = null`
 * lived inside selectUnit(), so once capture moves ahead of unit selection,
 * choosing a unit would silently destroy both photographs — the exact evidence
 * loss the whole reorder exists to prevent. It now belongs to flow entry, which
 * is the only place that means "start a new report".
 *
 * Behaviour is deliberately unchanged for now: selectUnit() still calls both in
 * the old order, so this commit is a pure refactor and can be verified against
 * the existing flow before anything moves.
 */
/**
 * SYNCHRONOUS reset. Everything here must run before the screen is painted,
 * because it is what makes the screen a NEW report rather than the last one.
 * No network, so it can never delay the paint.
 */
function resetReportState() {
  shots.sheet = null;
  shots.venue = null;
  selectedPu = null;
  window.HAWKEYE && (window.HAWKEYE.sheetOcr = null);
  const oldHint = document.getElementById('ocr-hint');
  if (oldHint) oldHint.remove();
  for (const t of ['sheet', 'venue']) {
    $(`preview-${t}`).hidden = true;
    $(`btn-cam-${t}`).textContent = 'Take photo';
  }
  // A new report has no sheet yet, so the counts step must not still be offering
  // the PREVIOUS report's — the worst possible thing to type figures from.
  showSheetReference(null);
  // Empty, not 'Report a result': the page header already says that, so a
  // matching h1 was the same words twice. .is-empty collapses the element so
  // nothing reserves space for a heading that has not arrived.
  $('submit-pu-name').textContent = '';
  $('submit-pu-name').classList.add('is-empty');
  // A new report starts at step 1 open, everything after it locked.
  stepDone = [false, false, false, false];
  STEP_FOLDS.forEach((id, i) => {
    const el = $(id);
    if (el) el.open = i === 0;
    const st = $(`${id}-state`);
    if (st) st.textContent = '';
  });
  stepLock();
  $('tier-notice').hidden = true;
  $('submit-status').textContent = '';
  $('pu-list').innerHTML = '';
  $('locate-status').textContent = '';
  updateSubmitState();
}

/**
 * ASYNC fill. Parties, contests and logos, then the vote rows.
 *
 * THIS MUST NEVER BE AWAITED BEFORE PAINTING THE SCREEN. It was, and it cost a
 * five-second freeze on entering the report flow: three sequential round trips
 * plus a ~6 MB Tesseract warm-up, all in front of the first paint, so the app
 * looked hung on the previous screen. The screen now shows immediately and
 * fills in behind. Nothing the observer can do in those first seconds needs
 * this — the camera does not depend on the party list.
 *
 * The three fetches run together rather than in sequence; they were independent
 * all along.
 */
/** Last known-good contests. Validated on READ too: a poisoned entry from an
 *  older build must heal itself rather than need a manual reset. */
function cachedContests() {
  try {
    const raw = localStorage.getItem('hk_contests1');
    const v = raw ? JSON.parse(raw) : null;
    if (Array.isArray(v) && v.length && v.every((c) => c && typeof c.code === 'string')) return v;
    if (raw) localStorage.removeItem('hk_contests1');
  } catch { /* unreadable — fall through */ }
  return [];
}

async function prepareReportUI() {
  const [p, c, l] = await Promise.all([
    parties.length === 0 ? api('/api/parties').then((r) => r.body).catch(() => []) : parties,
    // Fall back to the last known-good list rather than to [], because [] is
    // not "no elections" here — it disables every race and makes step 3
    // unusable. A stale list naming the open race beats a correct empty one.
    contests.length === 0
      ? api('/api/contests').then((r) => (Array.isArray(r.body) && r.body.length ? r.body : cachedContests()))
        .catch(() => cachedContests())
      : contests,
    logos === null ? fetch('logos/manifest.json').then((r) => r.json()).catch(() => ({})) : logos,
  ]);
  // The live list, else the last good one, else the bundled floor — never [].
  parties = (Array.isArray(p) && p.length) ? p : (cachedParties() || FALLBACK_PARTIES);
  if (Array.isArray(p) && p.length) {
    try { localStorage.setItem('hawkeye_parties', JSON.stringify(p)); } catch { /* quota */ }
  }
  contests = c || [];
  logos = l || {};
  // A unit may already have been picked while these were still in flight, in
  // which case step 3 was built from an empty list and every race rendered
  // "not open yet". Re-fill it now that the real answer is here.
  fillContests();
  // Remember a GOOD contests list so a cold start on a dead network still
  // offers the open race. Validated on write AND on read — caching a `{}` from
  // a 500 once left the state dropdown permanently empty, and this is the same
  // failure mode one screen further on.
  try {
    if (Array.isArray(contests) && contests.length) {
      localStorage.setItem('hk_contests1', JSON.stringify(contests));
    }
  } catch { /* private mode / quota — the network path still works */ }
  const wrap = $('vote-inputs');
  wrap.innerHTML = '';
  for (const p of parties) {
    const row = document.createElement('label');
    row.className = 'vote-row';
    // Official INEC emblem beside each name — several party names read alike.
    const mark = logos[p.code]
      ? `<img class="party-mark" src="${logos[p.code]}" alt="" loading="lazy" />`
      : `<span class="party-mark mono">${p.code.slice(0, 3)}</span>`;
    row.innerHTML = `<span class="party-label">${mark}<span><strong>${p.code}</strong><br /><small>${p.name}</small></span></span>
      <input type="number" min="0" step="1" inputmode="numeric" placeholder="0" data-party="${p.code}" />`;
    row.dataset.q = `${p.code} ${p.name}`.toLowerCase();
    wrap.appendChild(row);
  }
  // Filter, don't scroll. A row with a COUNT ALREADY IN IT is never hidden:
  // filtering is a way to find a party, not a way to lose a number you typed.
  const filter = $('vote-filter');
  if (filter) {
    filter.value = '';
    filter.oninput = () => {
      const q = filter.value.trim().toLowerCase();
      for (const row of wrap.querySelectorAll('.vote-row')) {
        const typed = row.querySelector('input').value !== '';
        row.hidden = !!q && !typed && !row.dataset.q.includes(q);
      }
    };
  }
  // Warm up the web OCR engine (~6 MB one-time download) so the read-back is
  // seconds, not half a minute, by the time the sheet is captured. Deliberately
  // NOT awaited — it is a background download, not a prerequisite.
  try { tessReady(); } catch { /* best-effort */ }
  // Same for the document scanner's OpenCV worker (~13 MB). It used to load
  // only when the camera opened, which under capture-first left it no time to
  // arrive — so the sheet step fell back to a plain photo with no edge
  // detection or auto-capture. Both are background downloads; if either is
  // still in flight the capture path degrades gracefully rather than waiting.
  // WEB ONLY. The native shell uses ML Kit's document scanner and the build
  // strips opencv.js from the APK, so warming there would spawn a worker whose
  // only possible outcome is failure.
  try {
    if (!(window.HAWKEYE && window.HAWKEYE.native) && window.DocScanner) DocScanner.warm();
  } catch { /* best-effort */ }
}

/**
 * Build the "Which election?" picker for the selected unit.
 *
 * SEPARATE FUNCTION BECAUSE IT HAS TO RUN TWICE. HAWKEYE_RACES.fill() renders
 * all five races and DISABLES every one that is not in the list handed to it,
 * so calling it with an empty `contests` produces a picker where all five read
 * "not open yet" and nothing can be selected. Step 3 is then a dead end.
 *
 * That is exactly what happened: bindUnit() runs the instant a unit is chosen,
 * while prepareReportUI() is still fetching /api/contests, and nothing ever
 * re-filled the picker when the answer arrived. It became reliable rather than
 * intermittent when polling-unit search moved offline — selection went from a
 * ~1.2 s round trip to ~30 ms, so the observer now always wins the race.
 *
 * Called again from prepareReportUI() once the contests land.
 */
function fillContests() {
  if (!selectedPu) return;
  const sel = $('sel-contest');
  if (!sel) return;
  // Full races list, unconfigured ones disabled — same picker as collation.html.
  // See window.HAWKEYE_RACES in menu.js for why /api/contests alone is too short.
  const applicableContests = contests.filter((c) => contestApplies(selectedPu, c.code, c.states));
  if (window.HAWKEYE_RACES) {
    window.HAWKEYE_RACES.fill(sel, applicableContests, { placeholder: '— Select election —' });
  } else {
    sel.innerHTML = '<option value="">— Select election —</option>'
      + applicableContests.map((c) => `<option value="${c.code}">${c.name}</option>`).join('');
  }
  applyRaceProposal(sel);
  updateScopeNotice();
  updateSubmitState();
}

/**
 * A race carried in from a race page's "Report from your unit" (?contest=).
 *
 * CONSUMED ONCE, at the first moment the unit and the election list are both
 * known — which is here, because fillContests runs on every unit change. After
 * that it is forgotten: re-imposing it would silently undo an observer who
 * corrected their unit and got a different set of races.
 *
 * It PRE-SELECTS and leaves the step on screen. The unit decides what can be
 * reported, and the unit was chosen after the link — so if the race is not
 * offered here, the picker simply stays unanswered rather than arguing.
 */
let raceProposal = (() => {
  try {
    return new URLSearchParams(location.search).get('contest') || null;
  } catch { return null; }
})();

function applyRaceProposal(sel) {
  if (!raceProposal || !sel) return;
  const code = raceProposal;
  raceProposal = null;
  const opt = [...sel.options].find((o) => o.value === code && !o.disabled);
  if (!opt) return;   // not held at this unit, or not open — the reader chooses
  sel.value = code;
  // A programmatic assignment does NOT fire `change`, and the step confirmer
  // and the fold lock below it both hang off that event. Without this the
  // election would look chosen and the next step would stay locked.
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function bindUnit(u) {
  selectedPu = u;
  $('submit-pu-name').textContent = `${u.name} (${u.pu_code})`;
  $('submit-pu-name').classList.remove('is-empty');
  const tier = tierOf(u);
  $('tier-notice').hidden = tier === 'verified';
  $('tier-notice').textContent =
    tier === 'crowd'
      ? '◌ This unit\'s location is crowd-confirmed, not yet officially verified.'
      : '⚠ This unit has no verified location. Your GPS position will be recorded with your report, and the result stays marked "location unverified" until independent reports from the same spot corroborate it.';
  fillContests();
  updateScopeNotice();
  updateSubmitState();
}

/**
 * Entering the report flow. Everything unit-independent is prepared HERE — the
 * only place that means "start a new report" — and the screen opens on the
 * capture card with no unit yet chosen.
 */
function enterReportFlow() {
  resetReportState();   // synchronous — the screen must open as a NEW report
  show('screen-submit'); // paint NOW, never behind a network call
  // Location warms from here, not from page load: asking for GPS permission on
  // the sign-in screen is a prompt with no context, before the observer has any
  // reason to grant it. This is the first moment it is actually needed.
  startLocationKeeper();
  void prepareReportUI(); // parties, contests, logos, vote rows — fills in behind
}

/**
 * Choosing a unit no longer navigates and no longer resets anything: the
 * observer is already on this screen, very likely with both photographs already
 * taken. It binds the unit and nothing else.
 *
 * If this ever calls prepareReportUI() again it will WIPE THE PHOTOS — that was
 * the coupling step 1 existed to remove. Bind only.
 */
function selectUnit(u) {
  // A DIFFERENT unit invalidates what follows: which elections run there can
  // change, and counts belong to a race at a place. Re-picking the SAME unit is
  // just a confirmation and must not wipe work the observer already did.
  const changed = !selectedPu || selectedPu.pu_code !== u.pu_code;
  bindUnit(u);
  updateSubmitState();
  if (changed) { stepDone[2] = false; stepDone[3] = false; $('race-fold-state').textContent = ''; $('counts-fold-state').textContent = ''; }
  // Choosing a unit IS step 2's confirmer: it folds and step 3 opens.
  stepDone[1] = false; // force the transition so the fold/advance fires again
  setStepDone(1, true, `✔ ${u.name}`);
  $('race-fold').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Prefill the submit screen from a Telegram chat handoff, then let the observer
// capture the live photos and sign as normal.
async function applyPrefill() {
  try {
    // The flow must be prepared before a unit can be bound onto it — the
    // Telegram handoff used to get that for free from selectUnit().
    await enterReportFlow();
    const { body } = await api(`/api/register/unit?pu_code=${encodeURIComponent(PREFILL.pu)}`);
    if (!body?.unit) return; // already on the report screen; pick a unit by hand
    selectUnit(body.unit);
    const sc = $('sel-contest');
    if (sc && [...sc.options].some((o) => o.value === PREFILL.contest)) sc.value = PREFILL.contest;
    updateScopeNotice();
    for (const v of PREFILL.votes) {
      const inp = document.querySelector(`#vote-inputs input[data-party="${v.party}"]`);
      if (inp && Number.isFinite(+v.count)) inp.value = v.count;
    }
    $('submit-status').textContent = 'Prefilled from Telegram — now capture the sheet & venue photos to finish.';
  } catch { enterReportFlow(); }
}

/**
 * STEP LOCKING for the report cards.
 *
 * Each step folds when its own confirmer fires — both photos taken, a unit
 * chosen, an election chosen, counts verified — and the next one unlocks. A step
 * that is not yet reachable cannot be opened at all: the order is real, not a
 * suggestion, and an observer who opens step 4 first would be typing counts for
 * a unit they have not named.
 *
 * Reopening a CONFIRMED step is always allowed (that is the edit path), and it
 * re-locks everything after it, because changing the unit can change which
 * elections exist and therefore which counts make sense.
 */
const STEP_FOLDS = ['photo-fold', 'unit-fold', 'race-fold', 'counts-fold'];
let stepDone = [false, false, false, false];
// CSS pointer-events blocks a TAP, but not the keyboard and not script, so the
// lock is enforced here as well: a locked <details> that somehow opens is
// closed again on the toggle event. Belt and braces, because "cannot open"
// being merely cosmetic is how someone types counts for a unit they never named.
STEP_FOLDS.forEach((id) => {
  const el = typeof document !== 'undefined' && document.getElementById(id);
  if (el) el.addEventListener('toggle', () => {
    if (el.open && el.classList.contains('locked')) el.open = false;
  });
});
function stepLock() {
  STEP_FOLDS.forEach((id, i) => {
    const el = $(id);
    if (!el) return;
    // Reachable = every earlier step confirmed.
    const reachable = i === 0 || stepDone[i - 1];
    el.classList.toggle('locked', !reachable);
    el.classList.toggle('done', stepDone[i]);
    if (!reachable && el.open) el.open = false;
  });
}
/** Mark a step confirmed (or not), fold it, and open the next unlocked one. */
function setStepDone(i, done, label) {
  const was = stepDone[i];
  stepDone[i] = done;
  // Anything after a step that just became UNconfirmed is no longer valid.
  if (!done) for (let j = i + 1; j < stepDone.length; j++) stepDone[j] = false;
  const el = $(STEP_FOLDS[i]);
  const state = $(`${STEP_FOLDS[i]}-state`.replace('-fold-state', '-fold-state'));
  // The "— tap to edit" tail is gone: the summary's ::after now says what the tap
  // does ("Tap to review" / "Tap to close"), on the heading line, in both states.
  if (state) state.textContent = done ? (label || '✔ Done') : '';
  if (done && !was && el) {
    el.open = false;
    const next = $(STEP_FOLDS[i + 1]);
    if (next) {
      next.open = true;
      // SCROLL TO THE STEP THAT JUST OPENED. Folding a card above the viewport
      // shortens the page under the observer, leaving them looking at whatever
      // happens to land where they were — usually the "Search near me again"
      // button, which reads as if nothing happened. Deferred a frame so the
      // fold has actually collapsed before the position is measured.
      requestAnimationFrame(() => next.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }
  stepLock();
}

/**
 * Name what is about to be signed, on the submit card.
 *
 * Painted from updateSubmitState so it follows every change that can invalidate
 * it — selectUnit() un-confirms steps 2 and 3 whenever the unit changes, and
 * this runs on the same path. Cleared when there is no unit, so it can never sit
 * there describing a choice the observer has since undone.
 *
 * BUILT WITH textContent, NOT innerHTML. The first version interpolated three
 * register-supplied strings through an `esc()` that does not exist in this file
 * — it is a closure-local const inside menu.js, practice.js, pu-search.js and
 * race.js, none of which leak it — so the very first paint threw
 * `ReferenceError: esc is not defined`. That throw escaped updateSubmitState()
 * and therefore bindUnit(), so selectUnit() never reached setStepDone(1, …):
 * choosing a polling unit painted the unit's name and then did nothing at all,
 * with no error on screen. Nodes and textContent remove the escaping question
 * rather than answering it, so there is nothing left to forget.
 */
function paintSubmitFacts() {
  const box = $('submit-facts');
  if (!box) return;
  box.textContent = '';
  const u = selectedPu;
  if (!u) { box.hidden = true; return; }
  const where = [u.ward, u.lga, u.state].filter(Boolean).join(', ');
  const code = [u.pu_code, where].filter(Boolean).join(' · ');
  const sel = $('sel-contest');
  const race = sel && sel.value ? (sel.options[sel.selectedIndex] || {}).textContent || '' : '';
  const add = (tag, text, cls) => {
    if (!text) return;
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    box.appendChild(el);
  };
  add('strong', u.name || u.pu_code || '');
  add('small', code);
  add('span', race.trim(), 'sf-race');
  box.hidden = false;
}

function updateSubmitState() {
  for (const t of ['sheet', 'venue']) {
    const badge = $(`status-${t}`);
    badge.textContent = shots[t] ? 'Captured ✔' : 'Required';
    badge.classList.toggle('done', Boolean(shots[t]));
  }
  // Step 1's confirmer is the second photo landing.
  const both = Boolean(shots.sheet && shots.venue);
  if (both !== stepDone[0]) setStepDone(0, both, '✔ Both captured');
  // Photos AND a unit gate the button. The unit is part of this now because it
  // is chosen on this screen rather than before reaching it — without it the
  // button would look ready while submit() silently returned on !selectedPu.
  // A CLOSED contest still keeps it clickable on purpose, so the tap surfaces
  // the "reporting opens on election day" error rather than a dead, silent
  // button — the scope notice already explains the wait.
  // STEP 4 IS A REAL GATE. Submit lit up as soon as the photos and the unit
  // existed, so it was pressable with no counts entered and "Verify counts"
  // never tapped — i.e. before the last card had been finished at all.
  $('btn-submit').disabled = !(shots.sheet && shots.venue && selectedPu && stepDone[3]);
  paintSubmitFacts();
}

// ---------- camera (live capture only; overlay opens per slot) ----------
/**
 * CAMERA — the shared implementation in capture.js.
 *
 * This code used to live here and collation.html carried a divergent copy, so
 * the native-scanner routing, the OpenCV warm-up and the camera height each got
 * fixed on this page and stayed broken there. capture.js is now the only copy;
 * this page supplies the tail that is genuinely its own (finalizeShot).
 */
const TARGET_LABELS = {
  sheet: { title: 'Results sheet (EC8A)', action: 'Capture EC8A' },
  venue: { title: 'Polling venue', action: 'Capture Polling Venue' },
};
const closeCamera = () => window.HAWKEYE_CAPTURE.close();
const openCamera = (target) => window.HAWKEYE_CAPTURE.open(target, {
  // Truthy closes the camera; falsy keeps it open for a retake, which is what
  // finalizeShot already signals.
  onShot: (blob, t) => finalizeShot(t, blob),
  onError: (m) => { $('submit-status').textContent = m; },
  labels: TARGET_LABELS,
});

$('btn-cam-sheet').onclick = () => openCamera('sheet');
$('btn-cam-venue').onclick = () => openCamera('venue');

// Web OCR — gives the browser the same sheet read-back the app shell gets from
// ML Kit, via Tesseract.js (WASM, self-hosted under vendor/tesseract, lazy-
// loaded on first sheet capture so pages stay light). Dispatches the same
// 'hawkeye-sheet-ocr' event, so the autofill path below is shared verbatim.
let tessWorker = null;
let tessWorkerP = null;
// Load + init once (~6 MB of WASM/model on first use — the slow part). Called
// early from selectUnit so the download runs while the observer is still
// filling in counts, not after they capture.
function tessReady() {
  if (window.HAWKEYE && window.HAWKEYE.native) return null;
  if (!tessWorkerP) {
    tessWorkerP = (async () => {
      if (!window.Tesseract) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'vendor/tesseract/tesseract.min.js';
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      tessWorker = await Tesseract.createWorker('eng', 1, {
        workerPath: 'vendor/tesseract/worker.min.js',
        corePath: 'vendor/tesseract',
        langPath: 'vendor/tesseract',
      });
      return tessWorker;
    })();
    tessWorkerP.catch(() => { tessWorkerP = null; }); // allow retry after a failed download
  }
  return tessWorkerP;
}
async function webOcrSheet(blob) {
  if (window.HAWKEYE && window.HAWKEYE.native) return; // app shell: ML Kit already handles this
  try {
    ocrHint('📖 Reading the numbers off your sheet photo… you can keep going — this fills in below when done.');
    await tessReady();
    const { data } = await tessWorker.recognize(blob, {}, { text: true, blocks: true });
    const lines = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const ln of p.lines || []) {
          const bb = ln.bbox || {};
          lines.push({ text: (ln.text || '').trim(), left: bb.x0 || 0, top: bb.y0 || 0, bottom: bb.y1 || 0 });
        }
      }
    }
    const text = data.text || '';
    const tokens = text.match(/\d+/g) || [];
    if (!tokens.length) { ocrHint('📖 Could not read numbers off the photo — enter the counts from your sheet.'); return; }
    // Mirror native.js: park the read on window.HAWKEYE so the exact recognised
    // string can be inspected after the fact on web too, instead of being
    // reconstructed from guesses when the parser misses.
    const read = { text, tokens, lines, at: Date.now() };
    window.HAWKEYE && (window.HAWKEYE.sheetOcr = read);
    window.dispatchEvent(new CustomEvent('hawkeye-sheet-ocr', { detail: read }));
  } catch {
    // best-effort — never blocks capture, but don't leave "reading…" up forever
    try { ocrHint('📖 Could not read the photo here — enter the counts from your sheet.'); } catch { /* no inputs yet */ }
  }
}

// On-device OCR read-back — AUTO-FILLS each party's count by
// matching its code to a line on the sheet photo. Suggestions only: filled
// inputs are highlighted, editing one clears the mark, and any still-marked
// values must be confirmed by the observer before the report submits. The
// server-side vision read remains the authoritative cross-check.
function ocrHint(msg) {
  const wrap = $('vote-inputs');
  let hint = document.getElementById('ocr-hint');
  if (!hint) {
    hint = document.createElement('p');
    hint.id = 'ocr-hint';
    hint.className = 'hint';
    wrap.parentNode.insertBefore(hint, wrap);
  }
  hint.textContent = msg;
}
/**
 * TIER A of the unit ladder: let the sheet name its own unit.
 *
 * The EC8A header carries the delimitation code, and the OCR already returns the
 * full recognised text — it was simply throwing everything that was not a party
 * count away. Resolution goes through pu-code.js, which treats the register as
 * the arbiter and refuses ambiguous repairs.
 *
 * The resolver tries the CACHED near-me slice first. That is not just a speed
 * trick: it is what lets Tier A work offline, on the election-day network the
 * outbox exists to survive. A single exact server lookup is the online extra —
 * never the 81 round trips a repair sweep would otherwise cost.
 *
 * Only a HIGH-confidence read selects. Anything weaker is left for the observer,
 * because a wrong unit is worse than a slower one.
 */
async function resolveUnitFromSheet(text) {
  const P = window.HAWKEYE_PUCODE;
  if (!P || selectedPu) return; // never override a unit already chosen
  const warm = (nearbyCache && nearbyCache.body && nearbyCache.body.units) || [];
  const byCode = new Map(warm.map((u) => [u.pu_code, u]));
  const resolve = async (code) => {
    if (byCode.has(code)) return byCode.get(code);
    if (!navigator.onLine) return null;
    try {
      const { body } = await api(`/api/register/unit?pu_code=${encodeURIComponent(code)}`);
      return body && body.unit ? body.unit : null;
    } catch { return null; }
  };
  // Repairs stay local-only: an 81-probe sweep must never hit the network.
  const local = async (code) => (byCode.has(code) ? byCode.get(code) : null);
  const fix = lastFix ? { lat: lastFix.coords.latitude, lng: lastFix.coords.longitude } : undefined;
  let hit = null;
  try {
    hit = await P.resolveUnitFromText(text, { resolve, fix, maxRepair: 0 }) // exact, may use network
      || await P.resolveUnitFromText(text, { resolve: local, fix });        // repairs, cache only
  } catch { return; }
  // ASK, DO NOT ASSUME. Auto-selecting was silent in both directions: when it
  // worked nobody could tell it had, and when it read the wrong unit it was
  // already chosen. Offer what it read — code AND unit — and let the observer
  // say yes. Any confidence is worth offering; only SELECTING needed the bar.
  const box = $('pu-sheet-card') || $('pu-list');
  if (!box || selectedPu) return;
  box.innerHTML = '';
  // SAY WHAT HAPPENED. Failing silently here was indistinguishable from the OCR
  // never having run at all, which is exactly what made this cost several rounds
  // of guessing at the parser instead of reading one line on screen.
  if (!hit) {
    let codes = [];
    try { codes = P.extractCandidates(text); } catch { /* report as unread */ }
    box.innerHTML = codes.length
      ? `<p class="hint">Read <strong>${codes[0]}</strong> off the sheet, but no unit with that code was found — pick yours below.</p>`
      : '<p class="hint">Could not read unit code off sheet. Pick unit below.</p>';
    return;
  }
  const u = hit.unit;
  const where = [u.ward, u.lga, u.state].filter(Boolean).join(', ');
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'border:2px solid var(--green);margin:0 0 10px';
  card.innerHTML = `<p style="margin:0 0 6px;font-weight:700">Is this your polling unit?</p>
    <p style="margin:0 0 2px"><strong>${u.name}</strong></p>
    <p class="hint" style="margin:0 0 10px">${u.pu_code}${where ? ` · ${where}` : ''} · read from the sheet${hit.source === 'repaired' ? ' (one digit corrected)' : ''}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="pu-yes" style="flex:1;min-width:120px">Yes, use this unit</button>
      <button class="pu-no secondary" style="flex:1;min-width:100px">No, choose another</button>
    </div>`;
  card.querySelector('.pu-yes').onclick = () => { card.remove(); selectUnit(u); };
  card.querySelector('.pu-no').onclick = () => {
    card.remove();
    $('locate-status').textContent = 'Pick your unit below, or search for it.';
  };
  box.prepend(card);
}

window.addEventListener('hawkeye-sheet-ocr', (e) => {
  if (e.detail && e.detail.text) resolveUnitFromSheet(e.detail.text);
  const wrap = $('vote-inputs');
  const d = e.detail;
  if (!wrap || !d || !d.tokens || !d.tokens.length) return;
  const lines = d.lines || [];
  const filled = [];
  for (const input of wrap.querySelectorAll('input[data-party]')) {
    // Only fill empty inputs or ones we filled from a previous shot — never
    // overwrite a number the observer typed themselves.
    if (input.value !== '' && !input.classList.contains('ocr-filled')) continue;
    const code = input.dataset.party;
    const re = new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`, 'i');
    const row = lines.find((l) => re.test(l.text));
    if (!row) continue;
    // First number AFTER the code in the same line (EC8A: the FIGURES column
    // follows the party name; anything before the code is the serial number).
    // Tolerate the classic O→0 misread next to digits, nothing riskier —
    // better to leave a count blank than to suggest a wrong one.
    const ex = re.exec(row.text);
    const after = row.text.slice(ex.index + ex[0].length)
      // No lookbehind — a (?<=…) regex LITERAL is a parse-time SyntaxError on
      // Safari/WebKit < 16.4, which would blank the whole page. Two passes of
      // the capture-group form cover consecutive O misreads ("1OO" → "100").
      .replace(/[Oo](?=\d)/g, '0')
      .replace(/(\d)[Oo]/g, (_, d) => `${d}0`)
      .replace(/(\d)[Oo]/g, (_, d) => `${d}0`);
    let m = after.match(/\d{1,6}/);
    let val = m && m[0];
    if (val == null) {
      // Table layouts (ML Kit): the count is a separate digits-only line to
      // the right in the same visual row.
      const midY = (row.top + row.bottom) / 2;
      const cands = lines.filter((l) => /^\d{1,6}$/.test(l.text.trim())
        && l.left > row.left && l.top <= midY && l.bottom >= midY);
      cands.sort((a, b) => a.left - b.left);
      if (cands.length) val = cands[0].text.trim();
    }
    if (val == null) continue;
    input.value = String(parseInt(val, 10));
    input.classList.add('ocr-filled');
    filled.push(code);
  }
  ocrHint(filled.length
    ? `✨ ${filled.length} count${filled.length === 1 ? '' : 's'} auto-filled from your sheet photo (highlighted) — check each against the sheet and edit anything that's off.`
    : `📖 Numbers read off your sheet photo (verify yourself): ${d.tokens.slice(0, 30).join(', ')}`);
});
// Editing a highlighted input = the observer verified/corrected it.
$('vote-inputs').addEventListener('input', (e) => {
  if (e.target && e.target.classList) e.target.classList.remove('ocr-filled');
});
// btn-capture / btn-cancel-camera are wired inside capture.js.
const useNativeCam = () => window.HAWKEYE_CAPTURE.native();


// Downscale + recompress a freshly captured photo BEFORE it is hashed, signed and
// uploaded — so the compressed bytes are exactly what the observer signs, the server
// stores, and the ledger content-addresses (integrity stays intact; see submissions.js
// where image_sha256 = sha256 of these bytes). Phone cameras hand us 3–8 MB full-res
// JPEGs; an EC8A sheet stays fully legible at ~1500 px, cutting each photo to a couple
// hundred KB (the tuned 1500 px / q0.76 point). Any failure returns the original
// blob unchanged — compression must never block a capture.
async function compressCapture(blob, maxDim, quality) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    return out && out.size < blob.size ? out : blob;
  } catch { return blob; }
}

// Shared capture tail for BOTH the web overlay and the native camera: compress
// FIRST (before hash/sign/upload — content-addressing commits these exact bytes),
// require a GPS fix, then store + preview. Sheet 1500 px / q0.76 (the tuned point
// that stays OCR-legible while pushing capacity toward ~10k observers); venue
// smaller (1280 px / q0.72). Returns false if the GPS fix failed.
/**
 * The sheet, kept in reach of the figures.
 *
 * Capture comes first because the EC8A is the perishable thing on election day
 * (docs/REPORT-FLOW-CAPTURE-FIRST.md) — but "type it up later from somewhere
 * safer" is exactly the moment the paper is no longer in front of the observer,
 * and step 4 told them to copy the figures off a sheet it did not show. Their
 * own photograph was already on the device, in a step that had folded shut.
 *
 * Enlarging matters as much as showing: an EC8A is a dense grid of party rows,
 * and a 108px strip proves a photo exists without letting anyone read a number
 * off it. Twin of native/src/components/sheet-reference.tsx.
 *
 * @param src object URL of the sheet, or null to withdraw it.
 */
function showSheetReference(src) {
  const box = document.getElementById('counts-sheet');
  const img = document.getElementById('counts-sheet-img');
  if (!box || !img) return;
  if (!src) {
    box.hidden = true;
    img.removeAttribute('src');
    const z = document.getElementById('sheet-zoom');
    if (z) z.hidden = true;
    return;
  }
  img.src = src;
  box.hidden = false;
}

// Delegated and registered once: the reference button and the viewer both exist
// in the markup from the start, so nothing here depends on a photo having been
// taken yet.
document.addEventListener('DOMContentLoaded', () => {
  const box = document.getElementById('counts-sheet');
  const zoom = document.getElementById('sheet-zoom');
  const zimg = document.getElementById('sheet-zoom-img');
  const close = document.getElementById('sheet-zoom-x');
  if (!box || !zoom || !zimg || !close) return;
  const shut = () => { zoom.hidden = true; zoom.classList.remove('big'); };
  box.addEventListener('click', () => {
    const src = document.getElementById('counts-sheet-img').getAttribute('src');
    if (!src) return;
    zimg.src = src;
    zoom.hidden = false;
  });
  // Tap the paper to go to 250% and back — a pinch is awkward one-handed, and
  // this is a one-handed moment.
  zimg.addEventListener('click', () => zoom.classList.toggle('big'));
  close.addEventListener('click', shut);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !zoom.hidden) shut(); });
});

async function finalizeShot(target, blob) {
  // SHOW THE PHOTO FIRST. The preview used to be set only after compression AND
  // the GPS await, so between the shutter and the fix there was nothing on screen
  // at all — the app looked frozen, and on a slow indoor lock that lasted several
  // seconds. Painting the raw frame costs nothing and is replaced below by the
  // compressed bytes, which are the ones actually signed and uploaded.
  const img = $(`preview-${target}`);
  const raw = URL.createObjectURL(blob);
  img.src = raw;
  img.hidden = false;

  blob = await compressCapture(blob, target === 'sheet' ? 1500 : 1280, target === 'sheet' ? 0.76 : 0.72);
  const fix = await getCaptureFix();
  if (!fix) {
    // Nothing was stored, so the optimistic preview has to come back off.
    img.hidden = true;
    img.removeAttribute('src');
    URL.revokeObjectURL(raw);
    alert('No GPS fix — photos must be location-stamped. Move to open sky and retake.');
    return false;
  }
  shots[target] = { blob, capturedAt: Date.now(), lat: fix.coords.latitude, lng: fix.coords.longitude };
  if (target === 'sheet') webOcrSheet(blob); // fire-and-forget read-back (no-op in the app shell — ML Kit covers it there)
  img.src = URL.createObjectURL(blob);
  URL.revokeObjectURL(raw);
  img.hidden = false;
  // The counts step gets the sheet too. By the time the figures are typed the
  // observer has usually left the crowd, and their own photo was two collapsed
  // steps up the page — while the step said to copy the figures off it.
  if (target === 'sheet') showSheetReference(img.src);
  $(`btn-cam-${target}`).textContent = 'Retake photo';
  updateSubmitState();
  return true;
}

// ---------- submit ----------
$('btn-submit').onclick = async () => {
  if (!shots.sheet || !shots.venue || !selectedPu) return;
  if (!$('sel-contest').value) {
    $('submit-status').textContent = 'Select which election you are reporting.';
    $('sel-contest').focus();
    return;
  }
  if (selectedContestClosed()) {
    // A MODAL, NOT A LINE UNDER THE BUTTON. This is not "check that field" — it
    // is the whole submission being refused for a reason no amount of editing
    // fixes today, and the observer has just photographed a sheet and typed a
    // tally. A status line below the fold is missable enough that it reads as
    // the button doing nothing.
    notifyBlocked('Reporting is not open yet', ERRORS.reporting_not_open);
    return;
  }
  const auto = [...document.querySelectorAll('#vote-inputs input.ocr-filled')]
    .map((i) => `${i.dataset.party}: ${i.value || 0}`);
  if (auto.length && !confirm(`These counts were auto-filled from your sheet photo — confirm they match the sheet:\n\n${auto.join('\n')}\n\nSubmit with these numbers?`)) {
    $('submit-status').textContent = 'Check the highlighted counts against your sheet, then submit again.';
    return;
  }
  $('btn-submit').disabled = true;
  $('submit-status').textContent = 'Getting a fresh GPS fix…';

  let pos;
  try {
    pos = await getPosition();
  } catch {
    $('submit-status').textContent = 'Could not get your location.';
    $('btn-submit').disabled = false;
    return;
  }
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const accuracy = pos.coords.accuracy;

  const votes = canonicalVotes(
    [...document.querySelectorAll('#vote-inputs input')].map((input) => ({
      party: input.dataset.party,
      count: Number(input.value || 0),
    })),
  );

  $('submit-status').textContent = 'Signing your report…';
  const pair = await ensureKeys();
  const imageSha256 = await sha256Hex(await shots.sheet.blob.arrayBuffer());
  const venueImageSha256 = await sha256Hex(await shots.venue.blob.arrayBuffer());
  const contest = $('sel-contest').value;
  const payload = canonicalPayload({
    puCode: selectedPu.pu_code,
    contest,
    votes,
    imageSha256,
    venueImageSha256,
    capturedAt: shots.sheet.capturedAt,
    venueCapturedAt: shots.venue.capturedAt,
    lat,
    lng,
    sheetLat: shots.sheet.lat,
    sheetLng: shots.sheet.lng,
    venueLat: shots.venue.lat,
    venueLng: shots.venue.lng,
  });
  const signature = await signPayload(pair, payload);

  const form = new FormData();
  form.set('puCode', selectedPu.pu_code);
  form.set('contest', contest);
  form.set('votes', JSON.stringify(votes));
  form.set('lat', String(lat));
  form.set('lng', String(lng));
  form.set('accuracy', String(accuracy));
  form.set('capturedAt', String(shots.sheet.capturedAt));
  form.set('venueCapturedAt', String(shots.venue.capturedAt));
  form.set('sheetLat', String(shots.sheet.lat));
  form.set('sheetLng', String(shots.sheet.lng));
  form.set('venueLat', String(shots.venue.lat));
  form.set('venueLng', String(shots.venue.lng));
  form.set('signature', signature);
  const serialEl = $('sheet-serial');
  if (serialEl && serialEl.value.trim()) form.set('sheetSerial', serialEl.value.trim());
  form.set('photo', shots.sheet.blob, 'ec8a.jpg');
  form.set('venuePhoto', shots.venue.blob, 'venue.jpg');

  $('submit-status').textContent = 'Submitting…';

  // DIRECT UPLOAD, WHEN THE SERVER OFFERS IT. The photos go straight to the
  // bucket and only hashes come here, because inbound bytes count against the
  // host's monthly allowance and the photos are the whole of it. If anything at
  // all goes wrong — proxy mode, no bucket, CORS, a flaky link — direct() gives
  // back null and the original multipart post runs untouched. A report is never
  // lost to a storage optimisation.
  let directBody = null;
  if (window.HawkeyeDirect) {
    const okDirect = await window.HawkeyeDirect.upload({
      base: (window.HAWKEYE && window.HAWKEYE.apiBase) || '',
      token: localStorage.getItem('hawkeye_token'),
      blobs: { sheet: shots.sheet.blob, venue: shots.venue.blob },
      hashes: { sheet: imageSha256, venue: venueImageSha256 },
    });
    if (okDirect) {
      const f = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') f[k] = v;
      directBody = JSON.stringify({ ...f, imageSha256, venueImageSha256 });
    }
  }

  const post = () => api('/api/submissions', {
    method: 'POST',
    headers: directBody
      ? { authorization: `Bearer ${localStorage.getItem('hawkeye_token')}`, 'content-type': 'application/json' }
      : { authorization: `Bearer ${localStorage.getItem('hawkeye_token')}` },
    body: directBody || form,
  });
  let status, body;
  try {
    ({ status, body } = await post());
  } catch {
    // Network failure. The report is already signed over its exact bytes, so we
    // queue it and flush on reconnect (offline outbox) — on every platform, since
    // IndexedDB is universal. outbox.js's own 'online' + DOMContentLoaded listeners
    // drive the retry (the Capacitor shell fires those same events).
    if (window.HAWKEYE && window.HawkeyeOutbox) {
      const fields = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
      // Carried so a later flush can presign without re-hashing the blobs. The
      // signature already covers these exact values, so recording them changes
      // nothing evidentiary.
      fields.imageSha256 = imageSha256;
      fields.venueImageSha256 = venueImageSha256;
      try { await window.HawkeyeOutbox.queue({ fields, sheet: shots.sheet.blob, venue: shots.venue.blob }); } catch { /* ignore */ }
      shots.sheet = null; shots.venue = null;
      alert('Saved offline — your signed report will send automatically when you are back online.');
      enterReportFlow(); // that report is queued; this is a fresh one
      $('btn-submit').disabled = false;
      return;
    }
    $('submit-status').textContent = 'You appear to be offline — check your connection and try again.';
    $('btn-submit').disabled = false;
    return;
  }
  // ANY 401 (expired, unknown observer after a server reset, device mismatch…)
  // = dead session. Silently re-mint via resume and retry the same submission
  // once; only if that fails does the user get sent back to verification.
  if (status === 401) {
    localStorage.removeItem('hawkeye_token');
    $('submit-status').textContent = 'Refreshing your session…';
    if (await tryResume()) ({ status, body } = await post());
  }
  if (status === 401) {
    $('submit-status').textContent = 'Session expired — verify your phone again to submit.';
    resetAuthPane();
    show('screen-register');
    return;
  }
  if (status !== 201) {
    $('submit-status').textContent = explain(body);
    $('btn-submit').disabled = false;
    return;
  }

  const r = body.result;
  const locLabel =
    r.locationStatus === 'verified'
      ? TIER_LABEL.verified
      : r.locationStatus === 'provisional'
        ? `${TIER_LABEL.crowd} (${r.locationConfidence}% of reports agree)`
        : TIER_LABEL.unmapped;
  const venueLabel = r.venueMatches > 0 ? ` · 🏫 ${r.venueMatches} venue photo pair(s) match` : '';
  $('entry-hash').textContent = body.entryHash;
  const contestName = (contests.find((c) => c.code === r.contest) || {}).name || r.contest;
  $('result-summary').innerHTML = `
    <p><strong>${selectedPu.name}</strong> — ${contestName}</p>
    ${r.scope ? `<p class="hint">${r.scope}</p>` : ''}
    <p>Status: <strong class="status-${r.status}">${r.status.toUpperCase()}</strong>
       · Confidence: <strong>${r.confidence}%</strong>
       (${r.matchingReports} of ${r.totalReports} reports match)</p>
    <p>${locLabel}${venueLabel}</p>
    ${body.ocr && body.ocr.total ? `<p class="hint">🔎 OCR cross-check: ${body.ocr.matched}/${body.ocr.total} of your counts were read on the sheet photo.</p>` : ''}
    <ul>${r.votes.filter((v) => v.count > 0).map((v) => `<li>${v.party}: ${v.count}</li>`).join('')}</ul>`;
  show('screen-result');
};

$('btn-another').onclick = () => {
  // "Report another" IS a new report, so it goes through the same entry point —
  // which is what clears the previous shots and rebuilds the vote rows.
  enterReportFlow();
};

// A token can LOOK signed-in long after it died (7-day JWT expiry, or the
// observer row changing server-side). Check the expiry locally so we refresh
// BEFORE the user builds a whole report on a dead session.
function tokenFresh() {
  const t = localStorage.getItem('hawkeye_token');
  if (!t) return false;
  try {
    const { exp } = JSON.parse(atob(t.split('.')[1]));
    return exp * 1000 > Date.now() + 60_000;
  } catch { return false; }
}

// This device may already belong to a verified observer (identity saved on the
// server). If so, silently mint a fresh token — no repeat sign-up on your own phone.
async function tryResume() {
  try {
    const pair = await ensureKeys();
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const { status, body } = await api('/api/observers/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: await getDeviceId(), publicKeyJwk }),
    });
    if (status === 200 && body.token) {
      localStorage.setItem('hawkeye_token', body.token);
  // Register for push NOW. initPush ran once at launch and never again,
  // so signing in afterwards left this install permanently unregistered —
  // no token, no server row, and nothing anywhere said so.
  try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
      return true;
    }
  } catch { /* fall through to sign-up */ }
  return false;
}

// ---------- boot ----------
// Picking an election is step 3's confirmer. An empty selection un-confirms it,
// which also re-locks the counts behind it — counts belong to a race.
$('sel-contest').onchange = () => {
  updateScopeNotice();
  const sel = $('sel-contest');
  const label = sel.options[sel.selectedIndex]?.textContent || '';
  setStepDone(2, Boolean(sel.value), `✔ ${label}`);
};
// Counts have no natural confirmer, so this button is it.
$('btn-verify-counts') && ($('btn-verify-counts').onclick = () => {
  const n = [...document.querySelectorAll('#vote-inputs input')]
    .filter((i) => i.value !== '' && Number(i.value) >= 0).length;
  if (!n) {
    const rows = document.querySelectorAll('#vote-inputs input').length;
    if (window.HAWKEYE_ALERT) {
      HAWKEYE_ALERT('No counts entered', rows
        ? 'Type the votes each party was announced to have, then tap Verify counts again.'
        : 'The party list could not be loaded. Close and reopen the report to try again.');
    } else { $('submit-status').textContent = 'Enter at least one party count.'; }
    return;
  }
  $('submit-status').textContent = '';
  // Any OCR-proposed value the observer has now looked at is theirs.
  document.querySelectorAll('#vote-inputs input.ocr-filled')
    .forEach((i) => i.classList.remove('ocr-filled'));
  setStepDone(3, true, `✔ ${n} part${n === 1 ? 'y' : 'ies'} entered`);
  // Submit now DEPENDS on stepDone[3], and setStepDone does not recompute it —
  // without this the button stays disabled for ever, which is a worse bug than
  // the one the gate was added to fix.
  updateSubmitState();
});
if ('serviceWorker' in navigator && !(window.HAWKEYE && window.HAWKEYE.native)) navigator.serviceWorker.register('sw.js');
(async () => {
  const paintRegister = () => {
    applyIntentCopy();
    applySignUpMode();
    applySignInMode();
    show('screen-register');
  };

  // Expired/corrupt tokens are dropped BEFORE deciding which screen to show —
  // never let a dead session masquerade as signed-in (resume re-mints silently).
  if (!tokenFresh()) {
    localStorage.removeItem('hawkeye_token');
    // PAINT FIRST, resume in the background.
    //
    // This used to `await` tryResume() before showing anything, capped at 6s.
    // tryResume() ALWAYS goes to the network — it generates keys and POSTs to
    // /api/observers/resume even on a fresh install that has nothing to resume —
    // so every signed-out launch sat on a blank page for as long as that request
    // took, and for the full 6s whenever the link was slow or the API was down.
    // On the Capacitor shell, where every asset is already local, that wait was
    // the entire startup delay.
    //
    // The register pane is what a signed-out visitor needs regardless, so it goes
    // up immediately; a resume that lands afterwards still redirects below. The
    // cost is a brief glimpse of the form for the narrow case of an EXPIRED token
    // that then resumes — and those users were staring at a blank screen before.
    paintRegister();
    await Promise.race([tryResume().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
  }
  if (localStorage.getItem('hawkeye_token')) {
    // Already registered — honour the CTA intent instead of re-verifying.
    if (NEXT_DEST) location.href = NEXT_DEST;
    else if (PREFILL) applyPrefill();
    else if (INTENT_DEST[AUTH_INTENT]) location.href = INTENT_DEST[AUTH_INTENT];
    // Following "Sign in" while already signed in means "take me to my account",
    // not "start a report" — send them to the dashboard.
    else if (IS_SIGNIN) location.href = 'index.html';
    else enterReportFlow();
  } else {
    // Idempotent — already painted above on the !tokenFresh path; this covers a
    // fresh-token check that then found no token.
    paintRegister();
  }
})();

// ---------- Telegram Mini App: OTP-free sign-in via verified contact share ----------
// Inside Telegram, the phone number comes from Telegram itself (signed with the
// bot token) — no SMS. Falls back to the OTP form on any failure.
function armTelegramLogin() {
  const tg = window.HawkeyeTG;
  if (!tg || !tg.initData || $('btn-tg-login')) return;
  const label = document.querySelector('label[for="auth-input"]');
  if (!label) return;
  const btn = document.createElement('button');
  btn.id = 'btn-tg-login';
  btn.type = 'button';
  btn.textContent = '✈️ Continue with Telegram — no code needed';
  btn.style.cssText = 'background:#2aabee;box-shadow:0 4px 14px rgba(42,171,238,.35);margin:0 0 4px';
  const or = document.createElement('p');
  or.className = 'hint';
  or.style.cssText = 'text-align:center;margin:8px 0 2px';
  or.textContent = '— or sign in with SMS —';
  label.parentNode.insertBefore(btn, label);
  label.parentNode.insertBefore(or, label);
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Waiting for Telegram…';
    try {
      const pair = await ensureKeys();
      const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      const contact = await new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try { tg.requestContact((ok, resp) => finish(ok ? (resp || true) : null)); }
        catch { finish(null); }
        setTimeout(() => finish(null), 30000);
      });
      if (!contact) throw new Error('cancelled');
      const contactResponse = typeof contact === 'string' ? contact : (contact.response || null);
      const { status, body } = await api('/api/observers/telegram-verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData, contactResponse, publicKeyJwk }),
      });
      if (status !== 200) throw new Error(body.error || 'failed');
      localStorage.setItem('hawkeye_token', body.token);
  // Register for push NOW. initPush ran once at launch and never again,
  // so signing in afterwards left this install permanently unregistered —
  // no token, no server row, and nothing anywhere said so.
  try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
      afterVerified();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '✈️ Continue with Telegram — no code needed';
      alert('Telegram sign-in did not complete — you can use the SMS option below.');
    }
  };
}
if (window.HawkeyeTG) armTelegramLogin();
document.addEventListener('hawkeye-tg-ready', armTelegramLogin);

// NOTE: the location keeper is NOT started here. Starting it at page load meant
// a GPS permission prompt on the SIGN-IN screen, before the observer had any
// reason to grant it — and a prompt with no context is a prompt that gets
// denied. It starts in enterReportFlow() instead, which is the first moment a
// fix is actually needed and the first moment the ask makes sense.

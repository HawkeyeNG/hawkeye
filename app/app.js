/* Hawkeye observer PWA — no framework, no build step.
 * Security-relevant invariants:
 *  - the private key is generated NON-EXTRACTABLE and never leaves this device
 *  - BOTH photos (EC8A sheet + polling-unit surroundings) come only from live
 *    camera captures (no <input type="file"> anywhere)
 *  - nearby list offers only geofenceable units (verified or crowd tier); register
 *    browse reaches the rest, whose reports stay badged location-unverified
 *  - canonicalPayload() must stay byte-identical to backend/src/services/signatures.js
 */
/**
 * i18n for text this file PAINTS. See scripts/i18n/key_js.mjs for why these
 * cannot be data-i18n attributes: every element below is one a script writes
 * into, and auto_key.mjs refuses to key those in markup precisely so the two
 * writers never fight.
 *
 * The English literal stays as the second argument, so this file still reads as
 * English source and still renders correctly with no bundle loaded at all.
 */
function T(key, english, params) {
  /* PLACEHOLDERS ARE INTERPOLATED HERE, not by i18n.js — its t() takes a key
     and a fallback and nothing else. situation-room.html has always done this
     substitution in its own wrapper; this file had no string that needed one
     until check-in, and would have rendered a literal "{unit}" to the reader.
     Done AFTER the lookup so it works on the translation, not only on the
     English. */
  let out = window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english;
  for (const [k, v] of Object.entries(params || {})) out = String(out).split('{' + k + '}').join(v);
  return out;
}

/**
 * Text written into an element that carries its own data-i18n (a badge, a
 * camera button): the KEY moves with it, because menu.js re-runs apply() on
 * every language change and would otherwise put the markup's first words back.
 * The ENGLISH is written and apply() translates it — apply() remembers the
 * first text it sees under a key as that key's English, so writing the
 * translation directly would make it the "English" a switch back restores.
 */
function keyedText(el, key, english) {
  if (!el) return;
  el.setAttribute('data-i18n', key);
  el.textContent = english;
  if (window.HawkeyeI18n && el.parentNode) window.HawkeyeI18n.apply(el.parentNode);
}


const $ = (id) => document.getElementById(id);
const API = ''; // same origin

/**
 * The language to tell the SERVER about.
 *
 * Sent with the code request because the observer row does not exist yet — the
 * code itself is the first thing Hawkeye sends anyone, and without this it
 * would be the one message that could not be in their language. The server
 * parks it on the OTP row and copies it across at /verify.
 *
 * Reads localStorage directly rather than going through HawkeyeI18n: this file
 * loads on pages that do not carry the i18n runtime, and a sign-up must not
 * depend on it being there. `undefined` drops the field from the JSON body,
 * which is what a client with no preference should send.
 */
function chosenLang() {
  try { return localStorage.getItem('hawkeye_lang') || undefined; } catch (e) { return undefined; }
}

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
/**
 * PHONE OR COMPUTER — which of the account's two session slots this one takes
 * (backend services/sessions.js: one phone AND one computer per account).
 * The Lite shell and any mobile browser are phones. iPadOS Safari presents a
 * desktop Mac user agent, so the server cannot tell; a "Macintosh" with a touch
 * screen is an iPad (Macs report no touch points).
 */
function deviceClass() {
  try {
    if ((window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) || (window.HAWKEYE && window.HAWKEYE.native)) return 'phone';
    const ua = navigator.userAgent || '';
    if ((navigator.userAgentData && navigator.userAgentData.mobile) || /Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return 'phone';
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 0) return 'phone';
  } catch { /* fall through */ }
  return 'computer';
}
async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'x-device-id': await getDeviceId(), 'x-device-class': deviceClass() };
  const res = await fetch(API + path, opts);
  const body = await res.json().catch(() => ({}));
  // retryAfter: null cross-origin unless the server exposes the header; callers
  // fall back to body.retryAfterS.
  return { status: res.status, body, retryAfter: (res.headers && res.headers.get('retry-after')) || null };
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
 * one dialog implementation, and degrades to dialog.js's hkAlert if menu.js has
 * not loaded (the shell is cached separately, so that is a real possibility) — a
 * refusal must never fail silently, which is the whole reason it stopped being a
 * line of text under the submit button.
 */
function notifyBlocked(title, body) {
  if (window.HAWKEYE_MODAL) window.HAWKEYE_MODAL(title, body, '');
  else if (window.hkAlert) window.hkAlert(body, { title });
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

/* KEY BESIDE ENGLISH, RESOLVED WHEN SHOWN. These reach the reader through
   hkAlert, the refusal modal and the status line. A module-level constant is
   built once, before the language bundle has loaded, so a T() here would freeze
   every refusal in English — the key travels beside the English and
   errorText() resolves it at the moment the message is written. */
const ERRORS = {
  outside_geofence: ['observe.err.outside-geofence', 'You are too far from this polling unit to report it.'],
  too_far_from_unit: ['observe.err.too-far-from-unit', 'You are too far from this polling unit — report only while standing there.'],
  sms_send_failed: ['observe.err.sms-send-failed', 'Could not deliver your code just now — wait a minute and tap Resend code.'],
  otp_incorrect: ['observe.err.otp-incorrect', 'That code is not right — check it and try again.'],
  otp_expired: ['observe.err.otp-expired', 'That code has expired — tap "Resend code" to get a fresh one.'],
  too_many_attempts: ['observe.err.too-many-attempts', 'Too many wrong tries — tap "Resend code" and enter the fresh code.'],
  too_many_requests: ['observe.err.too-many-requests', 'Too many requests from your connection — wait a few minutes and try again.'],
  gps_accuracy_too_low: ['observe.err.gps-accuracy-too-low', 'GPS signal too weak — move to open sky and retry.'],
  photo_not_fresh: ['observe.err.photo-not-fresh', 'Photos too old — capture them again and submit immediately.'],
  photo_required: ['observe.err.photo-required', 'The result sheet photo is missing.'],
  venue_photo_required: ['observe.err.venue-photo-required', 'A distinct photo of the polling unit surroundings is required.'],
  duplicate_image: ['observe.err.duplicate-image', 'One of these exact photos was already submitted by someone.'],
  near_duplicate_image: ['observe.err.near-duplicate-image', 'A near-identical copy of one of these photos was already submitted.'],
  already_submitted: ['observe.err.already-submitted', 'You have already reported this election for this polling unit.'],
  unknown_contest: ['observe.select-which-election-you-are-reporting', 'Select which election you are reporting.'],
  contest_not_applicable: ['observe.err.contest-not-applicable', 'That election does not take place at this polling unit (the FCT has no governorship or state assembly).'],
  photo_location_mismatch: ['observe.err.photo-location-mismatch', 'Your photos were taken somewhere else — capture both here and submit immediately.'],
  bad_signature: ['observe.err.bad-signature', 'Signature check failed — refresh and try again.'],
  invalid_votes: ['observe.err.invalid-votes', 'Check the counts — whole numbers only.'],
  device_already_reported_race: ['observe.err.device-already-reported-race', 'This device has already reported this election — one report per race per device.'],
  device_too_fast: ['observe.err.device-too-fast', 'This device just submitted a report — wait a few minutes and try again.'],
  reporting_not_open: ['observe.err.reporting-not-open', 'Result reporting opens on election day, when polls open. Come back then.'],
};
/* SIGN-UP AND SIGN-IN REFUSALS, IN THE READER'S LANGUAGE (first-time
   walkthrough #2). The server's `hint` for most of these is a fixed English
   sentence — "Nigerian mobile, e.g. 08031234567" reached Hausa, Igbo and
   Yorùbá readers verbatim, because explain() put the hint first. Every code the
   auth routes return (backend routes/observers.js: /register, /verify,
   /wa-start, /wa-status, /login, /set-password, /passkeys/login, and the token
   check every authenticated call makes) is answered here instead, so the hint
   is never what a reader sees for these. The four the server already writes in
   the client's language (anonymous_number, channel_required, wa_paid_off,
   sms_off — t(hl, …) from the `lang` this page sends) are left to its hint.
   ORG_ERRORS below covers the organisation-code refusals. Same keys-beside-
   English shape as ERRORS: resolved when shown, never at import. */
const AUTH_ERRORS = {
  invalid_phone: ['auth.err.invalid-phone', 'Enter a Nigerian mobile number, e.g. 08031234567.'],
  not_a_nigerian_number: ['auth.err.invalid-phone', 'Enter a Nigerian mobile number, e.g. 08031234567.'],
  account_exists: ['auth.err.account-exists', 'This number is already registered. Sign in with your password, or reset it.'],
  password_login_unavailable: ['auth.err.password-login-unavailable', 'Password sign-in is not available for this number. Sign in with a one-time code, then set a password on your profile. If you deleted your account, signing in this way restores it.'],
  wrong_password: ['auth.err.wrong-password', 'Wrong password. Forgot it? Sign in with a one-time code to reset it.'],
  password_too_short: ['auth.password-too-short', 'Your password must be at least 8 characters.'],
  password_too_long: ['auth.err.password-too-long', 'That password is too long (200 characters max).'],
  current_password_wrong: ['auth.err.current-password-wrong', 'Enter your current password — or sign in with a one-time code first to reset it.'],
  passkey_failed: ['passkey.failed', 'That passkey did not work here. Sign in another way.'],
  passkeys_unavailable: ['passkey.unavailable', 'Passkeys are not available here. Sign in another way.'],
  wa_inbound_unavailable: ['auth.wa-unavailable', 'WhatsApp sign-in is not available right now. Use Telegram instead.'],
  wa_code_expired: ['auth.wa-expired', 'This code has expired. Start again for a new one.'],
  invalid_public_key: ['auth.err.device-key', "This device's sign-in key did not work. Refresh the page and try again."],
  device_required: ['auth.err.device-key', "This device's sign-in key did not work. Refresh the page and try again."],
  signed_in_elsewhere: ['auth.signed-out-elsewhere', 'You were signed out because this account signed in on another device.'],
  missing_token: ['notifications.session-expired', 'Your session has expired.'],
  invalid_token: ['notifications.session-expired', 'Your session has expired.'],
  unknown_observer: ['notifications.session-expired', 'Your session has expired.'],
  device_mismatch: ['notifications.session-expired', 'Your session has expired.'],
};
const errorText = (code) => {
  const e = ERRORS[code] || AUTH_ERRORS[code];
  return e ? T(e[0], e[1]) : null;
};
/* The client's own sentence first for every auth code. For the rest (the report
   refusals) the server's hint can carry detail — a distance, a limit — so it
   still leads in English; in any other language our translated sentence beats
   an English hint. */
const explain = (body) => {
  const code = body && body.error;
  if (AUTH_ERRORS[code]) return errorText(code);
  const own = errorText(code);
  const lang = (window.HawkeyeI18n && window.HawkeyeI18n.current) || chosenLang() || 'en';
  if (own && lang !== 'en') return own;
  return (body && body.hint) || own || code
    || T('observe.err.something-went-wrong', 'Something went wrong.');
};
/* /login's too_many_attempts is about PASSWORDS — ten wrong ones in an hour —
   not the code-entry limit ERRORS describes ("tap Resend code"). */
const explainLogin = (body) => (body && body.error === 'too_many_attempts'
  ? T('auth.err.too-many-passwords', 'Too many wrong passwords. Wait an hour, or sign in with a one-time code instead.')
  : explain(body));

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

/* Keys, not words: a module-level map of T() results would freeze in English
   before the dictionary lands, so the label is resolved where it is drawn. */
const TIER_LABEL = {
  verified: ['common.tier-verified', '📍 location verified'],
  crowd: ['common.tier-crowd', '◌ crowd-confirmed location'],
  geocoded: ['common.tier-geocoded', '◌ located from map data (unconfirmed)'],
  unmapped: ['common.tier-unmapped', '⚠ location not yet verified'],
  unverified: ['common.tier-unverified', '⚠ location unverified — its map position could not be confirmed'],
};
const tierLabel = (tier) => T(...(TIER_LABEL[tier] || TIER_LABEL.unmapped));
/**
 * A pin more than 25 km from the unit's own envelope is not a position. The
 * INEC locator load numbered FCT 15 where the register numbers it 37, so every
 * state from Gombe to FCT carries its predecessor's pins — Kubwa units sit in
 * Zamfara, 436 km from an observer standing 20 km away. The server now withholds
 * such a pin (backend/src/services/pin-trust.js, same rule); this catches rows
 * from an older server or a cache. Mirrors native/src/lib/geofence.ts.
 */
const pinContradictsEnvelope = (u) => {
  if (u.lat == null || u.lng == null || u.approx_lat == null || u.approx_lng == null) return false;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(u.approx_lat - u.lat) / 2) ** 2
    + Math.cos(rad(u.lat)) * Math.cos(rad(u.approx_lat)) * Math.sin(rad(u.approx_lng - u.lng) / 2) ** 2;
  const m = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  return m > Math.max(25000, (Number(u.approx_radius_m) || 0) * 1.5 + 2000);
};
// `crowd_mapped` is graded FIRST, ahead of the server's own tier: /api/polling-units
// runs pollingUnits.js:tierOf(), which calls any row holding `lat` 'verified' — including
// a promoted crowd median (mapping.js writes the clustered median into `lat` alongside
// coords_source='crowd_mapped'). Matches native's rowTier (native/src/app/map-unit.tsx),
// so a crowd-confirmed location is never overstated as verified.
const tierOf = (u) =>
  u.pin_unverified || pinContradictsEnvelope(u)
    ? 'unverified'
    : u.coords_source === 'crowd_mapped'
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
 * INEC's register of parties changes rarely (it last grew in Feb–Mar 2026:
 * DLA, NDC, NDP), so a bundled copy is a safe floor. It must equal
 * backend/src/data/parties.json — tests/party_register_test.mjs holds them
 * together. The live list still wins whenever it arrives, and a good response
 * is cached so the next run starts from real data.
 */
const FALLBACK_PARTIES = [
  ['A', 'Accord'], ['AA', 'Action Alliance'], ['AAC', 'African Action Congress'],
  ['ADC', 'African Democratic Congress'], ['ADP', 'Action Democratic Party'],
  ['APC', 'All Progressives Congress'], ['APGA', 'All Progressives Grand Alliance'],
  ['APM', 'Allied Peoples Movement'], ['APP', 'Action Peoples Party'], ['BP', 'Boot Party'],
  ['DLA', 'Democratic Leadership Alliance'], ['LP', 'Labour Party'],
  ['NDC', 'Nigeria Democratic Congress'], ['NDP', 'National Democratic Party'],
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
/* /api/health waInbound: the WhatsApp choice runs in reverse (free). Set by
   revealSmsOptionIfEnabled(); false until the server says otherwise. */
let WA_INBOUND = false;
/* /api/health waPaidOtp: the server will send a PAID WhatsApp code (WA_PAID_OTP
   on). False until it says so — fail closed: every "get a code on WhatsApp"
   link stays hidden, and the WhatsApp choice is the free route or nothing.
   WA_HEALTH: the server has answered at all (only then may WhatsApp be hidden). */
let WA_PAID = false;
let WA_HEALTH = false;
/* The free WhatsApp route in progress (startWaSend), or null. Declared up here
   because resetAuthPane() reads it. */
let wa = null;   // { pollToken, code, link, deadline, delay, timer, busy, fails, newPw, gen }
let waGen = 0;

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

/* LANGUAGE ON THE SIGN-UP / SIGN-IN SCREEN (first-time walkthrough #4). This
   screen hides the header and with it the EN/HA button, so someone who arrived
   in the wrong language had to leave to change it. #auth-lang is the header
   button's twin: same one-tap cycle (HawkeyeLang.cycle — remembers, tells the
   server, settles the first-run prompt), same code on its face, repainted on
   every 'hawkeye-lang'. Nothing typed is lost: the page is not reloaded. */
(function authLang() {
  const b = $('auth-lang');
  if (!b || !window.HawkeyeI18n || !window.HawkeyeLang) return;
  const paint = () => {
    const code = String(window.HawkeyeI18n.current || 'en').toUpperCase();
    b.textContent = code;
    b.setAttribute('aria-label', window.HawkeyeI18n.t('lang.current', 'Language') + ': ' + code);
  };
  b.addEventListener('click', () => (window.HawkeyeLang.cycle || window.HawkeyeLang.open)());
  document.addEventListener('hawkeye-lang', paint);
  paint();
  b.hidden = false;
})();

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
  if (title) title.textContent = T('observe.sign-in', 'Sign In');
  // "One number, one observer" is a sign-UP promise; a returning observer has
  // already made it.
  const lede = $('register-lede');
  if (lede) lede.textContent = T('observe.welcome-back-sign-in-to-your-observer', 'Welcome back — sign in to your observer account.');
  if ($('pw-signin-wrap')) $('pw-signin-wrap').hidden = false;
  if ($('channel-pick')) $('channel-pick').hidden = true;   // password sign-in sends no code
  syncChannelGate();
  $('btn-auth').textContent = T('observe.sign-in', 'Sign In');
  if ($('pw-link')) {
    $('pw-link').hidden = false;                            // reset path, sign-in only
    $('pw-link').textContent = T('observe.forgot-your-password', 'Forgot your password?');
  }
  if ($('signin-line')) $('signin-line').hidden = true;     // they ARE on sign-in
  if ($('signup-line')) $('signup-line').hidden = false;
  if ($('pw-opt')) $('pw-opt').hidden = true;               // creating one is a sign-up job
  // A returning observer doesn't need the big practice pitch card — but a light
  // practice link still belongs here (a practice link on every auth screen).
  if ($('starter-card')) $('starter-card').hidden = true;
  if ($('practice-line')) $('practice-line').hidden = false;
  paintPasskeySignIn();
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
  if ($('ref-opt')) $('ref-opt').hidden = false;   // the ONE code field: invite or organisation
}

/* ---------- Invite or organisation code (sign-up only) ----------
 * ONE field for two kinds of code, told apart by FORMAT (owner decision,
 * 2026-09-28): a friend's invite is six characters; an organisation code is
 * ORG-XXXX-XXXX-XXXX. No invite can start "ORG" (its alphabet has no O), so the
 * prefix alone decides. The invite is the one way a referral survives an App
 * Store install: invite.html prints the code and it is typed here; a link or
 * the Play referrer fills it (referral.js), so the reader sees it came along.
 * The server keeps the rules that matter: a referral is recorded only when
 * /verify CREATES the observer, first code wins; an organisation code is single
 * use and only ever creates an account. Twin of native sign-in.tsx. */

/* A TYPED code. Forgiving of case, spaces and hyphens; strict about the rest —
   stricter than referral.js normalize(), which drops stray characters: right for
   a link, wrong for typing, where "ABCDEOF" (O for 0) would drop to "ABCDEF", a
   stranger's code. Returns '' when nothing was typed, null when it is not a
   code. Twin of native lib/invite-parse.ts typedInviteCode(). */
function typedInviteCode(raw) {
  const c = String(raw || '').toUpperCase().replace(/[\s-]+/g, '');
  if (!c) return '';
  return /^[2-9A-HJKMNP-TV-Z]{6}$/.test(c) ? c : null;
}
(function initInviteField() {
  const input = $('ref-input');
  if (!input) return;
  const parked = (window.HAWKEYE_REFERRAL && window.HAWKEYE_REFERRAL.pending()) || '';
  if (parked) input.value = parked;
  input.addEventListener('input', () => { if ($('ref-err')) $('ref-err').hidden = true; paintCodeKind(); syncOrgMode(); });
  paintCodeKind();
})();
/* False (and the field says why) when the field holds neither kind of code.
   Checked before a paid code goes out, and again before /verify. */
function inviteFieldOk() {
  const input = $('ref-input');
  if (IS_SIGNIN || !input) return true;
  const ok = codeKind(input.value) !== null;
  if ($('ref-err')) $('ref-err').hidden = ok;
  if (!ok) input.focus();
  return ok;
}
/* What /verify carries: on sign-up, whatever the field holds (nothing when the
   person emptied it — their choice, even over a parked code); on sign-in and
   its forgotten-password route, the parked code as before. */
function referralForVerify() {
  const input = $('ref-input');
  if (!IS_SIGNIN && input) return typedInviteCode(input.value) || undefined;
  return (window.HAWKEYE_REFERRAL && window.HAWKEYE_REFERRAL.pending()) || undefined;
}

/* ---------- Organisation code (owner decision D4) ----------
 * A party's or civic partner's single-use code that REPLACES the one-time
 * code: with one in the field, the channel picker goes, "Request OTP" becomes
 * "Create account", nothing is sent, and /api/observers/org-signup creates the
 * account on this number. The server keeps every rule that matters (single use,
 * bound to this number at first use, never opens an existing account):
 * backend/src/services/orgCodes.js. */
// A declaration, not a const: initInviteField (above) paints the kind line at
// load, before this line has run.
function squashCode(raw) { return String(raw || '').toUpperCase().replace(/[\s-]+/g, ''); }
/* 'ORG-XXXX-XXXX-XXXX' for a well-formed organisation code, '' for nothing
   typed, null otherwise. Twin of native lib/auth-copy.ts typedOrgCode(). */
function typedOrgCode(raw) {
  const c = squashCode(raw);
  if (!c) return '';
  const m = /^ORG([2-9A-HJKMNP-TV-Z]{12})$/.exec(c);
  return m ? 'ORG-' + m[1].match(/.{4}/g).join('-') : null;
}
/* Which kind the field holds: '' (empty), 'invite', 'org', or null (neither).
   The ORG prefix decides, so a half-typed organisation code is never taken for
   an invite. Twin of native lib/auth-copy.ts codeKind(). */
function codeKind(raw) {
  const c = squashCode(raw);
  if (!c) return '';
  if (c.startsWith('ORG')) return typedOrgCode(raw) ? 'org' : null;
  return typedInviteCode(raw) ? 'invite' : null;
}
/* The line under the field: a hint while it is empty, then the kind it
   recognised. Errors are #ref-err, shown only when the reader tries to go on. */
function paintCodeKind() {
  const input = $('ref-input');
  if (!input) return;
  const k = codeKind(input.value);
  if ($('ref-hint')) $('ref-hint').hidden = k !== '' && k !== null;
  if ($('ref-kind-invite')) $('ref-kind-invite').hidden = k !== 'invite';
  if ($('ref-kind-org')) $('ref-kind-org').hidden = k !== 'org';
}
/* Organisation mode starts at the prefix, not at a complete code, so the form
   does not flip back and forth while the reader is still typing it. */
const orgCodeTyped = () => !IS_SIGNIN && authMode === 'phone' && !!$('ref-input') && squashCode($('ref-input').value).startsWith('ORG');
function syncOrgMode() {
  if (IS_SIGNIN || authMode !== 'phone' || !$('ref-input')) return;
  const on = orgCodeTyped();
  if ($('channel-pick')) $('channel-pick').hidden = on;   // nothing is sent with a code
  $('btn-auth').textContent = on ? T('auth.org-create-account', 'Create account') : T('observe.request-otp', 'Request OTP');
  syncChannelGate();
}
const ORG_ERRORS = {
  org_code_invalid: ['auth.org-code-unknown', 'That organisation code is not valid. Check it with your organisation, or leave the box empty to sign up with a one-time code.'],
  code_is_invite: ['auth.code-invalid', "Not a code we recognise. A friend's invite has 6 letters and numbers; an organisation code looks like ORG-ABCD-EFGH-JKMN."],
  org_code_used: ['auth.org-code-used', 'This organisation code has already been used. Ask your organisation for another one, or sign up with a one-time code.'],
  org_code_revoked: ['auth.org-code-revoked', 'This organisation code has been withdrawn. Ask your organisation for another one, or sign up with a one-time code.'],
  org_code_number_taken: ['auth.org-code-number-taken', 'An organisation code can only create a new account, and this code is now used up. If this number already has an account, sign in with a one-time code. If you deleted your account, signing in that way restores it.'],
  too_many_requests: ['auth.org-code-too-many', 'Too many attempts from this network. Wait an hour and try again.'],
};
async function orgSignUp(phone) {
  const code = typedOrgCode($('ref-input').value);
  if (!code) { if ($('ref-err')) $('ref-err').hidden = false; $('ref-input').focus(); return; }
  if (!phone) return void hkAlert(T('auth.enter-your-phone-number', 'Enter your phone number.'));
  const newPw = $('pw-opt-input') ? $('pw-opt-input').value : '';
  if (newPw.length < 8) return void hkAlert(T('auth.password-too-short', 'Your password must be at least 8 characters.'));
  // No code comes back to prove the number, so the number is the one thing to
  // get right: the code is tied to it for good. Native's sheet uses the same
  // two answers (native sign-in.tsx, n.auth.org-confirm-yes / -no).
  if (!(await hkConfirm(T('auth.org-confirm-number', 'This code will be tied to {phone} for good. Is this your number?', { phone }), {
    ok: T('auth.org-confirm-yes', 'Yes, create my account'),
    cancel: T('auth.org-confirm-no', 'Change number'),
  }))) return;
  const pair = await ensureKeys();
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { status, body } = await api('/api/observers/org-signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, orgCode: code, publicKeyJwk, lang: chosenLang() }),
  });
  if (status !== 200) {
    const m = ORG_ERRORS[body && body.error];
    return void hkAlert(m ? T(m[0], m[1]) : explain(body || {}));
  }
  localStorage.setItem('hawkeye_token', body.token);
  clearSignedOutElsewhere();
  try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
  const r = await api('/api/observers/set-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${body.token}` },
    body: JSON.stringify({ password: newPw }),
  });
  // Awaited: afterVerified() below navigates, and would take the notice with it.
  if (r.status !== 200) await hkAlert(T('auth.password-save-failed', 'Signed in, but saving your password failed ({v0}). Set one on My Profile so you can sign in with it next time.', { v0: explain(r.body) }));
  $('ref-input').value = '';
  paintCodeKind();
  resetAuthPane();
  afterVerified(body.isNew === true || body.needsUnit === true);
}

/* ---------- Signed out because the account signed in elsewhere (D3) ----------
 * One device at a time: a sign-in on another device revokes this one's session.
 * authgate.js catches the server's 401 signed_in_elsewhere on every page and
 * leaves this flag; /resume says the same (signedInElsewhere). The sign-in pane
 * explains it — with the count of signed reports still waiting in this phone's
 * outbox, which a 401 never drops — until this device signs in again. */
const K_ELSEWHERE = 'hawkeye_signed_out_elsewhere';
function signedOutElsewhere() { try { return !!localStorage.getItem(K_ELSEWHERE); } catch { return false; } }
function markSignedOutElsewhere() {
  try { localStorage.setItem(K_ELSEWHERE, String(Date.now())); } catch { /* the notice is a courtesy */ }
  paintElsewhere();
}
function clearSignedOutElsewhere() {
  try { localStorage.removeItem(K_ELSEWHERE); } catch { /* nothing to clear */ }
  paintElsewhere();
}
async function paintElsewhere() {
  const el = $('elsewhere-note');
  if (!el) return;
  if (!signedOutElsewhere()) { el.hidden = true; return; }
  let n = 0;
  try { n = window.HawkeyeOutbox ? await window.HawkeyeOutbox.count() : 0; } catch { /* count is optional */ }
  el.textContent = T('auth.signed-out-elsewhere', 'You were signed out because this account signed in on another device.')
    + (n ? ' ' + T('auth.signed-out-elsewhere-queued', 'Signed reports waiting on this phone: {n}. Sign in again here to send them.', { n }) : '');
  el.hidden = false;
}
window.addEventListener('hawkeye-signed-out-elsewhere', () => paintElsewhere());

/**
 * `isNew` is the server's word that this verification CREATED the observer
 * (/api/observers/verify). Only `true` counts: password login never sends it and
 * /telegram-verify does not yet, so anything else keeps the old routing.
 */
function afterVerified(isNew) {
  if (NEXT_DEST) { location.href = NEXT_DEST; return; }
  if (INTENT_DEST[AUTH_INTENT]) { location.href = INTENT_DEST[AUTH_INTENT]; return; }
  // A BRAND-NEW observer is asked for their polling unit once, before anything
  // else. It is what their alerts and the election-day reminder hang off, and
  // the moment they have just signed up is the one time the ask is expected;
  // afterwards it is a Profile setting nobody goes looking for. Skippable; Save
  // and Skip both land on Home. Not when a Telegram /report handoff already
  // carries a unit — that report comes first. (NEXT_DEST and the map/incident
  // intents returned above: those observers came for something specific.)
  //
  // CHOOSE, NOT MAP. This used to be map-unit.html?onboard=1 — a surveying page
  // whose primary action is a GPS capture. choose-unit.html is the chooser, the
  // twin of native's /choose-unit. REPLACE, as native's sign-in does, so Back
  // from it never returns to a finished sign-up form.
  if (isNew === true && !PREFILL) { location.replace('choose-unit.html?onboard=1'); return; }
  // Default intent is 'observe' (AUTH_INTENT), so a fresh verification on this
  // page continues into the report flow even when a shared/og link dropped the
  // ?intent=observe param — matching the signed-in boot path below.
  if (AUTH_INTENT === 'observe') { enterReportFlow(); return; }
  location.href = 'index.html';
}

function resetAuthPane() {
  // Leaving a WhatsApp send-us-the-code wait: that code stops working.
  waStop(true);
  showWaPane(false);
  authMode = 'phone';
  pendingPhone = '';
  const input = $('auth-input');
  input.value = '';
  input.placeholder = T('observe.enter-phone-number', 'Enter Phone Number');
  input.type = 'tel';
  input.inputMode = 'tel';
  // The OTP step retitles this to "Enter OTP"; a new number wants its own label back.
  if ($('auth-input-label')) $('auth-input-label').textContent = T('observe.nigerian-mobile-number', 'Nigerian Mobile Number');
  $('btn-auth').textContent = T('observe.request-otp', 'Request OTP');
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
  syncOrgMode();       // a typed organisation code keeps the picker hidden
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
  $('btn-auth').textContent = toPw ? T('observe.sign-in', 'Sign In') : T('observe.request-otp', 'Request OTP');
  $('pw-link').textContent = toPw
    ? T('observe.forgot-your-password', 'Forgot your password?')
    : T('observe.sign-in-with-password-instead', 'Sign in with your password instead');
  $('otp-hint').textContent = '';
  paintPasskeySignIn();   // the passkey button belongs to the password step only
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
  const p = fetch(base + '/api/health').then((r) => (r.ok ? r.json() : null));
  // passkey.js reads the same answer rather than asking the server twice.
  window.__hkHealthP = p.catch(() => null);
  p
    .then((h) => {
      // WhatsApp runs in reverse (the observer sends US the code, free) only
      // when the server says so; otherwise the WhatsApp choice sends a paid
      // code exactly as before. Same fail-closed contract as SMS below.
      if (h && h.waInbound === true) WA_INBOUND = true;
      if (h && h.waPaidOtp === true) WA_PAID = true;
      if (h) WA_HEALTH = true;
      paintWaRoutes();
      paintPasskeySignIn();
      if (h && h.smsOtp === true) {
        opt.hidden = false;
        if ($('wa-sms-line')) $('wa-sms-line').hidden = false;
        return;
      }
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

/**
 * WHATSAPP OFFERS ONLY WHAT THE SERVER RUNS (owner, 2026-10-02: free route only).
 *  - "Can't send it? Get a code on WhatsApp instead" (a PAID code) shows only
 *    while /api/health says waPaidOtp — hidden in the markup until then.
 *  - The WhatsApp choice itself goes away only when the server has ANSWERED
 *    and runs neither route; with no answer it stays, and the server decides
 *    when it is chosen (/wa-start answers 503 if it cannot receive).
 */
function paintWaRoutes() {
  if ($('wa-paid-line')) $('wa-paid-line').hidden = !WA_PAID;
  const opt = $('otp-wa-opt');
  if (!opt) return;
  const none = WA_HEALTH && !WA_INBOUND && !WA_PAID;
  opt.hidden = none;
  // The label's inline display:flex outranks the UA's [hidden] rule.
  opt.style.display = none ? 'none' : 'flex';
  const radio = opt.querySelector('input');
  if (none && radio && radio.checked) { radio.checked = false; syncChannelGate(); }
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
  const need = document.getElementById('channel-need');
  paintResetNudge();
  if (!btn) return;
  // No picker on screen (password sign-in sends no code, or an organisation
  // code replaces it) => nothing to gate.
  if (!pick || pick.hidden) { btn.disabled = false; btn.removeAttribute('aria-disabled'); if (need) need.hidden = true; return; }
  // NO DEFAULT ROUTE: Request OTP looks off until one is picked. It still takes
  // a tap, which sends nothing and shows the one-line prompt (btn-auth below) —
  // the prompt only when it is needed, so the form fits with the keyboard up.
  const none = !document.querySelector('input[name="otp-channel"]:checked');
  btn.disabled = false;
  btn.setAttribute('aria-disabled', String(none));
  if (need && !none) need.hidden = true;
}
/* KEYBOARD UP ON A SMALL PHONE (owner, 2026-10-03): when the on-screen keyboard
   shrinks the visible area while a field of the sign-in form has focus, scroll
   just enough that Request OTP sits above the keyboard — never so far that the
   focused field leaves the top. 320x568 and 375x667. */
function keepAuthInView() {
  const vv = window.visualViewport;
  const btn = document.getElementById('btn-auth');
  const card = document.getElementById('auth-card');
  const field = document.activeElement;
  if (!vv || !btn || !card) return;
  // Room to scroll INTO: with the keypad up the page needs as much space below
  // the form as the keypad covers, or the end of the page stops the scroll.
  const keypad = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  card.style.marginBottom = keypad > 80 && field && card.contains(field) ? `${keypad}px` : '';
  if (!field || !card.contains(field) || btn.hidden) return;
  const visibleBottom = vv.offsetTop + vv.height;
  const over = btn.getBoundingClientRect().bottom + 12 - visibleBottom;
  if (over <= 0) return;
  const room = field.getBoundingClientRect().top - vv.offsetTop - 12;
  const by = Math.min(over, Math.max(0, room));
  if (by <= 0) return;
  const scroller = document.getElementById('page-scroll');
  if (scroller && scroller.scrollHeight > scroller.clientHeight) scroller.scrollBy(0, by);
  else window.scrollBy(0, by);
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', () => setTimeout(keepAuthInView, 50));
document.addEventListener('focusin', (e) => { if (e.target && e.target.closest && e.target.closest('#auth-card')) setTimeout(keepAuthInView, 350); });
// Leaving the form gives the room back.
document.addEventListener('focusout', () => setTimeout(() => {
  const card = document.getElementById('auth-card');
  if (card && !card.contains(document.activeElement)) card.style.marginBottom = '';
}, 300));
// First paint too: the prompt belongs on the form before anything is touched.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => syncChannelGate(), { once: true });
else syncChannelGate();
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
  $('otp-hint').textContent = T('observe.sending-a-fresh-code', 'Sending a fresh code…');
  try {
    const { status, body } = await api('/api/observers/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: pendingPhone, channel, lang: chosenLang() }),
    });
    if (status !== 200) { $('otp-hint').textContent = explain(body); return; }
    renderOtpSent(body);
  } catch { $('otp-hint').textContent = T('observe.network-problem-check-your-connection-and-try', 'Network problem — check your connection and try again.'); }
}

// How the code was delivered — shared by the first send and "Resend code".
// The user needs a single fact — where the code went — and the number so they can
// spot a typo. Telegram is the default, so a Telegram send also offers WhatsApp.
function renderOtpSent(body) {
  /* WHOLE SENTENCES, markup inside the value. The number is escaped before it
     goes in; the Telegram link is the server's, as it always was. A link that
     is a sentence of its own ("Use Telegram instead", "Prefer WhatsApp? …")
     is its own key — two sentences side by side, not one glued together. */
  const to = pendingPhone.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const hint = $('otp-hint');
  // The WhatsApp switch under a Telegram send: a PAID code only while the
  // server sends them (WA_PAID); otherwise the free route — the observer sends
  // US a code — when the server runs it; otherwise no switch at all.
  const waSwitch = WA_PAID
    ? ` <a class="btn-link" id="switch-wa" href="#">${T('observe.prefer-whatsapp-instead', 'Prefer WhatsApp? Get the code there instead.')}</a>`
    : WA_INBOUND
      ? ` <a class="btn-link" id="switch-wa-free" href="#">${T('observe.prefer-whatsapp-free', 'Prefer WhatsApp? Verify there instead.')}</a>`
      : '';
  if (body.devOtp) {
    hint.textContent = T('observe.dev-mode-your-code-is', 'DEV MODE — your code is {code}').replace('{code}', body.devOtp);
  } else if (body.viaWhatsapp) {
    hint.innerHTML = T('observe.code-sent-whatsapp', 'Code sent on WhatsApp to <strong>{phone}</strong>.', { phone: to });
  } else if (body.viaSms) {
    // Telegram stays a quiet alternative on its own line, never auto-launched.
    hint.innerHTML = T('observe.code-sent-sms', 'Code sent by SMS to <strong>{phone}</strong>.', { phone: to }) + (body.telegramLink
      ? ` <a class="btn-link" href="${body.telegramLink}" target="_blank" rel="noopener">${T('observe.use-telegram-instead', 'Use Telegram instead')}</a>` : '');
  } else if (body.telegramLink) {
    // The bot can only message someone who has opened it, so we send them
    // straight there; the two taps inside the bot are the whole instruction.
    // "Start" and "Share my phone number" stay as Telegram shows them.
    hint.innerHTML = T('observe.open-telegram-start-share',
      '<a class="btn-link" id="tg-open" href="{link}" target="_blank" rel="noopener">Open Telegram</a> — tap <strong>Start</strong>, then <strong>Share my phone number</strong>.',
      { link: body.telegramLink }) + waSwitch;
    if ($('tg-open')) $('tg-open').click(); // fresh gesture-linked click dodges popup blockers
  } else if (body.viaTelegram) {
    // Telegram is the default — say so plainly, and offer WhatsApp as the switch.
    hint.innerHTML = T('observe.code-sent-telegram', 'Code sent on Telegram to <strong>{phone}</strong>.', { phone: to }) + waSwitch;
  } else {
    hint.innerHTML = T('observe.code-sent-to', 'Code sent to <strong>{phone}</strong>.', { phone: to });
  }
  const sw = $('switch-wa');
  if (sw) sw.onclick = (e) => { e.preventDefault(); if (WA_PAID) resendVia('whatsapp'); };
  const swf = $('switch-wa-free');
  if (swf) swf.onclick = (e) => { e.preventDefault(); switchToFreeWa(); };
  showOtpPhone();
}

/* From a Telegram send to the free WhatsApp route, keeping the number. The
   sign-in completes by itself when the message lands, so the password (sign-up
   or reset) is chosen first, exactly as on the first screen. */
async function switchToFreeWa() {
  const pw = $('pw-opt-input') ? $('pw-opt-input').value : '';
  if (pw.length < 8) {
    if ($('pw-opt')) $('pw-opt').hidden = false;
    if ($('pw-opt-input')) $('pw-opt-input').focus();
    return void hkAlert(T('auth.wa-password-first', 'First choose a password (at least 8 characters) in the box above, then continue.'));
  }
  try {
    if (!(await startWaSend(pendingPhone, pw))) hkAlert(T('auth.wa-unavailable', 'WhatsApp sign-in is not available right now. Use Telegram instead.'));
  } catch {
    hkAlert(T('observe.network-problem-check-your-connection-and-try', 'Network problem — check your connection and try again.'));
  }
}

// A code that never arrived or expired is recoverable in place — the server
// happily re-issues on a fresh /register call for the same number.
if ($('otp-resend')) $('otp-resend').onclick = async (e) => {
  e.preventDefault();
  $('otp-hint').textContent = T('observe.sending-a-fresh-code', 'Sending a fresh code…');
  try {
    const { status, body } = await api('/api/observers/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: pendingPhone, channel: pendingChannel, lang: chosenLang() }),
    });
    if (status !== 200) { $('otp-hint').textContent = explain(body); return; }
    renderOtpSent(body);
  } catch {
    $('otp-hint').textContent = T('observe.network-problem-check-your-connection-and-tap', 'Network problem — check your connection and tap Resend code again.');
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
    if (orgCodeTyped()) { await orgSignUp(phone); return; }
    const channel = pickedChannel();
    if (!channel) {
      // Nothing is sent: the prompt shows under the routes.
      if ($('channel-need')) $('channel-need').hidden = false;
      return;
    }
    if (!inviteFieldOk()) return;
    // WHATSAPP, FREE: when the server runs it in reverse, the observer sends US
    // the code. Tried whenever paid codes are off too (the server decides: 503
    // if it cannot receive) — a server that sends paid codes and cannot
    // receive drops through to the paid code below, as before; one that sends
    // neither says so, and nothing is sent.
    if (channel === 'whatsapp' && (WA_INBOUND || !WA_PAID)) {
      const pw = $('pw-opt-input') ? $('pw-opt-input').value : '';
      if ($('pw-opt') && $('pw-opt').hidden) {
        // Forgotten-password route: the new password is chosen BEFORE the
        // sign-in, because the sign-in completes by itself when the message lands.
        $('pw-opt').hidden = false;
        $('pw-opt-input').focus();
        return void hkAlert(T('auth.wa-password-first', 'First choose a password (at least 8 characters) in the box above, then continue.'));
      }
      if (pw.length < 8) return void hkAlert(T('auth.password-too-short', 'Your password must be at least 8 characters.'));
      if (await startWaSend(phone, pw)) return;
      if (!WA_PAID) return void hkAlert(T('auth.wa-unavailable', 'WhatsApp sign-in is not available right now. Use Telegram instead.'));
    }
    const { status, body } = await api('/api/observers/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, channel, lang: chosenLang() }),
    });
    if (status !== 200) return void hkAlert(explain(body));
    enterOtpMode(phone, channel, body);
    return;
  }

  // A password is REQUIRED whenever we finish via OTP — a sign-up OR a forgotten-
  // password reset. Validate BEFORE burning the OTP attempt. Password sign-in
  // (authMode 'password') sets nothing; it uses the existing password.
  const settingPw = authMode !== 'password';
  const newPw = settingPw && $('pw-opt-input') ? $('pw-opt-input').value : '';
  if (settingPw && newPw.length < 8) return void hkAlert(T('auth.password-too-short', 'Your password must be at least 8 characters.'));
  if (authMode !== 'password' && !inviteFieldOk()) return;

  if (authMode === 'password') {
    if (!input.value.trim()) return void hkAlert(T('auth.enter-your-phone-number', 'Enter your phone number.'));
    if (!$('pw-signin-input').value) return void hkAlert(T('auth.enter-your-password', 'Enter your password.'));
  }

  const pair = await ensureKeys();
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const endpoint = authMode === 'password' ? '/api/observers/login' : '/api/observers/verify';
  /* WHO BROUGHT THEM. Sent on every sign-in attempt and used by the server only
     when the account is genuinely NEW — attribution on a returning sign-in would
     let anyone claim an existing observer by routing them through a link. Absent
     is fine and never blocks the request. On sign-up it is the invite field. */
  const referralCode = referralForVerify();
  const payload = authMode === 'password'
    ? { phone: input.value.trim(), password: $('pw-signin-input').value, publicKeyJwk, referralCode }
    : { phone: pendingPhone, otp: input.value.trim(), publicKeyJwk, referralCode };
  const { status, body } = await api(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (status !== 200) return void hkAlert(authMode === 'password' ? explainLogin(body) : explain(body));
  localStorage.setItem('hawkeye_token', body.token);
  clearSignedOutElsewhere();
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
    // Awaited: afterVerified() below navigates, and would take the notice with it.
    if (r.status !== 200) await hkAlert(T('auth.password-save-failed', 'Signed in, but saving your password failed ({v0}). Set one on My Profile so you can sign in with it next time.', { v0: explain(r.body) }));
  }
  resetAuthPane();
  // /login has no isNew, so a password sign-in can never be taken for a sign-up.
  // A returning sign-in may first be offered a passkey (inline, skippable).
  offerPasskeyThen(body.isNew === true, () => afterVerified(body.isNew === true || body.needsUnit === true));

  } catch {
    hkAlert(T('observe.network-problem-check-your-connection-and-try', 'Network problem — check your connection and try again.'));
  } finally {
    $('btn-auth').disabled = false;
  }
};

$('auth-reset').onclick = (e) => {
  e.preventDefault();
  resetAuthPane();
};

/* The pane flips to code entry once a code has gone out: the same input now
   takes the code, and the links that lead elsewhere step aside. Shared by
   "Request OTP" and the WhatsApp-reverse fallbacks below. */
function enterOtpMode(phone, channel, body) {
  const input = $('auth-input');
  pendingPhone = phone;
  pendingChannel = channel;
  authMode = 'otp';
  input.value = '';
  input.placeholder = T('observe.enter-otp', 'Enter OTP');
  input.inputMode = 'numeric';
  // The LABEL has to move with the field. It kept saying "Nigerian Mobile
  // Number" over an input that now wants a code, which is the one thing on
  // this screen the observer reads before typing.
  if ($('auth-input-label')) $('auth-input-label').textContent = T('observe.enter-otp', 'Enter OTP');
  $('btn-auth').textContent = T('observe.verify-otp', 'Verify OTP');
  $('auth-reset').hidden = false;
  if ($('otp-resend')) $('otp-resend').hidden = false;
  // A code is in flight — every "go somewhere else to sign in" link is noise
  // now. The create-a-password option stays (it applies on verify).
  if ($('pw-link')) $('pw-link').hidden = true;
  if ($('signin-line')) $('signin-line').hidden = true;
  if ($('signup-line')) $('signup-line').hidden = true;
  if ($('pw-opt')) $('pw-opt').hidden = false;
  if ($('channel-pick')) $('channel-pick').hidden = true;
  paintPasskeySignIn();
  renderOtpSent(body);
}

/* ---------- WhatsApp, free: "send us the code" ----------
 * The server shows a code (HK-XXXXXX); the observer sends it FROM the WhatsApp
 * on the number they typed TO our number (wa.me link, message prefilled);
 * Meta's webhook matches sender + code; this page collects the session with a
 * poll token only it holds. backend/src/services/waInbound.js has the rules.
 *
 * Polling is BOUNDED: first after the server's pollAfterMs, then x1.5 up to
 * 10 s, never past the code's expiry, and at once when the page comes back
 * into view (the observer returning from WhatsApp). One poll in flight at a
 * time. SMS (when the server sends it) stays one tap away, and a paid WhatsApp
 * code only while /api/health says waPaidOtp (paintWaRoutes). */
function showWaPane(on) {
  if ($('wa-send')) $('wa-send').hidden = !on;
  for (const id of ['auth-input', 'auth-input-label', 'btn-auth']) if ($(id)) $(id).hidden = on;
  if (on) {
    for (const id of ['channel-pick', 'pw-opt', 'ref-opt', 'otp-resend', 'pw-link', 'signin-line', 'signup-line']) if ($(id)) $(id).hidden = true;
    if ($('otp-hint')) $('otp-hint').textContent = '';
    if ($('auth-reset')) $('auth-reset').hidden = false;
  }
  paintPasskeySignIn();
}
/** The live line under the button; `spin` shows the small spinner (waiting, verified). */
function waStatus(text, spin = false) {
  const line = $('wa-status-text') || $('wa-status');
  if (line) line.textContent = text;
  if ($('wa-spin')) $('wa-spin').hidden = !spin;
}
const WA_WAITING = () => T('auth.wa-waiting', 'Waiting for your message…');
const WA_BODY = () => T('auth.wa-body-3', 'Press Send in WhatsApp — this screen continues by itself.');
function waStop(cancelOnServer) {
  if (!wa) return;
  clearTimeout(wa.timer);
  if (cancelOnServer) {
    const pollToken = wa.pollToken;
    api('/api/observers/wa-cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollToken }) }).catch(() => {});
  }
  wa = null;
}
/** Start (or restart) the free WhatsApp route. False = not available: send the paid code instead. */
async function startWaSend(phone, newPw) {
  waStop(true);
  $('otp-hint').textContent = T('auth.wa-starting', 'Getting your code…');
  const pair = await ensureKeys();
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { status, body } = await api('/api/observers/wa-start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, publicKeyJwk, lang: chosenLang(), referralCode: referralForVerify() }),
  });
  $('otp-hint').textContent = '';
  if (status === 503) { WA_INBOUND = false; return false; }
  if (status === 429) {
    hkAlert(WA_PAID
      ? T('auth.wa-too-many', 'Too many tries for this number. Wait an hour, or get a code on WhatsApp instead.')
      : T('auth.wa-too-many-free', 'Too many tries for this number. Wait an hour, or use Telegram instead.'));
    return true;
  }
  if (status !== 200) { hkAlert(explain(body)); return true; }
  pendingPhone = phone;
  pendingChannel = 'whatsapp';
  authMode = 'wa';
  wa = {
    pollToken: body.pollToken, code: body.code, link: body.waLink, newPw, gen: ++waGen,
    deadline: Date.now() + (Number(body.expiresInS) || 600) * 1000,
    delay: Number(body.pollAfterMs) || 2000, timer: 0, busy: false, fails: 0,
  };
  // SENDING IS THE VERIFICATION. Nothing comes back to type, and this screen
  // moves on by itself — one short line says so (owner, 2026-09-30: the long
  // paragraph that used to explain it went unread).
  $('wa-body').textContent = WA_BODY();
  $('wa-code').textContent = body.code;
  wa.number = body.waNumber;
  $('wa-number').textContent = T('auth.wa-number', 'Or send the code yourself to {number}.', { number: body.waNumber });
  if ($('wa-again-line')) $('wa-again-line').hidden = true;
  if ($('wa-open')) $('wa-open').hidden = false;
  waStatus(WA_WAITING(), true);
  showWaPane(true);
  waSchedule(wa.delay);
  return true;
}
function waSchedule(ms) {
  if (!wa) return;
  clearTimeout(wa.timer);
  const left = wa.deadline - Date.now();
  wa.timer = setTimeout(waPoll, Math.max(0, Math.min(ms, left + 250)));
}
async function waPoll() {
  if (!wa || wa.busy) return;
  const mine = wa;
  if (Date.now() > mine.deadline) return waExpired();
  mine.busy = true;
  let r = null;
  try {
    r = await api('/api/observers/wa-status', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollToken: mine.pollToken }),
    });
  } catch { r = null; }
  mine.busy = false;
  if (wa !== mine) return;                       // cancelled or restarted meanwhile
  mine.delay = Math.min(10000, Math.round(mine.delay * 1.5));
  if (!r || r.status === 0 || r.status === 429 || r.status >= 500) {
    mine.fails += 1;
    if (mine.fails >= 2) waStatus(T('auth.wa-offline', "Can't reach Hawkeye — check your connection. We'll keep checking."));
    return waSchedule(mine.delay);
  }
  mine.fails = 0;
  if (r.status === 410) return waExpired();
  if (r.status === 200 && r.body.status === 'verified') return waFinish(r.body);
  if (r.status === 200 && r.body.mismatch) {
    waStatus(T('auth.wa-mismatch', 'We got the code from a different number. Send it from the WhatsApp on {phone}, or go back and enter the number your WhatsApp uses.', { phone: pendingPhone }));
  } else {
    waStatus(WA_WAITING(), true);
  }
  waSchedule(mine.delay);
}
function waExpired() {
  if (!wa) return;
  clearTimeout(wa.timer);
  wa.timer = 0;
  wa.deadline = 0;
  waStatus(T('auth.wa-expired', 'This code has expired. Start again for a new one.'));
  if ($('wa-open')) $('wa-open').hidden = true;
  if ($('wa-again-line')) $('wa-again-line').hidden = false;
}
async function waFinish(body) {
  const newPw = wa && wa.newPw;
  waStop(false);
  waStatus(T('auth.wa-verified', 'Verified — signing you in…'), true);
  localStorage.setItem('hawkeye_token', body.token);
  clearSignedOutElsewhere();
  try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
  // Every phone-proof sign-in on this page ends with a password (sign-up or
  // reset); it was chosen before the code went out. The WhatsApp proof is
  // fresh phone proof, so no current password is needed.
  if (newPw) {
    const r = await api('/api/observers/set-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.token}` },
      body: JSON.stringify({ password: newPw }),
    });
    if (r.status !== 200) await hkAlert(T('auth.password-save-failed', 'Signed in, but saving your password failed ({v0}). Set one on My Profile so you can sign in with it next time.', { v0: explain(r.body) }));
  }
  resetAuthPane();
  offerPasskeyThen(body.isNew === true, () => afterVerified(body.isNew === true || body.needsUnit === true));
}
/* Leave the free route for a code sent TO the observer (paid). */
async function waFallback(channel) {
  const phone = pendingPhone;
  waStop(true);
  showWaPane(false);
  if (!IS_SIGNIN && $('ref-opt')) $('ref-opt').hidden = false;
  $('otp-hint').textContent = T('observe.sending-a-fresh-code', 'Sending a fresh code…');
  try {
    const { status, body } = await api('/api/observers/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone, channel, lang: chosenLang() }),
    });
    if (status !== 200) {
      $('otp-hint').textContent = '';
      resetAuthPane();
      return void hkAlert(explain(body));
    }
    enterOtpMode(phone, channel, body);
  } catch {
    $('otp-hint').textContent = T('observe.network-problem-check-your-connection-and-try', 'Network problem — check your connection and try again.');
  }
}
/**
 * THE APP ITSELF, ON A PHONE.
 *
 * wa.me is a web page that then offers to open WhatsApp — on a phone that is a
 * browser screen and one more tap before the prefilled message is even in
 * view. whatsapp://send opens the app straight onto the chat. It is built from
 * the SERVER's wa.me link (its number and ?text), so there is still one source
 * for both and nothing here hardcodes our number.
 *
 * If the app does not open (not installed, or the scheme is refused) this page
 * is still in front a beat later, and the wa.me link takes over exactly as
 * before. A desktop keeps wa.me: that is how WhatsApp Web and Desktop take it.
 *
 * iOS GETS THE SCHEME TOO (owner, 2026-09-30). iOS asks "Open in WhatsApp?"
 * first, but wa.me there opened Safari's api.whatsapp.com page with its own
 * "Open this page in WhatsApp?" banner — a web page AND a prompt. The single
 * system prompt is the lesser step.
 */
function waAppLink(link) {
  try {
    const u = new URL(link);
    if (!/(^|\.)wa\.me$/i.test(u.hostname)) return null;
    const phone = u.pathname.replace(/\D/g, '');
    if (!phone) return null;
    const text = u.searchParams.get('text') || '';
    return `whatsapp://send?phone=${phone}${text ? `&text=${encodeURIComponent(text)}` : ''}`;
  } catch { return null; }
}
const waOnPhone = () => Boolean(window.Capacitor)
  || Boolean(navigator.userAgentData && navigator.userAgentData.mobile)
  || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
// A new tab (Lite: the system opens WhatsApp) so this page keeps waiting. A
// blocked popup (it can be, a second after the tap) navigates instead.
const waOpenWeb = (link) => { if (!window.open(link, '_blank', 'noopener') && waOnPhone()) location.href = link; };
if ($('wa-open')) $('wa-open').onclick = () => {
  if (!wa || !wa.link) return;
  const link = wa.link;
  const app = waOnPhone() ? waAppLink(link) : null;
  if (!app) { window.open(link, '_blank', 'noopener'); return; }
  // Did WhatsApp take over? Any of these means the page went behind it.
  let left = false;
  const gone = () => { left = true; };
  const hid = () => { if (document.hidden) left = true; };
  window.addEventListener('pagehide', gone);
  window.addEventListener('blur', gone);
  document.addEventListener('visibilitychange', hid);
  location.href = app;
  setTimeout(() => {
    window.removeEventListener('pagehide', gone);
    window.removeEventListener('blur', gone);
    document.removeEventListener('visibilitychange', hid);
    if (!left && document.visibilityState === 'visible') waOpenWeb(link);
  }, 1200);
};
if ($('wa-copy')) $('wa-copy').onclick = async (e) => {
  e.preventDefault();
  const code = $('wa-code') ? $('wa-code').textContent : '';
  try {
    await navigator.clipboard.writeText(code);
    e.target.textContent = T('auth.wa-copied', 'Copied');
    setTimeout(() => { e.target.textContent = T('auth.wa-copy', 'Copy code'); }, 2000);
  } catch { /* the code is selectable on screen */ }
};
if ($('wa-again')) $('wa-again').onclick = () => {
  const pw = wa && wa.newPw;
  startWaSend(pendingPhone, pw || ($('pw-opt-input') ? $('pw-opt-input').value : '')).then((started) => {
    if (started) return;
    if (WA_PAID) waFallback('whatsapp');
    else waStatus(T('auth.wa-unavailable', 'WhatsApp sign-in is not available right now. Use Telegram instead.'));
  });
};
// A PAID code: only while the server sends them (the line is hidden otherwise).
if ($('wa-paid')) $('wa-paid').onclick = (e) => { e.preventDefault(); if (WA_PAID) waFallback('whatsapp'); };
if ($('wa-sms')) $('wa-sms').onclick = (e) => { e.preventDefault(); waFallback('sms'); };
// Back from WhatsApp: check straight away instead of waiting out the backoff.
function waWake() {
  if (!wa || document.hidden || !wa.deadline) return;
  clearTimeout(wa.timer);
  waPoll();
}
document.addEventListener('visibilitychange', waWake);
window.addEventListener('focus', waWake);
window.addEventListener('pageshow', waWake);

/* ---------- Passkeys (passkey.js) ----------
 * Sign-in: one ordinary button on the password step, only where a passkey can
 * work. Offer: after a RETURNING sign-in on a device that can make one, an
 * inline card before the page moves on — never on a brand-new sign-up, never
 * again for 30 days after "Not now", never once this device has one. */
async function paintPasskeySignIn() {
  const wrap = $('pk-signin-wrap');
  if (!wrap) return;
  const want = IS_SIGNIN && authMode === 'password' && !!window.HawkeyePasskey;
  if (!want) { wrap.hidden = true; return; }
  let ok = false;
  try { ok = await window.HawkeyePasskey.supported(); } catch { ok = false; }
  // Re-read: the mode may have changed while support was being checked.
  const show = ok && IS_SIGNIN && authMode === 'password';
  wrap.hidden = !show;
  // PASSKEY FIRST ON A DEVICE THAT HAS ONE (D2, owner 2026-10-02): this
  // browser made or used a Hawkeye passkey (passkey.js sets the flag), so the
  // passkey is the default — the primary button, above the number and
  // password. Everywhere else it stays where it was, right after Sign In.
  let here = false;
  try { here = localStorage.getItem('hawkeye_pk_here') === '1'; } catch { /* a courtesy flag */ }
  const lead = show && here;
  const top = $('auth-input-label');
  if (lead && top && wrap.parentNode === top.parentNode && wrap.nextElementSibling !== top) {
    top.parentNode.insertBefore(wrap, top);
    wrap.style.margin = '0 0 16px';
  }
  if ($('pk-signin')) $('pk-signin').classList.toggle('secondary', !lead);
}

/* D3: the forgotten-password route asks for resets BEFORE the election window,
   when sessions are held open (no code needed 9-17 Jan). Shown until 9 Jan. */
function paintResetNudge() {
  const el = $('reset-nudge');
  if (!el) return;
  const until = Date.parse('2027-01-09T00:00:00+01:00');
  el.hidden = !(IS_SIGNIN && authMode !== 'password' && Date.now() < until);
}
if ($('pk-signin')) $('pk-signin').onclick = async () => {
  const btn = $('pk-signin');
  if (btn.disabled) return;
  btn.disabled = true;
  const hint = $('pk-signin-hint');
  const was = hint ? hint.textContent : '';
  if (hint) hint.textContent = T('passkey.signing-in', 'Waiting for your passkey…');
  try {
    const pair = await ensureKeys();
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const r = await window.HawkeyePasskey.signIn(api, publicKeyJwk);
    if (!r || r.error || !r.token) {
      if (hint) hint.textContent = was;
      if (r && r.error === 'cancelled') return;
      return void hkAlert(window.HawkeyePasskey.errorText(r));
    }
    localStorage.setItem('hawkeye_token', r.token);
    clearSignedOutElsewhere();
    try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
    resetAuthPane();
    // A returning sign-in, like the password: no sign-up routing.
    afterVerified(false);
  } finally {
    btn.disabled = false;
  }
};
const K_PK_LATER = 'hawkeye_pk_offer_later';
async function offerPasskeyThen(isNew, next) {
  let eligible = false;
  try {
    const later = Number(localStorage.getItem(K_PK_LATER) || 0);
    eligible = !isNew && !PREFILL && !!window.HawkeyePasskey && !!$('pk-offer')
      && !localStorage.getItem('hawkeye_pk_here')
      && Date.now() - later > 30 * 24 * 3600_000
      && await window.HawkeyePasskey.canCreateHere();
  } catch { eligible = false; }
  if (!eligible) return next();
  const card = $('auth-card');
  const offer = $('pk-offer');
  const yes = $('pk-offer-yes');
  const no = $('pk-offer-no');
  const msg = $('pk-offer-msg');
  if (card) card.hidden = true;
  if ($('practice-line')) $('practice-line').hidden = true;
  offer.hidden = false;
  msg.textContent = '';
  yes.textContent = T('passkey.offer-yes', 'Use fingerprint or face');
  no.hidden = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    offer.hidden = true;
    if (card) card.hidden = false;
    next();
  };
  const authed = (p, o = {}) => api(p, { ...o, headers: { ...(o.headers || {}), authorization: 'Bearer ' + localStorage.getItem('hawkeye_token') } });
  yes.onclick = async () => {
    if (yes.dataset.saved) return finish();
    yes.disabled = true;
    const r = await window.HawkeyePasskey.register(authed);
    yes.disabled = false;
    if (r && r.ok) {
      msg.textContent = T('passkey.saved', 'Passkey saved. Next time, tap "Sign in with a passkey".');
      yes.dataset.saved = '1';
      yes.textContent = T('passkey.continue', 'Continue');
      no.hidden = true;
      return;
    }
    msg.textContent = window.HawkeyePasskey.errorText(r);
  };
  no.onclick = (e) => {
    e.preventDefault();
    try { localStorage.setItem(K_PK_LATER, String(Date.now())); } catch { /* asked again next time */ }
    finish();
  };
  yes.focus();
}

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
  $('locate-status').textContent = T('observe.getting-your-location', 'Getting your location…');
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
    $('locate-status').textContent = T('observe.location-fixed-looking-up-nearby-units', 'Location fixed (±{m} m). Looking up nearby units…')
      .replace('{m}', String(Math.round(accuracy)));
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
      T('observe.could-not-check-nearby-units-search-by', 'Could not check nearby units. Search by name below.');
    $('browse-block').open = true;
    $('btn-locate').textContent = T('observe.try-searching-near-me-again', 'Try Searching Near Me Again');
    return;
  }
  const body = r.body;
  if (!body.units || body.units.length === 0) {
    $('locate-status').textContent =
      T('observe.no-units-found-search-or-browse-the', 'No units found — search or browse the register below.');
    $('browse-block').open = true;
    return;
  }
  $('locate-status').textContent = T('observe.select-the-unit-you-are-standing-at', 'Select the unit you are standing at:');
  for (const u of body.units) {
    const btn = document.createElement('button');
    btn.className = 'pu-option';
    // Join what EXISTS. A unit placed only by its GRID3 envelope has a ward but
    // no LGA, and "Akogun, " with a dangling comma reads as broken in a list
    // someone is scanning under time pressure.
    const where = [u.ward, u.lga].filter(Boolean).join(', ');
    const facts = [u.pu_code, where, T('common.m-away', '{v0} m away', { v0: u.distanceM }), tierLabel(tierOf(u))]
      .filter(Boolean).join(' · ');
    btn.innerHTML = `<strong>${u.name}</strong><br /><small>${facts}</small>`;
    btn.onclick = () => selectUnit(u);
    $('pu-list').appendChild(btn);
  }
  // A search has now genuinely run, so offering to repeat it is honest.
  $('btn-locate').textContent = T('observe.search-near-me-again', 'Search Near Me Again');
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
    fillSelect($('sel-state'), body, T('common.select-state', '— select state —'));
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
    btn.innerHTML = `<strong>${u.name}</strong><br /><small>${u.pu_code} · ${tierLabel(tierOf(u))}</small>`;
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
    keyedText($(`btn-cam-${t}`), 'common.take-photo', 'Take photo');
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
  /* CHECK IN ON ARRIVAL, before the photos: a roster member with a unit they
     are down for gets the card at the top of the report. Never awaited, never
     scrolled to — the camera card stays where the eye is. */
  checkInOfferedEarly = false;
  void renderCheckIn().then((actionable) => { checkInOfferedEarly = actionable; }).catch(() => {});
}

/**
 * Choosing a unit no longer navigates and no longer resets anything: the
 * observer is already on this screen, very likely with both photographs already
 * taken. It binds the unit and nothing else.
 *
 * If this ever calls prepareReportUI() again it will WIPE THE PHOTOS — that was
 * the coupling step 1 existed to remove. Bind only.
 */
/**
 * ATTENDANCE, INSIDE THE REPORT FLOW.
 *
 * WHY HERE. On election day an agent is in this flow, not in the situation
 * room — the room is where their coordinator sits. Presence typed into a
 * separate page is presence most agents will never record.
 *
 * WHY ONLY SOME PEOPLE SEE IT. /api/my/rooms is empty for anyone not on a
 * roster, so the control renders for nobody else. That is a server decision,
 * not a client guess: Hawkeye's whole premise is that every citizen is an
 * observer, and showing a lone voter a button that says "let your coordinator
 * know" would invent an authority over them that does not exist.
 *
 * Fetched ONCE per flow and cached, including the empty answer — this runs on
 * a phone on a rural connection on the busiest day of the year, and the
 * majority case must cost exactly one request.
 */
let myRooms = null;

async function loadMyRooms() {
  if (myRooms !== null) return myRooms;
  try {
    const { status, body } = await api('/api/my/rooms', {
      headers: { authorization: `Bearer ${localStorage.getItem('hawkeye_token') || ''}` },
    });
    myRooms = status === 200 && Array.isArray(body?.rooms) ? body.rooms : [];
  } catch {
    /* A roster lookup that fails must never block a report. The control simply
       does not appear, which is the same as it is for most people. */
    myRooms = [];
  }
  return myRooms;
}

/**
 * The card, rebuilt whenever the chosen unit changes: it names the unit they
 * are actually standing at, which is the whole point — it is checking them in
 * HERE, not wherever a coordinator expected.
 */
/**
 * WHICH UNIT the card checks them in at: the one chosen in step 2 — or, BEFORE
 * any is chosen (the card now sits above the photos, where arrival happens),
 * the unit a room has them down for. Null when neither is known: then the card
 * waits for step 2, as it always did.
 */
function checkInUnit(rooms) {
  if (selectedPu) return { pu_code: selectedPu.pu_code, name: selectedPu.name, chosen: true };
  const a = (rooms || []).map((r) => r.assigned).find((x) => x && x.pu_code);
  return a ? { pu_code: a.pu_code, name: a.name, chosen: false } : null;
}
/* Offered at the top of a new report already? Then choosing a unit later must
   not drag the page back up past the photos to it. */
let checkInOfferedEarly = false;

async function renderCheckIn() {
  const host = $('checkin-host');
  if (!host) return false;
  const rooms = await loadMyRooms();
  const unit = checkInUnit(rooms);
  if (!rooms.length || !unit) { host.hidden = true; host.innerHTML = ''; return false; }

  const done = rooms.every((r) => r.checkedIn && r.checkedIn.standing === 'verified');
  if (done) {
    host.hidden = false;
    host.innerHTML = `<div class="card" style="border-left:4px solid var(--ok, #1f7a4d);padding:14px 18px">`
      + `<p class="hint" style="margin:0">\u2714 ${T('observe.checked-in-already', 'Your coordinator knows you are here.')}</p></div>`;
    return false;
  }

  /* An assignment somewhere ELSE is said plainly before they tap. Being sent
     to another unit is ordinary — agents get moved, gates get closed — and the
     coordinator needs to see it, so the copy tells them what will be recorded
     rather than warning them off. */
  const elsewhere = rooms.filter((r) => r.assigned && r.assigned.pu_code !== unit.pu_code);
  host.hidden = false;
  host.innerHTML = `
    <div class="card" id="checkin-card" style="border-left:4px solid var(--accent);padding:16px 18px">
      <b style="display:block;margin-bottom:4px">${T('observe.check-in-title', 'Tell your coordinator you are here')}</b>
      <p class="hint" style="margin:0" id="checkin-note">${!unit.chosen
    ? T('observe.check-in-at-assigned', 'This checks you in at {unit}, the unit you are down for. At a different unit? Choose it in step 2 first.', { unit: String(unit.name || unit.pu_code).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) })
    : elsewhere.length
      ? T('observe.check-in-different-unit', 'You are down for {unit}. Checking in here records where you actually are.', { unit: elsewhere[0].assigned.name })
      : T('observe.check-in-sub', 'They will see that you have arrived, before any result is filed.')}</p>
      <button type="button" id="btn-checkin" style="width:auto;margin:12px 0 0;background:var(--accent);color:var(--green-950);border-color:transparent;box-shadow:none">${T('observe.check-in', "I'm at my unit")}</button>
    </div>`;
  return true;
}

async function doFlowCheckIn(btn) {
  const note = $('checkin-note');
  const say = (m) => { if (note) note.textContent = m; };
  if (!navigator.geolocation) return say(T('observe.check-in-no-gps', 'This device cannot give a location, so a check-in cannot be recorded.'));
  btn.disabled = true;
  say(T('observe.check-in-locating', 'Finding your location\u2026'));
  try {
    /* THE FLOW'S OWN FIX, not a second one. getPosition() is what the near-me
       search and the submission already use: it accepts a 30s-old reading and
       falls back to the keeper's lastFix, because demanding a brand-new
       high-accuracy lock races a cold GPS start and loses — indoors it burns
       the whole timeout and then returns the same value anyway. A check-in
       that fails on a warm phone would be worse than none. */
    const pos = await getPosition();
    const unit = checkInUnit(myRooms);
    if (!unit) { btn.disabled = false; return say(T('common.something-went-wrong', 'Something went wrong. Try again.')); }
    const { status, body } = await api('/api/my/check-in', {
      method: 'POST',
      /* BOTH headers matter. Without the Bearer this is a 401; without the
         content-type express.json() never parses the body and the server
         answers "no fix" to a perfectly good one. api() adds only
         x-device-id. */
      headers: {
        authorization: `Bearer ${localStorage.getItem('hawkeye_token') || ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pu_code: unit.pu_code,
        lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy,
      }),
    });
    if (status !== 200) {
      btn.disabled = false;
      return say({
        no_rooms: T('observe.check-in-not-member', 'You are not on anybody\u2019s roster.'),
        no_such_unit: T('observe.check-in-no-such-unit', 'That polling unit is not in the register.'),
        no_fix: T('observe.check-in-no-fix', 'Your device did not return a usable location.'),
      }[body?.error] || T('common.something-went-wrong', 'Something went wrong. Try again.'));
    }
    /* SAY WHAT WAS RECORDED, not "done". A check-in the location could not
       stand behind is worth less to the coordinator than one it could, and the
       agent is the only person who can still do something about it. */
    myRooms = null;
    if (body.standing === 'verified') {
      $('checkin-card').innerHTML = `<p class="hint">\u2714 ${T('observe.checked-in-ok', 'Checked in. Your coordinator can see you are at this unit.')}</p>`;
    } else {
      $('checkin-card').innerHTML = `<p class="hint">${T('observe.checked-in-weak', 'Recorded, but your location could not be confirmed. Your coordinator sees it as unconfirmed.')}</p>`;
    }
    /* The card has just become a receipt with nothing left to do on it, so this
       is the moment to hand them on — the same move every other step makes:
       to the photos when they checked in on arrival, else to the race. */
    const next = unit.chosen ? $('race-fold') : $('photo-fold');
    if (next) requestAnimationFrame(() => next.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } catch (e) {
    btn.disabled = false;
    say(e && e.code === 1
      ? T('observe.check-in-denied', 'Location permission was refused, so a check-in cannot be recorded.')
      : T('observe.check-in-failed', 'Could not read your location. Move into the open and try again.'));
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#btn-checkin');
  if (b) doFlowCheckIn(b);
});

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
  /* Named after the unit is bound, so the card can say where it will check
     them in. Still never AWAITED — a roster lookup must not delay the flow —
     but it now owns where the page lands.

     THE CARD WAS BEING SCROLLED PAST. setStepDone(1) advances to step 3 and
     scrolls there, and this line scrolled there again; the check-in card sits
     between the two and renders a moment later, when the roster call returns.
     So the one card asking the observer to do something appeared above the
     viewport and was never seen. Now: if there is something to check into, the
     page goes to THAT, and checking in is what sends them on to step 3. */
  /* Offered on arrival already (above the photos)? Then it is redrawn for this
     unit where it is, and the page moves on to step 3 rather than back up. */
  renderCheckIn().then((actionable) => {
    const target = actionable && !checkInOfferedEarly ? $('checkin-card') : $('race-fold');
    if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  });
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
    $('submit-status').textContent = T('observe.prefilled-from-telegram-now-capture-the-sheet', 'Prefilled from Telegram — now capture the sheet & venue photos to finish.');
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
    // The KEY moves with the word: the badge carries data-i18n="common.required"
    // in the markup, and apply() re-runs on every language change.
    if (shots[t]) keyedText(badge, 'common.captured', 'Captured ✔');
    else keyedText(badge, 'common.required', 'Required');
    badge.classList.toggle('done', Boolean(shots[t]));
  }
  // Step 1's confirmer is the second photo landing.
  const both = Boolean(shots.sheet && shots.venue);
  if (both !== stepDone[0]) setStepDone(0, both, '✔ ' + T('report.both-captured', 'Both captured'));
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
// A function, so the labels are in the language of the moment the camera
// opens (capture.js paints them on every open).
const targetLabels = () => ({
  sheet: { title: T('observe.results-sheet-ec8a', 'Results sheet (EC8A)'), action: T('observe.capture-ec8a', 'Capture EC8A') },
  venue: { title: T('observe.polling-venue', 'Polling venue'), action: T('observe.capture-polling-venue', 'Capture Polling Venue') },
});
const closeCamera = () => window.HAWKEYE_CAPTURE.close();
const openCamera = (target) => window.HAWKEYE_CAPTURE.open(target, {
  // Truthy closes the camera; falsy keeps it open for a retake, which is what
  // finalizeShot already signals.
  onShot: (blob, t) => finalizeShot(t, blob),
  onError: (m) => { $('submit-status').textContent = m; },
  labels: targetLabels(),
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
    const esc1 = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    box.innerHTML = codes.length
      ? `<p class="hint">${T('observe.sheet-code-no-unit', 'Read <strong>{code}</strong> off the sheet, but no unit with that code was found — pick yours below.', { code: esc1(codes[0]) })}</p>`
      : `<p class="hint">${T('observe.sheet-code-unread', 'Could not read unit code off sheet. Pick unit below.')}</p>`;
    return;
  }
  const u = hit.unit;
  const where = [u.ward, u.lga, u.state].filter(Boolean).join(', ');
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'border:2px solid var(--green);margin:0 0 10px';
  // "read from the sheet" is a tag in a · list, not a clause of a sentence, so
  // the list stays in code; the tag itself is one whole phrase per case.
  const readTag = hit.source === 'repaired'
    ? T('observe.read-from-sheet-corrected', 'read from the sheet (one digit corrected)')
    : T('observe.read-from-sheet', 'read from the sheet');
  card.innerHTML = `<p style="margin:0 0 6px;font-weight:700">${T('observe.is-this-your-polling-unit', 'Is this your polling unit?')}</p>
    <p style="margin:0 0 2px"><strong>${u.name}</strong></p>
    <p class="hint" style="margin:0 0 10px">${u.pu_code}${where ? ` · ${where}` : ''} · ${readTag}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="pu-yes" style="flex:1;min-width:120px">${T('observe.yes-use-this-unit', 'Yes, use this unit')}</button>
      <button class="pu-no secondary" style="flex:1;min-width:100px">${T('observe.no-choose-another', 'No, choose another')}</button>
    </div>`;
  card.querySelector('.pu-yes').onclick = () => { card.remove(); selectUnit(u); };
  card.querySelector('.pu-no').onclick = () => {
    card.remove();
    $('locate-status').textContent = T('observe.pick-your-unit-below-or-search-for', 'Pick your unit below, or search for it.');
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
    hkAlert(T('observe.no-gps-fix-retake', 'No GPS fix — photos must be location-stamped. Move to open sky and retake.'));
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
  // Key with the text: the button's markup key is "Take photo", and apply()
  // re-runs on every language change.
  keyedText($(`btn-cam-${target}`), 'observe.retake-photo', 'Retake photo');
  updateSubmitState();
  return true;
}

// ---------- submit ----------
$('btn-submit').onclick = async () => {
  if (!shots.sheet || !shots.venue || !selectedPu) return;
  if (!$('sel-contest').value) {
    $('submit-status').textContent = T('observe.select-which-election-you-are-reporting', 'Select which election you are reporting.');
    $('sel-contest').focus();
    return;
  }
  if (selectedContestClosed()) {
    // A MODAL, NOT A LINE UNDER THE BUTTON. This is not "check that field" — it
    // is the whole submission being refused for a reason no amount of editing
    // fixes today, and the observer has just photographed a sheet and typed a
    // tally. A status line below the fold is missable enough that it reads as
    // the button doing nothing.
    notifyBlocked(T('common.reporting-not-open-yet', 'Reporting is not open yet'), errorText('reporting_not_open'));
    return;
  }
  const auto = [...document.querySelectorAll('#vote-inputs input.ocr-filled')]
    .map((i) => `${i.dataset.party}: ${i.value || 0}`);
  if (auto.length && !(await hkConfirm(T('observe.auto-filled-confirm', 'These counts were auto-filled from your sheet photo — confirm they match the sheet:\n\n{v0}\n\nSubmit with these numbers?', { v0: auto.join('\n') })))) {
    $('submit-status').textContent = T('observe.check-the-highlighted-counts-against-your-sheet', 'Check the highlighted counts against your sheet, then submit again.');
    return;
  }
  $('btn-submit').disabled = true;
  $('submit-status').textContent = T('observe.getting-a-fresh-gps-fix', 'Getting a fresh GPS fix…');

  let pos;
  try {
    pos = await getPosition();
  } catch {
    $('submit-status').textContent = T('observe.could-not-get-your-location', 'Could not get your location.');
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

  $('submit-status').textContent = T('observe.signing-your-report', 'Signing your report…');
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
  // Device signals (device.js getDeviceSignals): unsigned, advisory — the server
  // counts one phone running both Hawkeye apps once, and one phone as one
  // counting account per election (a report asks for a DeviceCheck token too,
  // on iOS Lite builds that have it). Rides the outbox too.
  if (window.getDeviceSignals) {
    try { form.set('signals', JSON.stringify(await window.getDeviceSignals({ deviceCheck: true }))); } catch { /* not sent */ }
  }
  form.set('photo', shots.sheet.blob, 'ec8a.jpg');
  form.set('venuePhoto', shots.venue.blob, 'venue.jpg');

  $('submit-status').textContent = T('observe.submitting', 'Submitting…');

  // DIRECT UPLOAD, WHEN THE SERVER OFFERS IT. The photos go straight to the
  // bucket and only hashes come here, because inbound bytes count against the
  // host's monthly allowance and the photos are the whole of it. If anything at
  // all goes wrong — proxy mode, no bucket, CORS, a flaky link — direct() gives
  // back null and the original multipart post runs untouched. A report is never
  // lost to a storage optimisation.
  // EXCEPT "busy": a presign refused 429/503 must not become a multipart post —
  // that pushes the photo bytes through the origin just when it asked for less.
  // The report is parked in the outbox below instead, until Retry-After.
  // D1 PHOTO QUORUM: with the figures, the presign may answer "hash-only" (the
  // sheet already holds 5 agreeing photo-backed reports). direct-upload.js
  // then keeps both photos on this phone and nothing is uploaded; hashOnly
  // marks the body so the server re-checks the quorum on the SIGNED figures.
  let directBody = null;
  let presignBusy = null;
  let hashOnly = false;
  const planUpload = async (withFigures) => {
    directBody = null;
    hashOnly = false;
    if (!window.HawkeyeDirect) return;
    const D = window.HawkeyeDirect;
    const up = await (D.tryUpload || D.upload)({
      base: (window.HAWKEYE && window.HAWKEYE.apiBase) || '',
      token: localStorage.getItem('hawkeye_token'),
      blobs: { sheet: shots.sheet.blob, venue: shots.venue.blob },
      hashes: { sheet: imageSha256, venue: venueImageSha256 },
      ...(withFigures ? { figures: { puCode: selectedPu.pu_code, contest, votes } } : {}),
    });
    if (up && up.busy) presignBusy = up;
    else if (up === true || (up && up.hashOnly)) {
      hashOnly = up !== true;
      const f = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') f[k] = v;
      directBody = JSON.stringify({ ...f, imageSha256, venueImageSha256, ...(hashOnly ? { hashOnly: '1' } : {}) });
    }
  };
  await planUpload(true);

  // A copy of the two photos on the device (save-media.js), once, at hand-off —
  // accepted or queued. These are the compressed bytes that were signed.
  const keepCopies = () => window.HAWKEYE_SAVE_MEDIA && window.HAWKEYE_SAVE_MEDIA(
    [shots.sheet, shots.venue].filter(Boolean).map((s) => ({ blob: s.blob, kind: 'photo' })), 'result');

  const post = () => api('/api/submissions', {
    method: 'POST',
    headers: directBody
      ? { authorization: `Bearer ${localStorage.getItem('hawkeye_token')}`, 'content-type': 'application/json' }
      : { authorization: `Bearer ${localStorage.getItem('hawkeye_token')}` },
    body: directBody || form,
  });
  // Hand the signed report to the offline outbox and show it as saved. The
  // report is already signed over its exact bytes, so it can wait — on every
  // platform, since IndexedDB is universal; outbox.js's own listeners drive the
  // retry (the Capacitor shell fires those same events). `notBefore` holds the
  // first retry when the server asked for time. False when there is no outbox.
  const park = async (lead, notBefore) => {
    if (!(window.HAWKEYE && window.HawkeyeOutbox)) return false;
    const fields = {};
    for (const [k, v] of form.entries()) if (typeof v === 'string') fields[k] = v;
    // Carried so a later flush can presign without re-hashing the blobs. The
    // signature already covers these exact values, so recording them changes
    // nothing evidentiary.
    fields.imageSha256 = imageSha256;
    fields.venueImageSha256 = venueImageSha256;
    try {
      await window.HawkeyeOutbox.queue({ fields, sheet: shots.sheet.blob, venue: shots.venue.blob, ...(notBefore ? { notBefore } : {}) });
      keepCopies(); // here, not when the outbox flushes it later
    } catch { /* ignore */ }
    shots.sheet = null; shots.venue = null;
    const offlineContest = (contests.find((c) => c.code === fields.contest) || {}).name || fields.contest || '';
    let offlineVotes = [];
    try { offlineVotes = JSON.parse(fields.votes); } catch { /* card just omits them */ }
    $('result-summary').innerHTML = `
      <p><strong>${selectedPu ? selectedPu.name : ''}</strong> — ${offlineContest}</p>
      <p>${lead}</p>`;
    $('entry-hash').textContent = '';
    $('receipt-wrap').hidden = true;
    showReceipt(receiptData(offlineContest, offlineVotes, ''));
    show('screen-result');
    $('btn-submit').disabled = false;
    return true;
  };
  const busyLine = () => T('observe.server-busy-saved', 'Hawkeye is busy right now — your signed report is saved on this phone and sends automatically.');
  // First retry: Retry-After plus jitter (outbox.js decides the numbers).
  const holdUntil = (st, ra) => Date.now() + (window.HawkeyeOutbox && window.HawkeyeOutbox.retryDelayMs
    ? window.HawkeyeOutbox.retryDelayMs(st, ra, 0) : 60000);

  if (presignBusy) {
    if (await park(busyLine(), holdUntil(presignBusy.status, presignBusy.retryAfter))) return;
    $('submit-status').textContent = T('observe.server-busy-try-again', 'Hawkeye is busy — try again in a minute.');
    $('btn-submit').disabled = false;
    return;
  }

  let status, body, retryAfter;
  try {
    ({ status, body, retryAfter } = await post());
  } catch {
    // Network failure: queue it and flush on reconnect (offline outbox).
    if (await park(T('observe.saved-offline', 'Saved offline — your signed report sends automatically when you are back online.'))) return;
    $('submit-status').textContent = T('observe.you-appear-to-be-offline-check-your', 'You appear to be offline — check your connection and try again.');
    $('btn-submit').disabled = false;
    return;
  }
  // ANY 401 (expired, unknown observer after a server reset, device mismatch…)
  // = dead session. Silently re-mint via resume and retry the same submission
  // once; only if that fails does the user get sent back to verification.
  if (status === 401) {
    localStorage.removeItem('hawkeye_token');
    $('submit-status').textContent = T('observe.refreshing-your-session', 'Refreshing your session…');
    if (await tryResume()) ({ status, body, retryAfter } = await post());
  }
  if (status === 401) {
    /* KEEP THE SIGNED REPORT. The report is signed over its exact bytes and
       only the session died, so it goes to the outbox — which holds 401s until
       this device signs in again — exactly as native's submit does. When the
       reason is a sign-in on another device (D3), the sign-in pane says so and
       counts what is waiting. */
    const elsewhere = (body && body.error === 'signed_in_elsewhere') || signedOutElsewhere();
    if (elsewhere) markSignedOutElsewhere();
    const kept = await park(elsewhere
      ? T('auth.report-kept-elsewhere', 'You were signed out because this account signed in on another device. Your signed report is saved on this phone and sends when you sign in here again.')
      : T('auth.report-kept-signed-out', 'You are signed out. Your signed report is saved on this phone and sends when you sign in again.'));
    if (kept && !elsewhere) return;
    if (!kept) $('submit-status').textContent = T('observe.session-expired-verify-your-phone-again-to', 'Session expired — verify your phone again to submit.');
    resetAuthPane();
    show('screen-register');
    paintElsewhere();
    return;
  }
  // D1: the answer changed between presign and submit (a dissent landed, or
  // this server cannot hold a byte-less report). The photos never left the
  // phone, so upload them the ordinary way and send the same signed report.
  if (hashOnly && status === 409 && body && body.error === 'photo_not_uploaded') {
    await planUpload(false);
    if (presignBusy) {
      if (await park(busyLine(), holdUntil(presignBusy.status, presignBusy.retryAfter))) return;
      $('submit-status').textContent = T('observe.server-busy-try-again', 'Hawkeye is busy — try again in a minute.');
      $('btn-submit').disabled = false;
      return;
    }
    try {
      ({ status, body, retryAfter } = await post());
    } catch {
      if (await park(T('observe.saved-offline', 'Saved offline — your signed report sends automatically when you are back online.'))) return;
      $('submit-status').textContent = T('observe.you-appear-to-be-offline-check-your', 'You appear to be offline — check your connection and try again.');
      $('btn-submit').disabled = false;
      return;
    }
  }
  // The report is fine, the server is not (busy 503, rate-limited 429, down,
  // timed out): exactly the class the outbox retries — native has queued these
  // all along — so park it rather than ask the observer to keep tapping Submit.
  if (status >= 500 || status === 408 || status === 425 || status === 429) {
    const ra = retryAfter || (body && body.retryAfterS != null ? String(body.retryAfterS) : null);
    if (await park(busyLine(), holdUntil(status, ra))) return;
  }
  if (status !== 201) {
    $('submit-status').textContent = explain(body);
    $('btn-submit').disabled = false;
    return;
  }

  keepCopies();
  const r = body.result;
  // KEPT, NOT COUNTED (backend services/deviceClaims.js): another account
  // already reported from this phone this election. The report is on the
  // ledger, but the unit's result describes OTHER reports — or is null when
  // none count — so this receipt shows the observer's own figures and says why.
  if (body.counted === false || !r) {
    const name = (contests.find((c) => c.code === contest) || {}).name || contest;
    $('entry-hash').textContent = body.entryHash || '';
    $('result-summary').innerHTML = `
      <p><strong>${selectedPu.name}</strong> — ${name}</p>
      ${body.counted === false ? `<p class="hint">${T('observe.device-owned-not-counted', 'This phone was already used by another account this election, so this report is kept for review but not counted.')}</p>` : ''}
      ${body.photosOnDevice ? `<p class="hint">${T('observe.photos-kept-as-evidence', 'Your photos were kept on this phone as evidence.')}</p>` : ''}
      <ul>${votes.filter((v) => v.count > 0).map((v) => `<li>${v.party}: ${v.count}</li>`).join('')}</ul>`;
    $('receipt-wrap').hidden = true;
    showReceipt(receiptData(name, votes, body.entryHash || ''));
    show('screen-result');
    return;
  }
  const locLabel =
    r.locationStatus === 'verified'
      ? tierLabel('verified')
      : r.locationStatus === 'provisional'
        ? `${tierLabel('crowd')} ${T('common.pct-of-reports-agree', '({v0}% of reports agree)', { v0: r.locationConfidence })}`
        : tierLabel('unmapped');
  // One whole phrase per count — never "pair(s)", and never an English "s".
  const venueLabel = r.venueMatches > 0
    ? ' · ' + (r.venueMatches === 1
      ? T('common.venue-photo-pair-matches-one', '🏫 {v0} venue photo pair matches', { v0: r.venueMatches })
      : T('common.venue-photo-pairs-match', '🏫 {v0} venue photo pairs match', { v0: r.venueMatches }))
    : '';
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
    ${body.photosOnDevice ? `<p class="hint">${T('observe.photos-kept-as-evidence', 'Your photos were kept on this phone as evidence.')}</p>` : ''}
    <ul>${r.votes.filter((v) => v.count > 0).map((v) => `<li>${v.party}: ${v.count}</li>`).join('')}</ul>`;
  $('receipt-wrap').hidden = true;
  showReceipt(receiptData(contestName, r.votes, body.entryHash));
  show('screen-result');
};

/**
 * THE OBSERVER'S OWN COPY, drawn and shown.
 *
 * Called from BOTH hand-off points — the 201 and the offline queue — because a
 * report that is waiting to send is still a report the person filed, and the
 * one moment they will look at a receipt is right after doing the work. The
 * card itself decides what it can claim: with no entry hash it prints no hash
 * and no verify link and says it is not on the ledger yet (see receipt.js).
 *
 * NEVER THROWS INTO THE SUBMIT PATH. A receipt is the nicest thing on this
 * screen and the least important; a canvas that fails must not turn an accepted
 * report into an error.
 */
let receiptBlob = null;
async function showReceipt(data) {
  /**
   * IT SAVES WITH THE PHOTOS, at the same hand-off and under the same switch.
   *
   * The two sheet photos already copy themselves to the phone the moment a
   * report is accepted; making the CARD the one artefact that needs a button
   * is an inconsistency the observer has to discover, and it is the item most
   * likely to be forwarded — friction there defeats the point of having it.
   * receipt.js show() does the drawing, the saving and the note, the same for
   * this page, collation.html and incidents.html.
   */
  try {
    const R = window.HAWKEYE_RECEIPT;
    if (!R || !R.show) return;
    receiptBlob = await R.show(data, { wrap: $('receipt-wrap'), img: $('receipt-img'), note: $('receipt-note'), tag: 'receipt' }, T);
  } catch { /* a report is not worth failing over a picture of itself */ }
}

/** The report data a receipt is drawn from, from whichever hand-off has it. */
function receiptData(contestName, votes, entryHash) {
  return {
    puName: selectedPu && selectedPu.name,
    puCode: selectedPu && selectedPu.pu_code,
    ward: selectedPu && selectedPu.ward,
    lga: selectedPu && selectedPu.lga,
    state: selectedPu && selectedPu.state,
    contest: contestName,
    votes: votes,
    entryHash: entryHash,
    at: Date.now(),
  };
}

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
      clearSignedOutElsewhere();
  // Register for push NOW. initPush ran once at launch and never again,
  // so signing in afterwards left this install permanently unregistered —
  // no token, no server row, and nothing anywhere said so.
  try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
      return true;
    }
    // This device was the account's until another device signed in (D3).
    if (body && body.signedInElsewhere) markSignedOutElsewhere();
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
      HAWKEYE_ALERT(T('observe.no-counts-entered', 'No counts entered'), rows
        ? T('observe.no-counts-entered-body', 'Type the votes each party was announced to have, then tap Verify counts again.')
        : T('observe.party-list-not-loaded-body', 'The party list could not be loaded. Close and reopen the report to try again.'));
    } else { $('submit-status').textContent = T('observe.enter-at-least-one-party-count', 'Enter at least one party count.'); }
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
    paintElsewhere();
  };
  /* The auth screen's copy is painted by JS, and T() resolves when it is called.
     Without this, switching language on this page moves every keyed element in
     the markup and leaves the sign-in title, lede, button and hint in the old
     one. i18n.js dispatches 'hawkeye-lang' immediately after its apply() pass,
     so re-running the painters here always wins. */
  document.addEventListener('hawkeye-lang', () => {
    if (document.getElementById('screen-register')?.hidden === false) {
      applyIntentCopy();
      applySignUpMode();
      applySignInMode();
      /* The primary button is painted by resetAuthPane(), which this listener
         must NOT call — it clears the number the reader has already typed. So
         repaint just the button, from the mode it is already in. */
      const b = $('btn-auth');
      if (b) {
        b.textContent = authMode === 'otp'
          ? T('observe.verify-otp', 'Verify OTP')
          : authMode === 'password'
            ? T('observe.sign-in', 'Sign In')
            : orgCodeTyped()
              ? T('auth.org-create-account', 'Create account')
              : T('observe.request-otp', 'Request OTP');
      }
      // Waiting on a WhatsApp code: the mode painters above re-showed the
      // sign-up fields, so hide them again and repaint the panel's own lines.
      if (authMode === 'wa' && wa) {
        showWaPane(true);
        $('wa-body').textContent = WA_BODY();
        if (wa.number) $('wa-number').textContent = T('auth.wa-number', 'Or send the code yourself to {number}.', { number: wa.number });
        if (wa.deadline) waStatus(WA_WAITING(), true);
        else waStatus(T('auth.wa-expired', 'This code has expired. Start again for a new one.'));
      }
      paintElsewhere();
    }
  });

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
  btn.textContent = T('observe.continue-with-telegram-no-code-needed', '✈️ Continue with Telegram — no code needed');
  btn.style.cssText = 'background:#2aabee;box-shadow:0 4px 14px rgba(42,171,238,.35);margin:0 0 4px';
  const or = document.createElement('p');
  or.className = 'hint';
  or.style.cssText = 'text-align:center;margin:8px 0 2px';
  or.textContent = T('observe.or-sign-in-with-sms', '— or sign in with SMS —');
  label.parentNode.insertBefore(btn, label);
  label.parentNode.insertBefore(or, label);
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = T('observe.waiting-for-telegram', 'Waiting for Telegram…');
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
      clearSignedOutElsewhere();
  // Register for push NOW. initPush ran once at launch and never again,
  // so signing in afterwards left this install permanently unregistered —
  // no token, no server row, and nothing anywhere said so.
  try { window.HAWKEYE && window.HAWKEYE.initPush && window.HAWKEYE.initPush().catch(() => {}); } catch {}
      // Passed through for when /telegram-verify reports isNew; today it does
      // not, so a Telegram sign-up keeps the old routing.
      afterVerified(body.isNew === true || body.needsUnit === true);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = T('observe.continue-with-telegram-no-code-needed', '✈️ Continue with Telegram — no code needed');
      hkAlert(T('observe.telegram-sign-in-failed', 'Telegram sign-in did not complete — you can use the SMS option below.'));
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

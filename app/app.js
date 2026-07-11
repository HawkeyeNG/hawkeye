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
function show(screenId) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== screenId;
  window.scrollTo(0, 0); // each screen starts at the top, not the old scroll pos
}
let lastFix = null; // most recent successful GPS fix
function getPosition() {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastFix = pos;
        resolve(pos);
      },
      reject,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    ),
  );
}
// Capture-time fix: fast (accepts a <30 s old reading), falls back to the last
// known fix — each photo gets GPS-stamped the moment it is taken.
async function getCaptureFix() {
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
const ERRORS = {
  outside_geofence: 'You are too far from this polling unit to report it.',
  too_far_from_unit: 'You are too far from this polling unit — report only while standing there.',
  sms_send_failed: 'Could not send the SMS code — check the number and try again.',
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
};
const explain = (body) => body.hint || ERRORS[body.error] || body.error || 'Something went wrong.';

// Mirror of backend/src/services/scope.js — the polling unit determines the race.
// The FCT has an appointed minister: no governorship, no state assembly.
const stateLabel = (s) => (s === 'FCT' ? 'the FCT' : `${s} State`);
const contestApplies = (u, contest) =>
  !(u.state === 'FCT' && (contest === 'GOV' || contest === 'SHA'));
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
function updateScopeNotice() {
  if (!selectedPu) return;
  const contest = $('sel-contest').value;
  const c = contests.find((x) => x.code === contest);
  const when = c?.date
    ? ` · ${new Date(c.date + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`
    : '';
  $('contest-scope').textContent = contest
    ? `You are reporting: ${contestScope(selectedPu, contest)}${c?.election ? ` — ${c.election}${when}` : ''}`
    : 'Choose which election you are reporting before continuing.';
}

const TIER_LABEL = {
  verified: '📍 location verified',
  crowd: '◌ crowd-confirmed location',
  geocoded: '◌ located from map data (unconfirmed)',
  unmapped: '⚠ location not yet verified',
};
const tierOf = (u) =>
  u.locationTier || (u.lat != null ? 'verified' : u.crowd_lat != null ? 'crowd' : 'unmapped');

// ---------- state ----------
let selectedPu = null;
let parties = [];
let contests = [];
let logos = null; // party code -> official emblem path (logos/manifest.json)
let cameraStream = null;
let cameraTarget = null; // 'sheet' | 'venue'
const shots = { sheet: null, venue: null }; // { blob, capturedAt }

// ---------- registration (single pane: phone first, then OTP in the same input) ----------
let authMode = 'phone';
let pendingPhone = '';

// Why the user is registering, from the CTA (?intent=observe|map|incident).
// Drives the verification heading and where we send them once verified.
const AUTH_INTENT = new URLSearchParams(location.search).get('intent') || 'observe';
const INTENT_LABEL = { observe: 'Become an Observer', map: 'Map a Polling Unit', incident: 'Report an Incident' };
const INTENT_DEST = { map: 'map-unit.html', incident: 'incidents.html' };

// Telegram hybrid /report handoff: PU + votes were chosen in chat; prefill and
// jump straight to the live-capture screen (the photo + signature must happen here).
const QP = new URLSearchParams(location.search);
const PREFILL = (QP.get('pu') && QP.get('contest')) ? {
  pu: QP.get('pu'), contest: QP.get('contest'),
  votes: (() => { try { return JSON.parse(QP.get('votes') || '[]'); } catch { return []; } })(),
} : null;
function applyIntentCopy() {
  const label = INTENT_LABEL[AUTH_INTENT];
  if (!label) return;
  const note = $('intent-note');
  if (note) {
    note.textContent = `To ${label}, register your device below.`;
    note.hidden = false;
  }
}
function afterVerified() {
  if (INTENT_DEST[AUTH_INTENT]) { location.href = INTENT_DEST[AUTH_INTENT]; return; }
  show('screen-locate');
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
}

$('btn-auth').onclick = async () => {
  const input = $('auth-input');

  if (authMode === 'phone') {
    const phone = input.value.trim();
    const { status, body } = await api('/api/observers/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    if (status !== 200) return alert(explain(body));
    // same pane flips to OTP entry
    pendingPhone = phone;
    authMode = 'otp';
    input.value = '';
    input.placeholder = 'Enter OTP';
    input.inputMode = 'numeric';
    $('btn-auth').textContent = 'Verify OTP';
    $('auth-reset').hidden = false;
    if (body.telegramLink) {
      // The bot can only message a user who has opened it, so send them straight
      // there. In the chat they tap Start → Share contact, and the bot replies
      // with the code immediately (future codes then arrive automatically).
      $('otp-hint').innerHTML =
        `<a class="btn-link" id="tg-open" href="${body.telegramLink}" target="_blank" rel="noopener">📨 Open the Telegram bot to get your code</a>
         <span>You'll be taken to our Telegram bot. Tap <strong>Start</strong>, then <strong>Share my phone number</strong> — your code appears in the chat instantly. Come back here and enter it below.</span>`;
      // Auto-launch the bot (a fresh gesture-linked anchor click dodges popup blockers).
      $('tg-open').click();
    } else if (body.viaTelegram) {
      $('otp-hint').textContent = 'Code sent to your Telegram.';
    } else {
      $('otp-hint').textContent = body.devOtp
        ? `DEV MODE — your code is ${body.devOtp}`
        : 'Code sent by SMS.';
    }
    return;
  }

  const pair = await ensureKeys();
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const { status, body } = await api('/api/observers/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: pendingPhone, otp: input.value.trim(), publicKeyJwk }),
  });
  if (status !== 200) return alert(explain(body));
  localStorage.setItem('hawkeye_token', body.token);
  resetAuthPane();
  afterVerified();
};

$('auth-reset').onclick = (e) => {
  e.preventDefault();
  resetAuthPane();
};

// ---------- locate: geofenced discovery ----------
$('btn-locate').onclick = async () => {
  $('locate-status').textContent = 'Getting your location…';
  $('pu-list').innerHTML = '';
  let pos;
  try {
    pos = await getPosition();
  } catch {
    $('locate-status').textContent = 'Location denied or unavailable. Hawkeye cannot work without it.';
    return;
  }
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  $('locate-status').textContent = `Location fixed (±${Math.round(accuracy)} m). Looking up nearby units…`;
  const { body } = await api(`/api/polling-units?lat=${lat}&lng=${lng}`);
  if (!body.units || body.units.length === 0) {
    $('locate-status').textContent =
      `No mapped polling unit within ${body.radiusM || 200} m — use "Browse the register" below.`;
    $('browse-block').open = true;
    return;
  }
  $('locate-status').textContent = 'Select the unit you are standing at:';
  for (const u of body.units) {
    const btn = document.createElement('button');
    btn.className = 'pu-option';
    btn.innerHTML = `<strong>${u.name}</strong><br />
      <small>${u.pu_code} · ${u.ward}, ${u.lga} · ${u.distanceM} m away · ${TIER_LABEL[tierOf(u)]}</small>`;
    btn.onclick = () => selectUnit(u);
    $('pu-list').appendChild(btn);
  }
};

// ---------- locate: register browse (units without coordinates) ----------
async function fillSelect(sel, items, placeholder) {
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    items.map((i) => `<option>${i}</option>`).join('');
  sel.disabled = items.length === 0;
}

$('browse-block').addEventListener('toggle', async () => {
  if ($('browse-block').open && $('sel-state').options.length <= 1) {
    const { body } = await api('/api/register/states');
    fillSelect($('sel-state'), body, '— select state —');
  }
});
$('sel-state').onchange = async () => {
  $('register-units').innerHTML = '';
  fillSelect($('sel-ward'), [], '— select —');
  const { body } = await api(`/api/register/lgas?state=${encodeURIComponent($('sel-state').value)}`);
  fillSelect($('sel-lga'), body, '— select LGA —');
};
$('sel-lga').onchange = async () => {
  $('register-units').innerHTML = '';
  const { body } = await api(
    `/api/register/wards?state=${encodeURIComponent($('sel-state').value)}&lga=${encodeURIComponent($('sel-lga').value)}`,
  );
  fillSelect($('sel-ward'), body, '— select ward —');
};
$('sel-ward').onchange = async () => {
  const { body } = await api(
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
async function selectUnit(u) {
  selectedPu = u;
  $('submit-pu-name').textContent = `${u.name} (${u.pu_code})`;
  const tier = tierOf(u);
  $('tier-notice').hidden = tier === 'verified';
  $('tier-notice').textContent =
    tier === 'crowd'
      ? '◌ This unit\'s location is crowd-confirmed, not yet officially verified.'
      : '⚠ This unit has no verified location. Your GPS position will be recorded with your report, and the result stays marked "location unverified" until independent reports from the same spot corroborate it.';
  if (parties.length === 0) parties = (await api('/api/parties')).body;
  if (contests.length === 0) contests = (await api('/api/contests')).body;
  if (logos === null) {
    logos = await fetch('logos/manifest.json').then((r) => r.json()).catch(() => ({}));
  }
  $('sel-contest').innerHTML = '<option value="">— Select election —</option>' + contests
    .filter((c) => contestApplies(selectedPu, c.code))
    .map((c) => `<option value="${c.code}">${c.name}</option>`)
    .join('');
  updateScopeNotice();
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
    wrap.appendChild(row);
  }
  shots.sheet = null;
  shots.venue = null;
  for (const t of ['sheet', 'venue']) {
    $(`preview-${t}`).hidden = true;
    $(`btn-cam-${t}`).textContent = 'Take photo';
  }
  updateSubmitState();
  $('submit-status').textContent = '';
  show('screen-submit');
}

// Prefill the submit screen from a Telegram chat handoff, then let the observer
// capture the live photos and sign as normal.
async function applyPrefill() {
  try {
    const { body } = await api(`/api/register/unit?pu_code=${encodeURIComponent(PREFILL.pu)}`);
    if (!body?.unit) { show('screen-locate'); return; }
    await selectUnit(body.unit);
    const sc = $('sel-contest');
    if (sc && [...sc.options].some((o) => o.value === PREFILL.contest)) sc.value = PREFILL.contest;
    updateScopeNotice();
    for (const v of PREFILL.votes) {
      const inp = document.querySelector(`#vote-inputs input[data-party="${v.party}"]`);
      if (inp && Number.isFinite(+v.count)) inp.value = v.count;
    }
    $('submit-status').textContent = 'Prefilled from Telegram — now capture the sheet & venue photos to finish.';
  } catch { show('screen-locate'); }
}

function updateSubmitState() {
  for (const t of ['sheet', 'venue']) {
    const badge = $(`status-${t}`);
    badge.textContent = shots[t] ? 'Captured ✓' : 'Required';
    badge.classList.toggle('done', Boolean(shots[t]));
  }
  $('btn-submit').disabled = !(shots.sheet && shots.venue);
}

// ---------- camera (live capture only; overlay opens per slot) ----------
const TARGET_LABELS = {
  sheet: { title: 'Results sheet (EC8A)', action: 'Capture EC8A' },
  venue: { title: 'Polling venue', action: 'Capture Polling Venue' },
};

function closeCamera() {
  if (window.DocScanner) DocScanner.stop();
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  $('camera-overlay').hidden = true;
}

async function startCapture(target) {
  cameraTarget = target;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 } },
      audio: false,
    });
  } catch {
    return alert('Camera access is required — Hawkeye only accepts live photos.');
  }
  $('camera-title').textContent = TARGET_LABELS[target].title;
  $('btn-capture').textContent = TARGET_LABELS[target].action;
  $('camera-overlay').hidden = false;
  const video = $('video');
  video.srcObject = cameraStream;
  await video.play();
  // Sheet capture gets Adobe-Scan-style document detection: live outline,
  // auto-capture when steady, perspective-corrected output (scan.js).
  if (target === 'sheet' && window.DocScanner) {
    DocScanner.start(video, $('scan-canvas'), $('scan-hint'), doCapture);
  }
}

$('btn-cam-sheet').onclick = () => (useNativeCam() ? nativeCapture('sheet') : startCapture('sheet'));
$('btn-cam-venue').onclick = () => (useNativeCam() ? nativeCapture('venue') : startCapture('venue'));
$('btn-cancel-camera').onclick = closeCamera;

let capturing = false;
// Downscale + recompress a freshly captured photo BEFORE it is hashed, signed and
// uploaded — so the compressed bytes are exactly what the observer signs, the server
// stores, and the ledger content-addresses (integrity stays intact; see submissions.js
// where image_sha256 = sha256 of these bytes). Phone cameras hand us 3–8 MB full-res
// JPEGs; an EC8A sheet stays fully legible at ~1600 px (our own OCR downsizes to 1600 px
// wide anyway), cutting each photo to a few hundred KB. Any failure returns the original
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
// require a GPS fix, then store + preview. Sheet kept crisper (1600 px / q0.8);
// venue smaller (1280 px / q0.72). Returns false if the GPS fix failed.
async function finalizeShot(target, blob) {
  blob = await compressCapture(blob, target === 'sheet' ? 1600 : 1280, target === 'sheet' ? 0.8 : 0.72);
  const fix = await getCaptureFix();
  if (!fix) {
    alert('No GPS fix — photos must be location-stamped. Move to open sky and retake.');
    return false;
  }
  shots[target] = { blob, capturedAt: Date.now(), lat: fix.coords.latitude, lng: fix.coords.longitude };
  const img = $(`preview-${target}`);
  img.src = URL.createObjectURL(blob);
  img.hidden = false;
  $(`btn-cam-${target}`).textContent = 'Retake photo';
  updateSubmitState();
  return true;
}

async function doCapture() {
  if (capturing || !cameraStream) return;
  capturing = true;
  try {
    let blob;
    if (cameraTarget === 'sheet' && window.DocScanner) {
      const scan = await DocScanner.capture();
      if (scan.warnings.length && !confirm(`${scan.warnings.join(' ')} Use this photo anyway?`)) {
        DocScanner.rearm();
        return;
      }
      blob = scan.blob;
    } else {
      const video = $('video');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    }
    const ok = await finalizeShot(cameraTarget, blob);
    if (!ok) { if (cameraTarget === 'sheet' && window.DocScanner) DocScanner.rearm(); return; }
    closeCamera();
  } finally {
    capturing = false;
  }
}
$('btn-capture').onclick = doCapture;

// Native shell: the OS camera (capture-only, no gallery) replaces the getUserMedia
// overlay entirely — tapping the capture button invokes it directly. Same
// finalizeShot tail, so the integrity pipeline is identical to web.
const useNativeCam = () => Boolean(window.HAWKEYE && window.HAWKEYE.native
  && window.HAWKEYE.capabilities && window.HAWKEYE.capabilities.camera);
async function nativeCapture(target) {
  if (capturing) return;
  capturing = true;
  cameraTarget = target;
  try {
    let blob;
    try { blob = await window.HAWKEYE.capturePhoto(); }
    catch { return; } // user cancelled / dismissed the OS camera
    await finalizeShot(target, blob);
  } finally {
    capturing = false;
  }
}

// ---------- submit ----------
$('btn-submit').onclick = async () => {
  if (!shots.sheet || !shots.venue || !selectedPu) return;
  if (!$('sel-contest').value) {
    $('submit-status').textContent = 'Select which election you are reporting.';
    $('sel-contest').focus();
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
  const post = () => api('/api/submissions', {
    method: 'POST',
    headers: { authorization: `Bearer ${localStorage.getItem('hawkeye_token')}` },
    body: form,
  });
  let { status, body } = await post();
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
  selectedPu = null;
  show('screen-locate');
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
      return true;
    }
  } catch { /* fall through to sign-up */ }
  return false;
}

// ---------- boot ----------
$('sel-contest').onchange = updateScopeNotice;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
(async () => {
  // Expired/corrupt tokens are dropped BEFORE deciding which screen to show —
  // never let a dead session masquerade as signed-in (resume re-mints silently).
  if (!tokenFresh()) {
    localStorage.removeItem('hawkeye_token');
    await tryResume();
  }
  if (localStorage.getItem('hawkeye_token')) {
    // Already registered — honour the CTA intent instead of re-verifying.
    if (PREFILL) applyPrefill();
    else if (INTENT_DEST[AUTH_INTENT]) location.href = INTENT_DEST[AUTH_INTENT];
    else show('screen-locate');
  } else {
    applyIntentCopy();
    show('screen-register');
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

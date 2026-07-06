// End-to-end exercise of the observer flow against a RUNNING server, doubling as
// a reference client. Covers tier-1 (geofenced) reporting, tier-2 (crowd-located)
// reporting, and the classic attacks — all of which must be rejected.
//
//   npm start            # terminal 1
//   npm run smoke        # terminal 2  (or: node scripts/smoke_test.js [baseUrl])
import crypto from 'node:crypto';
import sharp from 'sharp';

const BASE = process.argv[2] || 'http://127.0.0.1:8430';

// Tier-1 default: a real Lagos Island unit with (demo) verified coordinates.
// Override with SMOKE_PU="<pu_code>,<lat>,<lng>".
const PU = process.env.SMOKE_PU
  ? (([code, lat, lng]) => ({ code, lat: Number(lat), lng: Number(lng) }))(process.env.SMOKE_PU.split(','))
  : { code: '24-14-01-020', lat: 6.453, lng: 3.3866 };
const FAR_AWAY = { lat: PU.lat + 3, lng: PU.lng + 3 }; // ~470 km away, wherever PU is

// Tier-2: real register units (Delta, Ndokwa West) that have NO coordinates.
const PU_T2_CLUSTERED = { code: '10-12-01-033', lat: 5.93, lng: 6.42 };
const PU_T2_SCATTERED = { code: '10-12-01-030', lat: 5.93, lng: 6.42 };

// Mirrors backend/src/services/signatures.js (and app/app.js) exactly.
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
    puCode, contest, votes: canonicalVotes(votes), imageSha256, venueImageSha256, capturedAt, venueCapturedAt,
    lat, lng, sheetLat, sheetLng, venueLat, venueLng,
  });
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function makeObserverKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, publicKeyJwk: publicKey.export({ format: 'jwk' }) };
}

// Random-noise JPEG stands in for a camera capture; every photo is unique.
async function randomPhoto() {
  const w = 320;
  const h = 240;
  const raw = crypto.randomBytes(w * h * 3);
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
}

// Structured synthetic "venue" (random rectangles) — ORB-matchable across rotations,
// standing in for photos of the same building from different angles.
const rand = (n) => Math.floor(Math.random() * n);
async function randomVenueScene() {
  let shapes = '';
  for (let i = 0; i < 40; i++) {
    shapes += `<rect x="${rand(640)}" y="${rand(480)}" width="${20 + rand(120)}" height="${20 + rand(120)}"
      fill="rgb(${rand(255)},${rand(255)},${rand(255)})"/>`;
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
      <rect width="100%" height="100%" fill="#8a8a8a"/>${shapes}</svg>`,
  );
  return sharp(svg).jpeg().toBuffer();
}

async function registerObserver(phone) {
  // one distinct device fingerprint per smoke observer (mirrors app/device.js)
  const deviceId = crypto.createHash('sha256').update('smoke-device:' + phone).digest('hex');
  const reg = await api('/api/observers/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!reg.body.devOtp) throw new Error('register failed: ' + JSON.stringify(reg));
  const keys = makeObserverKeys();
  const ver = await api('/api/observers/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-id': deviceId },
    body: JSON.stringify({ phone, otp: reg.body.devOtp, publicKeyJwk: keys.publicKeyJwk }),
  });
  if (!ver.body.token) throw new Error('verify failed: ' + JSON.stringify(ver));
  return { ...keys, token: ver.body.token, id: ver.body.observerId, deviceId };
}

// One submission. opts: puCode, at {lat,lng}, jitterDeg, sheet, venue,
// capturedAt, venueCapturedAt, signVotes (sign different votes than sent).
async function submit(observer, votes, opts = {}) {
  const at = opts.at || PU;
  const jitter = opts.jitterDeg ?? 0.0003; // ~±15 m
  const lat = at.lat + (Math.random() - 0.5) * jitter;
  const lng = at.lng + (Math.random() - 0.5) * jitter;
  const sheet = opts.sheet || (await randomPhoto());
  const venue = opts.venue || (await randomPhoto());
  const capturedAt = opts.capturedAt ?? Date.now();
  const venueCapturedAt = opts.venueCapturedAt ?? Date.now();
  const puCode = opts.puCode || PU.code;
  const contest = opts.contest || 'PRES';
  // capture-time GPS stamps: tiny jitter around the submission fix unless overridden
  const sheetLat = opts.sheetAt?.lat ?? lat + (Math.random() - 0.5) * 0.0002;
  const sheetLng = opts.sheetAt?.lng ?? lng + (Math.random() - 0.5) * 0.0002;
  const venueLat = opts.venueAt?.lat ?? lat + (Math.random() - 0.5) * 0.0002;
  const venueLng = opts.venueAt?.lng ?? lng + (Math.random() - 0.5) * 0.0002;
  const imageSha256 = crypto.createHash('sha256').update(sheet).digest('hex');
  const venueImageSha256 = crypto.createHash('sha256').update(venue).digest('hex');
  const payload = canonicalPayload({
    puCode, contest, votes: opts.signVotes || votes, imageSha256, venueImageSha256, capturedAt, venueCapturedAt,
    lat, lng, sheetLat, sheetLng, venueLat, venueLng,
  });
  const signature = crypto
    .sign('sha256', Buffer.from(payload), { key: observer.privateKey, dsaEncoding: 'ieee-p1363' })
    .toString('base64');

  const form = new FormData();
  form.set('puCode', puCode);
  form.set('contest', contest);
  form.set('votes', JSON.stringify(votes));
  form.set('lat', String(lat));
  form.set('lng', String(lng));
  form.set('accuracy', '12');
  form.set('capturedAt', String(capturedAt));
  form.set('venueCapturedAt', String(venueCapturedAt));
  form.set('sheetLat', String(sheetLat));
  form.set('sheetLng', String(sheetLng));
  form.set('venueLat', String(venueLat));
  form.set('venueLng', String(venueLng));
  form.set('signature', signature);
  form.set('photo', new Blob([sheet], { type: 'image/jpeg' }), 'ec8a.jpg');
  form.set('venuePhoto', new Blob([venue], { type: 'image/jpeg' }), 'venue.jpg');
  return api('/api/submissions', {
    method: 'POST',
    headers: { authorization: `Bearer ${observer.token}`, ...(observer.deviceId ? { 'x-device-id': observer.deviceId } : {}) },
    body: form,
  });
}

const consensus = canonicalVotes([
  { party: 'APC', count: 120 },
  { party: 'PDP', count: 95 },
  { party: 'LP', count: 143 },
  { party: 'NNPP', count: 12 },
]);
const fabricated = canonicalVotes([
  { party: 'APC', count: 220 },
  { party: 'PDP', count: 95 },
  { party: 'LP', count: 43 },
  { party: 'NNPP', count: 12 },
]);

const expect = (label, cond) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}`);
  if (!cond) process.exitCode = 1;
};

console.log(`Hawkeye smoke test against ${BASE}\n`);
const health = await api('/api/health');
if (!health.body.ok) throw new Error('server not reachable — start it with: npm start');

const observers = [];
for (let i = 0; i < 13; i++) observers.push(await registerObserver(`+2348012345${600 + i}`));
console.log(`registered ${observers.length} observers\n`);

// Approximate locations (GRID3 ward/school data) for the tier-2 units, fetched
// from the register so the "honest" cluster lands where the unit plausibly is.
const regUnits =
  (await api('/api/register/units?state=Delta&lga=' + encodeURIComponent('Ndokwa West') + '&ward=' + encodeURIComponent('Utagba Ogbe'))).body.units || [];
const infoOf = (code) => regUnits.find((u) => u.pu_code === code) || {};

const sheets = [await randomPhoto(), await randomPhoto(), await randomPhoto()];

console.log('-- tier 1: geofenced unit, honest + conflicting reports --');
const r1 = await submit(observers[0], consensus, { sheet: sheets[0] });
expect('observer 1 (honest) accepted, location verified, confidence 100%',
  r1.status === 201 && r1.body.locationVerified === true && r1.body.result.confidence === 100
  && r1.body.result.locationStatus === 'verified');
const r2 = await submit(observers[1], consensus, { sheet: sheets[1] });
expect('observer 2 (honest) accepted, confidence 100%', r2.status === 201 && r2.body.result.confidence === 100);
const r3 = await submit(observers[2], fabricated, { sheet: sheets[2] });
expect('observer 3 (conflicting) accepted -> disputed, ~66.7%',
  r3.status === 201 && r3.body.result.status === 'disputed' && Math.abs(r3.body.result.confidence - 66.7) < 0.2);

console.log('\n-- multi-contest: same observer, same unit, different election --');
const gov = await submit(observers[0], consensus, { contest: 'GOV' });
expect('observer 1 also reports GOVERNORSHIP from the same unit',
  gov.status === 201 && gov.body.result.contest === 'GOV' && gov.body.result.totalReports === 1);
expect(`race auto-resolved from the unit: "${gov.body.result.scope}"`,
  gov.body.result.scope === 'Lagos State Governorship');
const senInfo = (await api('/api/register/units?state=Lagos&lga=' + encodeURIComponent('Lagos Island') + '&ward=' + encodeURIComponent('Olowogbowo/Elegbata'))).body.units?.[0];
expect(`register rows carry senatorial + federal constituency ("${senInfo?.senatorial}" / "${senInfo?.federal_constituency}")`,
  Boolean(senInfo?.senatorial && senInfo?.federal_constituency));
const govAgain = await submit(observers[0], consensus, { contest: 'GOV' });
expect(`second GOV report from observer 1 -> ${govAgain.body.error}`,
  govAgain.status === 409 && govAgain.body.error === 'already_submitted');
const presUnchanged = await api(`/api/results/${PU.code}?contest=PRES`);
expect('presidential tally unaffected by governorship report',
  presUnchanged.body.totalReports === 3);

// FCT rules: state string fully capitalized; no governorship contest exists there
const fctLgas = (await api('/api/register/lgas?state=FCT')).body;
expect(`FCT state string is fully capitalized (${(fctLgas || []).length} LGAs found)`,
  Array.isArray(fctLgas) && fctLgas.length > 0);
const fctWards = (await api(`/api/register/wards?state=FCT&lga=${encodeURIComponent(fctLgas[0])}`)).body;
const fctUnit = (await api(`/api/register/units?state=FCT&lga=${encodeURIComponent(fctLgas[0])}&ward=${encodeURIComponent(fctWards[0])}`)).body.units?.[0];
const fctGov = await submit(observers[3], consensus, {
  puCode: fctUnit.pu_code, contest: 'GOV', at: { lat: 9.05, lng: 7.49 },
});
expect(`governorship report for an FCT unit -> ${fctGov.body.error}`,
  fctGov.status === 400 && fctGov.body.error === 'contest_not_applicable');

console.log('\n-- tier 2: unit without coordinates, observers clustered --');
// The three observers photograph the SAME venue from different angles (rotated
// views of one synthetic scene) — ORB should confirm the pairs.
const venueScene = await randomVenueScene();
const venueViews = [
  venueScene,
  await sharp(venueScene).rotate(15).jpeg().toBuffer(),
  await sharp(venueScene).rotate(-12).jpeg().toBuffer(),
];
const t2Info = infoOf(PU_T2_CLUSTERED.code);
const t2Base = t2Info.approx_lat != null ? { lat: t2Info.approx_lat, lng: t2Info.approx_lng } : PU_T2_CLUSTERED;
let last;
for (const [k, i] of [4, 5, 6].entries()) {
  last = await submit(observers[i], consensus, {
    puCode: PU_T2_CLUSTERED.code, at: t2Base, jitterDeg: 0.001, venue: venueViews[k],
  });
}
expect('3 clustered reports -> location provisional, votes verified',
  last.status === 201 && last.body.locationVerified === false
  && last.body.result.locationStatus === 'provisional' && last.body.result.status === 'verified');
expect(`cluster consistent with approx envelope (${last.body.result.locationPlausibility})`,
  last.body.result.locationPlausibility !== 'inconsistent');
expect(`fused location evidence score ${last.body.result.locationScore}/100 (GPS+landmark+venue photos)`,
  last.body.result.locationScore >= 60);
expect(`ORB confirmed same-venue photo pairs (${last.body.result.venueMatches})`,
  last.body.result.venueMatches >= 2);

const discovered = await api(`/api/polling-units?lat=${t2Base.lat}&lng=${t2Base.lng}`);
expect('crowd-located unit now appears in geofenced discovery (tier crowd)',
  (discovered.body.units || []).some((u) => u.pu_code === PU_T2_CLUSTERED.code && u.locationTier === 'crowd'));

console.log('\n-- tier 2: unit without coordinates, observers scattered ~5 km --');
for (const i of [7, 8, 9]) {
  last = await submit(observers[i], consensus, { puCode: PU_T2_SCATTERED.code, at: PU_T2_SCATTERED, jitterDeg: 0.09 });
}
expect('3 matching votes but scattered GPS -> location unverified, status capped at reported',
  last.status === 201 && last.body.result.locationStatus === 'unverified' && last.body.result.status === 'reported');
expect(`unrelated venue photos do NOT match (${last.body.result.venueMatches})`,
  last.body.result.venueMatches === 0);

// Colluders planting a coherent cluster ~78 km from where the unit can plausibly
// be (outside its GRID3 ward/school envelope) — must NOT earn provisional status.
const plantUnit = regUnits.find(
  (u) => u.approx_lat != null && u.pu_code !== PU_T2_CLUSTERED.code && u.pu_code !== PU_T2_SCATTERED.code,
);
let planted = false;
if (plantUnit) {
  console.log('\n-- tier 2: colluding cluster planted far outside the approx envelope --');
  const farBase = { lat: plantUnit.approx_lat + 0.7, lng: plantUnit.approx_lng };
  for (const i of [10, 11, 12]) {
    last = await submit(observers[i], consensus, { puCode: plantUnit.pu_code, at: farBase, jitterDeg: 0.001 });
  }
  expect(`planted cluster -> ${last.body.result.locationStatus}/${last.body.result.locationPlausibility}, status ${last.body.result.status}`,
    last.status === 201 && last.body.result.locationStatus === 'unverified'
    && last.body.result.locationPlausibility === 'inconsistent' && last.body.result.status === 'reported');
  expect(`planted cluster location evidence score is 0 (${last.body.result.locationScore})`,
    last.body.result.locationScore === 0);
  planted = true;
} else {
  console.log('\n(skipping planted-cluster case — no approximate locations loaded)');
}

console.log('\n-- attacks (all must be rejected) --');
const replaySheet = await submit(observers[3], fabricated, { sheet: sheets[0] });
expect(`replaying observer 1's sheet photo -> ${replaySheet.body.error}`,
  replaySheet.status === 409 && replaySheet.body.error === 'duplicate_image');

const replayVenue = await submit(observers[3], fabricated, { venue: sheets[0] });
expect(`reusing a stored sheet photo as venue photo -> ${replayVenue.body.error}`,
  replayVenue.status === 409 && replayVenue.body.error === 'duplicate_image');

const double = await submit(observers[0], consensus, {});
expect(`observer 1 submitting twice -> ${double.body.error}`,
  double.status === 409 && double.body.error === 'already_submitted');

// multi-SIM sybil: fresh account, but observer 1's DEVICE reports the same race
const sybil = await registerObserver('+2348000009999');
const sybilRes = await submit({ ...sybil, deviceId: observers[0].deviceId }, fabricated, {});
expect(`second account on the same device, same race -> ${sybilRes.body.error}`,
  sybilRes.status === 409 && sybilRes.body.error === 'device_already_reported_race');

const noDevice = await submit({ ...sybil, deviceId: undefined }, fabricated, {});
expect(`submission without a device fingerprint -> ${noDevice.body.error}`,
  noDevice.status === 400 && noDevice.body.error === 'device_required');

const remote = await submit(observers[3], fabricated, { at: FAR_AWAY });
expect(`reporting the geofenced Lagos PU from ${Math.round(3 * 157)} km away -> ${remote.body.error}`,
  remote.status === 403 && remote.body.error === 'outside_geofence');

const staleSheet = await submit(observers[3], fabricated, { capturedAt: Date.now() - 3 * 3600_000 });
expect(`3-hour-old sheet photo -> ${staleSheet.body.error}`,
  staleSheet.status === 400 && staleSheet.body.error === 'photo_not_fresh');

const staleVenue = await submit(observers[3], fabricated, { venueCapturedAt: Date.now() - 3 * 3600_000 });
expect(`3-hour-old venue photo -> ${staleVenue.body.error}`,
  staleVenue.status === 400 && staleVenue.body.error === 'photo_not_fresh');

const tampered = await submit(observers[3], fabricated, { signVotes: consensus });
expect(`votes swapped after signing -> ${tampered.body.error}`,
  tampered.status === 401 && tampered.body.error === 'bad_signature');

// venue photo GPS-stamped ~5.5 km from the submission fix — photographed elsewhere
const elsewhere = await submit(observers[3], fabricated, {
  venueAt: { lat: PU.lat + 0.05, lng: PU.lng },
});
expect(`venue photo captured 5.5 km away -> ${elsewhere.body.error}`,
  elsewhere.status === 403 && elsewhere.body.error === 'photo_location_mismatch');

console.log('\n-- final state --');
const result = await api(`/api/results/${PU.code}`);
console.log('  tier-1 result:', JSON.stringify(result.body));
const t2 = await api(`/api/results/${PU_T2_CLUSTERED.code}`);
console.log('  tier-2 result:', JSON.stringify(t2.body));
const coverage = await api('/api/coverage');
console.log('  coverage:', JSON.stringify(coverage.body));
const natl = await api('/api/national/PRES');
console.log('  national PRES:', JSON.stringify(natl.body.national), 'states:', natl.body.states.length);
expect('national leaderboard aggregates votes and state leaders',
  natl.body.national.length > 0 && natl.body.states.every((s) => s.leader));
const ledger = await api('/api/ledger/verify');
console.log('  ledger:', JSON.stringify(ledger.body));
const expectedEntries = planted ? 13 : 10;
expect(`ledger chain verifies with ${expectedEntries} entries`,
  ledger.body.ok === true && ledger.body.entries === expectedEntries);

console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nAll smoke tests passed.');

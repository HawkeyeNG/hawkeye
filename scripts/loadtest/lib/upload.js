// REPORT UPLOAD: the observer's real path in direct mode.
//   1. POST /api/uploads/presign   (hashes + sizes, origin)
//   2. PUT sheet + venue to R2      (presigned; bytes never touch the origin)
//   3. POST /api/submissions        (JSON: hashes, votes, GPS, ECDSA signature)
// UPLOAD_PATH=proxy sends multipart to /api/submissions instead, which measures
// kill switch KS-6 (the fallback) and the CPU it costs.
//
// Test data only: seeded observers (is_staff=1, phone_hash "loadtest:*") on a
// STAGING database whose PRES/SEN/REP dates were set to the test day. Photos are
// synthetic JPEGs (seed/make_sample_jpegs.mjs) given NEW PIXELS per report by
// lib/jpeg.js, so both the sha256 and the dhash near-duplicate checks see
// distinct images.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { sha256 } from 'k6/crypto';
import { b64decode, b64encode } from 'k6/encoding';
import { headers, url, noteResponse, reportOk, reportLatency } from './common.js';
import { uploadPool, parties } from './fixtures.js';
import { parseTemplate, uniqueJpeg } from './jpeg.js';

const MODE = String(__ENV.UPLOAD_PATH || 'direct');
const RACES = ['PRES', 'SEN', 'REP'];

// Templates are loaded in the init context only when the scenario needs them.
const SHEET = __ENV.SHEET_JPEG ? new Uint8Array(open(__ENV.SHEET_JPEG, 'b')) : null;
const VENUE = __ENV.VENUE_JPEG ? new Uint8Array(open(__ENV.VENUE_JPEG, 'b')) : null;
// Parsed once per VU. Every report then gets its own pixels (lib/jpeg.js): a
// comment-only change left the pixels identical, so the server's near-duplicate
// guard refused every proxy-path report after the first (409 near_duplicate_image).
let TPL_ERR = null;
const tpl = (b) => { try { return b ? parseTemplate(b) : null; } catch (e) { TPL_ERR = String(e.message || e); return null; } };
const SHEET_T = tpl(SHEET);
const VENUE_T = tpl(VENUE);

export function uploadPreflight() {
  if (!SHEET || !VENUE) return 'SHEET_JPEG and VENUE_JPEG (absolute paths) are required';
  if (SHEET[0] !== 0xff || SHEET[1] !== 0xd8 || VENUE[0] !== 0xff || VENUE[1] !== 0xd8) return 'templates must be JPEGs';
  if (!SHEET_T || !VENUE_T) return `templates unusable (${TPL_ERR}); regenerate them with seed/make_sample_jpegs.mjs`;
  if (!uploadPool.length) return 'no upload fixtures';
  if (!parties.length) return 'fixtures carry no party codes';
  if (!globalThis.crypto || !globalThis.crypto.subtle) return 'k6 >= 1.0 is required (global WebCrypto)';
  return null;
}

// MIRROR of backend/src/services/signatures.js canonicalPayload/canonicalVotes.
// Byte-identical or the server answers bad_signature.
function canonicalVotes(votes) {
  return votes
    .map((v) => ({ party: String(v.party), count: Number(v.count) }))
    .sort((a, b) => (a.party < b.party ? -1 : a.party > b.party ? 1 : 0));
}
function canonicalPayload(p) {
  return JSON.stringify({
    puCode: p.puCode, contest: p.contest, votes: canonicalVotes(p.votes),
    imageSha256: p.imageSha256, venueImageSha256: p.venueImageSha256,
    capturedAt: p.capturedAt, venueCapturedAt: p.venueCapturedAt,
    lat: p.lat, lng: p.lng, sheetLat: p.sheetLat, sheetLng: p.sheetLng,
    venueLat: p.venueLat, venueLng: p.venueLng,
  });
}

const keyCache = new Map(); // per VU: fixture index -> CryptoKey
async function signingKey(i, pkcs8B64) {
  if (!keyCache.has(i)) {
    const k = await crypto.subtle.importKey(
      'pkcs8', b64decode(pkcs8B64, 'std'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    );
    keyCache.set(i, k);
  }
  return keyCache.get(i);
}
function utf8(s) {
  // Payload is ASCII (hex, codes, numbers), so a byte per char is exact.
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b.buffer;
}

function randomVotes() {
  const n = Math.min(parties.length, 4 + Math.floor(Math.random() * 6));
  const start = Math.floor(Math.random() * parties.length);
  const out = [];
  for (let k = 0; k < n; k++) out.push({ party: parties[(start + k) % parties.length], count: Math.floor(Math.random() * 400) });
  return out;
}

export async function uploadIteration() {
  // Each seeded observer/device may file each race once; iteration i uses
  // fixture i mod N for race floor(i/N). Past 3N the pool is spent.
  const i = exec.scenario.iterationInTest;
  const N = uploadPool.length;
  if (i >= N * RACES.length) return; // pool exhausted: seed more (--count)
  const idx = i % N;
  const f = uploadPool[idx];
  const contest = RACES[Math.floor(i / N)];
  const auth = { authorization: `Bearer ${f.token}`, 'x-device-id': f.deviceId };
  const t0 = Date.now();

  const nonce = `loadtest:${exec.vu.idInTest}:${i}:${t0}`;
  const sheet = uniqueJpeg(SHEET_T, `${nonce}:sheet`);
  const venue = uniqueJpeg(VENUE_T, `${nonce}:venue`);
  const imageSha256 = sha256(sheet, 'hex');
  const venueImageSha256 = sha256(venue, 'hex');

  if (MODE === 'direct') {
    const pre = http.post(url('/api/uploads/presign'), JSON.stringify({
      sheetSha256: imageSha256, venueSha256: venueImageSha256,
      sheetBytes: sheet.byteLength, venueBytes: venue.byteLength,
    }), { headers: headers({ ...auth, 'content-type': 'application/json' }), tags: { name: 'presign' } });
    noteResponse(pre);
    if (pre.status === 409) exec.test.abort('staging is not in direct mode (409 direct_upload_disabled). Set UPLOAD_MODE=direct + BLOB_DRIVER=s3, or run UPLOAD_PATH=proxy.');
    if (!check(pre, { 'presign 200': (r) => r.status === 200 })) { reportOk.add(false); return; }
    const plan = pre.json();
    for (const [slot, body] of [['sheet', sheet], ['venue', venue]]) {
      const p = plan[slot];
      if (!p || p.alreadyStored) continue;
      const put = http.put(p.url, body, { headers: p.headers || {}, tags: { name: 'r2_put' } });
      if (!check(put, { 'r2 put 200': (r) => r.status === 200 })) { reportOk.add(false); return; }
    }
  }

  const now = Date.now();
  const jitter = () => (Math.random() - 0.5) * 0.0004; // ~ +/-20 m
  const p = {
    puCode: f.pu.code, contest, votes: randomVotes(),
    imageSha256, venueImageSha256,
    capturedAt: now - 90_000, venueCapturedAt: now - 60_000,
    lat: f.pu.lat, lng: f.pu.lng,
    sheetLat: f.pu.lat + jitter(), sheetLng: f.pu.lng + jitter(),
    venueLat: f.pu.lat + jitter(), venueLng: f.pu.lng + jitter(),
  };
  const key = await signingKey(idx, f.pkcs8);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(canonicalPayload(p)));
  const fields = {
    ...p, votes: JSON.stringify(p.votes), accuracy: 12, signature: b64encode(sig, 'std'),
  };

  let res;
  if (MODE === 'direct') {
    res = http.post(url('/api/submissions'), JSON.stringify(fields), {
      headers: headers({ ...auth, 'content-type': 'application/json' }), tags: { name: 'submit' },
    });
  } else {
    const form = {};
    for (const [k, v] of Object.entries(fields)) if (k !== 'imageSha256' && k !== 'venueImageSha256') form[k] = String(v);
    form.photo = http.file(sheet, 'sheet.jpg', 'image/jpeg');
    form.venuePhoto = http.file(venue, 'venue.jpg', 'image/jpeg');
    res = http.post(url('/api/submissions'), form, { headers: headers(auth), tags: { name: 'submit_proxy' } });
  }
  noteResponse(res);
  const ok = res.status === 201;
  reportOk.add(ok);
  if (ok) reportLatency.add(Date.now() - t0);
  check(res, { 'submit 201': () => ok });
}

// A SIGNED REPORT ON NATIVE IS NEVER LEFT ON "SIGNING AND SUBMITTING…"
// (pre-election review, native/) — the twin of tests/submit_never_stuck_test.mjs.
//
//   1. A STALLED LINK. RN's fetch never times out, and none of the three
//      requests a result submit makes (presign, photo PUTs, the POST) had a
//      deadline: on a socket that stalled after connecting, submitResult()
//      never returned, the screen held its spinner, and the signed report was
//      in neither the ledger nor the outbox. Now each request has a deadline
//      and a stall parks the report in the outbox like any dead network.
//   2. A 401 ABOUT THE REPORT (bad_signature) was parked in the outbox as
//      "signed out" — where it then blocked the queue (see
//      tests/native_outbox_stuck_test.mjs) — after a pointless session re-mint.
//      Now the observer is told what the server said, on the screen, and
//      nothing is re-minted. CONTROL: 401 invalid_token still re-mints, then
//      parks.
//   3. The register browse (lib/register-fetch.ts): a 503 with a JSON body
//      was handed to five screens as the list of LGAs, whose render then threw
//      "lgas.map is not a function" — the error screen in place of the report
//      flow. Now a refusal rejects into the callers' .catch. CONTROL: a 200
//      list comes through.
//
// The SHIPPED submit.ts, direct-upload.ts, retry.ts, deadline.ts and
// register-fetch.ts run in Node via tests/helpers/native-loader.mjs.
//
//   node tests/native_submit_deadline_test.mjs
import fs from 'node:fs';
import { tally } from './helpers/harness.mjs';
import { fastTimers, loadNative, settles, stalled } from './helpers/native-loader.mjs';

const { check, finish } = tally();
fastTimers();
const N = globalThis.__native;
const STUBS = ['@/lib/identity', '@/lib/i18n', '@/lib/evidence', '@/lib/secure-store', '@/lib/auth',
  '@/lib/outbox', '@/lib/biometric', '@/lib/device-signals', '@/lib/register'];
N.queued = []; // what handOff() hands the (stubbed) outbox
const S = await loadNative('lib/submit.ts', { stub: STUBS });
const R = await loadNative('lib/register-fetch.ts');
N.secure.set('hawkeye.auth.token', 'tok');
let remints = 0;
N.bootstrapAuth = async () => { remints++; N.secure.set('hawkeye.auth.token', `tok${remints + 1}`); };

const photo = (n) => { const p = `${N.docs}/${n}.jpg`; fs.writeFileSync(p, n); return 'file://' + p; };
const shot = (n) => ({ uri: photo(n), capturedAt: 1, lat: 7.5, lng: 4.5 });
const input = () => ({
  puCode: '30-05-07-001', contest: 'GOV', votes: [{ party: 'AAA', count: 10 }],
  sheet: shot('sheet'), venue: shot('venue'), fix: { lat: 7.5, lng: 4.5, accuracy: 10 },
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let route;
const calls = [];
globalThis.fetch = (url, init = {}) => { const path = new URL(url).pathname; calls.push(path); return route(path, init); };

console.log('=== 1. a stalled link parks the report ===');
// [where it stalls, what the presign answers, the outcome once it settles]
for (const [label, stallAt, presign, want, wantLabel] of [
  ['the POST (multipart)', '/api/submissions', 409, [false, true, 1], 'parked: "saved on this phone", queued in the outbox'],
  ['the POST (after direct upload)', '/api/submissions', 'direct', [false, true, 1], 'parked: "saved on this phone", queued in the outbox'],
  ['the presign', '/api/uploads/presign', null, [true, undefined, 0], 'falls back to multipart, which files it'],
  ['a photo PUT', '/bucket/sheet', 'direct', [true, undefined, 0], 'falls back to multipart, which files it'],
]) {
  N.queued.length = 0;
  route = (path, init) => {
    if (path === stallAt) return stalled(init);
    if (path === '/api/uploads/presign') {
      return Promise.resolve(presign === 'direct'
        ? json(200, { mode: 'direct', sheet: { url: 'https://r2.example/bucket/sheet' }, venue: { url: 'https://r2.example/bucket/venue' } })
        : json(409, { error: 'direct_upload_disabled' }));
    }
    return Promise.resolve(json(path.startsWith('/bucket/') ? 200 : 201, { ok: true }));
  };
  const p = S.submitResult(input());
  const settled = await settles(p);
  check(`stall at ${label}: submitResult() settles`, settled, 'resolved');
  const r = settled === 'resolved' ? await p : {};
  check(`...${wantLabel}`, [r.ok, r.queued, N.queued.length], want);
}
{
  N.queued.length = 0;
  route = (path) => Promise.resolve(path === '/api/uploads/presign' ? json(409, {}) : json(201, { ok: true, entryHash: 'h' }));
  const r = await S.submitResult(input());
  check('CONTROL: a server that answers files the report (ok, not queued)', [r.ok, N.queued.length], [true, 0]);
}

console.log('\n=== 2. a 401 about the report is not a session to re-mint ===');
{
  N.queued.length = 0;
  remints = 0;
  route = (path) => Promise.resolve(path === '/api/uploads/presign' ? json(409, {}) : json(401, { error: 'bad_signature' }));
  const r = await S.submitResult(input());
  check('bad_signature: the observer is told (not "saved"), nothing queued', [r.ok, !!r.queued, r.error, N.queued.length], [false, false, 'bad_signature', 0]);
  check('...and no session re-mint', remints, 0);
}
{
  N.queued.length = 0;
  remints = 0;
  route = (path) => Promise.resolve(path === '/api/uploads/presign' ? json(409, {}) : json(401, { error: 'invalid_token' }));
  const r = await S.submitResult(input());
  check('CONTROL: invalid_token re-mints once, then parks the report', [remints, r.queued, N.queued.length], [1, true, 1]);
}

console.log('\n=== 3. a register refusal is not a list ===');
{
  const REG = 'https://hawkeye.com.ng/api/register';
  route = () => Promise.resolve(json(503, { error: 'busy' }));
  // What result.tsx / collation.tsx / incident.tsx / map-unit.tsx do with it.
  let lgas = [];
  await R.regFetch(`${REG}/lgas?state=Osun`).then((r) => r.json()).then((v) => { lgas = v; }).catch(() => {});
  check('a 503 never becomes the LGA list (render does lgas.map)', Array.isArray(lgas), true);
  route = () => Promise.resolve(json(200, ['Ede North', 'Ede South']));
  await R.regFetch(`${REG}/lgas?state=Osun`).then((r) => r.json()).then((v) => { lgas = v; }).catch(() => {});
  check('CONTROL: a 200 list comes through', lgas, ['Ede North', 'Ede South']);
}

finish();

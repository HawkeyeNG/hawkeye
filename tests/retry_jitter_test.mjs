// RETRY-AFTER + JITTER, AND NO MULTIPART FALLBACK WHEN THE SERVER SAYS "BUSY".
//
// docs/private/ELECTION-NIGHT-HOSTING.md §5 item 10. The phone is the queue, so
// admission control at the origin (503 + Retry-After) loses nothing — provided
// (a) the phones honour Retry-After, (b) they do not all come back in the same
// second, and (c) a presign refused as busy does NOT turn into a multipart post
// that pushes both photos through the origin at exactly the moment it asked for
// less (§2.4, the CGNAT finding).
//
// What runs here is the SHIPPED code:
//   - app/outbox.js, loaded in a service-worker-shaped sandbox with an in-memory
//     IndexedDB, flushed against a stubbed fetch and a stubbed HawkeyeDirect;
//   - native/src/lib/retry.ts, imported with Node's type stripping, and checked
//     to give the same answers as the web copy (the two must stay in step).
// Every "does not post" check has a CONTROL showing the harness sees posts.
//
//   node tests/retry_jitter_test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const H = '/home/elrio/hawkeye';
let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- a small IndexedDB, enough for outbox.js ------------------------------
function fakeIndexedDB() {
  const dbs = new Map(); // name -> Map(store -> { keyPath, auto, next, data: Map })
  const later = (fn) => setTimeout(fn, 0);
  return {
    open(name) {
      const req = {};
      later(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          createObjectStore(store, opts = {}) {
            stores.set(store, { keyPath: opts.keyPath, auto: !!opts.autoIncrement, next: 1, data: new Map() });
          },
          close() {},
          transaction(store) {
            const s = stores.get(store);
            const ops = [];
            const t = {
              objectStore() {
                const op = (fn) => { const r = {}; ops.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
                return {
                  add: (v) => op(() => { const c = structuredClone(v); const id = s.next++; if (s.keyPath) c[s.keyPath] = id; s.data.set(id, c); return id; }),
                  put: (v, k) => op(() => { s.data.set(k ?? v[s.keyPath], structuredClone(v)); return k; }),
                  get: (k) => op(() => structuredClone(s.data.get(k))),
                  delete: (k) => op(() => { s.data.delete(k); }),
                  getAll: () => op(() => [...s.data.values()].map((v) => structuredClone(v))),
                };
              },
            };
            later(() => { for (const f of ops) f(); t.oncomplete?.(); });
            return t;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

/** A fresh outbox.js in its own realm, service-worker shaped (no document). */
function loadOutbox({ direct, respond }) {
  const posts = [];
  const G = {
    navigator: { onLine: true },
    addEventListener() {},
    dispatchEvent() {},
  };
  G.HawkeyeDirect = direct;
  const sandbox = {
    self: G,
    indexedDB: fakeIndexedDB(),
    fetch: async (url, init) => {
      posts.push({ url, multipart: init.body instanceof FormData, json: typeof init.body === 'string' });
      return respond(url, init, posts.length);
    },
    FormData, Blob, Response, Headers, CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d?.detail; } },
    setTimeout, clearTimeout, setInterval, console, structuredClone,
  };
  vm.runInNewContext(fs.readFileSync(`${H}/app/outbox.js`, 'utf8'), sandbox);
  return { O: G.HawkeyeOutbox, posts, sandbox };
}
const report = (n, extra = {}) => ({
  fields: { puCode: `01-01-01-00${n}`, contest: 'PRES', votes: '[]', imageSha256: 'a'.repeat(64), venueImageSha256: 'b'.repeat(64) },
  sheet: new Blob(['sheet']), venue: new Blob(['venue']), ...extra,
});
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
/** Seed the token the service worker reads, and queue `n` reports. */
async function seeded(o, n, extra) {
  // session() in a worker reads the token from the meta store; a page puts it there.
  await new Promise((r) => {
    const req = o.sandbox.indexedDB.open('hawkeye-outbox-meta');
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => { const t = req.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('tok', 'token'); t.oncomplete = r; };
  });
  for (let i = 1; i <= n; i++) await o.O.queue(report(i, extra));
}
const retryState = async (o) => new Promise((r) => {
  const req = o.sandbox.indexedDB.open('hawkeye-outbox-meta');
  req.onsuccess = () => { const t = req.result.transaction('kv'); const g = t.objectStore('kv').get('retry'); t.oncomplete = () => r(g.result || {}); };
});

// ---- 1. the arithmetic ----------------------------------------------------
console.log('=== retryDelayMs (web) ===');
const { O: W } = loadOutbox({ direct: null, respond: () => json(201, {}) });
const at = (v) => () => v;
check('Retry-After 30 on a 503 is a floor: rand 0 -> 30 s', W.retryDelayMs(503, '30', 0, at(0)), 30000);
check('...plus up to 50% on top: rand 0.999 -> < 45 s', W.retryDelayMs(503, '30', 0, at(0.999)), (v) => v >= 44000 && v < 45000);
check('429 honours it too', W.retryDelayMs(429, '12', 3, at(0)), 12000);
check('an HTTP-date is honoured', W.retryDelayMs(503, new Date(1_000_000 + 40_000).toUTCString(), 0, at(0), 1_000_000), 40000);
check('a silly Retry-After is capped at 15 min', W.retryDelayMs(503, '999999', 0, at(0)), 15 * 60000);
check('Retry-After on a 500 is not a promise: full jitter instead', W.retryDelayMs(500, '30', 0, at(0.5)), 15000);
check('no Retry-After: full jitter under 30 s on attempt 0', W.retryDelayMs(503, null, 0, at(0.999)), (v) => v < 30000);
check('...under 30 min from attempt 3 on', W.retryDelayMs(502, null, 9, at(0.999)), (v) => v < 1_800_000 && v > 1_700_000);
const spread = Array.from({ length: 2000 }, () => W.retryDelayMs(503, '30', 0));
check('2,000 phones told "30" spread over 30-45 s, never before 30',
  [Math.min(...spread) >= 30000, Math.max(...spread) < 45000, new Set(spread.map((v) => Math.floor(v / 1000))).size >= 14], [true, true, true]);
check('control: without jitter they would all land on one second', new Set([30000, 30000].map((v) => Math.floor(v / 1000))).size, 1);
check('retryable: 5xx, 408, 425, 429', [500, 502, 503, 408, 425, 429, 400, 404, 409, 422].map(W.retryableStatus),
  [true, true, true, true, true, true, false, false, false, false]);

// ---- 2. native twin -------------------------------------------------------
console.log('\n=== native lib/retry.ts gives the same answers ===');
let N = null;
try { N = await import(`${H}/native/src/lib/retry.ts`); } catch {
  // Older Node: type stripping behind a flag. Run the comparison in a child.
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
    `import * as N from '${H}/native/src/lib/retry.ts'; console.log(JSON.stringify(Object.keys(N)));`], { encoding: 'utf8' });
  if (r.status === 0) N = await import(`${H}/native/src/lib/retry.ts`).catch(() => null);
}
if (!N) { fail++; console.log('FAIL  could not load native/src/lib/retry.ts'); } else {
  const cases = [];
  for (const s of [429, 503, 500, 502, 408, 425]) {
    for (const ra of [null, '0', '7', '30', '120', '999999', 'garbage', new Date(1_000_000 + 25_000).toUTCString()]) {
      for (const a of [0, 1, 2, 3, 7]) for (const r of [0, 0.25, 0.999]) cases.push([s, ra, a, r]);
    }
  }
  const diff = cases.filter(([s, ra, a, r]) => W.retryDelayMs(s, ra, a, at(r), 1_000_000) !== N.retryDelayMs(s, ra, a, at(r), 1_000_000));
  check(`retryDelayMs agrees on all ${cases.length} cases`, diff.slice(0, 3), []);
  check('retryableStatus agrees', [400, 408, 425, 429, 499, 500, 503, 599].every((s) => W.retryableStatus(s) === N.retryableStatus(s)), true);
  check('holdsQueue is exactly 429 and 503', [408, 429, 500, 502, 503].map(N.holdsQueue), [false, true, false, false, true]);
  const res = new Response(JSON.stringify({ retryAfterS: 33 }), { status: 503 });
  check('retryAfterOf falls back to the body when the header is absent', await N.retryAfterOf(res), '33');
  check('...and leaves the body readable for the next reader', (await res.json()).retryAfterS, 33);
  check('the header wins when present', await N.retryAfterOf(new Response('{}', { status: 429, headers: { 'retry-after': '9' } })), '9');
}

// ---- 3. the web outbox, flushed -------------------------------------------
console.log('\n=== app/outbox.js flush ===');
{
  // CONTROL: a presign that says "proxy mode" (null) falls back to multipart,
  // so the harness does see posts when they happen.
  const o = loadOutbox({ direct: { tryUpload: async () => null }, respond: () => json(201, {}) });
  await seeded(o, 2);
  await o.O.flush();
  check('control: presign null -> multipart posts, both sent', [o.posts.length, o.posts.every((p) => p.multipart), await o.O.count()], [2, true, 0]);
}
{
  const o = loadOutbox({ direct: { tryUpload: async () => ({ busy: true, status: 429, retryAfter: '30' }) }, respond: () => json(201, {}) });
  await seeded(o, 3);
  const t0 = Date.now();
  await o.O.flush();
  const st = await retryState(o);
  check('presign 429 -> NO post at all (no multipart fallback)', o.posts.length, 0);
  check('...all three reports kept', await o.O.count(), 3);
  check('...each held until at least Retry-After', Object.values(st).map((x) => x.at - t0 >= 30000), [true, true, true]);
  check('...with its own jitter', new Set(Object.values(st).map((x) => x.at)).size >= 2, true);
  await o.O.flush();
  check('a second flush inside the window sends nothing', o.posts.length, 0);
}
{
  // Old cached direct-upload.js without tryUpload: upload() keeps true|null.
  const o = loadOutbox({ direct: { upload: async () => true }, respond: () => json(201, {}) });
  await seeded(o, 1);
  await o.O.flush();
  check('an old upload()-only HawkeyeDirect still works (JSON post)', [o.posts.length, o.posts[0]?.json], [1, true]);
}
{
  const o = loadOutbox({ direct: null, respond: () => json(503, { error: 'server_busy', retryAfterS: 20 }, { 'retry-after': '20' }) });
  await seeded(o, 3);
  const t0 = Date.now();
  await o.O.flush();
  const st = await retryState(o);
  check('submit 503 -> one attempt, then the flush stops', o.posts.length, 1);
  check('...all three held >= 20 s', Object.values(st).map((x) => x.at - t0 >= 20000), [true, true, true]);
  check('...only the one tried counts as a failed attempt', Object.values(st).map((x) => x.n).sort(), [0, 0, 1]);
}
{
  const o = loadOutbox({ direct: null, respond: () => json(503, { error: 'read_only', retryAfterS: 41 }) });
  await seeded(o, 1);
  const t0 = Date.now();
  await o.O.flush();
  const st = await retryState(o);
  check('no Retry-After header (cross-origin) -> body retryAfterS is used', Object.values(st)[0].at - t0 >= 41000, true);
}
{
  const o = loadOutbox({ direct: null, respond: () => json(500, { error: 'internal_error' }) });
  await seeded(o, 3);
  await o.O.flush();
  check('a plain 500 is about ONE report: the others are still tried', o.posts.length, 3);
  check('...and all are kept', await o.O.count(), 3);
}
{
  const o = loadOutbox({ direct: null, respond: () => json(201, {}) });
  await seeded(o, 2, { notBefore: Date.now() + 60_000 });
  await o.O.queue(report(9));
  await o.O.flush();
  check('a report parked with notBefore waits; one without it goes', [o.posts.length, await o.O.count()], [1, 2]);
}

// ---- 4. the callers -------------------------------------------------------
console.log('\n=== callers ===');
const du = fs.readFileSync(`${H}/app/direct-upload.js`, 'utf8');
check('direct-upload.js: 429/503 return busy, before the generic !ok -> null',
  du.indexOf('r.status === 429 || r.status === 503') > 0 && du.indexOf('r.status === 429 || r.status === 503') < du.indexOf('if (!r.ok) return null'), true);
check('direct-upload.js keeps upload() for cached callers', /window\.HawkeyeDirect = \{ upload, tryUpload \}/.test(du), true);
const app = fs.readFileSync(`${H}/app/app.js`, 'utf8');
const sub = app.slice(app.indexOf("$('btn-submit').onclick"));
check('app.js: a busy presign parks BEFORE the multipart post is built into a request',
  sub.indexOf('if (presignBusy)') > 0 && sub.indexOf('if (presignBusy)') < sub.indexOf('await post()'), true);
check('app.js: 5xx/429 after submit park in the outbox', /status >= 500 \|\| status === 408 \|\| status === 425 \|\| status === 429\)[\s\S]{0,200}park\(busyLine\(\)/.test(sub), true);
const dua = fs.readFileSync(`${H}/native/src/lib/direct-upload.ts`, 'utf8');
check('native direct-upload.ts: 429/503 -> DirectBusy, not null',
  /res\.status === 429 \|\| res\.status === 503\)[\s\S]{0,300}busy: true/.test(dua), true);
const submit = fs.readFileSync(`${H}/native/src/lib/submit.ts`, 'utf8');
const sr = submit.slice(submit.indexOf('export async function submitResult'));
check('native submit.ts: a busy presign parks before any multipart fetch',
  sr.indexOf('isDirectBusy(direct)') > 0 && sr.indexOf('isDirectBusy(direct)') < sr.indexOf("deliver('/api/submissions'"), true);
const ob = fs.readFileSync(`${H}/native/src/lib/outbox.ts`, 'utf8');
check('native outbox.ts: a busy presign holds the queue and breaks', /if \(isDirectBusy\(res\)\) \{\s*holdQueue\(/.test(ob), true);
check('native outbox.ts: a reconnect never overrides a server notBefore', /ignoreBackoff\) \{\s*for \(const job of jobs\) job\.nextAttemptAt = \(job\.notBefore/.test(ob), true);
check('native outbox.ts: reconnect and resume flushes are staggered', /staggered\(RECONNECT_STAGGER_MS/.test(ob) && /staggered\(RESUME_STAGGER_MS/.test(ob), true);

console.log(fail ? `\n${fail} FAILED` : '\nretry_jitter: all checks passed');
process.exit(fail ? 1 : 0);

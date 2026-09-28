// D1 PHOTO QUORUM — the web / Lite client (app/direct-upload.js, app/outbox.js).
//
// A hash-only report's photos exist nowhere but the phone, so they MUST be kept
// there until the election-petition window closes (31 July 2027), whatever the
// "keep copies on this phone" switch says. A page has no reliable device
// storage, so they go into IndexedDB ('hawkeye-evidence') and hash-only is
// offered ONLY when the browser grants persistent storage; otherwise the photos
// upload exactly as before.
//
// What runs here is the SHIPPED code, each file in its own vm realm, against an
// in-memory IndexedDB and a stubbed fetch. Every "not hash-only" check has a
// CONTROL beside it where the same setup, one switch flipped, IS hash-only.
//
//   node tests/photo_quorum_web_test.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const H = '/home/elrio/hawkeye';
let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- an in-memory IndexedDB: put/get/add/delete/getAll/openCursor ---------
function fakeIndexedDB({ failPut = false } = {}) {
  const dbs = new Map();
  const tick = (fn) => setTimeout(fn, 0);
  return {
    dbs,
    open(name) {
      const req = {};
      tick(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore(s, o = {}) { stores.set(s, { keyPath: o.keyPath, next: 1, data: new Map() }); },
          close() {},
          transaction(store) {
            const s = stores.get(store);
            const t = { error: null };
            let pending = 0; let ended = false;
            const end = () => {
              if (ended || pending) return;
              ended = true;
              tick(() => (t.error ? (t.onerror?.(), t.onabort?.()) : t.oncomplete?.()));
            };
            const op = (fn) => {
              const r = {}; pending++;
              tick(() => {
                try { r.result = fn(); r.onsuccess?.(); } catch (e) { t.error = e; r.error = e; r.onerror?.(); }
                pending--; end();
              });
              return r;
            };
            t.objectStore = () => ({
              put: (v, k) => op(() => {
                if (failPut && store === 'photos') throw new Error('QuotaExceededError');
                const key = k ?? v[s.keyPath]; s.data.set(key, structuredClone(v)); return key;
              }),
              add: (v) => op(() => { const c = structuredClone(v); const id = s.next++; if (s.keyPath) c[s.keyPath] = id; s.data.set(id, c); return id; }),
              get: (k) => op(() => structuredClone(s.data.get(k))),
              delete: (k) => op(() => { s.data.delete(k); }),
              getAll: () => op(() => [...s.data.values()].map((v) => structuredClone(v))),
              openCursor() {
                const r = {}; pending++;
                const keys = [...s.data.keys()]; let i = 0;
                const step = () => tick(() => {
                  if (i >= keys.length) { r.result = null; r.onsuccess?.(); pending--; end(); return; }
                  const k = keys[i++];
                  r.result = { value: structuredClone(s.data.get(k)), delete: () => { s.data.delete(k); }, continue: step };
                  r.onsuccess?.();
                });
                step();
                return r;
              },
            });
            tick(end); // an empty transaction still completes
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
const evidenceRows = (idb) => {
  const d = idb.dbs.get('hawkeye-evidence');
  return d && d.get('photos') ? [...d.get('photos').data.values()] : [];
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const HASHES = { sheet: 'a'.repeat(64), venue: 'b'.repeat(64) };
const FIGURES = { puCode: '24-14-01-020', contest: 'PRES', votes: [{ party: 'A', count: 41 }] };
const KEEP_UNTIL = Date.UTC(2027, 6, 31, 23, 0, 0);

/** app/direct-upload.js in a page-shaped realm. */
function loadDirect({ persisted = false, persist = false, hangPersist = false, failPut = false, respond }) {
  const calls = [];
  const idb = fakeIndexedDB({ failPut });
  const storage = new Map([['hawkeye_save_media', '0']]); // the gallery switch is OFF
  const sandbox = {
    navigator: {
      onLine: true,
      storage: {
        persisted: async () => persisted,
        persist: () => (hangPersist ? new Promise(() => {}) : Promise.resolve(persist)),
      },
    },
    indexedDB: idb,
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    fetch: async (url, init) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: init.method, body });
      return respond(String(url), init, body);
    },
    setTimeout, clearTimeout, console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(`${H}/app/direct-upload.js`, 'utf8'), sandbox);
  return { D: sandbox.HawkeyeDirect, calls, idb };
}
/** A server at quorum: "hash-only" when (and only when) the figures come. */
const quorumServer = (url, init, body) => {
  if (url.endsWith('/api/uploads/presign')) {
    if (body && body.puCode) return json(200, { mode: 'hash-only', quorum: 5 });
    return json(200, {
      mode: 'direct',
      sheet: { url: 'https://bucket.example/s', headers: {}, alreadyStored: false },
      venue: { url: 'https://bucket.example/v', headers: {}, alreadyStored: false },
    });
  }
  if (init.method === 'PUT') return new Response('', { status: 200 });
  return json(500, {});
};
const blobs = () => ({ sheet: new Blob(['sheet-bytes-xx']), venue: new Blob(['venue-bytes']) });

// ---- 1. hash-only keeps the photos, whatever the gallery switch says -------
console.log('=== direct-upload.js: hash-only ===');
{
  const o = loadDirect({ persisted: true, respond: quorumServer });
  const up = await o.D.tryUpload({ base: '', token: 't', blobs: blobs(), hashes: HASHES, figures: FIGURES });
  check('persistent storage + quorum: tryUpload returns { hashOnly: true }', up, { hashOnly: true });
  check('...the presign carried the figures', o.calls[0].body && [o.calls[0].body.puCode, o.calls[0].body.contest, o.calls[0].body.votes],
    [FIGURES.puCode, FIGURES.contest, FIGURES.votes]);
  check('...nothing was uploaded (no PUT)', o.calls.filter((c) => c.method === 'PUT').length, 0);
  const rows = evidenceRows(o.idb);
  check('...BOTH photos kept in IndexedDB although the gallery switch is off',
    rows.map((r) => [r.slot, r.sha256, r.blob.size]).sort(), [['sheet', HASHES.sheet, 14], ['venue', HASHES.venue, 11]]);
  check('...kept until 31 July 2027 (end of day, Lagos)', rows.every((r) => r.keepUntil === KEEP_UNTIL), true);
  check('...with the unit and contest, for a later evidence request',
    rows.every((r) => r.puCode === FIGURES.puCode && r.contest === 'PRES'), true);
  const back = await o.D.evidence.get(HASHES.sheet);
  check('...and it can be read back by hash', back && back.blob.size, 14);
}
// CONTROL: the same server, storage NOT persistent -> the figures never go.
{
  const o = loadDirect({ persisted: false, persist: false, respond: quorumServer });
  const up = await o.D.tryUpload({ base: '', token: 't', blobs: blobs(), hashes: HASHES, figures: FIGURES });
  check('control: no persistent storage -> NOT hash-only (uploads: true)', up, true);
  check('...the presign carried NO figures', o.calls[0].body.puCode, undefined);
  check('...both photos were PUT to the bucket', o.calls.filter((c) => c.method === 'PUT').length, 2);
  check('...nothing claimed as kept', evidenceRows(o.idb).length, 0);
}
{
  const o = loadDirect({ persisted: false, persist: true, respond: quorumServer });
  const up = await o.D.tryUpload({ base: '', token: 't', blobs: blobs(), hashes: HASHES, figures: FIGURES });
  check('persist() granted on request -> hash-only', up, { hashOnly: true });
}
{
  const o = loadDirect({ persisted: false, hangPersist: true, respond: quorumServer });
  const t0 = Date.now();
  const up = await o.D.tryUpload({ base: '', token: 't', blobs: blobs(), hashes: HASHES, figures: FIGURES });
  check('a persist() prompt nobody answers does not hold the report (< 3 s) and it uploads',
    [up, Date.now() - t0 < 3000, o.calls[0].body.puCode], [true, true, undefined]);
}
{
  const o = loadDirect({ persisted: true, failPut: true, respond: quorumServer });
  const up = await o.D.tryUpload({ base: '', token: 't', blobs: blobs(), hashes: HASHES, figures: FIGURES });
  const presigns = o.calls.filter((c) => c.url.endsWith('/presign'));
  check('hash-only answered but the copy FAILED -> asks again without figures and uploads',
    [up, presigns.length, presigns[0].body.puCode, presigns[1] && presigns[1].body.puCode, o.calls.filter((c) => c.method === 'PUT').length],
    [true, 2, FIGURES.puCode, undefined, 2]);
}
{
  // Proxy-mode server at quorum answers hash-only only with figures; 409 without.
  const proxy = (url, init, body) => (body && body.puCode ? json(200, { mode: 'hash-only', quorum: 5 }) : json(409, { error: 'direct_upload_disabled' }));
  const o = loadDirect({ persisted: true, failPut: true, respond: proxy });
  const up = await o.D.tryUpload({ base: '', token: 't', blobs: blobs(), hashes: HASHES, figures: FIGURES });
  check('proxy mode, copy failed -> null (the caller posts multipart)', up, null);
}
{
  const o = loadDirect({ persisted: true, respond: quorumServer });
  const up = await o.D.upload({ base: '', token: 't', blobs: blobs(), hashes: HASHES, figures: FIGURES });
  check('the old upload() contract never goes hash-only (figures stripped)', [up, o.calls[0].body.puCode], [true, undefined]);
}
{
  const o = loadDirect({ persisted: true, respond: quorumServer });
  const up = await o.D.tryUpload({ base: '', token: 't', blobs: blobs(), hashes: HASHES });
  check('no figures (a caller that did not offer) -> ordinary upload', [up, o.calls[0].body.puCode], [true, undefined]);
}

// ---- 2. retention ----------------------------------------------------------
console.log('\n=== evidence retention ===');
{
  const o = loadDirect({ persisted: true, respond: quorumServer });
  const E = o.D.evidence;
  check('KEEP_UNTIL is the end of 31 July 2027 in Lagos', E.KEEP_UNTIL, KEEP_UNTIL);
  // Election night (Dec 2026 stands in) and a June 2027 by-election.
  await E.keep({ blobs: blobs(), hashes: HASHES, figures: FIGURES, now: Date.UTC(2026, 11, 1) });
  const june = { sheet: 'c'.repeat(64), venue: 'd'.repeat(64) };
  await E.keep({ blobs: blobs(), hashes: june, figures: FIGURES, now: Date.UTC(2027, 5, 1) });
  check('a June 2027 report gets 180 days of its own (past 31 July)',
    evidenceRows(o.idb).find((r) => r.sha256 === june.sheet).keepUntil, Date.UTC(2027, 5, 1) + 180 * 864e5);
  await E.prune(Date.UTC(2027, 6, 31, 12));
  check('a prune on 31 July 2027 deletes nothing', evidenceRows(o.idb).length, 4);
  await E.prune(Date.UTC(2027, 7, 2));
  check('a prune on 2 August 2027 deletes the election-night photos only',
    evidenceRows(o.idb).map((r) => r.sha256).sort(), [june.sheet, june.venue].sort());
  // keep() prunes as it goes, with the same rule: the June report survives.
  const sept = { sheet: 'e'.repeat(64), venue: 'f'.repeat(64) };
  await E.keep({ blobs: blobs(), hashes: sept, figures: FIGURES, now: Date.UTC(2027, 8, 1) });
  await new Promise((r) => setTimeout(r, 50)); // its prune is fire-and-forget
  check('a September keep prunes nothing still inside its window',
    evidenceRows(o.idb).map((r) => r.sha256).sort(), [june.sheet, june.venue, sept.sheet, sept.venue].sort());
}

// ---- 3. the outbox: hash-only, and the fallback when the quorum moved ------
console.log('\n=== outbox.js flush ===');
function loadOutbox({ tryUpload, respond }) {
  const posts = [];
  const plans = [];
  const G = { navigator: { onLine: true }, addEventListener() {}, dispatchEvent() {} };
  G.HawkeyeDirect = {
    tryUpload: async (opts) => { plans.push(opts.figures ? { ...opts.figures } : null); return tryUpload(opts, plans.length); },
  };
  const sandbox = {
    self: G,
    indexedDB: fakeIndexedDB(),
    fetch: async (url, init) => {
      const isJson = typeof init.body === 'string';
      posts.push({ multipart: init.body instanceof FormData, json: isJson ? JSON.parse(init.body) : null });
      return respond(posts.length, posts[posts.length - 1]);
    },
    FormData, Blob, Response, Headers, CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d?.detail; } },
    setTimeout, clearTimeout, setInterval, console, structuredClone,
  };
  vm.runInNewContext(fs.readFileSync(`${H}/app/outbox.js`, 'utf8'), sandbox);
  return { O: G.HawkeyeOutbox, posts, plans, sandbox };
}
async function seeded(o) {
  await new Promise((r) => {
    const req = o.sandbox.indexedDB.open('hawkeye-outbox-meta');
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => { const t = req.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('tok', 'token'); t.oncomplete = r; };
  });
  await o.O.queue({
    fields: { puCode: FIGURES.puCode, contest: 'PRES', votes: JSON.stringify(FIGURES.votes), signature: 'sig', imageSha256: HASHES.sheet, venueImageSha256: HASHES.venue },
    sheet: new Blob(['sheet']), venue: new Blob(['venue']),
  });
}
{
  // CONTROL: at quorum, the queued report goes hash-only in one JSON post.
  const o = loadOutbox({ tryUpload: async () => ({ hashOnly: true }), respond: () => json(201, { ok: true, photosOnDevice: true }) });
  await seeded(o);
  await o.O.flush();
  check('control: hash-only flush = ONE JSON post marked hashOnly, report sent',
    [o.posts.length, o.posts[0]?.json?.hashOnly, await o.O.count()], [1, '1', 0]);
  check('...the presign was offered the queued figures', o.plans[0], { puCode: FIGURES.puCode, contest: 'PRES', votes: JSON.stringify(FIGURES.votes) });
}
{
  // The quorum moved (a dissent landed): 409 photo_not_uploaded -> upload now.
  const o = loadOutbox({
    tryUpload: async (opts, n) => (n === 1 ? { hashOnly: true } : null),
    respond: (n) => (n === 1 ? json(409, { error: 'photo_not_uploaded', reason: 'photo_quorum_not_met' }) : json(201, { ok: true })),
  });
  await seeded(o);
  await o.O.flush();
  check('quorum moved: hash-only refused, then the SAME flush uploads multipart and sends',
    [o.posts.length, o.posts[0].json?.hashOnly, o.posts[1]?.multipart, await o.O.count()], [2, '1', true, 0]);
  check('...the second plan was made WITHOUT figures', o.plans, [{ puCode: FIGURES.puCode, contest: 'PRES', votes: JSON.stringify(FIGURES.votes) }, null]);
}
{
  // A non-hash-only 409 photo_not_uploaded keeps its old meaning: stay queued.
  const o = loadOutbox({ tryUpload: async () => true, respond: () => json(409, { error: 'photo_not_uploaded' }) });
  await seeded(o);
  await o.O.flush();
  check('direct (not hash-only) 409 photo_not_uploaded: one post, report kept for the next flush',
    [o.posts.length, await o.O.count()], [1, 1]);
}

// ---- 4. the live path in app.js offers figures and falls back --------------
console.log('\n=== app.js submit path (structure) ===');
{
  const src = fs.readFileSync(`${H}/app/app.js`, 'utf8');
  const has = (re) => re.test(src);
  const rules = (s) => [
    /await planUpload\(true\)/.test(s),
    /figures: \{ puCode: selectedPu\.pu_code, contest, votes \}/.test(s),
    /hashOnly && status === 409 && body && body\.error === 'photo_not_uploaded'[\s\S]{0,80}await planUpload\(false\)/.test(s),
    /body\.photosOnDevice \? `<p class="hint">\$\{T\('observe\.photos-kept-as-evidence'/.test(s),
  ];
  check('app.js offers figures, falls back on 409, and says the photos were kept', rules(src), [true, true, true, true]);
  const broken = src.replace('await planUpload(false)', 'void 0');
  check('control: removing the fallback is detected', rules(broken)[2], false);
  check('app.js never gates hash-only on the gallery switch', has(/hashOnly[^\n]*hawkeye_save_media|hawkeye_save_media[^\n]*hashOnly/), false);
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nphoto_quorum_web: all checks passed');
process.exit(fail ? 1 : 0);

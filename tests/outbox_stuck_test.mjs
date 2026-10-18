// TWO WAYS A SIGNED REPORT GOT STUCK IN THE WEB / LITE OUTBOX (pre-election review).
//
//   1. A STORE THAT FAILS AT COMMIT. IndexedDB reports QuotaExceededError —
//      the two photos did not fit — by aborting the transaction: the request
//      itself succeeded, so only 'abort' fires, never 'error'. outbox.js
//      listened for complete and error only, so queue() never settled and the
//      submit screen sat on "Submitting…" for good.
//   2. A 401 ABOUT THE REPORT, NOT THE SESSION. Every 401 stopped the flush,
//      including bad_signature — a report signed with a key that a sign-out
//      deleted. No sign-in can fix that one, so it stopped EVERY flush, forever,
//      and every report queued behind it waited with it.
//
// What runs here is the SHIPPED app/outbox.js in a service-worker-shaped vm
// realm, against an in-memory IndexedDB and a stubbed fetch. Each check has a
// CONTROL showing the harness sees the opposite case.
//
//   node tests/outbox_stuck_test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import { H, tally } from './helpers/harness.mjs';
import { memoryIndexedDB } from './helpers/memory-idb.mjs';

const { check, finish } = tally();

function loadOutbox({ idb, respond }) {
  const posts = [];
  const G = { navigator: { onLine: true }, addEventListener() {}, dispatchEvent() {} };
  const sandbox = {
    self: G,
    indexedDB: idb,
    fetch: async (url, init) => { posts.push(init.body.get('puCode')); return respond(posts.length); },
    FormData, Blob, Response, Headers, CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d?.detail; } },
    setTimeout, clearTimeout, setInterval, console, structuredClone,
  };
  vm.runInNewContext(fs.readFileSync(`${H}/app/outbox.js`, 'utf8'), sandbox);
  return { O: G.HawkeyeOutbox, posts, sandbox };
}
const report = (n) => ({
  fields: { puCode: `01-01-01-00${n}`, contest: 'PRES', votes: '[]' },
  sheet: new Blob(['sheet']), venue: new Blob(['venue']),
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function seeded(o, n) {
  await new Promise((r) => {
    const req = o.sandbox.indexedDB.open('hawkeye-outbox-meta');
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => { const t = req.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('tok', 'token'); t.oncomplete = r; };
  });
  for (let i = 1; i <= n; i++) await o.O.queue(report(i));
}
const settles = (p, ms = 1500) => Promise.race([
  p.then(() => 'resolved', (e) => `rejected ${e && e.name}`),
  new Promise((r) => setTimeout(() => r('never settled'), ms)),
]);

console.log('=== 1. a store that refuses the report at commit ===');
{
  const o = loadOutbox({ idb: memoryIndexedDB({ abortAdds: true }), respond: () => json(201, {}) });
  check('queue() REJECTS (the caller can say "not saved"), it does not hang', await settles(o.O.queue(report(1))), 'rejected QuotaExceededError');
  check('...and nothing is in the queue', await o.O.count(), 0);
}
{
  const o = loadOutbox({ idb: memoryIndexedDB(), respond: () => json(201, {}) });
  check('CONTROL: the same queue() on a store with room resolves', await settles(o.O.queue(report(1))), 'resolved');
  check('CONTROL: ...and holds the report', await o.O.count(), 1);
}

console.log('\n=== 2. a 401 about the REPORT does not hold the queue ===');
{
  // Report 1 was signed with a key that no longer exists; report 2 is fine.
  const o = loadOutbox({ idb: memoryIndexedDB(), respond: (n) => (n === 1 ? json(401, { error: 'bad_signature' }) : json(201, {})) });
  await seeded(o, 2);
  await o.O.flush();
  check('bad_signature: the report behind it is still sent', o.posts, ['01-01-01-001', '01-01-01-002']);
  check('...and the queue is empty', await o.O.count(), 0);
  await o.O.flush();
  check('...so a later flush does not ask again', o.posts.length, 2);
}
for (const [label, resp] of [
  ['401 invalid_token', () => json(401, { error: 'invalid_token' })],
  ['401 signed_in_elsewhere', () => json(401, { error: 'signed_in_elsewhere' })],
  ['401 with no JSON body', () => new Response('<html>401</html>', { status: 401 })],
]) {
  const o = loadOutbox({ idb: memoryIndexedDB(), respond: resp });
  await seeded(o, 2);
  await o.O.flush();
  check(`CONTROL: ${label} is the SESSION -> one try, both reports kept for after sign-in`, [o.posts.length, await o.O.count()], [1, 2]);
}

finish();

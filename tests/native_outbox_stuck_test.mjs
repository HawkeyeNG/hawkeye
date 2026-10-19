// TWO WAYS THE NATIVE OUTBOX STOPPED FOR GOOD (pre-election review, native/).
//
//   1. A 401 ABOUT THE REPORT, NOT THE SESSION (bad_signature). Every 401 was
//      read as "session expired": re-mint (which drops the stored token and
//      runs a /resume) and stop the flush — on every pass, forever, with every
//      report queued behind it held too. The web outbox was fixed for this in
//      the app/ review; this is the native twin.
//   2. A STALLED UPLOAD. RN's fetch never times out, and the outbox POST had
//      no deadline, so on a socket that stalled after connecting flushOutbox()
//      never returned. It runs one flush at a time: `sending` stayed true and
//      no later flush — reconnect, resume, the 60 s sweep, the background
//      task — ever ran again until the app was killed.
//
// The SHIPPED native/src/lib/outbox.ts (and retry.ts, deadline.ts,
// direct-upload.ts) runs in Node via tests/helpers/native-loader.mjs, against
// a real temp directory and a stubbed fetch. Each rule has a CONTROL.
//
//   node tests/native_outbox_stuck_test.mjs
import fs from 'node:fs';
import { tally } from './helpers/harness.mjs';
import { fastTimers, loadNative, settles, stalled } from './helpers/native-loader.mjs';

const { check, finish } = tally();
fastTimers();
const N = globalThis.__native;
const O = await loadNative('lib/outbox.ts', {
  stub: ['@/lib/identity', '@/lib/i18n', '@/lib/evidence', '@/lib/submit', '@/lib/secure-store'],
});
N.secure.set('hawkeye.auth.token', 'tok');
let remints = 0;
N.remint = async () => { remints++; return 'tok2'; };

const photo = (n) => { const p = `${N.docs}/${n}.jpg`; fs.writeFileSync(p, 'jpeg'); return 'file://' + p; };
const job = (pu) => ({ kind: 'incident', body: { puCode: pu }, files: [{ field: 'media', uri: photo(pu), name: 'a.jpg', type: 'image/jpeg' }], label: pu });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Every flush is "later": past any backoff the last one set.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = () => { skew += 6 * 3600e3; };

let respond;
const posts = [];
globalThis.fetch = (url, init) => { posts.push(init.body.get?.('puCode')); return respond(init); };

console.log('=== 1. a 401 about the REPORT does not hold the queue ===');
posts.length = 0;
remints = 0;
await O.queueJob(job('B'));
await O.queueJob(job('C'));
respond = (init) => Promise.resolve(init.body.get('puCode') === 'B' ? json(401, { error: 'bad_signature', hint: 'Could not verify' }) : json(201, {}));
for (let i = 0; i < 3; i++) { later(); await O.flushOutbox(); }
check('bad_signature: the report behind it is still sent', posts, ['B', 'C']);
check('...the queue is empty (B dropped, C delivered)', (await O.listQueued()).length, 0);
check('...and nobody re-minted a session over it', remints, 0);
const dropped = await O.listDropped();
check('...B is in the dropped list with the server\'s reason', [dropped[0]?.label, /bad_signature/.test(dropped[0]?.why || '')], ['B', true]);

for (const [label, body] of [['invalid_token', { error: 'invalid_token' }], ['signed_in_elsewhere', { error: 'signed_in_elsewhere' }], ['no JSON body', null]]) {
  posts.length = 0;
  remints = 0;
  const before = (await O.listQueued()).length;
  await O.queueJob(job('D'));
  await O.queueJob(job('E'));
  respond = () => Promise.resolve(body ? json(401, body) : new Response('<html>401</html>', { status: 401 }));
  later();
  await O.flushOutbox();
  const after = (await O.listQueued()).length - before;
  check(`CONTROL: 401 ${label} is the SESSION -> one re-mint, flush stops, both reports kept`, [remints, after], [1, 2]);
  // Deliver them, so the next control starts empty.
  respond = () => Promise.resolve(json(201, {}));
  later();
  await O.flushOutbox();
}

console.log('\n=== 2. a stalled upload ends the flush ===');
await O.queueJob(job('A'));
respond = (init) => stalled(init);
later();
check('flushOutbox() settles on a socket that never answers', await settles(O.flushOutbox()), 'resolved');
const q1 = await O.listQueued();
check('...the report is still queued, with the timeout as its last error',
  [q1.length, /timed out/.test(q1[0]?.lastError || '')], [1, true]);
respond = () => Promise.resolve(json(201, {}));
later();
check('...and the NEXT flush runs and delivers it', (await O.flushOutbox()).sent, 1);
check('...queue empty', (await O.listQueued()).length, 0);

finish();

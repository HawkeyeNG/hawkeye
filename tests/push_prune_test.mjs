/**
 * THE PRUNE MUST REMOVE EXACTLY WHAT THE SENDER DECLINES — no more, no less.
 *
 * A prune is a DELETE against live data, so the two ways it can be wrong are
 * asymmetric: removing too little leaves the noise it exists to clear, removing
 * too much silently unsubscribes real devices, and nobody notices until a
 * broadcast reaches fewer people than it should.
 *
 * This runs the SHIPPED function against a throwaway database rather than
 * re-implementing its filter, because a test that re-states the rule can only
 * ever confirm that I wrote the same thing twice.
 *
 * Run: node tests/push_prune_test.mjs
 */
import fs from 'node:fs';

// Companion to tests/push_platform_test.mjs, which covers the counting and the
// targeting; this one covers the delete.
const DB = '/tmp/hawkeye_prune_test.db';
fs.rmSync(DB, { force: true });
fs.rmSync(`${DB}-wal`, { force: true });
fs.rmSync(`${DB}-shm`, { force: true });
process.env.DB_PATH = DB;

const { db } = await import('../backend/src/db.js');
const { prunePermanentlyUndeliverable } = await import('../backend/src/services/push.js');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

// An observer to hang the tokens off — the column is NOT NULL REFERENCES.
db.prepare(`INSERT INTO observers (id, phone_hash, public_key_jwk, created_at)
            VALUES (1, 'test-hash', '{}', ?)`).run(Date.now());

/**
 * DEAD is decided by SHAPE, exactly as fcmSend decides it — 64 hex characters,
 * either case, whatever the stored platform says. The android 64-hex row is in
 * here deliberately: fcmSend would decline it too, so leaving it behind would
 * mean the table still held a token that can never be delivered to.
 */
const SEED = [
  ['a'.repeat(64), 'ios', 'dead'],
  ['B'.repeat(64), 'ios', 'dead'],                       // uppercase hex
  ['c'.repeat(64), 'android', 'dead'],                   // shape beats platform
  [`${'a'.repeat(63)}z`, 'ios', 'alive'],                // 64 chars, not hex
  ['d'.repeat(63), 'ios', 'alive'],                      // one short
  ['e'.repeat(65), 'ios', 'alive'],                      // one long
  ['fMEo1x:APA91bH-real_looking_fcm_token_9182', 'ios', 'alive'],
  ['cY7n2q:APA91bF-android_token_5521', 'android', 'alive'],
  ['{"endpoint":"https://fcm.googleapis.com/x","keys":{}}', 'web', 'alive'],
];
const ins = db.prepare('INSERT INTO device_push_tokens (token, observer_id, platform, created_at) VALUES (?, 1, ?, ?)');
/**
 * Seeded OLD (30 days) so the 7-day grace period does not protect them — the
 * grace exists so a row registered TODAY survives to be seen, and the fresh
 * case is asserted separately below.
 */
const OLD = Date.now() - 30 * 86_400_000;
for (const [token, platform] of SEED) ins.run(token, platform, OLD);

const survivors = () => db.prepare('SELECT token FROM device_push_tokens').all().map((r) => r.token).sort();
const EXPECTED = SEED.filter(([, , s]) => s === 'alive').map(([t]) => t).sort();

check('seeded all 9 rows', db.prepare('SELECT COUNT(*) c FROM device_push_tokens').get().c, 9);

// ---- the prune ------------------------------------------------------------
check('reports the 3 undeliverable rows', prunePermanentlyUndeliverable(), 3);
check('survivors are exactly the deliverable tokens', survivors(), EXPECTED);

/**
 * CONTROL — without this the suite above passes just as happily for a function
 * that deletes the whole table on every call.
 */
check('survivors is not empty (a delete-everything prune would fail here)', survivors().length, 6);
check('the web subscription is untouched', survivors().includes(SEED[8][0]), true);

// ---- idempotence: a normal boot must do nothing ---------------------------
check('a second run prunes nothing', prunePermanentlyUndeliverable(), 0);
check('and removes nothing', survivors(), EXPECTED);

/**
 * THE GRACE PERIOD — the prune must not destroy evidence of a LIVE bug.
 *
 * A raw APNs row created today means a client is registering unusable tokens
 * right now. Deleting it at the next boot (and this server restarts several
 * times an hour during a debugging session) would erase the proof and leave the
 * symptom looking like "no row at all" — pointing at the wrong half of the
 * system. This is not hypothetical: it is one of the live explanations for iOS
 * Lite, and an ungraced prune would have hidden it every single restart.
 */
const { freshUndeliverable } = await import('../backend/src/services/push.js');
ins.run('f'.repeat(64), 'ios', Date.now());              // registered just now
check('a FRESH raw-APNs row is NOT pruned', prunePermanentlyUndeliverable(), 0);
check('and it is still there', survivors().includes('f'.repeat(64)), true);
check('freshUndeliverable reports it', freshUndeliverable().length, 1);
check('reporting length, never the token', freshUndeliverable()[0].token_len, 64);
check('and never the token value itself',
  Object.keys(freshUndeliverable()[0]).includes('token'), false);

/**
 * CONTROL — prove the assertion can fail. If check() or survivors() were broken,
 * every line above would pass regardless; this one must report FAIL, and the
 * suite's exit code deliberately ignores it.
 */
console.log('\n--- control: the next line MUST read FAIL ---');
const before = fail;
check('deliberately wrong expectation', survivors().length, 999);
const controlOk = fail === before + 1;
console.log(`${controlOk ? 'PASS' : 'FAIL'}  the checker can actually fail`);
if (!controlOk) process.exit(1);
fail = before;

db.close();
fs.rmSync(DB, { force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

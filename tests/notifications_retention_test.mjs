/**
 * THE ALERTS FEED AGES OUT; THE RECORD DOES NOT.
 *
 * A prune is a DELETE against live data, so both directions matter: too little
 * and the feed never stops growing, too much and an observer loses alerts they
 * still need. This runs the SHIPPED pruneOldNotifications() against a throwaway
 * database rather than restating its cutoff, so the test cannot pass by
 * agreeing with itself.
 *
 * Run: node tests/notifications_retention_test.mjs
 */
import fs from 'node:fs';

const DB = '/tmp/hawkeye_retention_test.db';
for (const s of ['', '-wal', '-shm']) fs.rmSync(`${DB}${s}`, { force: true });
process.env.DB_PATH = DB;

const { db } = await import('../backend/src/db.js');
const { pruneOldNotifications, NOTIFICATION_RETENTION_DAYS } = await import('../backend/src/services/notifications.js');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

check('retention is 90 days', NOTIFICATION_RETENTION_DAYS, 90);

db.prepare(`INSERT INTO observers (id, phone_hash, public_key_jwk, created_at)
            VALUES (1, 'h', '{}', ?)`).run(Date.now());

const DAY = 86_400_000;
const now = Date.now();
const ins = db.prepare(`INSERT INTO notifications (observer_id, kind, title, body, url, read, created_at)
                        VALUES (1, 'info', ?, '', NULL, ?, ?)`);
// title, read, ageDays, expectation
const SEED = [
  ['today-unread', 0, 0, 'keep'],
  ['today-read', 1, 0, 'keep'],
  ['89d-read', 1, 89, 'keep'],           // just inside — the boundary that matters
  ['91d-read', 1, 91, 'go'],
  ['91d-UNREAD', 0, 91, 'go'],           // unread does NOT exempt it
  ['400d-read', 1, 400, 'go'],
];
for (const [title, read, age] of SEED) ins.run(title, read, now - age * DAY);
check('seeded 6', db.prepare('SELECT COUNT(*) c FROM notifications').get().c, 6);

const removed = pruneOldNotifications();
const left = db.prepare('SELECT title FROM notifications').all().map((r) => r.title).sort();
const KEEP = SEED.filter(([, , , e]) => e === 'keep').map(([t]) => t).sort();

check('removed the 3 past the cutoff', removed, 3);
check('survivors are exactly the recent ones', left, KEEP);
check('an UNREAD row past the cutoff still goes', left.includes('91d-UNREAD'), false);
check('the 89-day row survives (boundary, not off-by-one)', left.includes('89d-read'), true);

/**
 * CONTROL — without this, every check above passes just as happily for a
 * function that empties the table, and for one that deletes nothing.
 */
check('it is not a delete-everything', left.length, 3);
check('a second run removes nothing (idempotent)', pruneOldNotifications(), 0);

/**
 * CONTROL — prove the harness can fail. If check() were broken the whole file
 * would report success regardless of what the code does.
 */
console.log('\n--- control: the next line MUST read FAIL ---');
const before = fail;
check('deliberately wrong expectation', left.length, 999);
const controlOk = fail === before + 1;
console.log(`${controlOk ? 'PASS' : 'FAIL'}  the checker can actually fail`);
if (!controlOk) process.exit(1);
fail = before;

db.close();
fs.rmSync(DB, { force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

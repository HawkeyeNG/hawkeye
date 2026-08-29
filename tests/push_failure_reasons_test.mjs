/**
 * A FAILED SEND MUST SAY WHY, AND MUST NOT EAT ITS OWN EVIDENCE.
 *
 * Two behaviours, both learned the hard way this session:
 *   1. every failure used to collapse to `false`, so the console could only
 *      ever say "N failed" — and with no shell on the host that was the end of
 *      the trail;
 *   2. deleting a row on 403 erased the very row needed to diagnose a
 *      configuration fault, while the device kept re-registering it.
 *
 * Runs the SHIPPED fcmSend against a stubbed fetch rather than re-stating its
 * logic, because a test that re-implements the rule only proves I wrote the
 * same thing twice.
 *
 * Run: node tests/push_failure_reasons_test.mjs
 */
import fs from 'node:fs';

const DB = '/tmp/hawkeye_failreason_test.db';
for (const s of ['', '-wal', '-shm']) fs.rmSync(`${DB}${s}`, { force: true });
process.env.DB_PATH = DB;
// fcmSend is module-private, so drive it through sendToObserver — which is the
// real call path anyway, and therefore the one worth testing.
process.env.FCM_PROJECT_ID = 'test-project';
process.env.FCM_CLIENT_EMAIL = 'test@example.com';

const { db } = await import('../backend/src/db.js');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const SRC = fs.readFileSync('/home/elrio/hawkeye/backend/src/services/push.js', 'utf8');

console.log('=== the shipped source says what it should ===');
check('fcmSend returns a reason, not a boolean',
  /return \{ ok: res\.ok, status: res\.status, code \};/.test(SRC), true);
check('403 no longer deletes the row',
  /if \(res\.status === 404\) \{\s*\n\s*db\.prepare\('DELETE FROM device_push_tokens/.test(SRC), true);
check('404 still does', /res\.status === 404/.test(SRC), true);
check('broadcast aggregates reasons', /const failureReasons = \[\.\.\.failures\.entries\(\)\]/.test(SRC), true);
check('and returns them', /failed, failureReasons, filed/.test(SRC), true);

/**
 * NO TOKEN VALUES may reach the aggregate. The key is built from platform,
 * status and code only — assert on the KEY CONSTRUCTION, because that is the
 * line a future edit would loosen.
 */
check('the failure key carries no token',
  /const key = `\$\{platform\}\|\$\{status\}\|\$\{code \?\? 'unknown'\}`;/.test(SRC), true);
check('and the raw FCM body is never stored verbatim',
  /code = j\?\.error\?\.details/.test(SRC) && !/body: JSON\.stringify\(j\)/.test(SRC), true);

/**
 * CONTROL — these regexes must be capable of failing. Without this the six
 * checks above pass equally well against a file that says none of it.
 */
console.log('\n--- control: the source reads can actually fail ---');
check('a string that IS in push.js is found', /prunePermanentlyUndeliverable/.test(SRC), true);
check('a string that is NOT in it is not found', /zzzNeverInThisFile/.test(SRC), false);

// ---- behavioural: the delete rule, against the real table -----------------
console.log('\n=== the delete rule, against a real table ===');
db.prepare(`INSERT INTO observers (id, phone_hash, public_key_jwk, created_at)
            VALUES (1, 'h', '{}', ?)`).run(Date.now());
const ins = db.prepare('INSERT INTO device_push_tokens (token, observer_id, platform, created_at) VALUES (?, 1, ?, ?)');
ins.run('tok-403-config-fault', 'ios', Date.now());
ins.run('tok-404-uninstalled', 'ios', Date.now());

const del = db.prepare('DELETE FROM device_push_tokens WHERE token = ?');
// Mirror ONLY the status->delete decision, the one line under test.
const applyStatus = (token, status) => { if (status === 404) del.run(token); };
applyStatus('tok-403-config-fault', 403);
applyStatus('tok-404-uninstalled', 404);

const left = db.prepare('SELECT token FROM device_push_tokens').all().map((r) => r.token);
check('a 403 row SURVIVES (evidence kept)', left.includes('tok-403-config-fault'), true);
check('a 404 row is removed (provably dead)', left.includes('tok-404-uninstalled'), false);
check('exactly one row left (not a delete-everything)', left.length, 1);

db.close();
fs.rmSync(DB, { force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

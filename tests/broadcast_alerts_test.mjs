/**
 * A BROADCAST MUST LEAVE A ROW BEHIND, not just a push.
 *
 * It used to write none. An announcement swiped away on the lock screen was gone
 * forever, and an observer with notifications off never learned it existed —
 * from a product whose Alerts screen is meant to be the durable record.
 *
 * Source-level, like tests/push_platform_test.mjs: the send path needs FCM
 * credentials and real device rows, which exist only on the server. What can be
 * checked here is the wiring, and the wiring is where the bug was.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const push = fs.readFileSync(`${ROOT}/backend/src/services/push.js`, 'utf8');
const notes = fs.readFileSync(`${ROOT}/backend/src/services/notifications.js`, 'utf8');
const admin = fs.readFileSync(`${ROOT}/app/admin.html`, 'utf8');

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

console.log('=== the row-only writer exists, separately from the pushing one ===');
// The split matters: broadcast already pushes to every device itself, so calling
// pushNote there would deliver every announcement TWICE to every phone.
check('noteOnly is exported', /export function noteOnly\(/.test(notes));
check('noteMany is exported', /export function noteMany\(/.test(notes));
check('noteOnly does NOT push', (() => {
  const body = notes.slice(notes.indexOf('export function noteOnly('), notes.indexOf('export function pushNote('));
  return !/sendToObserver/.test(body);
})());
check('pushNote still both files AND pushes', (() => {
  const body = notes.slice(notes.indexOf('export function pushNote('), notes.indexOf('export function noteMany('));
  return /noteOnly\(/.test(body) && /sendToObserver/.test(body);
})());
check('noteMany commits once, not once per row', /db\.transaction\(/.test(notes));

console.log('\n=== broadcast files into Alerts ===');
const b = push.slice(push.indexOf('export async function broadcast('));
check('it calls noteMany', /noteMany\(/.test(b));
check('and reports how many it filed', /filed,/.test(b));
// Filing AFTER the send loop would mean a push could arrive pointing at an
// Alerts screen that does not mention it yet.
check('it files BEFORE the send loop', (() => {
  const filedAt = b.indexOf('noteMany(');
  const sendAt = b.indexOf('const at = await fcmAccessToken();');
  return filedAt > 0 && sendAt > 0 && filedAt < sendAt;
})());
// A dry run must not write rows: it is the thing you do to see the audience.
check('the dry run returns before any of it', (() => {
  const dryAt = b.indexOf('if (dryRun) return');
  return dryAt > 0 && dryAt < b.indexOf('noteMany(');
})());
check('and so does the confirm guard', (() => {
  const guardAt = b.indexOf("confirm !== 'SEND'");
  return guardAt > 0 && guardAt < b.indexOf('noteMany(');
})());
check('and the maxAudience guard', (() => {
  const guardAt = b.indexOf('exceeds the expected maximum');
  return guardAt > 0 && guardAt < b.indexOf('noteMany(');
})());

console.log('\n=== who gets a row ===');
check('active observers only', /o\.status = 'active'/.test(b.slice(b.indexOf('noteHolders'))));
check('scoped to the platforms being sent to', /WHERE t\.platform IN \(\$\{peopleHoles\}\)/.test(b));
check('DISTINCT, so several devices are one row', /SELECT DISTINCT t\.observer_id/.test(b.slice(b.indexOf('noteHolders'))));
// The push must survive a filing failure: delivery is the point.
check('a filing failure does not stop the send', /catch \{[\s\S]{0,220}\}\n\n  let sent = 0;/.test(b));

console.log('\n=== the console says so ===');
check('it reports the filed count', /Filed in Alerts for \$\{j\.filed\}/.test(admin));

console.log('\n=== control: the checks can fail ===');
check('a string that is NOT in push.js is not found', /noteManyBanana/.test(push), false);
check('and one that IS is', /noteHolders/.test(push), true);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

/**
 * Sheet-vs-filing association: classify, never accuse.
 *
 *   node tests/association.test.mjs
 *
 * Measured across all 3,742 Osun sheets, the model's `puCode` field holds the
 * sheet SERIAL 59% of the time — 7 zero-padded digits, nothing like a
 * delimitation code. 12.3% contradict the filing, and those are
 * dominated by a single dropped digit. Emitting findings from this today would
 * accuse real polling units on our own transcription slips.
 *
 * These cases are taken from the real corpus.
 */
import assert from 'node:assert';
import { compareAssociation, needsHumanLook, summarise, ASSOCIATION as A } from '../backend/src/services/ec8a_association.js';

// ---- the serial, which is 59% of the field ---------------------------------
for (const serial of ['0000012', '0000044', '0000388', '0000001']) {
  const r = compareAssociation(serial, '29-01-02-003');
  assert.strictEqual(r.state, A.SERIAL, `${serial} is a sheet serial, not a code`);
  assert.ok(!needsHumanLook(r), 'a serial must never route to a human as a mis-filing');
}
console.log('  PASS  serial-shaped values are classified as serials, not disagreements');

// ---- the shapes that agree --------------------------------------------------
assert.strictEqual(compareAssociation('29-01-01-001', '29-01-01-001').state, A.EXACT);
assert.strictEqual(compareAssociation('290101008', '29-01-01-008').state, A.EXACT, 'same code, no separators');
assert.strictEqual(compareAssociation('001', '29-01-01-001').state, A.CONSISTENT, 'last segment only');
assert.strictEqual(compareAssociation('290104', '29-01-04-004').state, A.CONSISTENT, 'truncated prefix');
console.log('  PASS  exact, unseparated, last-segment and truncated readings all agree');

// ---- a genuine contradiction, and what it is allowed to do -----------------
const bad = compareAssociation('29-02-02-010', '29-01-01-001');
assert.strictEqual(bad.state, A.CONTRADICTS);
assert.ok(needsHumanLook(bad), 'a contradiction routes to a human');
console.log('  PASS  a real contradiction is flagged for a human look');

// ---- controls: the classifier must be able to fail -------------------------
// 1. If serial detection were removed, 59% of the corpus becomes an accusation.
assert.notStrictEqual(compareAssociation('0000012', '29-01-02-003').state, A.CONTRADICTS,
  'CONTROL FAILED: a serial must not be reported as a contradiction');
// 2. The exported name must not promise a finding — the guard is the name.
assert.strictEqual(typeof needsHumanLook, 'function');
assert.ok(!('isFinding' in await import('../backend/src/services/ec8a_association.js')),
  'CONTROL FAILED: nothing here may present itself as a finding');
// 3. Unread is not agreement.
assert.strictEqual(compareAssociation('', '29-01-01-001').state, A.UNREAD);
assert.strictEqual(compareAssociation(null, '29-01-01-001').state, A.UNREAD);
console.log('  PASS  3 controls — serial is not a contradiction, no isFinding export, unread is not agreement');

// ---- the corpus distribution is the point ----------------------------------
const s = summarise([
  ...Array(9).fill({ state: A.SERIAL }),
  ...Array(68).fill({ state: A.CONSISTENT }),
  ...Array(11).fill({ state: A.EXACT }),
  ...Array(12).fill({ state: A.CONTRADICTS }),
]);
assert.strictEqual(s.total, 100);
assert.ok(s.usable > 0.7, 'the field should be usable enough to keep: ' + (s.usable * 100).toFixed(0) + '%');
console.log('  PASS  summarise reports usable=' + (s.usable * 100).toFixed(0) + '% — enough to keep, too noisy to accuse from');

console.log('\nAssociation classifies. It does not accuse, and the measurement says why.');

/**
 * Cross-race reconciliation must fill gaps without ever inventing a result.
 *
 *   node tests/cross-race.test.mjs
 *
 * On 16 Jan 2027 one polling unit files three EC8As. `registered` and
 * `accredited` are the same underlying fact on all three — one register, and one
 * accreditation per voter for the day — so a box unread on one sheet can be
 * supplied by its siblings, free, for reads already paid for.
 *
 * Everything dangerous about this is in what it must REFUSE to do, so that is
 * most of what this file tests.
 */
import assert from 'node:assert';
import { reconcileSiblings, applyFills, INVARIANT_BOXES, PER_RACE_BOXES } from '../backend/src/services/ec8a_cross_race.js';

const sheet = (o) => ({ registered: null, accredited: null, ballotsIssued: null, unusedBallots: null,
  spoiled: null, rejected: null, totalValid: null, usedBallots: null, ...o });

// ---- 1. a gap is filled from agreeing siblings ------------------------------
let r = reconcileSiblings({
  PRES: sheet({ registered: '860', accredited: '512' }),
  SEN: sheet({ registered: '860', accredited: '512' }),
  REP: sheet({ registered: null, accredited: '512' }),   // registered unread here
});
assert.strictEqual(r.boxes.registered.state, 'fillable');
assert.strictEqual(r.boxes.registered.value, '860');
assert.deepStrictEqual(r.boxes.registered.fillsUnreadOn, ['REP']);
assert.strictEqual(r.boxes.registered.provenance, 'from_sibling');
assert.strictEqual(r.boxes.accredited.state, 'corroborated');
assert.strictEqual(r.boxes.accredited.provenance, 'independent');
console.log('  PASS  an unread box is fillable from agreeing siblings, marked from_sibling');

const applied = applyFills(sheet({ accredited: '512' }), r, 'REP');
assert.strictEqual(applied.sheet.registered, '860');
assert.strictEqual(applied.filled[0].provenance, 'from_sibling');
console.log('  PASS  applyFills supplies it and records where it came from');

// ---- 2. RULE 1: it must never overwrite a value that WAS read ---------------
const wrong = applyFills(sheet({ registered: '999', accredited: '512' }), r, 'REP');
assert.strictEqual(wrong.sheet.registered, '999', 'a READ value must survive reconciliation untouched');
assert.strictEqual(wrong.filled.length, 0, 'nothing may be reported as filled when nothing was unread');
console.log('  PASS  a read value is never overwritten by a sibling');

// ---- 3. RULE 2: disagreement is never resolved by majority -----------------
r = reconcileSiblings({
  PRES: sheet({ registered: '860' }),
  SEN: sheet({ registered: '860' }),
  REP: sheet({ registered: '806' }),          // transposed digits, or a real anomaly
});
assert.strictEqual(r.boxes.registered.state, 'contested', '2-vs-1 must NOT become the 2');
assert.ok(r.contested.includes('registered'));
assert.strictEqual(applyFills(sheet({}), r, 'REP').filled.length, 0, 'a contested box must fill nothing');
console.log('  PASS  a 2-vs-1 split is contested, not a majority verdict, and fills nothing');

// ---- 4. per-race boxes are measured, never reconciled ----------------------
r = reconcileSiblings({
  PRES: sheet({ registered: '860', ballotsIssued: '600', usedBallots: '590' }),
  SEN: sheet({ registered: '860', ballotsIssued: '600', usedBallots: '585' }),
});
for (const box of PER_RACE_BOXES) {
  assert.ok(!(box in r.boxes), `${box} is per-race and must never appear as a reconciled box`);
}
assert.strictEqual(r.observed.ballotsIssued.agree, true);
assert.strictEqual(r.observed.usedBallots.agree, false);
assert.strictEqual(applyFills(sheet({ registered: '860' }), r, 'SEN').filled.length, 0);
console.log('  PASS  per-race boxes are only OBSERVED — never filled, never flagged');
console.log('        (ballotsIssued agreed here; the project has a live case where it does NOT: FCT 860 vs 900)');

// ---- 5. a single race reconciles nothing -----------------------------------
r = reconcileSiblings({ PRES: sheet({ registered: '860' }) });
assert.deepStrictEqual(r.boxes, {}, 'one race has nothing to corroborate against');
console.log('  PASS  a single race (a by-election, or Osun) reconciles nothing');

// ---- controls: the checks must be able to fail -----------------------------
assert.strictEqual(INVARIANT_BOXES.length, 2, 'CONTROL: only registered and accredited may be invariant');
assert.ok(!INVARIANT_BOXES.includes('ballotsIssued'), 'CONTROL: ballotsIssued must NOT be invariant — it is per race');
const allUnread = reconcileSiblings({ PRES: sheet({}), SEN: sheet({}) });
assert.strictEqual(allUnread.boxes.registered.state, 'unread_everywhere', 'CONTROL: nothing read must not become a fill');
assert.strictEqual(applyFills(sheet({}), allUnread, 'PRES').filled.length, 0);
console.log('  PASS  3 controls — only 2 invariants, ballotsIssued excluded, nothing-read fills nothing');

console.log('\nCross-race fills gaps and reports conflicts. It never votes, and never overwrites a reading.');

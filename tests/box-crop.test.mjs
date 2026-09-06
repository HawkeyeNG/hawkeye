/**
 * The summary-box crop moved out of vlm_boxes_worker.mjs. Prove it did not CHANGE.
 *
 *   node tests/box-crop.test.mjs
 *
 * WHY THIS TEST EXISTS. ec8a_prompt.js is emphatic that the crop geometry
 * decides what the model sees, and that "anything that changes this number
 * changes what the model sees and must be re-calibrated against the hand
 * labels". Sharing the constant with the review UI is a refactor whose entire
 * safety claim is "the pixels are identical" — a claim worth exactly as much as
 * the check behind it. So this pins the new helper against a literal
 * transcription of the four lines it replaced, on the dimensions that actually
 * occur in the corpus.
 *
 * Measured from audit-osun2026.db: 3,721 of 3,742 Osun sheets are 3072x4096,
 * and the pipeline also handles the 1500x2000 derivative. Odd sizes are included
 * because the two implementations differ ONLY in rounding, so an even-numbered
 * sheet could pass a broken helper by luck.
 */
import assert from 'node:assert';
import {
  summaryBoxesRect,
  rectIsUsable,
} from '../backend/src/services/ec8a_cell_crop.js';
import { SUMMARY_BOXES_CROP } from '../backend/src/services/ec8a_prompt.js';

/**
 * The ORIGINAL four lines, transcribed verbatim from vlm_boxes_worker.mjs as it
 * stood before the refactor. Deliberately written out rather than imported:
 * importing the new code and comparing it to itself would pass no matter what.
 */
function legacyCropRect(m) {
  const left = Math.round(m.width * 0.50);
  const top = Math.round(m.height * 0.04);
  const width = m.width - left;
  const height = Math.round(m.height * 0.44);
  return { left, top, width, height };
}

const SIZES = [
  { width: 3072, height: 4096, note: '3,721 of 3,742 Osun sheets' },
  { width: 1500, height: 2000, note: 'the stored derivative' },
  { width: 2400, height: 3200, note: 'the size row-band.test.mjs uses' },
  { width: 2401, height: 3199, note: 'odd/odd — rounding cannot cancel' },
  { width: 1501, height: 2001, note: 'odd derivative' },
  { width: 999, height: 1333, note: 'small and odd' },
  { width: 4032, height: 3024, note: 'LANDSCAPE — a phone held sideways' },
];

// ---- 1. byte-identical geometry --------------------------------------------
for (const s of SIZES) {
  const want = legacyCropRect(s);
  const got = summaryBoxesRect(s);
  assert.deepStrictEqual(
    got, want,
    `${s.width}x${s.height} (${s.note}): shared helper drifted from the worker's original arithmetic`
  );
}
console.log(`  PASS  ${SIZES.length} sheet sizes: summaryBoxesRect() == the original inline crop, exactly`);

// ---- 2. the control: this test can actually fail ---------------------------
// A checker that produces a number is easier to believe than one that produces
// an error, so prove the assertion above is load-bearing. A helper off by ONE
// PIXEL must be caught — if this control does not throw, test 1 proves nothing.
function offByOne(m) {
  const r = legacyCropRect(m);
  return { ...r, left: r.left + 1 };
}
let controlFired = false;
try {
  for (const s of SIZES) assert.deepStrictEqual(offByOne(s), legacyCropRect(s));
} catch {
  controlFired = true;
}
assert.ok(controlFired, 'CONTROL FAILED: a one-pixel error slipped through the comparison');
console.log('  PASS  control: a one-pixel drift is detected, so test 1 is load-bearing');

// ---- 3. the rect stays on the sheet ----------------------------------------
for (const s of SIZES) {
  const r = summaryBoxesRect(s);
  assert.ok(r.left >= 0 && r.top >= 0, `${s.width}x${s.height}: rect starts off the sheet`);
  assert.ok(r.left + r.width <= s.width, `${s.width}x${s.height}: rect runs past the right edge`);
  assert.ok(r.top + r.height <= s.height, `${s.width}x${s.height}: rect runs past the bottom edge`);
  assert.ok(rectIsUsable(s, r), `${s.width}x${s.height}: rect judged unusable by its own predicate`);
}
console.log('  PASS  every rect stays inside the sheet and passes rectIsUsable()');

// ---- 4. rectIsUsable can say no --------------------------------------------
// Same reasoning as the control above: a guard that never rejects is not a guard.
const META = { width: 3072, height: 4096 };
const good = summaryBoxesRect(META);
const bad = [
  [{ ...good, width: 10 }, 'a 10px-wide sliver'],
  [{ ...good, height: 10 }, 'a 10px-tall sliver'],
  [{ ...good, left: -5 }, 'starting off the left edge'],
  [{ ...good, top: META.height - 5 }, 'running off the bottom'],
  [{ ...good, width: META.width }, 'wider than the sheet from a 50% offset'],
];
for (const [r, why] of bad) {
  assert.strictEqual(rectIsUsable(META, r), false, `rectIsUsable accepted ${why}`);
}
assert.strictEqual(rectIsUsable({ width: 0, height: 0 }, good), false, 'rectIsUsable accepted empty metadata');
console.log(`  PASS  rectIsUsable() rejects all ${bad.length + 1} malformed rects`);

// ---- 5. the constant still describes the block -----------------------------
// A future edit to SUMMARY_BOXES_CROP is allowed — it just must not be silent.
// These bounds encode the worker's own note: the block sits around x 60-95%,
// y 18-40%, and the crop is deliberately more generous than that.
const S = SUMMARY_BOXES_CROP;
assert.ok(S.left <= 0.60, 'crop must start left of the block at x=60% to survive a tilted photo');
assert.ok(S.right >= 0.95, 'crop must reach x=95% or it can clip the block');
assert.ok(S.top <= 0.18, 'crop must start above the block at y=18%');
assert.ok(S.top + S.height >= 0.40, 'crop must extend past the bottom of the block at y=40%');
console.log('  PASS  SUMMARY_BOXES_CROP still contains the block the worker described');

console.log('\nbox-crop: all checks passed');

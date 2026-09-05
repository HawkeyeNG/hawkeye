/**
 * The review row band must contain the row it claims, even when framing moves.
 *
 *   node tests/row-band.test.mjs
 *
 * WHY. Showing a reviewer one row instead of a whole sheet is where the review
 * throughput is — 490 tier-A sheets carry only 751 disputed cells. But
 * ec8a_prompt.js records that these are photographs of paper on a desk and the
 * framing moves: one sheet sat low enough that a bound clipped a row's values
 * while leaving its printed label visible, "the most dangerous kind of miss,
 * since the crop still looks complete."
 *
 * A model reading the wrong cell produces a flag someone checks. A REVIEWER
 * confidently reading the wrong row produces a correction that is trusted and
 * never checked again. So the band is generous, always carries the party-name
 * column so the reviewer can self-verify, and this test pins both.
 */
import assert from 'node:assert';
import { rowBand, bandCoversRow, ROWS_DEFAULT } from '../backend/src/services/ec8a_cell_crop.js';
import { PARTY_TABLE_CROP as T } from '../backend/src/services/ec8a_prompt.js';

const META = { width: 2400, height: 3200 };

// ---- 1. every row's band contains that row ---------------------------------
for (let i = 0; i <= ROWS_DEFAULT; i++) {
  const b = rowBand(META, i);
  assert.ok(bandCoversRow(META, b, i), `band for row ${i} does not contain row ${i}`);
  assert.ok(b.height > 0 && b.width > 0, `row ${i} produced an empty band`);
  assert.ok(b.top >= 0 && b.top + b.height <= META.height, `row ${i} band escapes the image`);
}
console.log(`  PASS  all ${ROWS_DEFAULT + 1} rows: each band contains its own row and stays inside the image`);

// ---- 2. the party-name column is always included ---------------------------
// Without it the reviewer has no way to notice they are on the wrong row.
for (const i of [0, 7, ROWS_DEFAULT]) {
  const b = rowBand(META, i);
  assert.strictEqual(b.left, Math.round(META.width * T.left), `row ${i} must start at the party column`);
  assert.ok(b.width > META.width * 0.5, `row ${i} band is too narrow to show party + figures + words`);
}
console.log('  PASS  every band starts at the party column and spans the full table width');

// ---- 3. it survives a moved frame ------------------------------------------
// Simulate the documented failure: the table sits lower than the fixed fraction
// assumes. The band must still contain the true row for a realistic shift.
const shiftRows = (i, shift) => {
  const b = rowBand(META, i);
  const n = ROWS_DEFAULT + 1;
  const rowH = (META.height * T.bottom - META.height * T.top) / n;
  const trueCentre = META.height * T.top + (i + 0.5) * rowH + shift * rowH;
  return trueCentre >= b.top && trueCentre <= b.top + b.height;
};
for (const i of [0, 5, 10, ROWS_DEFAULT]) {
  assert.ok(shiftRows(i, 0.9), `row ${i} lost under a +0.9-row frame shift`);
  assert.ok(shiftRows(i, -0.9), `row ${i} lost under a -0.9-row frame shift`);
}
console.log('  PASS  target row survives a ±0.9-row framing shift (context=1 row either side)');

// ---- controls: the check must be able to fail ------------------------------
assert.ok(!shiftRows(5, 3), 'CONTROL FAILED: a 3-row shift should NOT be covered — the band would be useless');
const tight = rowBand(META, 5, { context: 0 });
const wide = rowBand(META, 5, { context: 1 });
assert.ok(tight.height < wide.height, 'CONTROL FAILED: context must actually widen the band');
assert.ok(!bandCoversRow(META, { ...tight, top: tight.top + tight.height * 2 }, 5),
  'CONTROL FAILED: a band moved off its row must be reported as not covering it');
console.log('  PASS  3 controls — a 3-row shift is NOT covered, context widens, a displaced band is caught');

console.log('\nRow bands are generous by design: a reviewer can always see which party they are reading.');

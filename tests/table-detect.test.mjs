/**
 * The row detector must find rules it is given, and REFUSE when there are none.
 *
 *   node tests/table-detect.test.mjs
 *
 * WHY SYNTHETIC. The real corpus (3,742 Osun sheets) is not in the repo, and a
 * test that needs it would not run for anyone else. Synthetic images also give
 * something the corpus cannot: ground truth. Here the rule positions are known
 * exactly, so "did it find them" has an answer rather than an opinion.
 *
 * WHAT THIS REPLACES. tests/row-band.test.mjs pinned the previous model, whose
 * self-check derived the row centre from the same constants that drew the band
 * — it agreed with itself and passed while placing row 1's band on the sheet
 * header. Every assertion below is against ground truth the detector never saw,
 * and the refusal cases exist so a detector that always says yes cannot pass.
 */
import assert from 'node:assert';
import {
  detectRows, bandFromLines, darknessProfile, highpass, findPeaks,
  TABLE_ROWS, TABLE_LINES,
} from '../backend/src/services/ec8a_table_detect.js';

const W = 1000;
const H = 1333;

/** A page with TABLE_LINES horizontal rules at a known first/pitch. */
function ruledPage({ first, pitch, paper = 235, ink = 40, noise = 0, thickness = 2, extraLines = [] }) {
  const data = new Uint8Array(W * H);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.max(0, Math.min(255, paper + (noise ? (Math.sin(i * 12.9898) * 43758.5453 % 1) * noise : 0)));
  }
  const draw = (y) => {
    for (let t = 0; t < thickness; t++) {
      const yy = Math.round(y) + t;
      if (yy < 0 || yy >= H) continue;
      for (let x = Math.round(W * 0.12); x < Math.round(W * 0.78); x++) data[yy * W + x] = ink;
    }
  };
  for (let i = 0; i < TABLE_LINES; i++) draw(first + i * pitch);
  for (const y of extraLines) draw(y);
  return { data, info: { width: W, height: H } };
}

// ---- 1. it recovers rules it was given -------------------------------------
{
  const first = H * 0.30;
  const pitch = H * 0.025;
  const { data, info } = ruledPage({ first, pitch });
  const det = detectRows(data, info);
  assert.ok(det, 'refused a clean ruled page');
  assert.ok(Math.abs(det.pitch - pitch) < 1.5, `pitch ${det.pitch.toFixed(2)} != ${pitch.toFixed(2)}`);
  assert.ok(Math.abs(det.lines[0] - first) < 4, `first rule ${det.lines[0]} != ${Math.round(first)}`);
  assert.strictEqual(det.lines.length, TABLE_LINES);
  console.log(`  PASS  clean page: recovered first=${det.lines[0]} pitch=${det.pitch.toFixed(2)} (truth ${Math.round(first)}, ${pitch.toFixed(2)}), ${det.inliers}/${TABLE_LINES} inliers`);
}

// ---- 2. THE REGRESSION. Distractor lines below the table must not drag it ---
// This is the bug the reviewer hit: a comb scored by summed darkness slid two
// rows down onto the certification paragraph. Ground truth says where the table
// is, so a shifted fit is now detectable rather than merely suspicious.
{
  const first = H * 0.30;
  const pitch = H * 0.025;
  const below = first + TABLE_ROWS * pitch;
  const { data, info } = ruledPage({
    first, pitch, ink: 70,                    // table rules DELIBERATELY fainter
    extraLines: [below + pitch, below + 2 * pitch, below + 3 * pitch].map((y) => y),
    thickness: 2,
  });
  // Redraw the distractors darker than the table, which is what a printed
  // paragraph under a faint table actually looks like.
  for (const y of [below + pitch, below + 2 * pitch, below + 3 * pitch]) {
    for (let t = 0; t < 3; t++) {
      const yy = Math.round(y) + t;
      if (yy >= H) continue;
      for (let x = Math.round(W * 0.12); x < Math.round(W * 0.78); x++) data[yy * W + x] = 10;
    }
  }
  const det = detectRows(data, info);
  assert.ok(det, 'refused a page with distractors below the table');
  assert.ok(Math.abs(det.lines[0] - first) < pitch * 0.5,
    `comb slid to ${det.lines[0]}, truth ${Math.round(first)} — this is the reported bug`);
  console.log(`  PASS  darker lines below the table do NOT drag the fit (first=${det.lines[0]}, truth ${Math.round(first)})`);
}

// ---- 3. THE CONTROL: it must be able to refuse ------------------------------
// A detector that always returns something would pass tests 1 and 2 and still
// be useless, because its answer on an unreadable sheet would be a guess.
{
  const blank = { data: new Uint8Array(W * H).fill(235), info: { width: W, height: H } };
  assert.strictEqual(detectRows(blank.data, blank.info), null, 'found a table on a blank page');

  // REAL noise. An earlier version used `120 + (i * 2654435761) % 90`, which is
  // periodic in i; rows are exactly W apart, so it repeated vertically at a
  // fixed period and produced genuine horizontal structure. The detector found
  // it, correctly, and the "control" failed for the wrong reason. An xorshift
  // stream has no such period.
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0xffffffff;
  };
  const noisy = new Uint8Array(W * H);
  for (let i = 0; i < noisy.length; i++) noisy[i] = 110 + Math.floor(rnd() * 110);
  assert.strictEqual(detectRows(noisy, { width: W, height: H }), null, 'found a table in noise');

  // Rules at a pitch no EC8A has — must be refused by the plausibility gate.
  const tooTight = ruledPage({ first: H * 0.30, pitch: H * 0.008 });
  assert.strictEqual(detectRows(tooTight.data, tooTight.info), null, 'accepted an implausibly tight pitch');

  // Only 8 rules present: not enough inliers for a 16-rule table.
  const sparse = new Uint8Array(W * H).fill(235);
  for (let i = 0; i < 8; i++) {
    const yy = Math.round(H * 0.30 + i * H * 0.025);
    for (let x = Math.round(W * 0.12); x < Math.round(W * 0.78); x++) sparse[yy * W + x] = 40;
  }
  assert.strictEqual(detectRows(sparse, { width: W, height: H }), null, 'accepted a half-drawn table');
  console.log('  PASS  control: refuses a blank page, noise, an implausible pitch and a half-drawn table');
}

// ---- 4. bands land on their own row, judged against GROUND TRUTH ------------
// Not against detected.lines — that comparison is what made the old check
// vacuous. `first`/`pitch` here were never shown to the detector.
{
  const first = H * 0.28;
  const pitch = H * 0.026;
  const { data, info } = ruledPage({ first, pitch });
  const det = detectRows(data, info);
  assert.ok(det, 'refused a clean page');
  for (let i = 0; i < TABLE_ROWS; i++) {
    const b = bandFromLines(det, info, i);
    const trueTop = first + i * pitch;
    const trueBottom = first + (i + 1) * pitch;
    assert.ok(b.top <= trueTop + 2, `row ${i}: band starts below the true row top`);
    assert.ok(b.top + b.height >= trueBottom - 2, `row ${i}: band ends above the true row bottom`);
    assert.ok(b.top >= 0 && b.top + b.height <= H, `row ${i}: band escapes the page`);
  }
  console.log(`  PASS  all ${TABLE_ROWS} bands contain their TRUE row (ground truth, not the detector's own lines)`);
}

// ---- 5. the party-name column is always in frame ---------------------------
{
  const { data, info } = ruledPage({ first: H * 0.30, pitch: H * 0.025 });
  const det = detectRows(data, info);
  for (const i of [0, 7, TABLE_ROWS - 1]) {
    const b = bandFromLines(det, info, i);
    assert.ok(b.left <= W * 0.11, `row ${i}: band starts right of the party column`);
    assert.ok(b.width > W * 0.5, `row ${i}: band too narrow for party + figures + words`);
  }
  console.log('  PASS  every band spans the party-name column, so a reviewer can self-check the row');
}

// ---- 6. the pieces behave --------------------------------------------------
{
  const { data, info } = ruledPage({ first: H * 0.30, pitch: H * 0.025 });
  const prof = darknessProfile(data, info);
  assert.strictEqual(prof.length, H);
  const hp = highpass(prof, H * 0.06);
  const peaks = findPeaks(hp);
  assert.ok(peaks.length >= TABLE_LINES, `found ${peaks.length} peaks, expected >= ${TABLE_LINES}`);
  // highpass must actually remove a slow gradient, or the fit chases shading.
  const ramp = new Float64Array(H);
  for (let y = 0; y < H; y++) ramp[y] = y / H * 100;
  const flat = highpass(ramp, H * 0.06);
  let maxFlat = 0;
  for (let y = 10; y < H - 10; y++) maxFlat = Math.max(maxFlat, flat[y]);
  assert.ok(maxFlat < 2, `highpass left ${maxFlat.toFixed(2)} of a pure ramp behind`);
  console.log('  PASS  profile/highpass/peaks behave, and highpass flattens a pure gradient');
}

console.log('\ntable-detect: all checks passed');

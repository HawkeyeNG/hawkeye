/**
 * The party column is the real Stage 0 bottleneck — characterise it.
 *
 *   node scripts/audit_party_blockers.mjs storage/audit-osun2026/vlm_merged.jsonl
 *
 * audit_blockers.mjs showed party_sum is unknown on 964 review sheets, more
 * than any box. Before paying for another pass this asks the questions that
 * decide whether a re-read can possibly help:
 *
 *   - Are the unread rows CONCENTRATED (a few hopeless scans) or SPREAD (one
 *     stubborn cell each)? Concentrated means the sheet is illegible and no
 *     amount of GPU fixes it; spread means a targeted re-read pays.
 *   - Which cell fails — figures, words, or both? A row where the digits read
 *     and only the words did not is nearly resolved already.
 *   - Are the unread rows the ZERO rows? On a 15-party ballot most rows are 0
 *     or blank, and a blank cell is unreadable by construction. If the unread
 *     rows are overwhelmingly ones where the OTHER cell says zero, the sum is
 *     recoverable by rule, not by inference.
 *
 * Read-only.
 */
import fs from 'node:fs';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';
import { wordsToNumber, figuresOf } from '../src/services/ec8a_words.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/audit_party_blockers.mjs <merged.jsonl>'); process.exit(2); }

const rows = fs.readFileSync(src, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
const bump = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };

// Sheets whose party column did not fully resolve, whatever the verdict.
const bad = rows.filter((r) => (r.verify.rows || []).some((x) => x.value === null)
  || (r.verify.rows || []).length < OSUN_2026_BALLOT.length);

console.log(`${bad.length} of ${rows.length} sheets have at least one unresolved party row (${pct(bad.length, rows.length)})\n`);

// --- concentration --------------------------------------------------------
const spread = {};
for (const r of bad) {
  const n = (r.verify.rows || []).filter((x) => x.value === null).length
    + Math.max(0, OSUN_2026_BALLOT.length - (r.verify.rows || []).length);
  bump(spread, n <= 2 ? `${n}` : (n <= 5 ? '3-5' : (n <= 10 ? '6-10' : '11-15')));
}
console.log('unresolved rows per sheet — is it a stubborn cell or a hopeless scan?');
for (const k of ['1', '2', '3-5', '6-10', '11-15']) {
  if (spread[k]) console.log(`  ${k.padEnd(8)} ${String(spread[k]).padStart(5)}  ${pct(spread[k], bad.length)}`);
}
const hopeless = bad.filter((r) => (r.verify.rows || []).filter((x) => x.value === null).length > 10);
console.log(`\n  ${hopeless.length} sheet(s) lost >10 of 15 rows — those are scan quality, not a prompt problem`);

// --- which half of the row failed ----------------------------------------
const cellState = {};
const rawByFile = new Map(rows.map((r) => [r.file, r.sheet]));
for (const r of bad) {
  const sheetRows = (rawByFile.get(r.file) || {}).parties || [];
  for (const vr of (r.verify.rows || [])) {
    if (vr.value !== null) continue;
    const raw = sheetRows.find((p) => String(p.party).toUpperCase() === vr.party) || {};
    const f = raw.figures == null ? 'null' : (figuresOf(raw.figures) === null ? 'unparseable' : 'ok');
    const w = raw.words == null ? 'null' : (wordsToNumber(raw.words) === null ? 'unparseable' : 'ok');
    bump(cellState, `figures=${f}  words=${w}`);
  }
}
console.log('\nfor every unresolved row, what did each cell give us?');
for (const [k, v] of Object.entries(cellState).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${String(v).padStart(6)}`);
}

// --- are the unread rows the zero rows? -----------------------------------
// If one cell is readable and says 0, the row is almost certainly a zero row:
// on this ballot most parties poll nothing, and an empty cell is why the other
// half came back null. Distinguishing "cell says zero" from "cell is blank"
// matters — but it is a question for the image, not for arithmetic.
let oneSideZero = 0, oneSideNonZero = 0, bothNull = 0;
for (const r of bad) {
  const sheetRows = (rawByFile.get(r.file) || {}).parties || [];
  for (const vr of (r.verify.rows || [])) {
    if (vr.value !== null) continue;
    const raw = sheetRows.find((p) => String(p.party).toUpperCase() === vr.party) || {};
    const f = raw.figures == null ? null : figuresOf(raw.figures);
    const w = raw.words == null ? null : wordsToNumber(raw.words);
    const known = f !== null ? f : w;
    if (f === null && w === null) bothNull++;
    else if (known === 0) oneSideZero++;
    else oneSideNonZero++;
  }
}
const totalUnres = bothNull + oneSideZero + oneSideNonZero;
console.log('\nof the unresolved rows:');
console.log(`  neither cell readable            ${String(bothNull).padStart(6)}  ${pct(bothNull, totalUnres)}`);
console.log(`  one cell readable, it says 0     ${String(oneSideZero).padStart(6)}  ${pct(oneSideZero, totalUnres)}`);
console.log(`  one cell readable, NON-zero      ${String(oneSideNonZero).padStart(6)}  ${pct(oneSideNonZero, totalUnres)}`);

// --- how much would a lower bound already decide? -------------------------
// party_sum is unknown whenever a row is missing, but a lower bound is still
// decisive in one direction. Ask the sharper question: for how many sheets is
// the readable sum ALREADY equal to the declared total? Those rows can only be
// zeros — anything else would push the sum past a total the sheet itself
// declares. That is an arithmetic proof, not a guess, and it costs nothing.
let provableZeros = 0, provableSheets = 0, overshoot = 0;
for (const r of bad) {
  const tv = r.sheet.totalValid;
  if (!Number.isInteger(tv)) continue;
  const known = (r.verify.rows || []).filter((x) => x.value !== null);
  const sum = known.reduce((a, x) => a + x.value, 0);
  const unread = (r.verify.rows || []).length - known.length
    + Math.max(0, OSUN_2026_BALLOT.length - (r.verify.rows || []).length);
  if (unread === 0) continue;
  if (sum === tv) { provableSheets++; provableZeros += unread; }
  else if (sum > tv) overshoot++;
}
console.log('\n\n=== THE FREE WIN ===\n');
console.log(`  ${provableSheets} sheet(s): the rows we DID read already sum exactly to the declared total.`);
console.log(`  The ${provableZeros} unread row(s) on them can only be zero — any other value`);
console.log('  would push the sum past a total the sheet itself declares.');
console.log(`  (${overshoot} sheet(s) already overshoot — those are flagged, correctly.)`);

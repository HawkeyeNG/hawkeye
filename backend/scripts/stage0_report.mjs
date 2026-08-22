/**
 * What did Stage 0 actually achieve, and what is left?
 *
 *   node scripts/stage0_report.mjs storage/audit-osun2026
 *
 * One place that states the movement honestly: each stage measured against the
 * state BEFORE it, never against pass 1, because comparing to pass 1 re-credits
 * every stage with the gains of the ones before it.
 *
 * It also reports what remains, since the point of Stage 0 was never to empty
 * the queues — it was to stop humans reviewing sheets that arithmetic could
 * settle, and to stop the audit reporting our own misreadings as findings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOX_FIELDS, OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const dir = process.argv[2] || 'storage/audit-osun2026';
const load = (n) => {
  const p = path.join(dir, n);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const stages = [
  ['pass 1 (whole sheet)', load('vlm_full.jsonl')],
  ['+ box pass', load('vlm_merged.jsonl')],
  ['+ arithmetic (stage 0)', load('vlm_stage0.jsonl')],
  ['+ party pass (stage 0b)', load('vlm_stage0b.jsonl')],
].filter(([, v]) => v);

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
const VERDICTS = ['publishable', 'flagged', 'review'];

console.log('=== VERDICTS BY STAGE ===\n');
const head = `  ${'stage'.padEnd(26)}${VERDICTS.map((v) => v.padStart(13)).join('')}`;
console.log(head);
console.log(`  ${'-'.repeat(head.length - 2)}`);
let prev = null;
for (const [name, rows] of stages) {
  const c = {};
  for (const r of rows) c[r.verify.summary.verdict] = (c[r.verify.summary.verdict] || 0) + 1;
  const cells = VERDICTS.map((v) => {
    const n = c[v] || 0;
    const d = prev ? n - (prev[v] || 0) : null;
    return `${String(n).padStart(6)}${d === null ? '       ' : ` ${(d >= 0 ? '+' : '') + d}`.padStart(7)}`;
  }).join('');
  console.log(`  ${name.padEnd(26)}${cells}`);
  prev = c;
}

const final = stages[stages.length - 1][1];
console.log(`\n  (${final.length} sheets INEC published; 21 register units have no sheet at all)`);

// --- what the last stage cost and bought ---------------------------------
console.log('\n\n=== WHAT IS LEFT, AND WHY ===\n');
const review = final.filter((r) => r.verify.summary.verdict === 'review');
const flagged = final.filter((r) => r.verify.summary.verdict === 'flagged');

const cause = {};
for (const r of review) {
  const missingBoxes = BOX_FIELDS.filter((f) => !Number.isInteger(r.sheet[f])).length;
  const vr = r.verify.rows || [];
  const badRows = vr.filter((x) => x.value === null).length
    + Math.max(0, OSUN_2026_BALLOT.length - vr.length);
  const single = r.verify.summary.single || 0;
  const key = badRows ? (missingBoxes ? 'party rows AND boxes' : 'party rows')
    : (missingBoxes ? 'boxes' : (r.verify.summary.fail ? 'a low-severity failure' : 'single-sourced readings only'));
  cause[key] = (cause[key] || 0) + 1;
  void single;
}
console.log(`review (${review.length}) — something could not be established:`);
for (const [k, v] of Object.entries(cause).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(26)} ${String(v).padStart(5)}  ${pct(v, review.length)}`);
}

const failBy = {};
for (const r of flagged) {
  for (const c of r.verify.checks) {
    if (c.status === 'fail') failBy[`${c.name} (${c.severity})`] = (failBy[`${c.name} (${c.severity})`] || 0) + 1;
  }
}
console.log(`\nflagged (${flagged.length}) — a check failed. STILL NOT FINDINGS:`);
for (const [k, v] of Object.entries(failBy).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(5)}`);
}

// --- provenance: how much of the result rests on inference ---------------
let adjudicated = 0, adjSheets = 0, assumedChecks = 0, emptyRows = 0, contested = 0;
for (const r of final) {
  if (r.adjudicated?.length) { adjSheets++; adjudicated += r.adjudicated.length; }
  assumedChecks += r.verify.checks.filter((c) => c.status === 'assumed').length;
  emptyRows += r.verify.summary.emptyCells || 0;
  contested += r.verify.summary.contested || 0;
}
console.log('\n\n=== HOW MUCH RESTS ON INFERENCE ===\n');
console.log(`  boxes decided by the sheet's own equations   ${String(adjudicated).padStart(6)}  (on ${adjSheets} sheets)`);
console.log(`  checks spent making those decisions          ${String(assumedChecks).padStart(6)}  reported as \`assumed\`, never \`pass\``);
console.log(`  party rows resting on a lone EMPTY cell      ${String(emptyRows).padStart(6)}`);
console.log(`  party rows carried over a contradicting pass ${String(contested).padStart(6)}`);
console.log('\n  All four are visible per sheet in the workbook. None of them can reach');
console.log('  `publishable` on their own: a single-sourced row keeps a sheet in review.');

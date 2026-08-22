/**
 * What is actually blocking each unresolved sheet?
 *
 *   node scripts/audit_blockers.mjs storage/audit-osun2026/vlm_merged.jsonl
 *
 * Stage 0 of the triage plan is "drain automatically first", and the only way
 * to spend GPU time well is to know what the blocked sheets are blocked ON. A
 * sheet held back by one unread box is a different problem from a sheet where
 * two passes disagreed, and both are different from a sheet whose party column
 * did not resolve. This counts them apart, so the next pass targets a cause
 * rather than a bucket.
 *
 * Read-only. No inference, no writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOX_FIELDS, OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/audit_blockers.mjs <merged.jsonl>'); process.exit(2); }

const rows = fs.readFileSync(src, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
const bump = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; };

const verdicts = {};
for (const r of rows) bump(verdicts, r.verify.summary.verdict);

console.log(`${rows.length} sheets\n`);
for (const [k, v] of Object.entries(verdicts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${String(v).padStart(5)}  ${pct(v, rows.length)}`);
}

// ---------------------------------------------------------------------------
// REVIEW: something could not be established. What?
// ---------------------------------------------------------------------------
const review = rows.filter((r) => r.verify.summary.verdict === 'review');
const boxBlock = {};       // which box field is null, and why
const nBoxesMissing = {};  // how many boxes each blocked sheet is missing
const partyBlock = {};     // party-column resolution problems
const checkUnknown = {};   // which checks came back unknown
const causeMix = {};       // boxes only / parties only / both
let reviewWithFail = 0;

for (const r of review) {
  const s = r.sheet;
  const meta = r.boxMeta || {};
  const missing = BOX_FIELDS.filter((f) => !Number.isInteger(s[f]));
  for (const f of missing) bump(boxBlock, `${f}:${meta[f] || 'none'}`);
  bump(nBoxesMissing, String(missing.length));

  const vr = r.verify.rows || [];
  const omitted = Math.max(0, OSUN_2026_BALLOT.length - vr.length);
  const unresolved = vr.filter((x) => x.value === null);
  const partyBad = omitted + unresolved.length;
  if (omitted) bump(partyBlock, 'row never reported');
  for (const x of unresolved) bump(partyBlock, `row ${x.confidence}`);

  for (const c of r.verify.checks) if (c.status === 'unknown') bump(checkUnknown, c.name);
  if (r.verify.summary.fail > 0) reviewWithFail++;

  bump(causeMix, missing.length && partyBad ? 'both' : (missing.length ? 'boxes only' : (partyBad ? 'parties only' : 'neither (low-severity fail)')));
}

console.log(`\n\n=== REVIEW (${review.length}) — what is unestablished ===\n`);
console.log('cause:');
for (const [k, v] of Object.entries(causeMix).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(5)}  ${pct(v, review.length)}`);
}
console.log(`\n  (${reviewWithFail} of these ALSO carry a failing check — a low-severity fail alone lands here)`);

console.log('\nboxes missing per sheet:');
for (const [k, v] of Object.entries(nBoxesMissing).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${k} missing${' '.repeat(10)} ${String(v).padStart(5)}  ${pct(v, review.length)}`);
}

console.log('\nwhich box, and why it is null:');
for (const [k, v] of Object.entries(boxBlock).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}`);
}

console.log('\nparty-column problems (row count):');
for (const [k, v] of Object.entries(partyBlock).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}`);
}

console.log('\nchecks returning unknown:');
for (const [k, v] of Object.entries(checkUnknown).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${String(v).padStart(5)}  ${pct(v, review.length)}`);
}

// ---------------------------------------------------------------------------
// FLAGGED: a check failed. Which, and by how much?
// ---------------------------------------------------------------------------
const flagged = rows.filter((r) => r.verify.summary.verdict === 'flagged');
const failBy = {};
const deltas = {};
for (const r of flagged) {
  for (const c of r.verify.checks) {
    if (c.status !== 'fail') continue;
    bump(failBy, `${c.name} (${c.severity})`);
    const d = c.detail || {};
    const amount = d.excess ?? d.delta ?? null;
    if (amount !== null) (deltas[c.name] ||= []).push(Math.abs(amount));
  }
}

console.log(`\n\n=== FLAGGED (${flagged.length}) — which check fails ===\n`);
for (const [k, v] of Object.entries(failBy).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${String(v).padStart(5)}`);
}

console.log('\nsize of the discrepancy (a huge one is a misread, not a finding):');
for (const [k, arr] of Object.entries(deltas)) {
  arr.sort((a, b) => a - b);
  const q = (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const small = arr.filter((x) => x <= 10).length;
  const huge = arr.filter((x) => x > 1000).length;
  console.log(`  ${k.padEnd(26)} n=${String(arr.length).padStart(4)}  median ${String(q(0.5)).padStart(6)}`
    + `  p90 ${String(q(0.9)).padStart(7)}  max ${String(arr[arr.length - 1]).padStart(8)}`
    + `  ·  <=10: ${small}  >1000: ${huge}`);
}

// ---------------------------------------------------------------------------
// The single most useful number for Stage 0: how many sheets are one box away.
// ---------------------------------------------------------------------------
const oneBoxAway = review.filter((r) => {
  const missing = BOX_FIELDS.filter((f) => !Number.isInteger(r.sheet[f]));
  const vr = r.verify.rows || [];
  const partyOk = vr.length >= OSUN_2026_BALLOT.length && vr.every((x) => x.value !== null);
  return missing.length === 1 && partyOk && r.verify.summary.fail === 0;
});
console.log(`\n\n=== STAGE 0 TARGET ===\n`);
console.log(`  ${oneBoxAway.length} review sheet(s) are ONE readable box away from a verdict`);
const oneBoxWhich = {};
for (const r of oneBoxAway) {
  const f = BOX_FIELDS.find((x) => !Number.isInteger(r.sheet[x]));
  bump(oneBoxWhich, `${f} (${(r.boxMeta || {})[f] || 'none'})`);
}
for (const [k, v] of Object.entries(oneBoxWhich).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(28)} ${String(v).padStart(5)}`);
}

const dir = path.dirname(src);
fs.writeFileSync(path.join(dir, 'stage0_targets.json'), JSON.stringify({
  oneBoxAway: oneBoxAway.map((r) => ({
    file: r.file,
    box: BOX_FIELDS.find((x) => !Number.isInteger(r.sheet[x])),
    source: (r.boxMeta || {})[BOX_FIELDS.find((x) => !Number.isInteger(r.sheet[x]))] || 'none',
  })),
}, null, 2));
console.log(`\n  wrote ${path.join(dir, 'stage0_targets.json')}`);

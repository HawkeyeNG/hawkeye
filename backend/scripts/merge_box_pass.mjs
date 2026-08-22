/**
 * Merge the box pass into the full-sheet run and re-verify every sheet.
 *
 *   node scripts/merge_box_pass.mjs \
 *     storage/audit-osun2026/vlm_full.jsonl \
 *     storage/audit-osun2026/boxes_full.jsonl \
 *     storage/audit-osun2026/vlm_merged.jsonl
 *
 * Two independent readings of each summary box exist after the box pass: the
 * full-sheet read (an integer, with the known zero-padding truncation hazard)
 * and the cropped read (text). resolveBoxPair() reconciles them — agreement is
 * the assertable case, a lone reading is usable-but-weaker, an unexplained
 * disagreement yields null on purpose. Verdicts are then recomputed from the
 * merged sheet, so a sheet whose boxes only now became readable gets the checks
 * it was owed.
 *
 * Pure file-to-file: no inference, free to re-run as the resolution logic
 * evolves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifySheet, resolveBoxPair } from '../src/services/ec8a_verify.js';
import { OSUN_2026_BALLOT, BOX_FIELDS } from '../src/services/ec8a_prompt.js';

const [fullPath, boxesPath, outPath] = process.argv.slice(2);
if (!fullPath || !boxesPath || !outPath) {
  console.error('usage: node scripts/merge_box_pass.mjs <full.jsonl> <boxes.jsonl> <out.jsonl>');
  process.exit(2);
}

const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const full = readJsonl(fullPath);
const boxes = new Map(readJsonl(boxesPath).filter((r) => r.boxesRaw).map((r) => [path.basename(r.file), r.boxesRaw]));

console.log(`[merge] full run: ${full.length} sheets · box pass: ${boxes.size} with a reading`);
if (boxes.size < full.length) {
  console.log(`[merge] !! ${full.length - boxes.size} sheet(s) have NO box-pass reading — their boxes stay as pass 1 alone`);
}

const out = fs.createWriteStream(outPath);
const sourceTally = Object.fromEntries(BOX_FIELDS.map((f) => [f, {}]));
const verdicts = { before: {}, after: {} };
let covBefore = 0, covAfter = 0, conflicts = 0;

for (const r of full) {
  const key = path.basename(r.file);
  const raw = boxes.get(key) || {};
  const merged = { ...r.sheet };
  const boxMeta = {};

  for (const f of BOX_FIELDS) {
    const { value, source } = resolveBoxPair(r.sheet[f], raw[f] ?? null);
    merged[f] = value;
    boxMeta[f] = source;
    sourceTally[f][source] = (sourceTally[f][source] || 0) + 1;
    if (Number.isInteger(r.sheet[f])) covBefore++;
    if (Number.isInteger(value)) covAfter++;
    if (source === 'conflict') conflicts++;
  }

  const verify = verifySheet(merged, { expectedParties: OSUN_2026_BALLOT.length });
  verdicts.before[r.verify.summary.verdict] = (verdicts.before[r.verify.summary.verdict] || 0) + 1;
  verdicts.after[verify.summary.verdict] = (verdicts.after[verify.summary.verdict] || 0) + 1;

  out.write(`${JSON.stringify({ file: r.file, sheet: merged, verify, boxMeta, pass1Verdict: r.verify.summary.verdict })}\n`);
}
await new Promise((res) => out.end(res));

const cells = full.length * BOX_FIELDS.length;
console.log(`\n[merge] box coverage: ${covBefore}/${cells} (${(covBefore / cells * 100).toFixed(0)}%) -> `
  + `${covAfter}/${cells} (${(covAfter / cells * 100).toFixed(0)}%) · ${conflicts} conflict(s) nulled`);
console.log('\n[merge] per-box sources:');
for (const f of BOX_FIELDS) {
  const t = sourceTally[f];
  const line = ['both', 'p2', 'p1', 'p2-trunc', 'conflict', 'none']
    .map((s) => `${s} ${t[s] || 0}`).join(' · ');
  console.log(`  ${f.padEnd(14)} ${line}`);
}
console.log('\n[merge] verdicts:');
for (const v of ['publishable', 'flagged', 'review']) {
  console.log(`  ${v.padEnd(12)} ${String(verdicts.before[v] || 0).padStart(5)} -> ${String(verdicts.after[v] || 0).padStart(5)}`);
}
console.log(`\nwrote ${outPath}`);
process.exit(0);

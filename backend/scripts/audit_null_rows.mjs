/**
 * MEASURE FIRST. What is a null party row actually worth?
 *
 *   node scripts/audit_null_rows.mjs \
 *     storage/audit-osun2026/vlm_merged.jsonl \
 *     storage/audit-osun2026/hand_labels.json
 *
 * The archive has 8,032 party rows where the model read NEITHER cell, and
 * party_sum is unknown on 964 review sheets because of it. There is an obvious
 * temptation: most rows on this ballot are zero, blank cells are why a read
 * comes back null, so call them zero and watch the review pile collapse.
 *
 * That temptation is exactly the kind of thing this project keeps getting
 * caught by, so it gets measured before it gets believed. The 20 hand-labelled
 * sheets carry a human value for every row. This script asks, of the rows the
 * model returned null on:
 *
 *   how many were genuinely 0     — the rule would be right
 *   how many were NON-zero        — the rule would delete real votes
 *
 * A single non-zero here kills the rule outright: silently zeroing a cast vote
 * is the worst failure mode this audit has, worse than leaving the sheet in
 * review forever.
 *
 * Read-only.
 */
import fs from 'node:fs';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const [mergedPath, labelsPath] = process.argv.slice(2);
if (!mergedPath || !labelsPath) {
  console.error('usage: node scripts/audit_null_rows.mjs <merged.jsonl> <hand_labels.json>');
  process.exit(2);
}

const merged = new Map(fs.readFileSync(mergedPath, 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).map((r) => [r.file.replace(/\.[^.]+$/, ''), r]));
const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));

const units = Object.keys(labels).filter((k) => !k.startsWith('_'));
console.log(`${units.length} hand-labelled sheets\n`);

let nulls = 0, nullZero = 0, nullNonZero = 0;
let resolved = 0, resolvedRight = 0;
const offenders = [];

for (const unit of units) {
  const lab = labels[unit];
  const rec = merged.get(unit);
  if (!rec) { console.log(`  !! ${unit} not in the merged run`); continue; }
  const truth = lab.figures; // hand-read values, ballot order, blank/dash/NIL recorded as 0
  if (!Array.isArray(truth) || truth.length !== OSUN_2026_BALLOT.length) {
    console.log(`  !! ${unit} label has ${truth?.length} figures, expected ${OSUN_2026_BALLOT.length}`);
    continue;
  }

  for (let i = 0; i < OSUN_2026_BALLOT.length; i++) {
    const party = OSUN_2026_BALLOT[i];
    const vr = (rec.verify.rows || []).find((x) => x.party === party);
    const want = truth[i];
    if (!vr || vr.value === null) {
      nulls++;
      if (want === 0) nullZero++;
      else { nullNonZero++; offenders.push({ unit, party, want, saw: vr || null }); }
    } else {
      resolved++;
      if (vr.value === want) resolvedRight++;
      else offenders.push({ unit, party, want, saw: vr.value, kind: 'WRONG VALUE' });
    }
  }
}

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
console.log('rows the model RESOLVED:');
console.log(`  ${resolved} rows · ${resolvedRight} correct (${pct(resolvedRight, resolved)})\n`);

console.log('rows the model returned NULL on:');
console.log(`  ${nulls} rows`);
console.log(`  truly zero      ${String(nullZero).padStart(4)}  ${pct(nullZero, nulls)}`);
console.log(`  truly NON-zero  ${String(nullNonZero).padStart(4)}  ${pct(nullNonZero, nulls)}   <-- votes a zero-fill rule would delete`);

if (offenders.length) {
  console.log('\nevery disagreement:');
  for (const o of offenders.slice(0, 60)) {
    console.log(`  ${o.unit}  ${String(o.party).padEnd(6)} hand=${String(o.want).padStart(4)}`
      + `  model=${o.saw === null ? 'null' : (typeof o.saw === 'object' ? JSON.stringify(o.saw) : o.saw)}`
      + `${o.kind ? `  ${o.kind}` : ''}`);
  }
  if (offenders.length > 60) console.log(`  ... and ${offenders.length - 60} more`);
}

console.log('\n\n=== VERDICT ON THE ZERO-FILL RULE ===\n');
if (nulls === 0) {
  console.log('  No null rows in the labelled set — this sample cannot test the rule at all.');
  console.log('  Do NOT generalise from it. Label sheets that DO have null rows first.');
} else if (nullNonZero === 0) {
  console.log(`  ${nullZero}/${nulls} null rows were genuinely zero, none were not.`);
  console.log('  Supportive — but this is a small sample of EASY sheets: the labelled 20 are the');
  console.log('  first 20 by unit code, not a draw from the sheets that actually blocked. Treat as');
  console.log('  necessary evidence, not sufficient.');
} else {
  console.log(`  ${nullNonZero} of ${nulls} null rows carried REAL VOTES.`);
  console.log('  A blanket zero-fill would have deleted them. The rule is dead as stated.');
}

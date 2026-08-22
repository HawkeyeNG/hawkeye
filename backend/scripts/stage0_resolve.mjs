/**
 * Stage 0: drain the audit backlog with arithmetic before spending a cent of GPU.
 *
 *   node scripts/stage0_resolve.mjs \
 *     storage/audit-osun2026/vlm_full.jsonl \
 *     storage/audit-osun2026/boxes_full.jsonl \
 *     storage/audit-osun2026/vlm_stage0.jsonl
 *
 * Replaces merge_box_pass.mjs. Same file-to-file shape — no inference, free to
 * re-run — with three things it did not do:
 *
 *   1. ADJUDICATION. Where the two passes disagreed on exactly one box, the
 *      sheet's own equations often single out the right reading. Accepted only
 *      with two independent supporting constraints, one of which is then spent
 *      and reported as `assumed` rather than `pass`. Validated on 6,706
 *      adversarial trials with zero wrong choices — see validate_adjudication.mjs.
 *
 *   2. ROW INTEGRITY. Fifteen rows are not necessarily fifteen parties. Sheets
 *      whose row set is broken no longer get a manufactured party_sum finding.
 *
 *   3. PROMPT-LEAK MARKING. Readings matching the value printed in the prompt's
 *      own example are marked for re-reading rather than trusted.
 *
 * Everything it changes is recorded per sheet, so any number in the workbook
 * can be traced back to whether it was read, corroborated, or reconciled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifySheet, resolveRow } from '../src/services/ec8a_verify.js';
import { adjudicateBoxes, checkRowIntegrity, checkPromptLeak } from '../src/services/ec8a_resolve.js';
import { OSUN_2026_BALLOT, BOX_FIELDS } from '../src/services/ec8a_prompt.js';

const [fullPath, boxesPath, outPath] = process.argv.slice(2);
if (!fullPath || !boxesPath || !outPath) {
  console.error('usage: node scripts/stage0_resolve.mjs <full.jsonl> <boxes.jsonl> <out.jsonl>');
  process.exit(2);
}

const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const full = readJsonl(fullPath);
const boxes = new Map(readJsonl(boxesPath).filter((r) => r.boxesRaw).map((r) => [path.basename(r.file), r.boxesRaw]));

console.log(`[stage0] ${full.length} sheets · ${boxes.size} with a box-pass reading\n`);

const out = fs.createWriteStream(outPath);
const before = {};
const after = {};
let adjudicatedBoxes = 0, adjudicatedSheets = 0, brokenRows = 0, leaks = 0, leakSheets = 0;
const adjByField = {};
const needsReread = [];

for (const r of full) {
  const key = path.basename(r.file);
  const p2 = boxes.get(key) || {};

  // Party rows first — the party column supplies one of the constraints, but
  // only when the row SET is intact and every row resolved. A lower bound is
  // not an equation and must never be handed to the adjudicator as one.
  const integrity = checkRowIntegrity(r.sheet?.parties, OSUN_2026_BALLOT);
  const resolvedRows = (r.sheet?.parties || []).map(resolveRow);
  const allRowsRead = integrity.ok
    && resolvedRows.length === OSUN_2026_BALLOT.length
    && resolvedRows.every((x) => x.value !== null);
  const partySum = allRowsRead ? resolvedRows.reduce((a, x) => a + x.value, 0) : null;

  const { boxes: merged, meta, spent, adjudicated, implausible } = adjudicateBoxes(r.sheet, p2, partySum);
  const sheet = { ...r.sheet, ...merged };

  const verify = verifySheet(sheet, {
    expectedParties: OSUN_2026_BALLOT.length,
    spentChecks: spent,
    rowIntegrity: integrity,
    dropped: implausible,
  });

  const leak = checkPromptLeak(verify.rows);

  if (adjudicated.length) {
    adjudicatedSheets++;
    adjudicatedBoxes += adjudicated.length;
    for (const a of adjudicated) adjByField[a.field] = (adjByField[a.field] || 0) + 1;
  }
  if (!integrity.ok) brokenRows++;
  if (leak.length) { leakSheets++; leaks += leak.length; }

  const prev = r.verify.summary.verdict;
  before[prev] = (before[prev] || 0) + 1;
  after[verify.summary.verdict] = (after[verify.summary.verdict] || 0) + 1;

  // Anything Stage 0 could not settle, and why — this is the shopping list for
  // the GPU pass, and it is cheaper to build it here than to re-derive it.
  const stillMissing = BOX_FIELDS.filter((f) => !Number.isInteger(sheet[f]));
  if (stillMissing.length || !integrity.ok || leak.length) {
    needsReread.push({
      file: r.file,
      verdict: verify.summary.verdict,
      boxes: stillMissing.map((f) => ({ field: f, why: meta[f] })),
      rowSet: integrity.ok ? null : { duplicates: integrity.duplicates, missing: integrity.missing },
      promptLeak: leak.length ? leak : null,
    });
  }

  out.write(`${JSON.stringify({
    file: r.file,
    sheet,
    verify,
    boxMeta: meta,
    rowIntegrity: integrity.ok ? null : integrity,
    adjudicated: adjudicated.length ? adjudicated : null,
    implausible: implausible.length ? implausible : null,
    promptLeak: leak.length ? leak : null,
    pass1Verdict: prev,
  })}\n`);
}
await new Promise((res) => out.end(res));

const line = (label, v) => console.log(`  ${label.padEnd(30)} ${String(v).padStart(6)}`);
console.log('what Stage 0 changed:');
line('boxes adjudicated', adjudicatedBoxes);
line('sheets affected', adjudicatedSheets);
for (const [f, n] of Object.entries(adjByField).sort((a, b) => b[1] - a[1])) line(`  ${f}`, n);
console.log();
line('sheets with a broken row set', brokenRows);
line('prompt-leak readings marked', `${leaks} on ${leakSheets} sheets`);

// The baseline that matters is the CURRENT state of the audit, not pass 1.
// `full.jsonl` carries the full-sheet run's own verdicts, so comparing against
// those silently re-credits Stage 0 with the box pass's work — a real gain,
// banked last week, and not this change's to claim.
const baselinePath = path.join(path.dirname(outPath), 'vlm_merged.jsonl');
const baseline = {};
if (fs.existsSync(baselinePath)) {
  for (const b of readJsonl(baselinePath)) {
    baseline[b.verify.summary.verdict] = (baseline[b.verify.summary.verdict] || 0) + 1;
  }
}

console.log('\nverdicts:');
const width = (v) => String(v || 0).padStart(6);
const hasBaseline = Object.keys(baseline).length > 0;
console.log(`  ${''.padEnd(14)} ${'pass 1'.padStart(6)}    ${(hasBaseline ? '+boxes' : '').padStart(6)}    ${'stage 0'.padStart(6)}`);
for (const v of ['publishable', 'flagged', 'review']) {
  const d = (after[v] || 0) - (hasBaseline ? (baseline[v] || 0) : (before[v] || 0));
  console.log(`  ${v.padEnd(14)} ${width(before[v])} -> ${hasBaseline ? `${width(baseline[v])} -> ` : ''}${width(after[v])}`
    + `   ${d >= 0 ? '+' : ''}${d} this stage`);
}

const ref = hasBaseline ? baseline : before;
const drained = (after.publishable || 0) - (ref.publishable || 0);
const unflagged = (ref.flagged || 0) - (after.flagged || 0);
console.log(`\n  THIS STAGE: ${drained >= 0 ? '+' : ''}${drained} newly publishable · `
  + `${unflagged >= 0 ? unflagged : `${-unflagged} MORE`} flagged`);
if (unflagged < 0) {
  console.log('  (a rise is expected: adjudicating a box turns an unknown check into a real one,');
  console.log('   and a check that can now run is a check that can now fail. More is known, not worse.)');
}
console.log(`  ${needsReread.length} sheet(s) still need something a re-read could supply`);

fs.writeFileSync(path.join(path.dirname(outPath), 'stage0_reread.json'), JSON.stringify(needsReread, null, 2));
console.log(`\nwrote ${outPath}`);
console.log(`wrote ${path.join(path.dirname(outPath), 'stage0_reread.json')}`);

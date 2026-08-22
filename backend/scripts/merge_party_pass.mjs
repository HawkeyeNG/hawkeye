/**
 * Merge the party-table pass into the Stage 0 run and re-verify every sheet.
 *
 *   node scripts/merge_party_pass.mjs \
 *     storage/audit-osun2026/vlm_full.jsonl \
 *     storage/audit-osun2026/boxes_full.jsonl \
 *     storage/audit-osun2026/party_full.jsonl \
 *     storage/audit-osun2026/vlm_stage0b.jsonl
 *
 * Pure file-to-file: no inference, free to re-run as the resolution logic
 * changes. Three things happen here that could not happen earlier:
 *
 *   1. Each party row now has TWO independent readings, reconciled the same way
 *      the boxes were — agreement asserts, a lone reading is weaker, an
 *      unexplained disagreement yields null on purpose.
 *
 *   2. A cell can finally be EMPTY rather than merely unreadable, which is the
 *      whole point of the pass. Pass 1's prompt had no way to say "the officer
 *      drew a dash here", so 7,095 rows came back null with two different
 *      meanings collapsed into one.
 *
 *   3. The officer's own TOTAL VALID VOTES row joins the checks, giving a
 *      fourth independent statement of #7.
 *
 * Sheets the pass did not cover are carried through untouched and keep their
 * Stage 0 verdicts — a check nobody ran must not demote them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifySheet, resolveRow } from '../src/services/ec8a_verify.js';
import {
  adjudicateBoxes, checkRowIntegrity, checkPromptLeak, resolvePartyAcrossPasses,
} from '../src/services/ec8a_resolve.js';
import { OSUN_2026_BALLOT, BOX_FIELDS, normaliseParty } from '../src/services/ec8a_prompt.js';

const [fullPath, boxesPath, partyPath, outPath] = process.argv.slice(2);
if (!fullPath || !boxesPath || !partyPath || !outPath) {
  console.error('usage: node scripts/merge_party_pass.mjs <full> <boxes> <party> <out>');
  process.exit(2);
}

const readJsonl = (p) => (fs.existsSync(p)
  ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

const full = readJsonl(fullPath);
const boxes = new Map(readJsonl(boxesPath).filter((r) => r.boxesRaw).map((r) => [path.basename(r.file), r.boxesRaw]));
const party = new Map(readJsonl(partyPath).filter((r) => Array.isArray(r.parties))
  .map((r) => [path.basename(r.file), r]));

// Stage 0's output is the baseline this stage is measured against.
const baselinePath = path.join(path.dirname(outPath), 'vlm_stage0.jsonl');
const baseline = new Map(readJsonl(baselinePath)
  .map((b) => [path.basename(b.file), b.verify.summary.verdict]));

console.log(`[merge] ${full.length} sheets · ${boxes.size} box readings · ${party.size} party-table readings`);
console.log(`[merge] baseline: ${baseline.size ? path.basename(baselinePath) : 'MISSING — falling back to pass 1'}\n`);

const out = fs.createWriteStream(outPath);
const before = {};
const after = {};
const rowSource = {};
let coveredBefore = 0, coveredAfter = 0, totalCells = 0;
let emptyResolved = 0, newConflicts = 0, totalRowRead = 0, totalRowFail = 0;
let sheetsCovered = 0;

for (const r of full) {
  const key = path.basename(r.file);
  const p2 = boxes.get(key) || {};
  const p3 = party.get(key) || null;

  const integrity = checkRowIntegrity(r.sheet?.parties, OSUN_2026_BALLOT);
  const p3Integrity = p3 ? checkRowIntegrity(p3.parties, OSUN_2026_BALLOT) : null;

  let resolvedRows = null;
  let totalRow;

  if (p3) {
    sheetsCovered++;
    // Match rows by PARTY NAME, never by position. A pass that repeated APC and
    // dropped A still returns fifteen rows, and zipping two such lists by index
    // would silently pair one party's votes with another's.
    const byName = (list) => new Map((list || [])
      .filter((x) => x?.party)
      .map((x) => [normaliseParty(x.party), x]));
    const m1 = byName(r.sheet?.parties);
    const m3 = byName(p3.parties);
    resolvedRows = OSUN_2026_BALLOT.map((name) => {
      const row = resolvePartyAcrossPasses(m1.get(name) || null, m3.get(name) || null, resolveRow);
      return { ...row, party: name };
    });
    for (const row of resolvedRows) {
      rowSource[row.source || 'none'] = (rowSource[row.source || 'none'] || 0) + 1;
      if (row.confidence === 'empty' || (row.value === 0 && row.source === 'p3')) emptyResolved++;
      if (row.source === 'disagree') newConflicts++;
    }

    // emptyMeansZero is OFF here on purpose. On a party row a blank cell means
    // the party polled nothing; on the TOTAL line it means the officer never
    // filled it in, and calling that zero would invent a total of nought and
    // then flag the sheet for disagreeing with #7. A line observed blank in
    // BOTH cells is reported as such; unreadable stays null.
    const blankCell = (c) => typeof c === 'string' && /^[\s\-—–_=~/\\|.]*$/.test(c);
    if (!p3.totalRow) totalRow = null;
    else if (blankCell(p3.totalRow.figures) && blankCell(p3.totalRow.words)) totalRow = 'blank';
    else {
      const tr = resolveRow(
        { party: 'TOTAL', figures: p3.totalRow.figures, words: p3.totalRow.words },
        { emptyMeansZero: false },
      );
      totalRow = tr.value;
    }
    if (Number.isInteger(totalRow)) totalRowRead++;
  }

  const { boxes: mergedBoxes, meta, spent, adjudicated, implausible } = adjudicateBoxes(
    r.sheet, p2,
    resolvedRows && resolvedRows.every((x) => x.value !== null)
      ? resolvedRows.reduce((a, x) => a + x.value, 0)
      : null,
  );

  const sheet = { ...r.sheet, ...mergedBoxes };
  if (p3) sheet.totalRow = totalRow;

  const verify = verifySheet(sheet, {
    expectedParties: OSUN_2026_BALLOT.length,
    spentChecks: spent,
    // Once the third pass has supplied the row set, pass 1's broken one is no
    // longer what the sum is computed from, so it must not go on suppressing
    // the check.
    rowIntegrity: p3 ? p3Integrity : integrity,
    dropped: implausible,
    resolvedRows,
  });

  if (verify.checks.some((c) => c.name === 'total_row' && c.status === 'fail')) totalRowFail++;

  const prevRows = r.verify.rows || [];
  coveredBefore += prevRows.filter((x) => x.value !== null).length;
  coveredAfter += (resolvedRows || prevRows).filter((x) => x.value !== null).length;
  totalCells += OSUN_2026_BALLOT.length;

  // Baseline is the CURRENT state of the audit, not pass 1 — comparing against
  // pass 1 would re-credit this stage with the box pass's and Stage 0's gains.
  const prev = baseline.get(key) || r.verify.summary.verdict;
  before[prev] = (before[prev] || 0) + 1;
  after[verify.summary.verdict] = (after[verify.summary.verdict] || 0) + 1;

  out.write(`${JSON.stringify({
    file: r.file,
    sheet,
    verify,
    boxMeta: meta,
    partyPass: p3 ? { rowSet: p3Integrity?.ok ? 'ok' : p3Integrity, totalRow } : null,
    rowIntegrity: (p3 ? p3Integrity : integrity)?.ok ? null : (p3 ? p3Integrity : integrity),
    adjudicated: adjudicated.length ? adjudicated : null,
    implausible: implausible.length ? implausible : null,
    promptLeak: checkPromptLeak(verify.rows).length ? checkPromptLeak(verify.rows) : null,
  })}\n`);
}
await new Promise((res) => out.end(res));

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
console.log(`party-table pass covered ${sheetsCovered} of ${full.length} sheets\n`);
console.log(`party cell coverage: ${coveredBefore}/${totalCells} (${pct(coveredBefore, totalCells)})`
  + ` -> ${coveredAfter}/${totalCells} (${pct(coveredAfter, totalCells)})`);
console.log(`  rows resolved as an EMPTY cell: ${emptyResolved}`);
console.log(`  rows where the two passes DISAGREE (nulled on purpose): ${newConflicts}`);
console.log(`  TOTAL VALID VOTES row read on ${totalRowRead} sheets · disagrees on ${totalRowFail}`);

console.log('\nhow each row was settled:');
for (const [k, v] of Object.entries(rowSource).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(16)} ${String(v).padStart(6)}`);
}

console.log('\nverdicts:');
for (const v of ['publishable', 'flagged', 'review']) {
  const d = (after[v] || 0) - (before[v] || 0);
  console.log(`  ${v.padEnd(14)} ${String(before[v] || 0).padStart(6)} -> ${String(after[v] || 0).padStart(6)}`
    + `   ${d >= 0 ? '+' : ''}${d}`);
}
console.log(`\nwrote ${outPath}`);

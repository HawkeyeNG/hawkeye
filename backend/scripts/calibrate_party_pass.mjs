/**
 * Calibrate the party-table pass against the hand-labelled sheets.
 *
 *   node scripts/calibrate_party_pass.mjs \
 *     storage/audit-osun2026/party_20.jsonl \
 *     storage/audit-osun2026/hand_labels.json \
 *     storage/audit-osun2026/vlm_full.jsonl \
 *     storage/audit-osun2026/boxes_full.jsonl
 *
 * THE GATE. Nothing from this pass reaches the archive until it has been
 * measured here — this project has twice paid for a full archive run before
 * checking a five-minute assumption.
 *
 * WHAT "SILENT" MEANS, AND WHY THE FIRST VERSION OF THIS SCRIPT GOT IT WRONG.
 *
 * The first cut called a cell error "silent" whenever the figures and words
 * cells agreed and were both wrong, and on that definition it failed the pass
 * over 29-01-01-006, where BP and ZLP both came back 202. But those readings
 * are not silent at all: they push the party column to 709 against a declared
 * total of 305, party_sum fails, and the sheet is flagged. The figures-vs-words
 * check is one layer of several, and grading a layer as though it were the
 * whole stack condemns a pass for an error the stack catches.
 *
 * A silent error is one that survives EVERYTHING — a sheet that comes out
 * `publishable`, asserting numbers that are wrong. That is the only failure the
 * design cannot catch downstream, so that is what the gate turns on. Cell-level
 * mistakes are still reported, because they are how you see the pass degrading
 * before it starts costing sheets.
 *
 * The empty rule is judged the same way: not "was a cell blank" but "did a
 * blank cell make us CONCLUDE zero where a vote was cast". A blank figures cell
 * against a words cell reading ONE is a conflict, resolves to nothing, and
 * deletes no vote — counting that as a deleted vote condemns the pass for
 * behaving correctly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OSUN_2026_BALLOT, normaliseParty } from '../src/services/ec8a_prompt.js';
import { verifySheet, resolveRow } from '../src/services/ec8a_verify.js';
import { adjudicateBoxes, resolvePartyAcrossPasses } from '../src/services/ec8a_resolve.js';

const [partyPath, labelsPath, fullPath, boxesPath] = process.argv.slice(2);
if (!partyPath || !labelsPath) {
  console.error('usage: node scripts/calibrate_party_pass.mjs <party.jsonl> <labels.json> [full.jsonl] [boxes.jsonl]');
  process.exit(2);
}

const readJsonl = (p) => (p && fs.existsSync(p)
  ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const unitOf = (f) => path.basename(f).replace(/\.[^.]+$/, '');

const party = new Map(readJsonl(partyPath).map((r) => [unitOf(r.file), r]));
const pass1 = new Map(readJsonl(fullPath).map((r) => [unitOf(r.file), r]));
const boxes = new Map(readJsonl(boxesPath).filter((r) => r.boxesRaw).map((r) => [unitOf(r.file), r.boxesRaw]));
const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
const units = Object.keys(labels).filter((k) => !k.startsWith('_'));
const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;

let cells = 0, correct = 0, unread = 0, wrong = 0, agreedWrong = 0;
let emptyConcluded = 0, emptyRight = 0;
let recovered = 0, lost = 0;
let totalRows = 0, totalMatch = 0;
let publishable = 0, publishableWrong = 0;
const wrongCells = [];
const emptyWrong = [];
const lostCases = [];
const escaped = [];
const totalRowNotes = [];

for (const unit of units) {
  const rec = party.get(unit);
  const truth = labels[unit]?.figures;
  if (!rec || !Array.isArray(truth) || truth.length !== OSUN_2026_BALLOT.length) continue;

  const byName = (list) => new Map((list || [])
    .filter((x) => x?.party).map((x) => [normaliseParty(x.party), x]));
  const m1 = byName(pass1.get(unit)?.sheet?.parties);
  const m3 = byName(rec.parties);
  const p1rows = new Map(((pass1.get(unit)?.verify?.rows) || []).map((x) => [x.party, x]));

  const resolvedRows = OSUN_2026_BALLOT.map((name) => ({
    ...resolvePartyAcrossPasses(m1.get(name) || null, m3.get(name) || null, resolveRow),
    party: name,
  }));

  for (let i = 0; i < OSUN_2026_BALLOT.length; i++) {
    const name = OSUN_2026_BALLOT[i];
    const want = truth[i];
    const r = resolvedRows[i];
    cells++;

    if (r.value === null) unread++;
    else if (r.value === want) correct++;
    else {
      wrong++;
      if (r.confidence === 'both') agreedWrong++;
      wrongCells.push(`${unit} ${name}: read ${r.value} [${r.confidence}], human read ${want}`);
    }

    // Did an EMPTY cell make us conclude zero, and was that right?
    const raw = m3.get(name);
    const blank = (c) => typeof c === 'string' && /^[\s\-—–_=~/\\|.]*$/.test(c);
    if (r.value === 0 && raw && (blank(raw.figures) || blank(raw.words))) {
      emptyConcluded++;
      if (want === 0) emptyRight++;
      else emptyWrong.push(`${unit} ${name}: concluded 0 from an empty cell, human read ${want}`);
    }

    const before = p1rows.get(name);
    if (before && before.value === null && r.value !== null) recovered++;
    if (before && before.value !== null && r.value === null) {
      lost++;
      lostCases.push(`${unit} ${name}: pass 1 had ${before.value}, merged has nothing`);
    }
  }

  // --- the sheet-level question: does a wrong number ESCAPE? ---------------
  const blankCell = (c) => typeof c === 'string' && /^[\s\-—–_=~/\\|.]*$/.test(c);
  let totalRow;
  if (!rec.totalRow) totalRow = null;
  else if (blankCell(rec.totalRow.figures) && blankCell(rec.totalRow.words)) totalRow = 'blank';
  else totalRow = resolveRow({ party: 'TOTAL', figures: rec.totalRow.figures, words: rec.totalRow.words }).value;

  const p1sheet = pass1.get(unit)?.sheet || {};
  const partySum = resolvedRows.every((x) => x.value !== null)
    ? resolvedRows.reduce((a, x) => a + x.value, 0) : null;
  const { boxes: mergedBoxes, spent, implausible } = adjudicateBoxes(p1sheet, boxes.get(unit) || {}, partySum);
  const verify = verifySheet({ ...p1sheet, ...mergedBoxes, totalRow }, {
    expectedParties: OSUN_2026_BALLOT.length,
    spentChecks: spent,
    dropped: implausible,
    resolvedRows,
  });

  if (verify.summary.verdict === 'publishable') {
    publishable++;
    const bad = resolvedRows.filter((r, i) => r.value !== truth[i]);
    if (bad.length) {
      publishableWrong++;
      escaped.push(`${unit}: PUBLISHABLE but ${bad.map((b) => `${b.party}=${b.value} (human ${truth[OSUN_2026_BALLOT.indexOf(b.party)]})`).join(', ')}`);
    }
  }

  if (Number.isInteger(totalRow)) {
    totalRows++;
    const humanSum = truth.reduce((a, b) => a + b, 0);
    if (totalRow === humanSum) totalMatch++;
    else totalRowNotes.push(`${unit}: officer's TOTAL row ${totalRow}, human party sum ${humanSum}`);
  }
}

console.log(`\n${party.size} sheets in the run · ${units.length} hand-labelled\n`);
console.log(`cells: ${cells}`);
console.log(`  correct                 ${String(correct).padStart(5)}  ${pct(correct, cells)}`);
console.log(`  unread (honest null)    ${String(unread).padStart(5)}  ${pct(unread, cells)}`);
console.log(`  wrong                   ${String(wrong).padStart(5)}  ${pct(wrong, cells)}`);
console.log(`    of which both cells agreed: ${agreedWrong}`);

console.log('\nthe empty rule (did a blank cell make us conclude zero?):');
console.log(`  zeroes concluded from a blank  ${String(emptyConcluded).padStart(5)}`);
console.log(`  correct                        ${String(emptyRight).padStart(5)}  ${pct(emptyRight, emptyConcluded)}`);
console.log(`  A DELETED VOTE                 ${String(emptyWrong.length).padStart(5)}`);
for (const e of emptyWrong) console.log(`    ${e}`);

console.log('\nagainst pass 1:');
console.log(`  cells recovered that pass 1 could not read   ${recovered}`);
console.log(`  cells LOST that pass 1 had                   ${lost}`);
for (const l of lostCases) console.log(`    ${l}`);

if (totalRows) {
  console.log(`\nTOTAL row read on ${totalRows} sheets, matches the human party sum on ${totalMatch} (${pct(totalMatch, totalRows)})`);
  for (const n of totalRowNotes) console.log(`  ${n}`);
  console.log('  (a mismatch here is not necessarily an error — 29-01-03-003 genuinely carries');
  console.log('   three different totals, and finding those is why the row is now read at all)');
}

console.log(`\nsheet level: ${publishable} of ${units.length} came out PUBLISHABLE`);
console.log(`  of those, carrying a wrong number: ${publishableWrong}`);
for (const e of escaped) console.log(`    ${e}`);

if (wrongCells.length) {
  console.log('\nevery wrong cell (caught or not):');
  for (const w of wrongCells) console.log(`  ${w}`);
}

console.log('\n\n=== GATE ===\n');
if (publishableWrong === 0 && emptyWrong.length === 0) {
  console.log('  PASS — no sheet reached `publishable` carrying a number the human read differently,');
  console.log('  and no blank cell was turned into a zero over a real vote.');
  if (wrong) {
    console.log(`\n  ${wrong} cell(s) were misread, but every affected sheet was caught by the`);
    console.log('  arithmetic and held back. That is the stack working as designed, not a clean run.');
  }
  console.log('\n  The sample is 20 EASY sheets. This bounds the damage; it does not prove');
  console.log('  accuracy on the sheets that actually blocked.');
} else {
  if (publishableWrong) console.log(`  ${publishableWrong} sheet(s) reached PUBLISHABLE with a wrong number — a silent error.`);
  if (emptyWrong.length) console.log(`  ${emptyWrong.length} real vote(s) deleted by the empty rule.`);
  console.log('  DO NOT run the archive.');
}
process.exit(publishableWrong === 0 && emptyWrong.length === 0 ? 0 : 1);

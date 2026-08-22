/**
 * Score a VLM run against the hand-labelled Osun sheets.
 *
 *   node scripts/ec8a_calibrate.mjs storage/audit-osun2026/vlm20c.jsonl
 *
 * Two questions, and the second one is the one that matters:
 *
 *   1. How often does the model read a cell correctly?
 *   2. When the pipeline says `publishable`, is it? When it says `flagged`,
 *      is there really something wrong?
 *
 * A model at 95% cell accuracy is useless if its 5% of errors sail through the
 * checks, and a model at 80% is publishable-grade if every error it makes gets
 * caught. Accuracy is a property of the model; trustworthiness is a property of
 * the model AND the verification stack together, and only (2) measures that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifySheet, resolveRow } from '../src/services/ec8a_verify.js';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const runPath = process.argv[2];
if (!runPath) { console.error('usage: node scripts/ec8a_calibrate.mjs <run.jsonl>'); process.exit(2); }

const LABELS = JSON.parse(fs.readFileSync('storage/audit-osun2026/hand_labels.json', 'utf8'));
const BOXES = ['registered', 'accredited', 'ballotsIssued', 'unusedBallots', 'spoiled', 'rejected', 'totalValid', 'usedBallots'];
const sheets = Object.entries(LABELS).filter(([k]) => !k.startsWith('_'));

// --- 0. the labels have to survive their own arithmetic before they can judge
//        anything else. A ground truth nobody checked is just another opinion.
console.log('=== label self-check');
let labelBad = 0;
for (const [key, L] of sheets) {
  const sum = L.figures.reduce((a, b) => a + b, 0);
  const account = L.spoiled + L.rejected + L.totalValid;
  const problems = [];
  if (sum !== L.totalValid) problems.push(`party sum ${sum} != #7 ${L.totalValid}`);
  if (account !== L.usedBallots) problems.push(`#5+#6+#7 ${account} != #8 ${L.usedBallots}`);
  if (L.totalValid + L.rejected > L.accredited) problems.push(`cast ${L.totalValid + L.rejected} > accredited ${L.accredited}`);
  if (problems.length) {
    labelBad++;
    const tag = L._anomaly ? '   <- recorded as a GENUINE anomaly' : '   <- UNEXPLAINED, re-read this sheet';
    console.log(`  ${key}: ${problems.join('; ')}${tag}`);
  }
}
console.log(`  ${sheets.length - labelBad} of ${sheets.length} sheets are internally consistent; ${labelBad} carry a real anomaly\n`);

// --- 1. read the run
const rows = fs.readFileSync(runPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byFile = new Map(rows.map((r) => [path.basename(r.file, '.jpg'), r]));

let cellOk = 0, cellWrong = 0, cellNull = 0, rawOk = 0;
let boxOk = 0, boxWrong = 0, boxNull = 0;
const wrongCells = [];
const wrongBoxes = [];
const perSheet = [];

for (const [key, L] of sheets) {
  const r = byFile.get(key);
  if (!r || !r.sheet) { perSheet.push({ key, missing: true }); continue; }

  const got = new Map((r.sheet.parties || []).map((p) => [String(p.party).toUpperCase(), p]));
  let sheetWrong = 0;
  OSUN_2026_BALLOT.forEach((party, i) => {
    const want = L.figures[i];
    const p = got.get(party);
    // Score what the PIPELINE produces, not the model's raw token. The raw value
    // is tracked alongside, because the gap between the two is exactly what the
    // parser is buying - and if that gap is large, the parser is carrying more
    // weight than anyone realises and deserves harder tests.
    const raw = p ? p.figures : null;
    const f = p ? resolveRow(p).figures : null;
    if (raw !== null && raw !== undefined && Number(raw) === want) rawOk++;
    if (f === null) { cellNull++; sheetWrong++; }
    else if (f === want) cellOk++;
    else { cellWrong++; sheetWrong++; wrongCells.push(`${key} ${party}: ${JSON.stringify(raw)} -> ${f}, sheet says ${want}`); }
  });

  let boxWrongHere = 0;
  for (const b of BOXES) {
    const want = L[b];
    // A null LABEL means the box on the sheet is genuinely unreadable (02-004's
    // overwritten #3/#4). There is no right answer to score against, so the
    // cell is excluded rather than counted for or against anyone.
    if (want == null) continue;
    const g = Number.isInteger(r.sheet[b]) ? r.sheet[b] : null;
    if (g === null) { boxNull++; boxWrongHere++; }
    else if (g === want) boxOk++;
    else { boxWrong++; boxWrongHere++; wrongBoxes.push(`${key} ${b}: read ${g}, sheet says ${want}`); }
  }

  // RECOMPUTE rather than trusting the verdict stored at run time. The stored
  // one came from whatever the verification stack looked like that day, so
  // reading it back would measure history instead of the current code - and
  // would make every fix to the checks look like it changed nothing. The
  // transcription is fixed; the judgement of it is not.
  const verify = verifySheet(r.sheet, { expectedParties: OSUN_2026_BALLOT.length });

  perSheet.push({
    key, sheetWrong, boxWrongHere,
    verdict: verify.summary.verdict,
    perfect: sheetWrong === 0 && boxWrongHere === 0,
    anomaly: Boolean(L._anomaly),
  });
}

const cellTotal = cellOk + cellWrong + cellNull;
const boxTotal = boxOk + boxWrong + boxNull;
const pct = (n, d) => `${n}/${d} (${(n / d * 100).toFixed(1)}%)`;
console.log('=== transcription accuracy vs the hand labels');
console.log(`  raw model    : ${pct(rawOk, cellTotal)}   <- the model's own value, before our parser`);
console.log(`  after parsing: ${pct(cellOk, cellTotal)}   ·  ${cellWrong} WRONG  ·  ${cellNull} not read`);
console.log(`  summary boxes: ${pct(boxOk, boxTotal)}   ·  ${boxWrong} WRONG  ·  ${boxNull} not read`);
if (wrongCells.length) {
  console.log('\n  wrong party cells:');
  for (const w of wrongCells) console.log('    ' + w);
}
if (wrongBoxes.length) {
  console.log('\n  wrong boxes:');
  for (const w of wrongBoxes) console.log('    ' + w);
}

// --- 2. THE QUESTION THAT MATTERS: does the verdict tell the truth?
//
// A `publishable` sheet that is in fact misread is a SILENT ERROR - the audit
// would assert a wrong number with no warning attached. That number is the one
// to drive to zero; everything else is recoverable by a human.
console.log('\n=== does the verdict tell the truth?');
const done = perSheet.filter((s) => !s.missing);
const pub = done.filter((s) => s.verdict === 'publishable');
const flagged = done.filter((s) => s.verdict === 'flagged');
const review = done.filter((s) => s.verdict === 'review');
const silentErrors = pub.filter((s) => !s.perfect);

console.log(`  publishable : ${pub.length}  ->  ${pub.filter((s) => s.perfect).length} fully correct, ${silentErrors.length} SILENTLY WRONG`);
console.log(`  flagged     : ${flagged.length}  ->  ${flagged.filter((s) => s.anomaly).length} on a sheet with a real anomaly, ${flagged.filter((s) => !s.anomaly).length} are our own misreads`);
console.log(`  review      : ${review.length}  ->  ${review.filter((s) => s.perfect).length} read perfectly but held back, ${review.filter((s) => !s.perfect).length} correctly held back`);
for (const s of silentErrors) {
  console.log(`    !! ${s.key}: called publishable but ${s.sheetWrong} cell(s) and ${s.boxWrongHere} box(es) are wrong`);
}
const caught = done.filter((s) => !s.perfect && s.verdict !== 'publishable').length;
const imperfect = done.filter((s) => !s.perfect).length;
console.log(`\n  of ${imperfect} imperfectly-read sheets, ${caught} were caught by the checks `
  + `(${imperfect ? (caught / imperfect * 100).toFixed(0) : 0}% recall on our own errors)`);

// --- 3. the over-voting rule, measured against the labels
//
// `usedBallots > accredited` fires on any sheet where spoiled ballots were
// replaced - the voter legitimately consumes two papers. `totalValid + rejected
// > accredited` counts ballots that actually went into the box.
console.log('\n=== over-voting rule: old vs corrected (measured on the hand labels)');
let oldFires = 0, newFires = 0;
const oldFalse = [];
for (const [key, L] of sheets) {
  const oldHit = L.usedBallots > L.accredited;
  const newHit = L.totalValid + L.rejected > L.accredited;
  if (oldHit) oldFires++;
  if (newHit) newFires++;
  if (oldHit && !newHit) {
    oldFalse.push(`${key}: used ${L.usedBallots} > accredited ${L.accredited}, but only because ${L.spoiled} ballot(s) were spoiled and replaced`);
  }
}
console.log(`  usedBallots > accredited           : fires on ${oldFires}/${sheets.length}`);
console.log(`  totalValid + rejected > accredited : fires on ${newFires}/${sheets.length}`);
for (const f of oldFalse) console.log(`    FALSE POSITIVE - ${f}`);

process.exit(0);

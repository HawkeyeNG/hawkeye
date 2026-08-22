/**
 * Did pass 1 already record the officer's dashes — and if so, what are they worth?
 *
 *   node scripts/audit_dash_cells.mjs \
 *     storage/audit-osun2026/vlm_full.jsonl \
 *     storage/audit-osun2026/hand_labels.json
 *
 * On 29-20-08-001 twelve of fifteen rows hold nothing but a ruled stroke, in
 * both cells, on a sheet that is otherwise perfectly legible: the three rows
 * carrying numbers are 127 + 2 + 72 and the officer's own TOTAL row says 201.
 * A lone dash parses to null, which is why that sheet reads as twelve
 * "unreadable" rows.
 *
 * If pass 1 wrote those strokes down as text rather than collapsing them to
 * null, then a large slice of the stuck archive can be resolved with no GPU at
 * all. That is a big enough prize to be suspicious of, so this script answers
 * two questions in order:
 *
 *   1. how many dash-only cells does pass 1 actually contain?
 *   2. on the 20 hand-labelled sheets, what did the HUMAN record for those
 *      exact cells? A dash the human read as a real number kills the rule.
 *
 * Question 2 is the one that matters. Question 1 only sizes the prize.
 *
 * Read-only.
 */
import fs from 'node:fs';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const [fullPath, labelsPath] = process.argv.slice(2);
if (!fullPath) { console.error('usage: node scripts/audit_dash_cells.mjs <full.jsonl> [hand_labels.json]'); process.exit(2); }

const DASHES_ONLY = /^[\s\-—–_=~/\\|.]*$/;
const isDash = (v) => typeof v === 'string' && v !== '' && DASHES_ONLY.test(v);
const isBlank = (v) => typeof v === 'string' && v.trim() === '';

const rows = fs.readFileSync(fullPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

let dashFig = 0, dashWords = 0, blankFig = 0, blankWords = 0, nullBoth = 0, cells = 0;
const shapes = {};
const bothDashSheets = new Set();
const perSheetDash = {};

for (const r of rows) {
  let n = 0;
  for (const p of (r.sheet?.parties || [])) {
    cells += 2;
    if (isDash(p.figures)) dashFig++;
    if (isDash(p.words)) dashWords++;
    if (isBlank(p.figures)) blankFig++;
    if (isBlank(p.words)) blankWords++;
    if (p.figures == null && p.words == null) nullBoth++;
    const shape = `${p.figures == null ? 'null' : (isBlank(p.figures) ? '""' : (isDash(p.figures) ? 'dash' : 'text'))}`
      + ` / ${p.words == null ? 'null' : (isBlank(p.words) ? '""' : (isDash(p.words) ? 'dash' : 'text'))}`;
    shapes[shape] = (shapes[shape] || 0) + 1;
    if ((isDash(p.figures) || isBlank(p.figures)) && (isDash(p.words) || isBlank(p.words))) {
      bothDashSheets.add(r.file); n++;
    }
  }
  if (n) perSheetDash[r.file] = n;
}

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(2)}%`;
console.log(`${rows.length} sheets · ${cells} party cells in pass 1\n`);
console.log(`  dash-only figures cells   ${String(dashFig).padStart(6)}  ${pct(dashFig, cells / 2)}`);
console.log(`  dash-only words cells     ${String(dashWords).padStart(6)}  ${pct(dashWords, cells / 2)}`);
console.log(`  empty-string figures      ${String(blankFig).padStart(6)}`);
console.log(`  empty-string words        ${String(blankWords).padStart(6)}`);
console.log(`  BOTH cells null           ${String(nullBoth).padStart(6)}  ${pct(nullBoth, cells / 2)}`);

console.log('\ncell-pair shapes (figures / words):');
for (const [k, v] of Object.entries(shapes).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(6)}`);
}
console.log(`\n  ${bothDashSheets.size} sheet(s) carry at least one row where BOTH cells are dash/blank`);

// -------------------------------------------------------------------------
// The question that decides it: what did the human read in those cells?
// -------------------------------------------------------------------------
if (!labelsPath) process.exit(0);
const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
const byUnit = new Map(rows.map((r) => [r.file.replace(/\.[^.]+$/, ''), r]));

let checked = 0, wasZero = 0, wasNonZero = 0;
const offenders = [];
for (const unit of Object.keys(labels).filter((k) => !k.startsWith('_'))) {
  const rec = byUnit.get(unit);
  const truth = labels[unit]?.figures;
  if (!rec || !Array.isArray(truth)) continue;
  for (let i = 0; i < OSUN_2026_BALLOT.length; i++) {
    const p = (rec.sheet?.parties || []).find((x) => String(x.party).toUpperCase() === OSUN_2026_BALLOT[i]);
    if (!p) continue;
    const fEmpty = isDash(p.figures) || isBlank(p.figures);
    const wEmpty = isDash(p.words) || isBlank(p.words);
    if (!fEmpty && !wEmpty) continue;
    checked++;
    if (truth[i] === 0) wasZero++;
    else { wasNonZero++; offenders.push(`${unit} ${OSUN_2026_BALLOT[i]}: pass1 figures=${JSON.stringify(p.figures)} words=${JSON.stringify(p.words)} — human read ${truth[i]}`); }
  }
}

console.log('\n\n=== WHAT THE HUMAN READ IN THOSE CELLS ===\n');
if (!checked) {
  console.log('  Not one dash/blank cell appears on the 20 hand-labelled sheets.');
  console.log('  This sample CANNOT test the rule. Do not generalise from it — the labelled 20');
  console.log('  are the first 20 by unit code and their officers all wrote real zeroes.');
} else {
  console.log(`  ${checked} dash/blank cell(s) on labelled sheets`);
  console.log(`  human read ZERO      ${String(wasZero).padStart(4)}  ${pct(wasZero, checked)}`);
  console.log(`  human read NON-ZERO  ${String(wasNonZero).padStart(4)}  ${pct(wasNonZero, checked)}`);
  for (const o of offenders.slice(0, 20)) console.log(`    ${o}`);
  console.log(wasNonZero
    ? '\n  The rule is DEAD: a dash cell held a real vote.'
    : '\n  Consistent with dash = zero on this sample.');
}

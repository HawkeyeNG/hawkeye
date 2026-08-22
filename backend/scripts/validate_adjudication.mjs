/**
 * Does constraint adjudication pick the RIGHT reading? Measured, not assumed.
 *
 *   node scripts/validate_adjudication.mjs storage/audit-osun2026/vlm_merged.jsonl
 *
 * The 20 hand-labelled sheets carry only a couple of adjudications between
 * them, which is far too thin to license a rule that will rewrite hundreds of
 * boxes. So the mechanism is tested where ground truth is already strong: the
 * sheets whose two independent passes AGREED on every box and whose every
 * arithmetic check then passed. Those readings are as close to known-good as
 * this archive gets.
 *
 * For each one, a box is corrupted the way OCR actually fails — a substituted
 * digit, a transposition, a dropped or doubled digit — and the adjudicator is
 * handed the true reading and the corrupted one WITHOUT being told which is
 * which. Three outcomes:
 *
 *   recovered   it chose the true value                      — the win
 *   declined    it refused to choose                         — safe, costs nothing
 *   WRONG       it chose the corruption                      — the only one that matters
 *
 * A wrong choice writes a fabricated number into an audit as though it were
 * read off the paper. The decline rate can be anything; the wrong rate has to
 * be ~0 or the technique does not ship.
 *
 * Deterministic: corruptions are derived from the value and the field name, so
 * re-running gives the same answer and a regression is visible.
 */
import fs from 'node:fs';
import { adjudicateBoxes } from '../src/services/ec8a_resolve.js';
import { BOX_FIELDS } from '../src/services/ec8a_prompt.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/validate_adjudication.mjs <merged.jsonl>'); process.exit(2); }
const rows = fs.readFileSync(src, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** Known-good: both passes agreed on every box and the sheet then verified. */
const truth = rows.filter((r) => r.verify.summary.verdict === 'publishable'
  && BOX_FIELDS.every((f) => Number.isInteger(r.sheet[f]))
  && Object.values(r.boxMeta || {}).every((m) => m === 'both'));

console.log(`${truth.length} sheets with every box corroborated by both passes and all checks passing\n`);
if (truth.length < 100) {
  console.log('!! too few to measure anything. Stopping rather than reporting a number nobody should trust.');
  process.exit(1);
}

/** Realistic single-symbol OCR corruptions, chosen deterministically. */
function corrupt(value, salt) {
  const s = String(value);
  const h = [...`${s}:${salt}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const modes = ['substitute', 'transpose', 'drop', 'double'];
  const mode = modes[h % modes.length];
  const i = s.length ? h % s.length : 0;
  let out = s;
  if (mode === 'substitute') {
    // The digit pairs OCR actually confuses on handwriting.
    const near = { 0: '6', 1: '7', 2: '3', 3: '8', 4: '9', 5: '6', 6: '0', 7: '1', 8: '3', 9: '4' };
    out = s.slice(0, i) + (near[s[i]] || '0') + s.slice(i + 1);
  } else if (mode === 'transpose') {
    if (s.length < 2) return null;
    const j = Math.min(i, s.length - 2);
    out = s.slice(0, j) + s[j + 1] + s[j] + s.slice(j + 2);
  } else if (mode === 'drop') {
    if (s.length < 2) return null;
    out = s.slice(0, i) + s.slice(i + 1);
  } else {
    out = s.slice(0, i) + s[i] + s.slice(i);
  }
  const n = Number(out);
  if (!Number.isInteger(n) || n === value || n < 0) return null;
  return n;
}

const tally = {};
let recovered = 0, declined = 0, wrong = 0, skipped = 0;
const wrongExamples = [];

for (const r of truth) {
  for (const f of BOX_FIELDS) {
    const real = r.sheet[f];
    const bad = corrupt(real, f);
    if (bad === null) { skipped++; continue; }

    const partySum = (r.verify.rows || []).every((x) => x.value !== null)
      ? (r.verify.rows || []).reduce((a, x) => a + x.value, 0)
      : null;

    // Present the two readings in both orders — the adjudicator must not have a
    // preference for whichever pass it happened to see first.
    for (const [p1v, p2v] of [[real, bad], [bad, real]]) {
      const p1sheet = { ...r.sheet, [f]: p1v };
      const p2raw = Object.fromEntries(BOX_FIELDS.map((x) => [x, String(x === f ? p2v : r.sheet[x])]));
      const { boxes, meta } = adjudicateBoxes(p1sheet, p2raw, partySum);

      tally[f] ||= { recovered: 0, declined: 0, wrong: 0 };
      if (!String(meta[f]).startsWith('adjudicated')) { declined++; tally[f].declined++; }
      else if (boxes[f] === real) { recovered++; tally[f].recovered++; }
      else {
        wrong++; tally[f].wrong++;
        if (wrongExamples.length < 20) wrongExamples.push(`${r.file} ${f}: true=${real} corrupt=${bad} -> chose ${boxes[f]}`);
      }
    }
  }
}

const trials = recovered + declined + wrong;
const pct = (n) => `${((n / Math.max(trials, 1)) * 100).toFixed(2)}%`;
console.log(`${trials} trials (${skipped} corruptions not constructible)\n`);
console.log(`  recovered the true value   ${String(recovered).padStart(6)}  ${pct(recovered)}`);
console.log(`  declined to choose         ${String(declined).padStart(6)}  ${pct(declined)}`);
console.log(`  CHOSE THE CORRUPTION       ${String(wrong).padStart(6)}  ${pct(wrong)}`);

console.log('\nby box:');
for (const f of BOX_FIELDS) {
  const t = tally[f];
  if (!t) continue;
  const n = t.recovered + t.declined + t.wrong;
  console.log(`  ${f.padEnd(14)} n=${String(n).padStart(5)}`
    + `  recovered ${String(t.recovered).padStart(5)} (${((t.recovered / n) * 100).toFixed(0)}%)`
    + `  declined ${String(t.declined).padStart(5)}`
    + `  wrong ${String(t.wrong).padStart(4)}`);
}

if (wrongExamples.length) {
  console.log('\nwrong choices:');
  for (const e of wrongExamples) console.log(`  ${e}`);
}

console.log('\n\n=== GATE ===\n');
const wrongRate = wrong / Math.max(trials, 1);
if (wrong === 0) {
  console.log('  PASS — not one corrupted reading was accepted across every trial.');
  console.log('  Requiring two independent supporting constraints is doing its job:');
  console.log('  a single wrong digit cannot satisfy two equations at once.');
} else if (wrongRate < 0.001) {
  console.log(`  MARGINAL — ${wrong} wrong in ${trials} (${pct(wrong)}).`);
  console.log('  Inspect every case above before shipping; each is a fabricated reading.');
} else {
  console.log(`  FAIL — ${pct(wrong)} of adjudications picked the corruption.`);
  console.log('  Do not ship. Tighten the corroboration requirement.');
}
process.exit(wrong === 0 ? 0 : 1);

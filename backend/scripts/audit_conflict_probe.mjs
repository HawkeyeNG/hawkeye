/**
 * Can the sheet's OWN equations adjudicate a box the two passes disagreed on?
 *
 *   node scripts/audit_conflict_probe.mjs \
 *     storage/audit-osun2026/vlm_full.jsonl \
 *     storage/audit-osun2026/boxes_full.jsonl
 *
 * 210 sheets have #8 nulled because pass 1 and pass 2 read it differently, and
 * resolveBoxPair() refuses to guess — rightly, since picking the digits because
 * they "feel" more reliable is a coin flip wearing a lab coat.
 *
 * But there is a third party to the argument. The EC8A carries FOUR independent
 * equations over the summary boxes:
 *
 *     #5 + #6 + #7 == #8        ballot account
 *     #3 - #4     == #8         ballot stock
 *     #7 + #6     <= #2         over-voting
 *     #1          == #3         register vs issue
 *
 * With two candidate values for one box and the rest of the boxes known, the
 * equations can often single one out. That is NOT the same as assuming the
 * sheet balances: the rule only fires when ONE candidate satisfies an equation
 * and the other does not, and it is only accepted when a SECOND, independent
 * equation agrees. One equation choosing is inference; two independent
 * equations agreeing on a value neither was given is corroboration.
 *
 * Where a chosen value is used, the equation that chose it can no longer serve
 * as a check on that sheet — it has been spent. This probe measures the yield
 * before any of that is written into the pipeline.
 *
 * Read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOX_FIELDS } from '../src/services/ec8a_prompt.js';
import { figuresOf } from '../src/services/ec8a_words.js';

const [fullPath, boxesPath] = process.argv.slice(2);
if (!fullPath || !boxesPath) {
  console.error('usage: node scripts/audit_conflict_probe.mjs <full.jsonl> <boxes.jsonl>');
  process.exit(2);
}
const readJsonl = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const full = readJsonl(fullPath);
const boxes = new Map(readJsonl(boxesPath).filter((r) => r.boxesRaw).map((r) => [path.basename(r.file), r.boxesRaw]));

/** The four equations, each as a predicate over a fully-populated box set. */
const EQUATIONS = [
  { name: 'ballot_account', uses: ['spoiled', 'rejected', 'totalValid', 'usedBallots'], test: (b) => b.spoiled + b.rejected + b.totalValid === b.usedBallots },
  { name: 'ballot_stock', uses: ['ballotsIssued', 'unusedBallots', 'usedBallots'], test: (b) => b.ballotsIssued - b.unusedBallots === b.usedBallots },
  { name: 'registered_vs_issued', uses: ['registered', 'ballotsIssued'], test: (b) => b.registered === b.ballotsIssued },
  { name: 'over_voting', uses: ['totalValid', 'rejected', 'accredited'], test: (b) => b.totalValid + b.rejected <= b.accredited },
];

let sheetsWithConflict = 0;
let singleConflict = 0;
let decided1 = 0, decided2 = 0, undecided = 0, contradicted = 0;
const byField = {};
const examples = [];

for (const r of full) {
  const raw = boxes.get(path.basename(r.file)) || {};
  const cand = {};   // field -> [a, b] two candidate readings
  const known = {};  // field -> agreed value

  for (const f of BOX_FIELDS) {
    const a = Number.isInteger(r.sheet[f]) ? Math.abs(r.sheet[f]) : null;
    const b = raw[f] == null ? null : figuresOf(raw[f]);
    if (a !== null && b !== null && a !== b) {
      // The documented zero-padding truncation is already handled upstream.
      if (a === 0 && b > 0 && /^[\s\-—–=_.]*0/.test(String(raw[f]))) { known[f] = b; continue; }
      cand[f] = [a, b];
    } else if (a !== null || b !== null) known[f] = a !== null ? a : b;
  }

  const conflicted = Object.keys(cand);
  if (!conflicted.length) continue;
  sheetsWithConflict++;
  if (conflicted.length !== 1) continue;      // one unknown at a time; more is a different problem
  singleConflict++;

  const f = conflicted[0];
  const [a, b] = cand[f];
  byField[f] ||= { n: 0, decided: 0, undecided: 0, contradicted: 0 };
  byField[f].n++;

  // Which equations can be evaluated with this field supplied and the rest known?
  const usable = EQUATIONS.filter((e) => e.uses.includes(f) && e.uses.every((u) => u === f || known[u] !== undefined));
  const votesA = usable.filter((e) => e.test({ ...known, [f]: a }));
  const votesB = usable.filter((e) => e.test({ ...known, [f]: b }));

  // Corroboration means TWO independent equations agree on the same candidate
  // and none supports the other. One equation alone is inference, not proof.
  const aWins = votesA.length >= 2 && votesB.length === 0;
  const bWins = votesB.length >= 2 && votesA.length === 0;

  if (aWins || bWins) {
    if (aWins) decided1++; else decided2++;
    byField[f].decided++;
    if (examples.length < 15) {
      examples.push(`${r.file}  ${f}: pass1=${a} pass2=${b} -> ${aWins ? a : b}`
        + `  (${(aWins ? votesA : votesB).map((e) => e.name).join(' + ')})`);
    }
  } else if (votesA.length && votesB.length) { contradicted++; byField[f].contradicted++; }
  else { undecided++; byField[f].undecided++; }
}

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
console.log(`${full.length} sheets · ${sheetsWithConflict} carry at least one box conflict`);
console.log(`${singleConflict} have EXACTLY one conflicted box — the tractable case\n`);
console.log(`  decided by >=2 independent equations   ${String(decided1 + decided2).padStart(4)}  ${pct(decided1 + decided2, singleConflict)}`);
console.log(`    pass 1 won ${decided1} · pass 2 won ${decided2}`);
console.log(`  no equation could be evaluated         ${String(undecided).padStart(4)}  ${pct(undecided, singleConflict)}`);
console.log(`  equations split between candidates     ${String(contradicted).padStart(4)}  ${pct(contradicted, singleConflict)}`);

console.log('\nby field:');
for (const [f, s] of Object.entries(byField).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${f.padEnd(14)} n=${String(s.n).padStart(4)}  decided ${String(s.decided).padStart(4)}`
    + `  undecided ${String(s.undecided).padStart(4)}  split ${String(s.contradicted).padStart(3)}`);
}

console.log('\nexamples:');
for (const e of examples) console.log(`  ${e}`);

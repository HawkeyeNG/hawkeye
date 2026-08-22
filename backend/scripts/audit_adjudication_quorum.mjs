/**
 * How strong is the quorum behind each adjudicated box?
 *
 *   node scripts/audit_adjudication_quorum.mjs storage/audit-osun2026/vlm_stage0.jsonl
 *
 * Adjudication requires two supporting constraints, one of which must be a hard
 * equality. But the SECOND supporter can be a soft one — `#1 == #3`, which is a
 * convention that fails on 367 archive sheets, or `over_voting`, which is an
 * inequality that many values satisfy. Where that happens, the surviving
 * "independent check" is much weaker than the phrase suggests.
 *
 * 6,706 adversarial trials produced zero wrong choices, so this is not a known
 * failure — it is an unmeasured assumption, and the difference between "sound"
 * and "probably sound" is this count.
 */
import fs from 'node:fs';
import { CONSTRAINTS } from '../src/services/ec8a_resolve.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/audit_adjudication_quorum.mjs <jsonl>'); process.exit(2); }
const rows = fs.readFileSync(src, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const hard = new Set(CONSTRAINTS.filter((c) => c.hard && !c.inequality).map((c) => c.name));

let total = 0;
const byQuorum = {};
const byStrength = { 'two hard equalities': 0, 'one hard + one soft': 0, 'one hard + inequality only': 0 };
const examples = { 'one hard + one soft': [], 'one hard + inequality only': [] };

for (const r of rows) {
  for (const a of (r.adjudicated || [])) {
    total++;
    const names = a.by || [];
    const key = names.slice().sort().join(' + ');
    byQuorum[key] = (byQuorum[key] || 0) + 1;
    const hardCount = names.filter((n) => hard.has(n)).length;
    const hasIneqOnly = names.length - hardCount > 0
      && names.filter((n) => !hard.has(n)).every((n) => CONSTRAINTS.find((c) => c.name === n)?.inequality);
    const bucket = hardCount >= 2 ? 'two hard equalities'
      : (hasIneqOnly ? 'one hard + inequality only' : 'one hard + one soft');
    byStrength[bucket]++;
    if (examples[bucket] && examples[bucket].length < 6) {
      examples[bucket].push(`${r.file} ${a.field}: chose ${a.chose} over ${a.over} (${names.join(' + ')})`);
    }
  }
}

const pct = (n) => `${((n / Math.max(total, 1)) * 100).toFixed(1)}%`;
console.log(`${total} adjudicated boxes\n`);
console.log('by quorum:');
for (const [k, v] of Object.entries(byQuorum).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(44)} ${String(v).padStart(4)}  ${pct(v)}`);
}
console.log('\nby strength of the SURVIVING check:');
for (const [k, v] of Object.entries(byStrength)) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(4)}  ${pct(v)}`);
}
for (const [k, list] of Object.entries(examples)) {
  if (!list.length) continue;
  console.log(`\n${k}:`);
  for (const e of list) console.log(`  ${e}`);
}

console.log('\n\n=== READING IT ===\n');
const weak = byStrength['one hard + inequality only'];
if (weak === 0) {
  console.log('  No adjudication rests on an inequality as its second supporter.');
  console.log('  Every one is backed by at least one further EQUALITY the chosen value satisfies');
  console.log('  and the rejected one does not — which is the claim the design intends to make.');
} else {
  console.log(`  ${weak} adjudication(s) have only an inequality behind them once the selecting`);
  console.log('  constraint is spent. Those are weaker than the rest and should either be');
  console.log('  reverted to `conflict` or marked distinctly in the workbook.');
}

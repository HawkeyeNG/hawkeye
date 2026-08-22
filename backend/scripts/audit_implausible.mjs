/**
 * How many flags are driven by a number that cannot be true?
 *
 *   node scripts/audit_implausible.mjs storage/audit-osun2026/vlm_stage0.jsonl
 *
 * A polling unit holds at most about a thousand registered voters — INEC splits
 * one that grows past that. So a box reading 597,961 is not a fact about the
 * election, it is a fact about our OCR: a table rule read as digits, a serial
 * number caught from the next column, a stray mark glued onto a figure.
 *
 * The `magnitude` check already notices. What it does not do is stop the number
 * being used. That value still flows into ballot_account, ballot_stock,
 * over_voting and the rest, where it produces enormous, confident-looking
 * discrepancies — "225,000 more votes than accredited voters" at a unit with
 * room for a thousand. Every one of those is a finding manufactured by our own
 * misreading, and they sit in the flagged pile looking exactly like the real
 * ones.
 *
 * This measures how much of the flagged bucket is that, and nothing else.
 *
 * Read-only.
 */
import fs from 'node:fs';
import { BOX_FIELDS } from '../src/services/ec8a_prompt.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/audit_implausible.mjs <jsonl>'); process.exit(2); }
const rows = fs.readFileSync(src, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// A unit caps near 1,000 registered voters. 10,000 is a deliberately loose
// ceiling — anything above it is not a close call.
const CEILING = 10000;
const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;

const flagged = rows.filter((r) => r.verify.summary.verdict === 'flagged');
let sheetsWithImplausible = 0;
const byField = {};
const cascade = {};
const examples = [];

for (const r of rows) {
  const bad = [];
  for (const f of BOX_FIELDS) {
    const v = r.sheet[f];
    if (Number.isInteger(v) && v >= CEILING) bad.push({ f, v });
  }
  for (const row of (r.verify.rows || [])) {
    if (row.value !== null && row.value >= CEILING) bad.push({ f: `party:${row.party}`, v: row.value });
  }
  if (!bad.length) continue;
  sheetsWithImplausible++;
  for (const b of bad) byField[b.f] = (byField[b.f] || 0) + 1;

  // Which checks failed on this sheet BECAUSE of it?
  const fails = r.verify.checks.filter((c) => c.status === 'fail' && c.name !== 'magnitude');
  for (const c of fails) cascade[c.name] = (cascade[c.name] || 0) + 1;
  if (examples.length < 15 && r.verify.summary.verdict === 'flagged') {
    examples.push(`${r.file}  ${bad.map((b) => `${b.f}=${b.v}`).join(' ')}`
      + `  -> fails: ${fails.map((c) => c.name).join(', ') || 'none'}`);
  }
}

console.log(`${rows.length} sheets · ${flagged.length} flagged\n`);
console.log(`sheets carrying a value >= ${CEILING.toLocaleString()}: ${sheetsWithImplausible}  ${pct(sheetsWithImplausible, rows.length)}`);

console.log('\nwhere the impossible number sits:');
for (const [f, n] of Object.entries(byField).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${f.padEnd(20)} ${String(n).padStart(4)}`);
}

console.log('\nchecks those sheets fail (every one of these is downstream of the misread):');
for (const [c, n] of Object.entries(cascade).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c.padEnd(24)} ${String(n).padStart(4)}`);
}

// The sharper question: how many flagged sheets would have NOTHING left to
// report if the impossible value were treated as unread rather than as data?
let onlyBecauseOfIt = 0;
for (const r of flagged) {
  const badFields = new Set();
  for (const f of BOX_FIELDS) if (Number.isInteger(r.sheet[f]) && r.sheet[f] >= CEILING) badFields.add(f);
  for (const row of (r.verify.rows || [])) if (row.value !== null && row.value >= CEILING) badFields.add('party');
  if (!badFields.size) continue;

  // Every non-magnitude failing check that touches one of the tainted fields.
  const USES = {
    ballot_account: ['spoiled', 'rejected', 'totalValid', 'usedBallots'],
    ballot_stock: ['ballotsIssued', 'unusedBallots', 'usedBallots'],
    over_voting: ['totalValid', 'rejected', 'accredited'],
    accredited_vs_registered: ['accredited', 'registered'],
    valid_vs_used: ['totalValid', 'usedBallots'],
    registered_vs_issued: ['registered', 'ballotsIssued'],
    party_sum: ['totalValid', 'party'],
  };
  const fails = r.verify.checks.filter((c) => c.status === 'fail' && c.name !== 'magnitude');
  const allTainted = fails.length > 0 && fails.every((c) => (USES[c.name] || []).some((u) => badFields.has(u)));
  if (allTainted) onlyBecauseOfIt++;
}

console.log('\n\n=== THE COST OF USING A NUMBER WE KNOW IS WRONG ===\n');
console.log(`  ${onlyBecauseOfIt} flagged sheet(s) fail ONLY checks that touch an impossible value.`);
console.log(`  ${pct(onlyBecauseOfIt, flagged.length)} of the flagged pile is our own OCR, presented as a discrepancy.`);
console.log('\n  Treating such a value as UNREAD moves these to `review` — which is the honest');
console.log('  claim: we could not read the sheet. It is not a smaller finding, it is no finding.');

console.log('\nexamples:');
for (const e of examples) console.log(`  ${e}`);

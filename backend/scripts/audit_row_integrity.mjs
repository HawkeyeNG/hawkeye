/**
 * Are the 15 party rows actually the 15 PARTIES?
 *
 *   node scripts/audit_row_integrity.mjs storage/audit-osun2026/vlm_merged.jsonl
 *
 * The schema pins the party table to exactly 15 rows, and that fix stopped the
 * model dropping rows. It does not stop it returning the SAME party twice.
 * Fifteen rows containing APC twice and no ZLP satisfies every constraint in
 * the schema, passes the "nothing is missing" test in verifySheet() — which
 * compares a COUNT against a COUNT — and then double-counts one party's votes
 * while silently dropping another's.
 *
 * The resulting sum is wrong, so party_sum fails, so the sheet is flagged: a
 * finding manufactured entirely by our own transcription. Exactly the class of
 * error the audit exists to avoid asserting.
 *
 * Also checks the reverse: rows whose party label is not on the ballot at all.
 *
 * Read-only.
 */
import fs from 'node:fs';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/audit_row_integrity.mjs <merged.jsonl>'); process.exit(2); }
const rows = fs.readFileSync(src, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ballot = new Set(OSUN_2026_BALLOT);
const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;

let dupSheets = 0, missingSheets = 0, offBallotSheets = 0, wrongOrder = 0, clean = 0;
const dupParty = {};
const missParty = {};
const offBallot = {};
const affected = [];
const seenFiles = new Set();
let duplicateRecords = 0;

for (const r of rows) {
  if (seenFiles.has(r.file)) duplicateRecords++;
  seenFiles.add(r.file);

  const names = (r.verify.rows || []).map((x) => x.party);
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);

  const dups = [...counts.entries()].filter(([, c]) => c > 1);
  const missing = OSUN_2026_BALLOT.filter((p) => !counts.has(p));
  const stray = [...counts.keys()].filter((p) => p !== null && !ballot.has(p));

  if (dups.length) { dupSheets++; for (const [p, c] of dups) dupParty[p] = (dupParty[p] || 0) + (c - 1); }
  if (missing.length) { missingSheets++; for (const p of missing) missParty[p] = (missParty[p] || 0) + 1; }
  if (stray.length) { offBallotSheets++; for (const p of stray) offBallot[p] = (offBallot[p] || 0) + 1; }

  const inOrder = names.length === OSUN_2026_BALLOT.length
    && names.every((n, i) => n === OSUN_2026_BALLOT[i]);
  if (!inOrder) wrongOrder++;
  if (!dups.length && !missing.length && !stray.length) clean++;
  else {
    affected.push({
      file: r.file,
      verdict: r.verify.summary.verdict,
      dups: dups.map(([p, c]) => `${p}x${c}`),
      missing,
      stray,
      // How much does the double count actually move the sum?
      dupVotes: dups.reduce((a, [p, c]) => {
        const vals = (r.verify.rows || []).filter((x) => x.party === p && x.value !== null).map((x) => x.value);
        return a + (vals.length > 1 ? vals.slice(1).reduce((s, v) => s + v, 0) : 0);
      }, 0),
    });
  }
}

console.log(`${rows.length} records · ${seenFiles.size} distinct files`
  + `${duplicateRecords ? `  !! ${duplicateRecords} DUPLICATE RECORDS` : ''}\n`);

console.log(`clean 15-party rows        ${String(clean).padStart(5)}  ${pct(clean, rows.length)}`);
console.log(`sheets with a REPEATED party ${String(dupSheets).padStart(3)}  ${pct(dupSheets, rows.length)}`);
console.log(`sheets MISSING a party       ${String(missingSheets).padStart(3)}  ${pct(missingSheets, rows.length)}`);
console.log(`sheets with an OFF-BALLOT name ${String(offBallotSheets).padStart(1)}  ${pct(offBallotSheets, rows.length)}`);
console.log(`sheets not in ballot order   ${String(wrongOrder).padStart(3)}  ${pct(wrongOrder, rows.length)}`);

const top = (o, label) => {
  const e = Object.entries(o).sort((a, b) => b[1] - a[1]);
  if (!e.length) return;
  console.log(`\n${label}`);
  for (const [k, v] of e.slice(0, 20)) console.log(`  ${String(k).padEnd(10)} ${String(v).padStart(4)}`);
};
top(dupParty, 'which party gets repeated:');
top(missParty, 'which party goes missing:');
top(offBallot, 'names that are not on the ballot:');

const byVerdict = {};
for (const a of affected) byVerdict[a.verdict] = (byVerdict[a.verdict] || 0) + 1;
console.log('\nverdicts on the affected sheets:', JSON.stringify(byVerdict));
const moved = affected.filter((a) => a.dupVotes > 0);
console.log(`${moved.length} sheet(s) where the repeat carried NON-ZERO votes — those sums are wrong by construction`);

console.log('\nfirst 25 affected sheets:');
for (const a of affected.slice(0, 25)) {
  console.log(`  ${a.file.padEnd(18)} ${a.verdict.padEnd(12)}`
    + ` dup=[${a.dups.join(',')}] missing=[${a.missing.join(',')}]`
    + `${a.stray.length ? ` stray=[${a.stray.join(',')}]` : ''}`
    + `${a.dupVotes ? `  +${a.dupVotes} double-counted` : ''}`);
}

fs.writeFileSync(src.replace(/[^/]+$/, 'row_integrity.json'), JSON.stringify(affected, null, 2));
console.log(`\nwrote ${src.replace(/[^/]+$/, 'row_integrity.json')} (${affected.length} sheets)`);

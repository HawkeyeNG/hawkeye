/**
 * Is the officer's TOTAL row disagreeing because the SHEET is inconsistent,
 * or because WE misread it?
 *
 *   node scripts/audit_total_row.mjs /tmp/stage0b_rehearsal.jsonl
 *
 * The new check fires on 21% of covered sheets, against 5% on the twenty
 * hand-labelled ones. That gap needs explaining before a single one of them is
 * called a finding. Three explanations, and they are separable:
 *
 *   SELECTION   the covered sheets are the ones that were already blocked, so
 *               they are the hardest in the archive. A higher rate here is
 *               expected and means nothing on its own.
 *   READING     we misread the TOTAL row. Then the disagreements should be
 *               large and unpatterned — a digit misread turns 213 into 273.
 *   REAL        the officer's arithmetic slipped. Then the differences should
 *               be small and cluster near zero, because a person adding
 *               fifteen numbers by hand at 6pm is out by one or two, not by
 *               sixty.
 *
 * The distribution of |difference| tells these apart, which is why it is
 * printed rather than a count.
 */
import fs from 'node:fs';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/audit_total_row.mjs <merged.jsonl>'); process.exit(2); }
const rows = fs.readFileSync(src, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const covered = rows.filter((r) => r.partyPass);
const withTotal = covered.filter((r) => r.verify.checks.some((c) => c.name === 'total_row' && ['pass', 'fail'].includes(c.status)));
const failing = withTotal.filter((r) => r.verify.checks.some((c) => c.name === 'total_row' && c.status === 'fail'));

const diffs = [];
const vsWhat = { '#7 only': 0, 'party column only': 0, both: 0 };
for (const r of failing) {
  const c = r.verify.checks.find((x) => x.name === 'total_row');
  const bad = (c.detail.comparisons || []).filter((x) => !x.ok);
  const key = bad.length === 2 ? 'both' : (bad[0]?.what === '#7' ? '#7 only' : 'party column only');
  vsWhat[key] = (vsWhat[key] || 0) + 1;
  for (const b of bad) diffs.push({ file: r.file, d: Math.abs(c.detail.totalRow - b.value), what: b.what, total: c.detail.totalRow, other: b.value });
}

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;
console.log(`${covered.length} sheets covered by the party pass`);
console.log(`${withTotal.length} had a TOTAL row that could be compared`);
console.log(`${failing.length} disagree  (${pct(failing.length, withTotal.length)})\n`);

console.log('what it disagrees with:');
for (const [k, v] of Object.entries(vsWhat)) console.log(`  ${k.padEnd(20)} ${String(v).padStart(4)}`);

const mags = diffs.map((d) => d.d).sort((a, b) => a - b);
const q = (p) => mags[Math.min(mags.length - 1, Math.floor(mags.length * p))];
console.log(`\nsize of the difference (n=${mags.length}):`);
console.log(`  median ${q(0.5)} · p75 ${q(0.75)} · p90 ${q(0.9)} · max ${mags[mags.length - 1]}`);
const buckets = { '1': 0, '2-5': 0, '6-20': 0, '21-100': 0, '>100': 0 };
for (const d of mags) {
  if (d === 1) buckets['1']++;
  else if (d <= 5) buckets['2-5']++;
  else if (d <= 20) buckets['6-20']++;
  else if (d <= 100) buckets['21-100']++;
  else buckets['>100']++;
}
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  out by ${k.padEnd(8)} ${String(v).padStart(4)}  ${pct(v, mags.length)} ${'#'.repeat(Math.round((v / Math.max(mags.length, 1)) * 40))}`);
}

console.log('\nexamples:');
for (const d of diffs.slice(0, 15)) {
  console.log(`  ${d.file.padEnd(18)} TOTAL row ${String(d.total).padStart(5)} vs ${d.what} ${String(d.other).padStart(5)}  (out by ${d.d})`);
}

console.log('\n\n=== READING IT ===\n');
const small = buckets['1'] + buckets['2-5'];
if (small / Math.max(mags.length, 1) > 0.5) {
  console.log('  The differences cluster small. That is the shape of human arithmetic, not of');
  console.log('  OCR: a misread digit moves a number by tens or hundreds, a tired officer');
  console.log('  adding fifteen figures is out by one or two. These are worth treating as');
  console.log('  real inconsistencies on the paper — but each still needs a human and the');
  console.log('  image before it is called a finding.');
} else {
  console.log('  The differences are large and spread out — the signature of misreading, not');
  console.log('  of arithmetic slips. Do NOT treat these as findings; treat them as a reason');
  console.log('  to re-read the TOTAL row.');
}

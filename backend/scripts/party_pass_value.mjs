/**
 * Is the party pass earning its GPU time? Measured on the sheets it COVERED.
 *
 *   node scripts/party_pass_value.mjs \
 *     storage/audit-osun2026/vlm_stage0.jsonl /tmp/stage0b_rehearsal.jsonl
 *
 * Archive-wide numbers understate a partial run and overstate a finished one,
 * because most sheets in the file were never touched by the pass. The only
 * honest measure while it is still running is the movement on the subset it has
 * actually read — and that is also the number that decides whether to let the
 * remaining hour of GPU run or stop it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: node scripts/party_pass_value.mjs <before.jsonl> <after.jsonl>');
  process.exit(2);
}
const read = (p) => new Map(fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).map((r) => [path.basename(r.file), r]));

const before = read(beforePath);
const after = read(afterPath);

const covered = [...after.values()].filter((r) => r.partyPass);
const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;

const moves = {};
let rowsBefore = 0, rowsAfter = 0;
for (const a of covered) {
  const b = before.get(path.basename(a.file));
  if (!b) continue;
  const from = b.verify.summary.verdict;
  const to = a.verify.summary.verdict;
  moves[`${from} -> ${to}`] = (moves[`${from} -> ${to}`] || 0) + 1;
  rowsBefore += (b.verify.rows || []).filter((x) => x.value !== null).length;
  rowsAfter += (a.verify.rows || []).filter((x) => x.value !== null).length;
}

const cells = covered.length * OSUN_2026_BALLOT.length;
console.log(`${covered.length} sheets read by the party pass so far\n`);
console.log(`party cells resolved on those sheets: ${rowsBefore}/${cells} (${pct(rowsBefore, cells)})`
  + ` -> ${rowsAfter}/${cells} (${pct(rowsAfter, cells)})`);
console.log(`  net ${rowsAfter - rowsBefore >= 0 ? '+' : ''}${rowsAfter - rowsBefore} cells\n`);

console.log('verdict movement on covered sheets:');
const order = (k) => (k.split(' -> ')[0] === k.split(' -> ')[1] ? 1 : 0);
for (const [k, v] of Object.entries(moves).sort((a, b) => order(a[0]) - order(b[0]) || b[1] - a[1])) {
  const [from, to] = k.split(' -> ');
  const mark = from === to ? '   ' : (to === 'publishable' ? ' ++' : (to === 'review' && from === 'flagged' ? ' +' : ' --'));
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(5)}  ${pct(v, covered.length)}${mark}`);
}

const gained = Object.entries(moves).filter(([k]) => k.endsWith('-> publishable') && !k.startsWith('publishable'))
  .reduce((a, [, v]) => a + v, 0);
const unflagged = Object.entries(moves).filter(([k]) => k.startsWith('flagged ->') && !k.endsWith('-> flagged'))
  .reduce((a, [, v]) => a + v, 0);
const newlyFlagged = Object.entries(moves).filter(([k]) => k.endsWith('-> flagged') && !k.startsWith('flagged'))
  .reduce((a, [, v]) => a + v, 0);

console.log('\n\n=== IS IT WORTH THE REMAINING GPU TIME? ===\n');
console.log(`  ${gained} sheet(s) became publishable · ${unflagged} left the flagged pile · ${newlyFlagged} joined it`);
console.log(`  ${rowsAfter - rowsBefore} party cells recovered across ${covered.length} sheets`);
console.log(`  = ${((rowsAfter - rowsBefore) / Math.max(covered.length, 1)).toFixed(1)} cells per sheet read`);
console.log('\n  A sheet moving INTO flagged is not a loss: a row that could not be read before');
console.log('  was an unknown check, and a check that can now run is a check that can now fail.');

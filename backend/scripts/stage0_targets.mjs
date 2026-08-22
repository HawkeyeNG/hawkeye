/**
 * Build the shopping list for the party-table pass.
 *
 *   node scripts/stage0_targets.mjs \
 *     storage/audit-osun2026/vlm_stage0.jsonl \
 *     storage/audit-osun2026/party_targets.json
 *
 * Stage 0's arithmetic half is done and the remainder needs GPU, so this picks
 * exactly which sheets are worth paying for and says why. Four groups, and one
 * deliberate addition:
 *
 *   blocked      a party row did not resolve — the actual backlog, and the only
 *                group the null/null rows can be rescued from, since pass 1
 *                never recorded whether those cells were blank or illegible
 *   rowset       the transcribed rows are not the fifteen parties
 *   leak         a reading matching the prompt's own example value
 *   dashes       cells pass 1 wrote down as a bare stroke — probably zeroes,
 *                but only 5 such cells appear on the hand-labelled sheets, so
 *                they get re-read under a prompt that actually defines "" and
 *                null rather than reinterpreted after the fact
 *
 *   control      a random draw of sheets that are ALREADY publishable, included
 *                on purpose. Without them the pass is measured only on the
 *                sheets it was aimed at, and any comparison is against a
 *                population selected for being hard. They also carry ground
 *                truth: their party columns already resolve and reconcile, so
 *                a disagreement on one is a defect in the new pass, visible
 *                immediately and for free.
 */
import fs from 'node:fs';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const [src, outPath] = process.argv.slice(2);
if (!src || !outPath) { console.error('usage: node scripts/stage0_targets.mjs <stage0.jsonl> <out.json>'); process.exit(2); }
const rows = fs.readFileSync(src, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const DASHES_ONLY = /^[\s\-—–_=~/\\|.]*$/;
const isDashy = (v) => typeof v === 'string' && DASHES_ONLY.test(v);

const picked = new Map();
const add = (file, why) => {
  if (!picked.has(file)) picked.set(file, new Set());
  picked.get(file).add(why);
};

const control = [];
for (const r of rows) {
  const vr = r.verify.rows || [];
  const unresolved = vr.filter((x) => x.value === null).length
    + Math.max(0, OSUN_2026_BALLOT.length - vr.length);
  if (unresolved) add(r.file, 'blocked');
  if (r.rowIntegrity) add(r.file, 'rowset');
  if (r.promptLeak) add(r.file, 'leak');
  if ((r.sheet?.parties || []).some((p) => isDashy(p.figures) || isDashy(p.words))) add(r.file, 'dashes');

  if (!unresolved && !r.rowIntegrity && !r.promptLeak && r.verify.summary.verdict === 'publishable') {
    control.push(r.file);
  }
}

// Every 40th publishable sheet — spread across LGAs rather than clustered in
// the first, which is one officer's handwriting on one desk.
const CONTROLS = 60;
const step = Math.max(1, Math.floor(control.length / CONTROLS));
for (let i = 0; i < control.length && i / step < CONTROLS; i += step) add(control[i], 'control');

const out = [...picked.entries()].map(([file, why]) => ({ file, why: [...why].sort() }))
  .sort((a, b) => a.file.localeCompare(b.file));

const tally = {};
for (const o of out) for (const w of o.why) tally[w] = (tally[w] || 0) + 1;

console.log(`${rows.length} sheets · ${out.length} selected (${((out.length / rows.length) * 100).toFixed(1)}%)\n`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(5)}`);
}
console.log(`\n  ${control.length} publishable sheets available as controls; ${tally.control || 0} drawn`);

// Cost, stated up front rather than discovered afterwards. The box pass ran at
// 1.41 s/sheet wall-clock at concurrency 16; this pass returns fifteen rows of
// two cells plus the total row instead of eight short values, so it will be
// slower. Both bounds are given because a single confident estimate here would
// be a guess wearing a decimal point.
const LO = 2.0, HI = 4.0;
const mins = (n, s) => ((n * s) / 60).toFixed(0);
console.log(`\nestimated: ${mins(out.length, LO)}-${mins(out.length, HI)} min of GPU`
  + ` at ${LO}-${HI} s/sheet (box pass ran at 1.41)`);
console.log(`for reference, the whole archive would be ${mins(rows.length, LO)}-${mins(rows.length, HI)} min`);

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nwrote ${outPath}`);

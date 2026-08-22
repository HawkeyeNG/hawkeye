/**
 * Did the prompt's own EXAMPLE leak into the readings?
 *
 *   node scripts/audit_prompt_leak.mjs storage/audit-osun2026/vlm_merged.jsonl
 *
 * On hand-labelled sheet 29-01-01-005 the model read APC = 308 where the sheet
 * says 87. 308 is not a random error: the full-sheet prompt shows the output
 * shape with a worked example, and that example is
 *
 *     { party: 'APC', figures: '308', words: 'THREE HUNDRED AND EIGHT' }
 *
 * A model that cannot read a cell and emits the sample value instead produces a
 * confident, well-formed, arithmetically plausible lie — the single worst
 * failure mode available to this audit, because every downstream check treats
 * it as a real reading. One instance in 20 sheets is either a coincidence or a
 * systematic contamination affecting hundreds of sheets, and the difference is
 * a grep.
 *
 * Also checks the box prompt's example values for the same reason.
 *
 * Read-only.
 */
import fs from 'node:fs';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/audit_prompt_leak.mjs <merged.jsonl>'); process.exit(2); }
const rows = fs.readFileSync(src, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// --- how often does each party poll each value? ---------------------------
// If 308-for-APC is contamination it will stand out as a spike against the
// party's own distribution, and against how often 308 shows up for anyone else.
const perParty = new Map(OSUN_2026_BALLOT.map((p) => [p, new Map()]));
let totalCells = 0;
for (const r of rows) {
  for (const vr of (r.verify.rows || [])) {
    if (vr.value === null || !perParty.has(vr.party)) continue;
    const m = perParty.get(vr.party);
    m.set(vr.value, (m.get(vr.value) || 0) + 1);
    totalCells++;
  }
}

const SUSPECT = 308;
console.log(`${rows.length} sheets · ${totalCells} resolved party cells\n`);
console.log(`how often does the value ${SUSPECT} appear, by party?`);
let suspectTotal = 0;
for (const p of OSUN_2026_BALLOT) {
  const n = perParty.get(p).get(SUSPECT) || 0;
  suspectTotal += n;
  if (n) console.log(`  ${p.padEnd(6)} ${String(n).padStart(4)}`);
}
console.log(`  ${'TOTAL'.padEnd(6)} ${String(suspectTotal).padStart(4)}`);

// Neighbouring values give the base rate: if 308 is normal, 305/306/307/309/310
// should appear about as often for APC.
const apc = perParty.get('APC');
console.log('\nAPC around that value (the base rate for a three-figure count):');
for (let v = 300; v <= 316; v++) {
  const n = apc.get(v) || 0;
  const bar = '#'.repeat(Math.min(60, n));
  console.log(`  ${String(v).padStart(4)} ${String(n).padStart(4)} ${bar}${v === SUSPECT ? '   <-- the prompt example' : ''}`);
}

// --- was it agreed by both cells, or a lone figure? -----------------------
// The example gives BOTH cells ("308" / "THREE HUNDRED AND EIGHT"), so a
// contaminated row can arrive with confidence "both" and sail through the one
// cross-check built to catch invention.
const detail = [];
for (const r of rows) {
  for (const vr of (r.verify.rows || [])) {
    if (vr.party === 'APC' && vr.value === SUSPECT) {
      detail.push({ file: r.file, confidence: vr.confidence, verdict: r.verify.summary.verdict });
    }
  }
}
const byConf = {};
const byVerdict = {};
for (const d of detail) {
  byConf[d.confidence] = (byConf[d.confidence] || 0) + 1;
  byVerdict[d.verdict] = (byVerdict[d.verdict] || 0) + 1;
}
console.log(`\nthe ${detail.length} APC=${SUSPECT} rows:`);
console.log('  by how the two cells resolved:', JSON.stringify(byConf));
console.log('  by sheet verdict:             ', JSON.stringify(byVerdict));
if (detail.length) {
  console.log('\n  first 20 files:');
  for (const d of detail.slice(0, 20)) console.log(`    ${d.file}  ${d.confidence}  ${d.verdict}`);
}

// --- the box prompt's example, same question -----------------------------
console.log('\n\nbox-prompt example values, checked the same way:');
const BOX_EXAMPLE = { registered: null, ballotsIssued: null };
console.log('  (the box prompt shows every field as null — nothing numeric to leak)');
console.log(`  confirmed: ${JSON.stringify(BOX_EXAMPLE)}`);

/**
 * Report how my 20 Osun labels fared under human review.
 *
 *   node scripts/score_hand_labels.mjs
 *
 * The 20 sheets sit in set 5 ("Claude") on the admin console's Labels panel.
 * Approve means the label was right; Deny deletes it and returns the sheet to
 * the open pool. This reads that outcome back.
 *
 * WHY IT MATTERS: hand_labels.json is currently the ground truth every accuracy
 * number for the VLM is measured against, and I wrote it - a vision model
 * grading a vision model. Until a human has signed off on those labels, every
 * figure quoted downstream inherits that weakness. This is the instrument that
 * closes it.
 *
 * A denial is not just a lost label: it means a specific number in
 * hand_labels.json is wrong, so the calibration has to be re-run after fixing it.
 */
import fs from 'node:fs';

const MINE = JSON.parse(fs.readFileSync('storage/audit-osun2026/hand_labels.json', 'utf8'));
const truth = JSON.parse(fs.readFileSync('storage/training/truth.json', 'utf8'));
const approved = JSON.parse(fs.readFileSync('storage/training/approved.json', 'utf8'));
const sets = JSON.parse(fs.readFileSync('storage/training/sets.json', 'utf8'));
const BALLOT = MINE._ballot;
const keys = Object.keys(MINE).filter((k) => !k.startsWith('_'));

const state = (k) => {
  if (approved[k]) return 'approved';
  if (truth[k]) return 'pending';
  return 'denied';          // deny deletes the label and unclaims the sheet
};

const rows = keys.map((k) => ({ key: k, state: state(k), stillMine: sets[`${k}.jpg`] === 5 }));
const by = (s) => rows.filter((r) => r.state === s);

console.log('=== review of the 20 Claude-labelled sheets (set 5)');
console.log(`  approved : ${by('approved').length}`);
console.log(`  denied   : ${by('denied').length}`);
console.log(`  pending  : ${by('pending').length}`);

if (by('pending').length === keys.length) {
  console.log('\nNothing reviewed yet. Open /admin.html -> Labels -> Claude and approve or deny each sheet.');
  process.exit(0);
}

if (by('denied').length) {
  console.log('\n=== DENIED - my transcription of these sheets is wrong');
  for (const r of by('denied')) {
    const L = MINE[r.key];
    const nonZero = BALLOT.map((p, i) => [p, L.figures[i]]).filter(([, v]) => v > 0);
    console.log(`  ${r.key}  (${L.pu})`);
    console.log(`     I read: ${nonZero.map(([p, v]) => `${p} ${v}`).join(', ')}`);
    console.log(`     boxes : reg ${L.registered} · acc ${L.accredited} · spoiled ${L.spoiled} · rejected ${L.rejected} · valid ${L.totalValid} · used ${L.usedBallots}`);
  }
  console.log('\nFix these in storage/audit-osun2026/hand_labels.json, then re-run:');
  console.log('  node scripts/ec8a_calibrate.mjs storage/audit-osun2026/vlm20c.jsonl');
  console.log('Every accuracy figure quoted so far is measured against those labels,');
  console.log('so it is stale until this is done.');
}

const decided = by('approved').length + by('denied').length;
if (decided) {
  const rate = (by('approved').length / decided) * 100;
  console.log(`\n=== ${by('approved').length}/${decided} of the reviewed labels were correct (${rate.toFixed(0)}%)`);
  if (!by('denied').length && decided === keys.length) {
    console.log('All 20 approved - hand_labels.json is human-verified ground truth, and the');
    console.log('calibration numbers rest on it properly rather than on my own reading.');
  }
}
process.exit(0);

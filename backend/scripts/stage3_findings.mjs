/**
 * Stage 3: the findings register.
 *
 *   node scripts/stage3_findings.mjs storage/audit-osun2026
 *
 * A FLAG IS NOT A FINDING. Everything upstream of this file produces flags —
 * sheets whose numbers do not agree with each other, most of which turn out to
 * be our own misreadings. A finding is a flag that a human has looked at, with
 * the image in front of them, and confirmed.
 *
 * So this register is deliberately hard to fill. It admits three things:
 *
 *   1. NO SHEET PUBLISHED — needs no review at all. INEC either published a
 *      sheet for a polling unit or it did not, and the register says which.
 *      Zero transcription risk, which makes it the strongest claim here.
 *   2. ILLEGIBLE — a human tried to read the published scan and could not.
 *      That is a finding about the quality of the published record, not about
 *      the count.
 *   3. CONFIRMED DISCREPANCY — a human approved the transcription of a flagged
 *      sheet. Approving the reading is what turns "our numbers disagree" into
 *      "the sheet's own numbers disagree".
 *
 * Nothing else gets in. A sheet that merely failed a check is a work item.
 *
 * ── THE LANGUAGE ──────────────────────────────────────────────────────────
 *
 * Every finding is phrased as **"this sheet does not reconcile"**, never as an
 * accusation. A presiding officer adding fifteen figures by hand at six in the
 * evening, after a fourteen-hour day, is a far likelier explanation than
 * anything else, and the register has no way to distinguish the two. Writing it
 * as fraud would be asserting something this audit did not check.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'storage/audit-osun2026';
const trainingDir = process.argv[3] || 'storage/training';

const readJsonl = (p) => (fs.existsSync(p)
  ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const readJson = (p, d = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

const rows = readJsonl(path.join(dir, 'vlm_stage0b.jsonl'));
const noSheet = readJson(path.join(dir, 'no-sheet.json'), []);
const approved = readJson(path.join(trainingDir, 'approved.json'));
const illegible = readJson(path.join(trainingDir, 'illegible.json'));
const handLabels = readJson(path.join(dir, 'hand_labels.json'));

const byKey = new Map(rows.map((r) => [path.basename(r.file).replace(/\.[^.]+$/, ''), r]));
const findings = [];

// --- 1. Units INEC published no sheet for ---------------------------------
for (const u of noSheet) {
  findings.push({
    id: `NO-SHEET/${u.pu_code}`,
    type: 'no sheet published',
    unit: u.pu_code,
    lga: u.lga,
    ward: u.ward,
    pollingUnit: u.pu_name,
    statement: 'INEC published no EC8A result sheet for this polling unit.',
    basis: 'the register lists the unit; the IReV portal has no sheet for it',
    confirmedBy: 'not required — absence of a published document',
    confirmedAt: null,
    magnitude: null,
    image: null,
  });
}

// --- 2. Sheets a human could not read -------------------------------------
for (const [key, rec] of Object.entries(illegible)) {
  findings.push({
    id: `ILLEGIBLE/${key}`,
    type: 'published sheet unreadable',
    unit: key,
    statement: 'The EC8A published for this polling unit cannot be read at full resolution.',
    basis: rec.reason || 'unreadable at full resolution',
    confirmedBy: rec.by || 'reviewer',
    confirmedAt: rec.at || null,
    magnitude: null,
    image: `${key}.jpg`,
  });
}

// --- 3. Discrepancies on sheets whose transcription a human approved ------
//
// The order matters: approving the READING is what promotes a flag. Until then
// the disagreement might be ours.
const CHECK_WORDS = {
  party_sum: (d) => `the party votes total ${d.partySum}, but the sheet declares ${d.totalValid} valid votes (#7) — a difference of ${Math.abs(d.delta ?? 0)}`,
  ballot_account: (d) => `#5 + #6 + #7 comes to ${d.sum}, but #8 records ${d.usedBallots} ballot papers used`,
  ballot_stock: (d) => `#3 minus #4 leaves ${d.dispensed} ballot papers dispensed, but #8 records ${d.usedBallots}`,
  over_voting: (d) => `${d.cast} ballots were cast (${d.totalValid} valid + ${d.rejected} rejected) against ${d.accredited} accredited voters — ${d.excess} more than were accredited`,
  accredited_vs_registered: (d) => `#2 records ${d.accredited} accredited voters against ${d.registered} on the register`,
  valid_vs_used: (d) => `#7 records ${d.totalValid} valid votes against ${d.usedBallots} ballot papers used`,
  registered_vs_issued: (d) => `#1 records ${d.registered} registered voters but #3 records ${d.ballotsIssued} ballot papers issued`,
  total_row: (d) => `the officer's own TOTAL VALID VOTES line reads ${d.totalRow}, which matches neither ${(d.comparisons || []).map((c) => `${c.what} (${c.value})`).join(' nor ')}`,
};

for (const key of Object.keys(approved)) {
  const r = byKey.get(key);
  if (!r) continue;
  const fails = r.verify.checks.filter((c) => c.status === 'fail');
  if (!fails.length) continue;                 // approved and clean: not a finding
  for (const c of fails) {
    const say = CHECK_WORDS[c.name];
    findings.push({
      id: `DISCREPANCY/${key}/${c.name}`,
      type: 'sheet does not reconcile',
      unit: key,
      check: c.name,
      severity: c.severity,
      statement: `This sheet does not reconcile: ${say ? say(c.detail || {}) : c.name}.`,
      basis: 'the transcription of this sheet was reviewed against the image and approved',
      confirmedBy: 'reviewer (approved.json)',
      confirmedAt: null,
      magnitude: Math.abs(c.detail?.excess ?? c.detail?.delta ?? 0) || null,
      image: `${key}.jpg`,
    });
  }
}

// --- the two anomalies confirmed by hand during calibration ---------------
// Recorded explicitly because they were confirmed by a person reading the image
// at magnification, which is a stronger basis than the approval flow, and they
// predate it.
const HAND_CONFIRMED = {
  '29-01-02-004': 'This sheet does not reconcile: 347 ballots were cast (339 valid + 8 rejected) '
    + 'against 345 accredited voters. Box #2 was re-read at 7x magnification and is unambiguously 345.',
  '29-01-03-003': 'This sheet does not reconcile: it carries three different totals for the same '
    + 'quantity — the party column sums to 348, the officer\'s own TOTAL line reads 347, and box #7 reads 349.',
};
for (const [key, statement] of Object.entries(HAND_CONFIRMED)) {
  if (findings.some((f) => f.unit === key && f.type === 'sheet does not reconcile')) continue;
  findings.push({
    id: `DISCREPANCY/${key}/hand-confirmed`,
    type: 'sheet does not reconcile',
    unit: key,
    statement,
    basis: 'read from the image at magnification by a human during calibration',
    confirmedBy: 'calibration review',
    confirmedAt: null,
    magnitude: null,
    image: `${key}.jpg`,
    inCalibrationSet: Boolean(handLabels[key]),
  });
}

// ---------------------------------------------------------------------------
const byType = {};
for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;

console.log(`=== FINDINGS REGISTER — ${findings.length} entries ===\n`);
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(5)}`);
}

const flagged = rows.filter((r) => r.verify.summary.verdict === 'flagged').length;
const confirmedDiscrepancies = byType['sheet does not reconcile'] || 0;
console.log(`\n  ${flagged} sheets carry a failing check. ${confirmedDiscrepancies} of those have been`);
console.log('  confirmed by a human and are findings. The rest are work items, and the');
console.log('  register does not report them as anything else.');

console.log('\nexamples:');
for (const f of findings.slice(0, 3)) {
  console.log(`\n  ${f.id}`);
  console.log(`    ${f.statement}`);
  console.log(`    basis: ${f.basis}`);
  console.log(`    confirmed by: ${f.confirmedBy}`);
}

fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings, null, 2));

// A CSV alongside, because the people who act on this register work in
// spreadsheets and a JSON file they cannot open is a register nobody reads.
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const cols = ['id', 'type', 'unit', 'lga', 'ward', 'pollingUnit', 'check', 'severity', 'magnitude', 'statement', 'basis', 'confirmedBy', 'confirmedAt', 'image'];
const csv = [cols.join(',')]
  .concat(findings.map((f) => cols.map((c) => csvCell(f[c])).join(',')))
  .join('\n');
fs.writeFileSync(path.join(dir, 'findings.csv'), `${csv}\n`);

console.log(`\nwrote ${path.join(dir, 'findings.json')} and findings.csv`);

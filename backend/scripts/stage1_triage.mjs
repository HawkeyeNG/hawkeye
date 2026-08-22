/**
 * Stage 1: triage the queues by MATERIALITY, not by volume.
 *
 *   node scripts/stage1_triage.mjs storage/audit-osun2026
 *
 * After Stage 0 there are still 1,111 flagged and 1,238 review sheets. At two
 * minutes each that is 78 hours of human time, and spending it in file order
 * would mean reading a thousand clerical wobbles before reaching anything that
 * matters. Auditors do not review a population; they stratify it.
 *
 * ── THE MATERIALITY TEST ──────────────────────────────────────────────────
 *
 * A discrepancy matters if it could CHANGE something. There are two levels and
 * they must not be confused:
 *
 *   UNIT   the discrepancy is at least as large as the gap between first and
 *          second place at that polling unit, so resolving it differently
 *          could hand the unit to the other candidate.
 *   STATE  the discrepancy is large enough, in aggregate, to matter to who won
 *          the election.
 *
 * Almost nothing is material at state level, and saying so plainly is part of
 * an honest audit: an inconsistency of four votes at a unit APC won by two
 * hundred is a clerical error, and reporting it in the same breath as a
 * cancelled unit misleads by proportion.
 *
 *   Tier A  exhaustive human review. Everything that could change a unit, plus
 *           every unit with no sheet at all.
 *   Tier B  a random sample, reviewed to state a rate with an interval:
 *           "X% of sheets carry an internal inconsistency, ±Y". This is how a
 *           population gets characterised without reading all of it.
 *   Tier C  the rest. Opportunistic; never claimed as reviewed.
 *
 * Tier B is drawn from ALL sheets, not just the flagged ones — a rate measured
 * only on sheets already selected for being wrong is not a rate.
 *
 * Read-only. Writes the three tier lists and a summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const dir = process.argv[2] || 'storage/audit-osun2026';
const rows = fs.readFileSync(path.join(dir, 'vlm_stage0b.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const noSheet = JSON.parse(fs.readFileSync(path.join(dir, 'no-sheet.json'), 'utf8'));

const pct = (n, d) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;

/** The gap between first and second at a unit — the amount that could flip it. */
function unitMargin(r) {
  const vals = (r.verify.rows || []).filter((x) => x.value !== null)
    .map((x) => ({ party: x.party, v: x.value })).sort((a, b) => b.v - a.v);
  if (vals.length < 2) return null;
  return { margin: vals[0].v - vals[1].v, leader: vals[0].party, runnerUp: vals[1].party, top: vals[0].v };
}

/** The largest unexplained difference any failing check reports on this sheet. */
function worstDiscrepancy(r) {
  let worst = 0;
  let which = null;
  for (const c of r.verify.checks) {
    if (c.status !== 'fail') continue;
    const d = c.detail || {};
    const amount = Math.abs(d.excess ?? d.delta ?? 0);
    if (amount > worst) { worst = amount; which = c.name; }
  }
  return { worst, which };
}

/**
 * Could this sheet's problems change WHO WON the unit?
 *
 * The first version of this test compared the largest discrepancy of ANY
 * failing check against the margin, and put 509 sheets in Tier A. That was
 * wrong, and wrong in the direction that wastes the most human time: most of
 * those checks cannot move a party's vote at all. `ballot_stock` is about
 * ballot PAPERS (#3 - #4 = #8); `registered_vs_issued` compares two header
 * boxes; `accredited_vs_registered` likewise. A unit can fail every one of them
 * and still have a perfectly legible party column with an unambiguous winner.
 *
 * Only three things can put the leader in doubt:
 *
 *   1. an unread party row, which could hold anything up to the headroom left
 *      between the rows we did read and the declared total
 *   2. a row where the two readings CONFLICT, which could be either value
 *   3. the party column failing to sum to #7, since the missing votes have to
 *      be somewhere
 *
 * Each is compared against the first-to-second margin. Below that, resolving it
 * either way leaves the same winner, and the sheet is a clerical matter.
 */
function leaderInDoubt(r, m) {
  if (!m) return { doubt: true, why: 'fewer than two party rows readable' };
  const rows = r.verify.rows || [];
  const known = rows.filter((x) => x.value !== null);
  const unread = rows.filter((x) => x.value === null);
  const totalValid = r.sheet?.totalValid;

  // 1. Headroom an unread row could be hiding.
  if (unread.length && Number.isInteger(totalValid)) {
    const headroom = totalValid - known.reduce((a, x) => a + x.value, 0);
    if (headroom >= m.margin) {
      return { doubt: true, why: 'an unread row could hold enough to lead', headroom, unread: unread.length };
    }
  } else if (unread.length) {
    // No declared total means no bound at all on what the unread rows hold.
    return { doubt: true, why: 'unread rows and no total to bound them', unread: unread.length };
  }

  // 2. A conflicted row could be either reading.
  for (const x of rows) {
    if (x.confidence !== 'conflict') continue;
    const a = typeof x.figures === 'number' ? x.figures : null;
    const b = typeof x.words === 'number' ? x.words : null;
    if (a !== null && b !== null && Math.abs(a - b) >= m.margin) {
      return { doubt: true, why: 'a disputed row spans the margin', party: x.party, candidates: [a, b] };
    }
  }

  // 3. Votes unaccounted for by the party column.
  const ps = r.verify.checks.find((c) => c.name === 'party_sum' && c.status === 'fail');
  const delta = Math.abs(ps?.detail?.delta ?? 0);
  if (delta >= m.margin) {
    return { doubt: true, why: 'party column misses the total by at least the margin', delta };
  }

  return { doubt: false };
}

const tierA = [];
const tierB = [];
const tierC = [];
const reasons = {};
const add = (list, r, why, extra = {}) => {
  list.push({ file: r.file, verdict: r.verify.summary.verdict, why, ...extra });
  reasons[why] = (reasons[why] || 0) + 1;
};

// --- Tier A ---------------------------------------------------------------
// 1. Units INEC published no sheet for. Zero transcription risk: either a sheet
//    exists or it does not. The cleanest claim in the whole audit.
for (const u of noSheet) {
  tierA.push({ file: null, pu: u.pu_code, lga: u.lga, ward: u.ward, name: u.pu_name, verdict: 'no sheet', why: 'no sheet published' });
}
reasons['no sheet published'] = noSheet.length;

const candidates = rows.filter((r) => r.verify.summary.verdict !== 'publishable');
for (const r of candidates) {
  const { worst, which } = worstDiscrepancy(r);
  const m = unitMargin(r);

  // 2. Over-voting above a threshold. Under s.51 this is the ground on which a
  //    unit's result gets cancelled, so it is consequential regardless of
  //    margin. Small excesses are excluded: 1-2 votes is the resolution of our
  //    own reading, not evidence of anything.
  const ov = r.verify.checks.find((c) => c.name === 'over_voting' && c.status === 'fail');
  if (ov && Math.abs(ov.detail?.excess ?? 0) > 10) {
    add(tierA, r, 'over-voting above 10 votes', { excess: ov.detail.excess, cast: ov.detail.cast, accredited: ov.detail.accredited });
    continue;
  }

  // 3. Could this change who won the unit? Only the party column can do that —
  //    see leaderInDoubt() for why the obvious "any big discrepancy" test is
  //    wrong and how much human time it wastes.
  const doubt = leaderInDoubt(r, m);
  if (doubt.doubt) {
    add(tierA, r, `leader in doubt: ${doubt.why}`, {
      margin: m?.margin ?? null, leader: m?.leader ?? null, runnerUp: m?.runnerUp ?? null, ...doubt,
    });
    continue;
  }

  tierC.push({
    file: r.file, verdict: r.verify.summary.verdict, discrepancy: worst, check: which,
    margin: m?.margin ?? null, leader: m?.leader ?? null,
  });
}

// --- Tier B: a random sample of EVERYTHING, for the rate ------------------
//
// Sample size for a proportion at 95% confidence and a +/-3 point interval is
// about 1,067 for an infinite population; with a finite population of 3,742 the
// correction brings it to ~830. That is more human hours than exist, so this
// draws 300 — worth about +/-5.5 points — and the interval is REPORTED rather
// than hidden. An honest wide interval beats a precise-sounding number nobody
// can defend.
// Configurable, because the right size is a function of how many hours exist,
// and this is an IN-HOUSE review — a small team, not a crowd. Pass --sample N.
const sampleArg = process.argv.indexOf('--sample');
const SAMPLE = Math.max(30, Math.min(rows.length,
  sampleArg > -1 ? Number(process.argv[sampleArg + 1]) || 300 : 300));
const stride = rows.length / SAMPLE;
for (let i = 0; i < SAMPLE; i++) {
  const r = rows[Math.floor(i * stride)];
  if (r) tierB.push({ file: r.file, verdict: r.verify.summary.verdict });
}

const z = 1.96;
const p = 0.5; // worst case for the interval
const halfWidth = z * Math.sqrt((p * (1 - p)) / SAMPLE) * Math.sqrt((rows.length - SAMPLE) / (rows.length - 1));

console.log(`${rows.length} sheets + ${noSheet.length} units with no sheet\n`);
console.log(`=== TIER A — exhaustive review (${tierA.length}) ===\n`);
for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)} ${String(v).padStart(5)}`);
}
console.log(`\n  at ~2 min each: ${(tierA.length * 2 / 60).toFixed(1)} hours`);

console.log(`\n=== TIER B — random sample for the rate (${tierB.length}) ===\n`);
const bV = {};
for (const b of tierB) bV[b.verdict] = (bV[b.verdict] || 0) + 1;
for (const [k, v] of Object.entries(bV).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}  ${pct(v, tierB.length)}`);
}
console.log(`\n  a proportion measured on this sample carries about +/-${(halfWidth * 100).toFixed(1)} points at 95% confidence`);
console.log(`  at ~2 min each: ${(tierB.length * 2 / 60).toFixed(1)} hours`);

// The trade-off, priced in hours, because for an in-house review the binding
// constraint is people's time and precision costs it quadratically: halving the
// interval quadruples the sample. Printed so the size is chosen deliberately
// rather than inherited from whatever the script happened to default to.
console.log('\n  what a bigger or smaller sample would buy (--sample N):');
for (const n of [100, 200, 300, 500, 830]) {
  if (n > rows.length) continue;
  const hw = z * Math.sqrt((p * (1 - p)) / n) * Math.sqrt((rows.length - n) / (rows.length - 1));
  const mark = n === SAMPLE ? '  <- current' : '';
  console.log(`    ${String(n).padStart(4)} sheets  +/-${(hw * 100).toFixed(1)} pts  `
    + `${(n * 2 / 60).toFixed(1)} h${mark}`);
}

console.log(`\n=== TIER C — the rest (${tierC.length}) ===\n`);
const cV = {};
for (const c of tierC) cV[c.verdict] = (cV[c.verdict] || 0) + 1;
for (const [k, v] of Object.entries(cV).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(5)}`);
}
const smallC = tierC.filter((c) => c.discrepancy > 0 && c.discrepancy <= 5).length;
console.log(`\n  ${smallC} of these differ by 5 votes or fewer — clerical, and not claimed as reviewed`);

// ---------------------------------------------------------------------------
// MATERIALITY AT STATE LEVEL
//
// The number that keeps the whole exercise proportionate. An audit that lists
// 516 units needing review, without saying whether any of it could have changed
// the outcome, implies the election was in question. Usually it was not, and
// saying so plainly is not a concession — it is the finding.
//
// The bound is deliberately generous to the doubt: every vote in every Tier A
// unit is treated as though it could move, which is far beyond anything that
// could actually happen, and it is still compared against the statewide gap.
// ---------------------------------------------------------------------------
const statewide = new Map(OSUN_2026_BALLOT.map((p) => [p, 0]));
let unitsCounted = 0;
for (const r of rows) {
  const vr = r.verify.rows || [];
  if (vr.some((x) => x.value === null)) continue; // only fully-resolved units
  unitsCounted++;
  for (const x of vr) if (statewide.has(x.party)) statewide.set(x.party, statewide.get(x.party) + x.value);
}
const ranked = [...statewide.entries()].sort((a, b) => b[1] - a[1]);
const stateMargin = ranked.length > 1 ? ranked[0][1] - ranked[1][1] : null;

const tierAFiles = new Set(tierA.map((t) => t.file).filter(Boolean));
let votesInDoubt = 0;      // crude: every vote in a Tier A unit
let votesUncertain = 0;    // tight: only the quantity actually unestablished
const byReason = {};
for (const r of rows) {
  if (!tierAFiles.has(r.file)) continue;
  const tv = r.sheet?.totalValid;
  const cast = Number.isInteger(tv) ? tv : (r.verify.rows || []).reduce((a, x) => a + (x.value || 0), 0);
  votesInDoubt += cast;

  // What is genuinely unestablished on this sheet? Not the whole unit — the
  // rows we DID read are read, and pretending otherwise inflates the doubt
  // until it swallows the election.
  const vr = r.verify.rows || [];
  const known = vr.filter((x) => x.value !== null);
  const unread = vr.filter((x) => x.value === null);
  let u = 0;
  if (unread.length && Number.isInteger(tv)) u = Math.max(0, tv - known.reduce((a, x) => a + x.value, 0));
  else if (unread.length) u = cast;                       // unbounded: concede the unit
  const ps = r.verify.checks.find((c) => c.name === 'party_sum' && c.status === 'fail');
  u = Math.max(u, Math.abs(ps?.detail?.delta ?? 0));
  const ov = r.verify.checks.find((c) => c.name === 'over_voting' && c.status === 'fail');
  u = Math.max(u, Math.abs(ov?.detail?.excess ?? 0));
  votesUncertain += Math.min(u, cast || u);
  const why = (tierA.find((t) => t.file === r.file) || {}).why || 'other';
  byReason[why] = (byReason[why] || 0) + Math.min(u, cast || u);
}
// The 21 units with no sheet are entirely unknown. Estimate their scale from
// the median turnout of units that DO have one, and label it an estimate.
const turnouts = rows.map((r) => r.sheet?.totalValid).filter(Number.isInteger).sort((a, b) => a - b);
const medianTurnout = turnouts.length ? turnouts[Math.floor(turnouts.length / 2)] : 0;
const noSheetVotes = noSheet.length * medianTurnout;
votesUncertain += noSheetVotes;

console.log('\n\n=== IS ANY OF THIS MATERIAL TO WHO WON? ===\n');
console.log(`  statewide totals from ${unitsCounted} fully-resolved units (OUR transcription, not INEC's):`);
for (const [p, v] of ranked.slice(0, 4)) console.log(`    ${p.padEnd(6)} ${v.toLocaleString().padStart(9)}`);
if (stateMargin !== null) {
  console.log(`\n  gap between ${ranked[0][0]} and ${ranked[1][0]}: ${stateMargin.toLocaleString()} votes`);
  // A vote does not appear from nowhere: moving one from the leader to the
  // runner-up closes the gap by TWO. So the votes needed to overturn the result
  // is half the gap, not the gap.
  const swingNeeded = Math.ceil(stateMargin / 2);
  console.log(`  votes that would have to CHANGE HANDS to overturn it: ${swingNeeded.toLocaleString()}`);
  console.log('    (each vote moved counts twice — one off the leader, one onto the runner-up)');

  console.log(`\n  two bounds on the doubt:`);
  console.log(`    crude — every vote cast in all ${tierA.length} Tier A units   ${votesInDoubt.toLocaleString().padStart(9)}`);
  console.log(`    tight — only the quantity actually unestablished    ${votesUncertain.toLocaleString().padStart(9)}`);
  console.log(`            (includes ${noSheet.length} unpublished units at the median turnout of ${medianTurnout}, ~${noSheetVotes.toLocaleString()})`);

  // ── WHAT THIS AUDIT CAN AND CANNOT SAY ──────────────────────────────────
  //
  // The totals above are OURS, and they are computed from the 3,289 units whose
  // party column fully resolved. The other 453 units are not in them at all —
  // their votes are attributed to nobody. That unattributed pile is larger than
  // the lead, so nothing here bounds the statewide outcome in either direction.
  //
  // The temptation is to write "the result is safe" or "the result is not
  // beyond reach". Both overclaim. This audit checks whether each published
  // sheet reconciles with itself; it is not a recount, it does not hold INEC's
  // declared figures, and a partial transcription cannot adjudicate an
  // election. Saying so is the finding, not a hedge.
  const unresolvedUnits = rows.length - unitsCounted;
  console.log(`\n  ${unresolvedUnits} of ${rows.length} units are NOT in the totals above — their party`);
  console.log(`  column did not fully resolve, so their votes are attributed to nobody. That`);
  console.log(`  unattributed pile (~${votesUncertain.toLocaleString()}) is larger than the ${stateMargin.toLocaleString()}-vote lead.`);
  console.log('\n  So: this audit CANNOT confirm or overturn the statewide result, and must not');
  console.log('  be written as though it could. What it can say is which sheets do not');
  console.log('  reconcile with themselves, and which units INEC published nothing for.');
  console.log('  A recount is a different exercise needing INEC\'s declared figures and the');
  console.log('  BVAS record; this has neither.');
  console.log('\n  Unit-level findings stand on their own regardless: a unit that cannot be');
  console.log('  reconciled matters to the people who voted in it whether or not it moves a');
  console.log('  statewide total.');

  console.log('\n  where the uncertainty sits:');
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ${String(v).padStart(7)}  ${k}`);
  }
}

fs.writeFileSync(path.join(dir, 'tier_a.json'), JSON.stringify(tierA, null, 2));
fs.writeFileSync(path.join(dir, 'tier_b.json'), JSON.stringify(tierB, null, 2));
fs.writeFileSync(path.join(dir, 'tier_c.json'), JSON.stringify(tierC, null, 2));
console.log(`\nwrote tier_a.json (${tierA.length}), tier_b.json (${tierB.length}), tier_c.json (${tierC.length})`);

/**
 * THE PAIR AND ITS PANEL, end to end against the real database, inside a
 * transaction that rolls back even on failure.
 *
 * The two rules that must not be quietly wrong:
 *   - a reviewer is asked once, and never sees a subject they answered
 *   - a campaign's opinion is recorded and does NOT move the verdict
 * Both fail silently if broken — the panel still produces a confident answer,
 * just the wrong one — so each has a control.
 *
 *   node backend/scripts/test_pairs.mjs
 */
import { db } from '../src/db.js';
import { submitReview, refreshPanel, queueFor, panelsFor, KINDS } from '../src/services/review.js';
import { buildPairs, attachSheets, pairSummary } from '../src/services/pairs.js';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

db.exec('BEGIN');
const cleanup = () => { try { db.exec('ROLLBACK'); } catch { /* done */ } };
process.on('exit', cleanup);

const EID = 'TEST-ELECTION';
const CONTEST = 'TESTCONTEST';
const t0 = Date.now();

try {
  /* --- a pair, built from a real result row -------------------------------- */
  const pu = db.prepare('SELECT pu_code FROM polling_units LIMIT 1').get().pu_code;
  db.prepare(`INSERT INTO results (pu_code, contest, votes_json, status, updated_at, confidence, matching_reports, total_reports)
              VALUES (?, ?, ?, 'reported', ?, 1.0, 1, 1)`)
    .run(pu, CONTEST, JSON.stringify([{ party: 'APC', count: 341 }]), t0);
  check('one pair built from one result', buildPairs({ irevId: EID, contest: CONTEST }), 1);
  check('running it again builds nothing new', buildPairs({ irevId: EID, contest: CONTEST }), 0);
  const pair = db.prepare('SELECT * FROM result_pairs WHERE irev_id = ? AND contest = ?').get(EID, CONTEST);
  check('it starts as ours_only — INEC has published nothing yet', pair.presence, 'ours_only');
  check('and carries our tally', JSON.parse(pair.ours_json)[0].count, 341);

  /* --- INEC's side, hashed as served --------------------------------------- */
  db.prepare(`INSERT INTO irev_docs (pu_code, election_id, doc_url, status, checked_at)
              VALUES (?, ?, 'https://example.invalid/sheet.jpg', 'ok', ?)`).run(pu, EID, t0);
  const bytes = Buffer.from('pretend this is an EC8A photograph');
  const stub = async () => ({ ok: true, arrayBuffer: async () => bytes });
  check('the sheet attaches', await attachSheets({ irevId: EID, fetchImpl: stub }), 1);
  const withDoc = db.prepare('SELECT * FROM result_pairs WHERE id = ?').get(pair.id);
  check('presence becomes both', withDoc.presence, 'both');
  /* The hash is of INEC's bytes — that is what makes it evidence. */
  const expect = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  check('sha256 is of the bytes served, not of our copy', withDoc.doc_sha256, expect);

  /* --- the panel ----------------------------------------------------------- */
  const K = 'tally_match';
  check('first verdict leaves it pending',
    submitReview({ pairId: pair.id, kind: K, reviewerType: 'model', reviewerId: 'gpu-1', verdict: 'match' }).panel.state,
    'pending');
  check('a second, agreeing, settles it',
    submitReview({ pairId: pair.id, kind: K, reviewerType: 'staff', reviewerId: 's1', verdict: 'match' }).panel.state,
    'agreed');

  /* THE BLINDNESS GATE, keyed on the reviewer. */
  const again = submitReview({ pairId: pair.id, kind: K, reviewerType: 'staff', reviewerId: 's1', verdict: 'mismatch' });
  check('the same reviewer cannot answer twice', again, { ok: false, error: 'already_reviewed' });
  check('CONTROL: and their first answer still stands', panelsFor(pair.id).find((p) => p.kind === K).outcome, '"match"');

  /* --- the campaign rule ---------------------------------------------------- */
  const K2 = 'sheet_integrity';
  submitReview({ pairId: pair.id, kind: K2, reviewerType: 'campaign', reviewerId: 'obi-2027', verdict: 'unsound' });
  submitReview({ pairId: pair.id, kind: K2, reviewerType: 'campaign', reviewerId: 'atiku-2027', verdict: 'unsound' });
  const afterCampaigns = refreshPanel(pair.id, K2);
  /* Two campaigns agreeing is still zero neutral readings. If this ever says
     'agreed', a campaign can settle a question about its own race. */
  check('two campaigns agreeing does NOT settle anything', afterCampaigns.state, 'pending');
  check('  ...the panel counts zero of them', afterCampaigns.n, 0);
  check('  ...but their opinions are kept and attributed', afterCampaigns.campaign.length, 2);
  submitReview({ pairId: pair.id, kind: K2, reviewerType: 'model', reviewerId: 'gpu-1', verdict: 'sound' });
  const mixed = submitReview({ pairId: pair.id, kind: K2, reviewerType: 'staff', reviewerId: 's1', verdict: 'sound' }).panel;
  check('two neutral readings settle it', mixed.state, 'agreed');
  /* And the verdict is the neutral one, against both campaigns. */
  check('CONTROL: campaigns did not move the outcome', mixed.outcome, 'sound');

  /* --- the queue ------------------------------------------------------------ */
  const q1 = queueFor({ kind: 'report_credibility', reviewerType: 'staff', reviewerId: 's1', contest: CONTEST });
  check('an unanswered question is queued', q1.length, 1);
  check('CONTROL: and the row carries no other reviewer\'s verdict', Object.keys(q1[0]),
    (k) => !k.some((x) => /verdict|review/.test(x)));
  submitReview({ pairId: pair.id, kind: 'report_credibility', reviewerType: 'staff', reviewerId: 's1', verdict: 'credible' });
  check('after answering, it leaves THEIR queue',
    queueFor({ kind: 'report_credibility', reviewerType: 'staff', reviewerId: 's1', contest: CONTEST }).length, 0);
  check('CONTROL: but is still in somebody else\'s',
    queueFor({ kind: 'report_credibility', reviewerType: 'staff', reviewerId: 's2', contest: CONTEST }).length, 1);

  /* --- the pair is settled only when all three questions are ---------------- */
  const st = db.prepare('SELECT state FROM result_pairs WHERE id = ?').get(pair.id).state;
  check('one question still open leaves the pair open', st, 'open');
  submitReview({ pairId: pair.id, kind: 'report_credibility', reviewerType: 'model', reviewerId: 'gpu-1', verdict: 'credible' });
  /* report_credibility is the JUDGEMENT question and starts at THREE readers,
     not two. An earlier version of this test expected two to settle it and
     failed against a panel behaving exactly as configured — the test was
     wrong, not the rule. */
  submitReview({ pairId: pair.id, kind: 'report_credibility', reviewerType: 'staff', reviewerId: 's2', verdict: 'credible' });
  check('all three agreed settles the pair',
    db.prepare('SELECT state FROM result_pairs WHERE id = ?').get(pair.id).state, 'agreed');

  const sum = pairSummary(EID);
  check('summary counts it once', sum.total, 1);
} finally {
  cleanup();
  process.removeAllListeners('exit');
}

console.log(fail ? `\n${fail} FAILED` : '\nall pair + panel checks passed');
process.exit(fail ? 1 : 0);

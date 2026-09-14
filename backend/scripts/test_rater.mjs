/**
 * THE MODEL RATER, and the docket it can reach.
 *
 * Two behaviours here would be dangerous if wrong and silent if broken:
 * abstention (a guess counted as a reading fills a panel slot with noise) and
 * the docket write (an agreed adverse panel disputes a real result). Both have
 * controls.
 *
 *   node backend/scripts/test_rater.mjs
 */
import { db } from '../src/db.js';
import { judgeTally, judgeIntegrity, judgeCredibility, ratePair } from '../src/services/modelRater.js';
import { submitReview, refreshPanel } from '../src/services/review.js';
import { buildPairs } from '../src/services/pairs.js';
import { isAdverse } from '../src/services/verdicts.js';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

db.exec('BEGIN');
const cleanup = () => { try { db.exec('ROLLBACK'); } catch { /* done */ } };
process.on('exit', cleanup);

try {
  /* --- the tally judgement is deliberately timid --------------------------- */
  check('zero of three found is a mismatch', judgeTally({ matched: 0, total: 3 }).verdict, 'mismatch');
  /* CONTROL: zero of TWO is not. OCR reads 60-77% of a clean sheet, so a small
     sample of misses must never read as a contradiction. */
  check('CONTROL: zero of two is NOT — too few to accuse', judgeTally({ matched: 0, total: 2 }).verdict, 'unreadable');
  check('half or more found is a match', judgeTally({ matched: 2, total: 4 }).verdict, 'match');
  check('one of four is unreadable, not a mismatch', judgeTally({ matched: 1, total: 4 }).verdict, 'unreadable');
  check('a failed OCR abstains rather than guessing', judgeTally(null).verdict, null);

  /* --- integrity is arithmetic, and abstains without figures --------------- */
  check('no structured read -> abstain', judgeIntegrity(null).verdict, null);
  check('CONTROL: and that is not "sound"', judgeIntegrity(null).verdict, (v) => v !== 'sound');
  check('party votes not summing to the total is unsound',
    judgeIntegrity({ parties: [{ count: 10 }, { count: 5 }], total: 20 }).verdict, 'unsound');
  check('votes cast above accredited is unsound',
    judgeIntegrity({ accredited: 100, votesCast: 120 }).verdict, 'unsound');
  check('votes above registered is unsound',
    judgeIntegrity({ registered: 500, votesCast: 600 }).verdict, 'unsound');
  check('a consistent sheet is sound',
    judgeIntegrity({ parties: [{ count: 10 }, { count: 5 }], total: 15, accredited: 100, votesCast: 15 }).verdict, 'sound');
  check('an object with nothing checkable abstains', judgeIntegrity({ foo: 1 }).verdict, null);

  /* --- credibility is not the machine's to answer -------------------------- */
  check('the model always abstains on credibility', judgeCredibility().verdict, null);

  /* --- unreadable is never adverse ----------------------------------------- */
  check('CONTROL: unreadable does not flag anything', isAdverse('tally_match', 'unreadable'), false);
  check('CONTROL: cannot_say does not either', isAdverse('report_credibility', 'cannot_say'), false);
  check('mismatch does', isAdverse('tally_match', 'mismatch'), true);

  /* --- end to end: rate a pair, and abstentions write nothing -------------- */
  const pu = db.prepare('SELECT pu_code FROM polling_units LIMIT 1').get().pu_code;
  const CONTEST = 'RATERTEST';
  db.prepare(`INSERT INTO results (pu_code, contest, votes_json, status, updated_at, confidence, matching_reports, total_reports)
              VALUES (?, ?, ?, 'reported', ?, 1.0, 1, 1)`)
    .run(pu, CONTEST, JSON.stringify([{ party: 'APC', count: 341 }, { party: 'PDP', count: 10 }, { party: 'LP', count: 7 }]), Date.now());
  buildPairs({ irevId: 'RT', contest: CONTEST });
  const pair = db.prepare('SELECT * FROM result_pairs WHERE contest = ?').get(CONTEST);
  db.prepare('UPDATE result_pairs SET doc_url = ? WHERE id = ?').run('https://example.invalid/s.jpg', pair.id);

  /* A fetch that fails: every question should abstain, and NOTHING should be
     written — an abstention that quietly records a verdict is the bug. */
  const dead = async () => ({ ok: false });
  const r1 = await ratePair(pair.id, { fetchImpl: dead });
  check('an unreachable sheet abstains on everything', r1.submitted.length, 0);
  check('  ...and says why for each', r1.abstained.length, 3);
  check('CONTROL: nothing was written to pair_reviews',
    db.prepare('SELECT COUNT(*) n FROM pair_reviews WHERE pair_id = ?').get(pair.id).n, 0);

  /* --- the docket: an agreed adverse panel flags, once --------------------- */
  const before = db.prepare('SELECT COUNT(*) n FROM discrepancies').get().n;
  submitReview({ pairId: pair.id, kind: 'tally_match', reviewerType: 'model', reviewerId: 'm1', verdict: 'mismatch' });
  /* WHY THIS PASSES, precisely: a pending panel has outcome null, and
     isAdverse(kind, null) is false. So the `state === 'agreed'` test in
     flagIfAdverse is belt-and-braces rather than the load-bearing guard —
     removing it changes nothing here, as a control confirmed. The guard that
     actually holds is the adverse check, and removing THAT turns the
     agreed-SOUND case below red. Recorded because a check whose reason you have
     not established is a check you do not have. */
  check('CONTROL: one reading flags nothing',
    db.prepare('SELECT COUNT(*) n FROM discrepancies').get().n, before);
  submitReview({ pairId: pair.id, kind: 'tally_match', reviewerType: 'staff', reviewerId: 's1', verdict: 'mismatch' });
  const after = db.prepare('SELECT COUNT(*) n FROM discrepancies').get().n;
  check('an AGREED mismatch reaches the docket', after, before + 1);
  const flag = db.prepare("SELECT * FROM discrepancies WHERE type = 'pair_tally_match' ORDER BY id DESC").get();
  check('  ...at high severity', flag.severity, 'high');
  check('  ...naming the unit', flag.pu_code, pu);
  /* Re-deciding a settled panel must not flag again. */
  refreshPanel(pair.id, 'tally_match');
  check('CONTROL: re-deciding does not flag twice',
    db.prepare('SELECT COUNT(*) n FROM discrepancies').get().n, before + 1);

  /* An agreed NON-adverse panel must write nothing. */
  const b2 = db.prepare('SELECT COUNT(*) n FROM discrepancies').get().n;
  submitReview({ pairId: pair.id, kind: 'sheet_integrity', reviewerType: 'model', reviewerId: 'm1', verdict: 'sound' });
  submitReview({ pairId: pair.id, kind: 'sheet_integrity', reviewerType: 'staff', reviewerId: 's1', verdict: 'sound' });
  check('CONTROL: an agreed SOUND panel flags nothing',
    db.prepare('SELECT COUNT(*) n FROM discrepancies').get().n, b2);

  /* And a verdict outside the vocabulary is refused. */
  check('a made-up verdict is rejected',
    submitReview({ pairId: pair.id, kind: 'tally_match', reviewerType: 'staff', reviewerId: 'sX', verdict: 'looks fine' }).error,
    'bad_verdict');
} finally {
  cleanup();
  process.removeAllListeners('exit');
}

console.log(fail ? `\n${fail} FAILED` : '\nall rater + docket checks passed');
process.exit(fail ? 1 : 0);

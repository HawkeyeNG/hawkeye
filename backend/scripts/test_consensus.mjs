/**
 * THE PANEL RULE, and the ways it could be quietly wrong.
 *
 * Every case here is one somebody would hit: two agreeing, two splitting, a
 * third breaking the tie, a sheet nobody can agree on. The controls matter more
 * than the happy paths — a rule that says "agreed" too early is indistinguishable
 * from a working one until the label it blessed turns out wrong.
 *
 *   node backend/scripts/test_consensus.mjs
 */
import { decide, cfgFor } from '../src/services/consensus.js';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

/* --- the cheap path ------------------------------------------------------ */
check('one reading decides nothing', decide(['match']).state, 'pending');
check('and it says how many more it needs', decide(['match']).need, 1);
check('two agreeing is settled', decide(['match', 'match']).state, 'agreed');
check('  ...unanimously, not on a count', decide(['match', 'match']).by, 'unanimous');
check('  ...and carries the verdict out', decide(['match', 'match']).outcome, 'match');

/* --- disagreement buys readers, not a coin toss --------------------------- */
const split = decide(['match', 'mismatch']);
check('two disagreeing does NOT resolve', split.state, 'escalate');
check('CONTROL: and picks no winner from a tie', split.outcome, null);
check('it asks for one more', split.need, 1);

/* THE CASE THE USER NAMED: one person simply made a mistake. */
const third = decide(['match', 'mismatch', 'match']);
check('a third reader breaks it by supermajority', third.state, 'agreed');
check('  ...on the majority answer', third.outcome, 'match');
check('  ...and says it was not unanimous', third.by, 'supermajority');

/* 2/3 exactly is the threshold, so it must COUNT as agreement. */
check('two of three is exactly the bar and passes', decide(['a', 'a', 'b']).state, 'agreed');
/* ...and one short of it must not. */
check('CONTROL: two of four is below the bar and does not', decide(['a', 'a', 'b', 'b']).state, 'escalate');

/* --- the sheet nobody can read ------------------------------------------- */
const chaos = decide(['a', 'b', 'c', 'd', 'e']);
check('five readers, five answers, at max -> unresolved', chaos.state, 'unresolved');
/* A plurality verdict here would be the dangerous behaviour: it would bless a
   label 1 of 5 people gave and hide that the sheet is the problem. */
check('CONTROL: it refuses to crown a plurality', chaos.outcome, null);

/* --- structured verdicts compare by VALUE, not identity ------------------- */
const t1 = { APC: 341, PDP: 10 };
const t2 = { APC: 341, PDP: 10 };
check('two identical transcriptions agree though they are different objects',
  decide([t1, t2, t2], 'transcription').state, 'agreed');
check('CONTROL: one digit apart does not',
  decide([{ APC: 341 }, { APC: 341 }, { APC: 34 }], 'transcription').by, 'supermajority');

/* --- per-kind panels ------------------------------------------------------ */
check('transcription starts at three, not two', cfgFor('transcription').first, 3);
check('  ...so two agreeing is still pending there',
  decide([t1, t2], 'transcription').state, 'pending');
check('a mechanical check starts at two', cfgFor('tally_match').first, 2);
check('an unknown kind falls back to the default panel', cfgFor('nonsense').first, 2);

/* --- the escalation cannot overrun the cap -------------------------------- */
const nearMax = decide(['a', 'b', 'a', 'b'], 'tally_match');
check('escalation never asks for more than max allows',
  nearMax.need, (v) => nearMax.n + v <= cfgFor('tally_match').max);

console.log(fail ? `\n${fail} FAILED` : '\nall consensus checks passed');
process.exit(fail ? 1 : 0);

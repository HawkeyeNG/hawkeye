/**
 * The words column, both ways INEC officers actually write it.
 *
 *   node tests/ec8a-words.test.mjs
 *
 * WHY. Every EC8A asks for each count twice, in figures and in words, and that
 * redundancy is the cheapest verifier we have. But it only works if we can read
 * both grammars officers use:
 *
 *     130  ->  "ONE HUNDRED AND THIRTY"      place value
 *     130  ->  "ONE THREE ZERO"              digit by digit
 *
 * Read as place value, "ONE THREE ZERO" sums to FOUR, and a correctly completed
 * sheet was being reported as a figures-vs-words disagreement. That is not a
 * missed row — it is a manufactured finding against an officer who did nothing
 * wrong, and a clean sheet sent to a human to adjudicate our bug.
 *
 * The controls matter as much as the cases: a digit reading must NOT swallow
 * genuine place-value phrases, and must not turn a lone number word into
 * something else.
 */
import assert from 'node:assert';
import { wordsToNumber, figuresOf } from '../backend/src/services/ec8a_words.js';

let n = 0;
const eq = (phrase, want, why) => {
  const got = wordsToNumber(phrase);
  assert.strictEqual(got, want, `${why}: "${phrase}" -> ${got}, wanted ${want}`);
  n++;
};

// ---- digit-by-digit, the grammar that was being misread --------------------
for (const [phrase, want] of [
  ['ONE THREE ZERO', 130],
  ['THREE ZERO EIGHT', 308],
  ['NINE FIVE SIX', 956],      // registered voters, from a real sheet
  ['FOUR TWO NINE', 429],      // accredited voters, same sheet
  ['ONE ONE', 11],
  ['FIVE FIVE', 55],
  ['TWO ZERO', 20],
  ['ZERO ZERO', 0],
  ['ONE ZERO ZERO ZERO', 1000],
]) eq(phrase, want, 'digit spelling');
console.log(`  PASS  ${n} digit-by-digit spellings`);

// ---- place value still reads exactly as before -----------------------------
const before = n;
for (const [phrase, want] of [
  ['ONE HUNDRED AND THIRTY', 130],
  ['THREE HUNDRED AND EIGHT', 308],
  ['NINE HUNDRED AND FIFTY SIX', 956],
  ['FOUR HUNDRED AND TWENTY NINE', 429],
  ['THIRTEEN', 13],
  ['NINETEEN', 19],
  ['TWENTY', 20],
  ['ONE THOUSAND', 1000],
  ['TWO THOUSAND AND FIVE', 2005],
  ['SEVENTY FIVE', 75],
]) eq(phrase, want, 'place value');
console.log(`  PASS  ${n - before} place-value phrases unchanged`);

// ---- the third grammar: hundreds without the word "hundred" ----------------
// "172" spoken as "ONE SEVENTY TWO". Read as a plain sum that is 1 + 70 + 2 =
// 73, so a correct sheet became a figures-vs-words disagreement.
{
  const t = n;
  for (const [phrase, want] of [
    ['ONE SEVENTY TWO', 172],
    ['ONE SEVENTY', 170],
    ['TWO THIRTY FIVE', 235],
    ['NINE NINETY NINE', 999],
    ['THREE FORTY', 340],
    ['EIGHT SIXTY ONE', 861],
  ]) eq(phrase, want, 'spoken hundreds');
  console.log(`  PASS  ${n - t} spoken-hundreds phrases`);
}

// ---- CONTROLS for the third grammar ----------------------------------------
{
  // A TENS-first phrase is an ordinary number and must not gain a hundred.
  eq('TWENTY ONE', 21, 'tens first');
  eq('SEVENTY FIVE', 75, 'tens first');
  eq('NINETY', 90, 'tens alone');
  // A scale word forces the place-value reading.
  eq('ONE HUNDRED AND SEVENTY TWO', 172, 'scale wins');
  eq('TWO THOUSAND AND FIVE', 2005, 'scale wins');
  // ZERO cannot lead a hundreds phrase — "ZERO SEVENTY" is not 70 by this rule.
  assert.notStrictEqual(wordsToNumber('ZERO SEVENTY'), 170,
    'CONTROL FAILED: ZERO was treated as a hundreds digit');
  // A malformed tail is not this grammar.
  assert.notStrictEqual(wordsToNumber('ONE SEVENTY FIFTEEN'), 185,
    'CONTROL FAILED: a malformed tail was read as spoken hundreds');
  // A TEEN in the tens slot is REFUSED. "NINE TEEN" is OCR splitting NINETEEN,
  // and the figures on those rows say 19 — measured, 6 right against 18 where
  // neither reading matched.
  assert.notStrictEqual(wordsToNumber('NINE TEEN'), 910,
    'CONTROL FAILED: a split teen was read as spoken hundreds');
  assert.strictEqual(wordsToNumber('NINE TEEN'), 19,
    'a split NINETEEN should still sum to 19');
  console.log('  PASS  controls: tens-first, scale words, leading zero, malformed tails');
}

// ---- CONTROLS --------------------------------------------------------------
{
  // A lone digit word is that digit, NOT a one-element digit string. Same
  // answer here, but the rule must require two tokens or "THREE" could later
  // be treated as a sequence.
  eq('THREE', 3, 'single token');
  eq('ZERO', 0, 'single token');

  // TEN..NINETEEN are not digits, so a phrase containing one can never be read
  // digit-wise. "THIRTEEN ZERO" is not 130.
  assert.notStrictEqual(wordsToNumber('THIRTEEN ZERO'), 130,
    'CONTROL FAILED: a phrase containing THIRTEEN was read as digits');

  // A scale word forces place value.
  eq('ONE HUNDRED', 100, 'scale word');

  // Nothing recognisable is still null — silence beats a guess.
  assert.strictEqual(wordsToNumber(''), null);
  assert.strictEqual(wordsToNumber('%%%%'), null);

  // NIL survives, in both spellings officers use.
  eq('NIL', 0, 'nil');
  eq('NILL', 0, 'nil');

  // A run too long to be a count is refused rather than returned, matching
  // figuresOf's ceiling.
  assert.strictEqual(wordsToNumber('ONE TWO THREE FOUR FIVE SIX SEVEN'), null,
    'a seven-digit run should be refused');

  console.log('  PASS  controls: single tokens, teens, scales, junk and over-long runs');
}

// ---- the pairing the audit actually performs -------------------------------
{
  // This is the shape of the real check: figures and words must agree.
  const agree = (fig, wrd) => figuresOf(fig) === wordsToNumber(wrd);
  assert.ok(agree('130', 'ONE THREE ZERO'), 'digit spelling should now AGREE with its figures');
  assert.ok(agree('130', 'ONE HUNDRED AND THIRTY'), 'place value should still agree');
  assert.ok(agree('956', 'NINE FIVE SIX'));
  // CONTROL: a genuine mismatch must still be caught, or this change would have
  // bought agreement by making the check blind.
  assert.ok(!agree('131', 'ONE THREE ZERO'), 'CONTROL FAILED: a real disagreement was not caught');
  assert.ok(!agree('130', 'ONE THREE ONE'), 'CONTROL FAILED: a real disagreement was not caught');
  console.log('  PASS  figures-vs-words agrees on both grammars and still catches real mismatches');
}

console.log('\nec8a-words: all checks passed');

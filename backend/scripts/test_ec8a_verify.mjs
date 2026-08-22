/**
 * Regression test for the EC8A arithmetic self-verification.
 *
 * The cases that matter are the ones about HONESTY, not arithmetic: that an
 * unreadable total reports `unknown` instead of `pass`, that a disagreeing row
 * yields no value at all, and that a partial sum which already overshoots is
 * still a real finding.
 *
 *   node scripts/test_ec8a_verify.mjs
 */
import { resolveRow, verifySheet, resolveBoxPair } from '../src/services/ec8a_verify.js';

let failures = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`); }
  return ok;
};
const statusOf = (r, name) => { const c = r.checks.find((x) => x.name === name); return c && `${c.status}/${c.severity}`; };

// ---------------------------------------------------------------- resolveRow
console.log('resolveRow');
eq('agreeing cells', resolveRow({ party: 'APC', figures: 308, words: 'THREE HUNDRED AND EIGHT' }).confidence, 'both');
eq('agreeing value', resolveRow({ party: 'APC', figures: 308, words: 'THREE HUNDRED AND EIGHT' }).value, 308);
eq('conflict has NO value', resolveRow({ party: 'PDP', figures: 308, words: 'THREE HUNDRED AND NINE' }).value, null);
eq('conflict labelled', resolveRow({ party: 'PDP', figures: 308, words: 'THREE HUNDRED AND NINE' }).confidence, 'conflict');
eq('figures only', resolveRow({ party: 'LP', figures: 12, words: null }).confidence, 'figures');
eq('words only', resolveRow({ party: 'LP', figures: null, words: 'TWELVE' }).value, 12);
eq('zero is a value, not absence', resolveRow({ party: 'AA', figures: 0, words: 'ZERO' }).value, 0);
eq('zero agrees', resolveRow({ party: 'AA', figures: 0, words: 'ZERO' }).confidence, 'both');
eq('neither cell', resolveRow({ party: 'BP', figures: null, words: null }).confidence, 'none');
eq('mangled words still parse', resolveRow({ party: 'AA', figures: 0, words: '-26R0-' }).confidence, 'both');
// A negative vote count is impossible, so -5 is a dash beside a 5, not a sign.
eq('negative read as its magnitude', resolveRow({ party: 'AA', figures: -5, words: null }).value, 5);

// -------------------------------------------------------- a fully clean sheet
console.log('clean sheet');
const clean = verifySheet({
  registered: 500, ballotsIssued: 500, unusedBallots: 210,
  accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
  parties: [
    { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
    { party: 'PDP', figures: 130, words: 'ONE HUNDRED AND THIRTY' },
    { party: 'LP', figures: 0, words: 'ZERO' },
  ],
});
eq('party_sum', statusOf(clean, 'party_sum'), 'pass/none');
eq('ballot_account', statusOf(clean, 'ballot_account'), 'pass/none');
eq('over_voting', statusOf(clean, 'over_voting'), 'pass/none');
eq('accredited_vs_registered', statusOf(clean, 'accredited_vs_registered'), 'pass/none');
eq('no failures', clean.summary.fail, 0);
eq('verdict', clean.summary.verdict, 'publishable');

// ------------------------------------- unreadable total is UNKNOWN, not a pass
console.log('unreadable total');
const noTotal = verifySheet({
  registered: 500, accredited: 300, spoiled: null, rejected: null, totalValid: null, usedBallots: null,
  parties: [{ party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' }],
});
eq('party_sum unknown', statusOf(noTotal, 'party_sum'), 'unknown/none');
eq('ballot_account unknown', statusOf(noTotal, 'ballot_account'), 'unknown/none');
eq('over_voting unknown', statusOf(noTotal, 'over_voting'), 'unknown/none');
eq('nothing failed', noTotal.summary.fail, 0);
eq('but NOT publishable', noTotal.summary.verdict, 'review');

// ------------------------------- a lower bound can still decide, in one direction
console.log('partial sum that already overshoots');
const overshoot = verifySheet({
  totalValid: 100,
  parties: [
    { party: 'APC', figures: 90, words: 'NINETY' },
    { party: 'PDP', figures: 40, words: 'FORTY' },
    { party: 'LP', figures: null, words: null },          // unread — can only add
  ],
});
eq('fails despite the gap', statusOf(overshoot, 'party_sum'), 'fail/high');
eq('flagged', overshoot.summary.verdict, 'flagged');

console.log('partial sum still short stays unknown');
const short = verifySheet({
  totalValid: 300,
  parties: [
    { party: 'APC', figures: 90, words: 'NINETY' },
    { party: 'LP', figures: null, words: null },
  ],
});
eq('under the total is undecidable', statusOf(short, 'party_sum'), 'unknown/none');

// ------------------------------------------------------------- real findings
console.log('findings');
const overVote = verifySheet({ registered: 500, accredited: 200, usedBallots: 260, totalValid: 250, spoiled: 4, rejected: 6 });
eq('over-voting is high', statusOf(overVote, 'over_voting'), 'fail/high');
// cast = 250 valid + 6 rejected = 256 against 200 accredited. The 4 spoiled
// papers are not votes and must not count toward over-voting.
eq('excess is over ballots CAST', overVote.checks.find((c) => c.name === 'over_voting').detail.excess, 56);

const impossible = verifySheet({ registered: 400, accredited: 450 });
eq('accredited beyond register', statusOf(impossible, 'accredited_vs_registered'), 'fail/high');

const unbalanced = verifySheet({ spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 291 });
eq('ballot account off by one', statusOf(unbalanced, 'ballot_account'), 'fail/medium');
eq('delta reported', unbalanced.checks.find((c) => c.name === 'ballot_account').detail.delta, -1);

const wild = verifySheet({ parties: [{ party: 'APC', figures: 123456, words: null }] });
eq('table furniture flagged', statusOf(wild, 'magnitude'), 'fail/medium');

// ------------------- the figures cell is TEXT, and the officer's marks survive
// Every case below is a real reading from the 20 hand-labelled Osun sheets.
console.log('figures cell as written');
const fig = (t) => resolveRow({ party: 'APC', figures: t, words: null }).value;
eq('plain digits', fig('308'), 308);
eq('zero-padded 05 is FIVE, not zero', fig('05'), 5);
eq('zero-padded 01', fig('01'), 1);
eq('zero-padded 08', fig('08'), 8);
eq('dash-wrapped -02-', fig('-02-'), 2);
eq('em-dash wrapped', fig('—02—'), 2);
eq('a lone dash-zero', fig('-0-'), 0);
eq('letter O for zero', fig('O'), 0);
eq('NIL', fig('NIL'), 0);
eq('NILL', fig('NILL'), 0);
eq('thousands comma', fig('1,045'), 1045);
eq('blank cell', fig(''), null);
// A vote count can never be negative, so a minus sign is a dash, not a sign.
eq('negative integer is a dash artifact', resolveRow({ party: 'APC', figures: -2, words: null }).value, 2);
eq('negative text likewise', fig('-2'), 2);
eq('NIL agrees with a 0 figure', resolveRow({ party: 'AA', figures: '-0-', words: 'NILL' }).confidence, 'both');

// ------------------------- two-pass box reconciliation (resolveBoxPair)
// Pass 1 is the full-sheet integer read; pass 2 is the cropped text read.
console.log('resolveBoxPair');
const pair = (a, b) => resolveBoxPair(a, b);
eq('agreement', pair(345, '345'), { value: 345, source: 'both' });
eq('dashes agree with the bare int', pair(0, '-0-'), { value: 0, source: 'both' });
eq('NIL agrees with 0', pair(0, 'NIL'), { value: 0, source: 'both' });
eq('pass 1 alone survives', pair(217, null), { value: 217, source: 'p1' });
eq('pass 2 alone recovers a null', pair(null, '415'), { value: 415, source: 'p2' });
eq('neither', pair(null, null), { value: null, source: 'none' });
// The documented truncation: integer grammar turned "06" into 0. The text wins.
eq('zero-pad truncation recovered', pair(0, '06'), { value: 6, source: 'p2-trunc' });
eq('dashed zero-pad recovered', pair(0, '-014-'), { value: 14, source: 'p2-trunc' });
// A real disagreement with no known cause yields NOTHING - on purpose.
eq('unexplained disagreement is null', pair(345, '348'), { value: null, source: 'conflict' });
eq('0 vs non-zero-led text is a conflict, not truncation', pair(0, '6'), { value: null, source: 'conflict' });
// Pass-1 negatives are dash artifacts, read at magnitude before comparing.
eq('pass-1 negative agrees at magnitude', pair(-2, '2'), { value: 2, source: 'both' });
eq('unparseable pass-2 text falls back to p1', pair(217, 'scribble'), { value: 217, source: 'p1' });

// ------------------- registered voters vs ballot papers issued (#1 vs #3)
// The last unconstrained box. There is no registered-voter data anywhere in
// this project to compare against, so #1 is closed from INSIDE the sheet:
// ballot_stock pins #3, and INEC issues one paper per registered voter.
console.log('registered vs issued');
const regIss = (r, i) => statusOf(verifySheet({ registered: r, ballotsIssued: i }), 'registered_vs_issued');
eq('equal passes', regIss(415, 415), 'pass/none');
eq('996 vs 995 is a LOW failure', regIss(996, 995), 'fail/low');
eq('absent #3 is unknown', regIss(415, null), 'unknown/none');

// The hole this closes: #3 read correctly, #1 misread. ballot_stock is blind
// to #1 and passes; without this check the sheet reached `publishable`.
const holeSheet = {
  registered: 413, ballotsIssued: 415, unusedBallots: 231, usedBallots: 184,
  accredited: 184, spoiled: 0, rejected: 1, totalValid: 183,
  parties: [{ party: 'A', figures: '183', words: 'ONE HUNDRED AND EIGHTY THREE' }],
};
eq('ballot_stock is blind to it', statusOf(verifySheet(holeSheet, { expectedParties: 1 }), 'ballot_stock'), 'pass/none');
eq('this check catches it', statusOf(verifySheet(holeSheet, { expectedParties: 1 }), 'registered_vs_issued'), 'fail/low');
// A low failure must never reach `publishable` - it did, for one commit.
eq('a low failure blocks publication', verifySheet(holeSheet, { expectedParties: 1 }).summary.verdict, 'review');
eq('but is NOT raised as a finding', verifySheet(holeSheet, { expectedParties: 1 }).summary.highSeverity.length, 0);
const cleanSheet = { ...holeSheet, registered: 415 };
eq('the same sheet read right is publishable', verifySheet(cleanSheet, { expectedParties: 1 }).summary.verdict, 'publishable');

// ---------------------------------- ballot stock: issued - unused == used
// Real regression. On sheet 29-01-01-005 I read #1/#3 as 413 where the sheet
// says 415. Party sum, ballot account, over-voting and accredited-vs-registered
// ALL passed on the wrong number and it shipped as `publishable`; a human caught
// it. This subtraction is the only check that sees that class of error, because
// nothing else in the stack constrains #1 or #3 at all.
console.log('ballot stock');
const stock = (issued, unused, used) => statusOf(verifySheet({ ballotsIssued: issued, unusedBallots: unused, usedBallots: used }), 'ballot_stock');
eq('415 - 231 = 184 balances', stock(415, 231, 184), 'pass/none');
eq('my misread 413 is caught', stock(413, 231, 184), 'fail/medium');
eq('delta reported', verifySheet({ ballotsIssued: 413, unusedBallots: 231, usedBallots: 184 })
  .checks.find((c) => c.name === 'ballot_stock').detail.delta, -2);
eq('absent #3 is unknown, not pass', stock(null, 231, 184), 'unknown/none');
eq('absent #4 is unknown, not pass', stock(415, null, 184), 'unknown/none');

// -------------------------- an OMITTED row is missing data, not a discrepancy
// The regression from the first real Qwen run: it returned 1 party row for a
// 15-row sheet. Every listed row resolved, so the old code saw "nothing
// missing", compared 90 against 213 and reported a finding that was entirely
// our own omission — on 11 of 20 sheets.
console.log('omitted rows');
const dropped = { totalValid: 213, parties: [{ party: 'APC', figures: 90, words: 'NINETY' }] };
eq('a short list cannot fail', statusOf(verifySheet(dropped, { expectedParties: 15 }), 'party_sum'), 'unknown/none');
eq('omitted counted', verifySheet(dropped, { expectedParties: 15 }).checks.find((c) => c.name === 'party_sum').detail.omitted, 14);
eq('without a ballot length it still fails (old behaviour)', statusOf(verifySheet(dropped), 'party_sum'), 'fail/high');
// ...but a short list that ALREADY overshoots is still decisive.
eq('short list can still overshoot',
  statusOf(verifySheet({ totalValid: 50, parties: [{ party: 'APC', figures: 90, words: 'NINETY' }] }, { expectedParties: 15 }), 'party_sum'),
  'fail/high');

// --------------------------------------- the real sheet 29-01-01-001, in full
console.log('real sheet 29-01-01-001 (transcribed by hand from the image)');
const real = verifySheet({
  registered: 949, ballotsIssued: 949, unusedBallots: 732,
  accredited: 217, spoiled: 0, rejected: 4, totalValid: 213, usedBallots: 217,
  parties: [
    { party: 'A', figures: 110, words: 'ONE HUNDRED AND TEN' },
    { party: 'AA', figures: 1, words: 'One' },
    { party: 'AAC', figures: 1, words: 'ONE' },
    { party: 'ADC', figures: 9, words: 'NINE' },
    { party: 'ADP', figures: 0, words: 'ZERO' },
    { party: 'APC', figures: 90, words: 'NINETY' },
    { party: 'APGA', figures: 0, words: 'ZERO' },
    { party: 'APM', figures: 0, words: 'ZERO' },
    { party: 'APP', figures: 0, words: 'ZERO' },
    { party: 'BP', figures: 0, words: 'ZERO' },
    { party: 'NNPP', figures: 0, words: 'ZERO' },
    { party: 'PRP', figures: 0, words: 'ZERO' },
    { party: 'SDP', figures: 0, words: 'ZERO' },
    { party: 'YPP', figures: 1, words: 'ONE' },
    { party: 'ZLP', figures: 1, words: 'ONE' },
  ],
}, { expectedParties: 15 });
eq('sums to the declared total', statusOf(real, 'party_sum'), 'pass/none');
eq('ballot account balances', statusOf(real, 'ballot_account'), 'pass/none');
eq('no over-voting (217 = 217)', statusOf(real, 'over_voting'), 'pass/none');
eq('all 15 rows read twice', real.summary.agree, 15);
eq('PUBLISHABLE', real.summary.verdict, 'publishable');

// ------------------------------------------- a disagreement blocks publication
console.log('conflict blocks publication');
const conflicted = verifySheet({
  registered: 500, accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
  parties: [
    { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
    { party: 'PDP', figures: 130, words: 'ONE HUNDRED AND THIRTY ONE' },
  ],
});
eq('sum cannot be computed', statusOf(conflicted, 'party_sum'), 'unknown/none');
eq('one conflict counted', conflicted.summary.conflict, 1);
eq('not publishable', conflicted.summary.verdict, 'review');

// -------------------------------------------------------- an empty transcription
console.log('empty input');
const empty = verifySheet({});
eq('no crash, no assertions', empty.summary.fail, 0);
eq('no false pass', empty.summary.unknown, 7);
eq('review', empty.summary.verdict, 'review');

// ------------------------------------------ the officer's own TOTAL VALID VOTES row
//
// A fourth independent statement of #7, in the officer's hand. Sheet
// 29-01-03-003 carries three different totals — party column 348, TOTAL row
// 347, box #7 349 — and only a human ever saw the third.
console.log('total row');
const base = {
  registered: 500, ballotsIssued: 500, unusedBallots: 210,
  accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
  parties: [
    { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
    { party: 'PDP', figures: 130, words: 'ONE HUNDRED AND THIRTY' },
  ],
};
// The field being ABSENT must add no check at all — otherwise running a new
// pass on part of the archive silently demotes the part it did not touch.
eq('absent field adds no check', verifySheet(base, { expectedParties: 2 }).checks.some((c) => c.name === 'total_row'), false);
eq('and publishable survives', verifySheet(base, { expectedParties: 2 }).summary.verdict, 'publishable');
eq('present but null is unknown', statusOf(verifySheet({ ...base, totalRow: null }, { expectedParties: 2 }), 'total_row'), 'unknown/none');
eq('null blocks publication', verifySheet({ ...base, totalRow: null }, { expectedParties: 2 }).summary.verdict, 'review');
// The officer simply not filling the line in is a fact about the SHEET, not a
// gap in our reading — 29-28-02-009 is clean and legible with a blank total.
const blankTotal = verifySheet({ ...base, totalRow: 'blank' }, { expectedParties: 2 });
eq('a blank line is n/a, not unknown', statusOf(blankTotal, 'total_row'), 'n/a/none');
eq('it is not counted as unknown', blankTotal.summary.unknown, 0);
eq('and must not block publication', blankTotal.summary.verdict, 'publishable');
eq('agreeing total passes', statusOf(verifySheet({ ...base, totalRow: 280 }, { expectedParties: 2 }), 'total_row'), 'pass/none');
eq('agreement still publishable', verifySheet({ ...base, totalRow: 280 }, { expectedParties: 2 }).summary.verdict, 'publishable');
// The 29-01-03-003 shape: the officer's total matches neither.
//
// LOW severity, so this routes to `review` rather than `flagged`. Measured on
// the first 177 sheets the check could run on: it disagreed on 38, and 60% of
// those differences were in the hundreds or worse (one TOTAL row read as
// 1,618,126). A check wrong a third of the time must not put sheets in the
// findings pile next to over-voting — but it must still block publication.
const threeTotals = verifySheet({ ...base, totalRow: 279 }, { expectedParties: 2 });
eq('a disagreeing total fails', statusOf(threeTotals, 'total_row'), 'fail/low');
eq('it blocks publication', threeTotals.summary.verdict, 'review');
eq('it names both disagreements', threeTotals.checks.find((c) => c.name === 'total_row').detail.comparisons.length, 2);
// An impossible total is a misread, not a discrepancy — same ceiling the boxes get.
const wildTotal = verifySheet({ ...base, totalRow: 1618126 }, { expectedParties: 2 });
eq('an impossible total is not a finding', statusOf(wildTotal, 'total_row'), 'unknown/none');
eq('and does not flag the sheet', wildTotal.summary.verdict, 'review');

// ------------------------------------------------ empty is not the same as unreadable
//
// The distinction the third pass exists to capture. "" means the officer wrote
// nothing, which is a result — no votes. null means there are marks we cannot
// resolve, which is not a result at all. Collapsing them is what left a third
// of the archive in review; confusing them in the OTHER direction would invent
// zeroes where votes were cast.
console.log('empty vs unreadable cells');
const E = { emptyMeansZero: true };
eq('both cells blank is a corroborated zero', resolveRow({ party: 'BP', figures: '', words: '' }, E).value, 0);
eq('and counts as agreement', resolveRow({ party: 'BP', figures: '', words: '' }, E).confidence, 'both');
eq('blank figures, words say zero', resolveRow({ party: 'BP', figures: '', words: 'ZERO' }, E).confidence, 'both');
eq('blank against a real number is a CONFLICT', resolveRow({ party: 'BP', figures: '', words: 'FIFTY' }, E).value, null);
eq('conflict is labelled', resolveRow({ party: 'BP', figures: '', words: 'FIFTY' }, E).confidence, 'conflict');
eq('lone blank is a single observation', resolveRow({ party: 'BP', figures: '', words: null }, E).confidence, 'empty');
eq('lone blank still yields zero', resolveRow({ party: 'BP', figures: '', words: null }, E).value, 0);
eq('null is NOT empty', resolveRow({ party: 'BP', figures: null, words: null }, E).confidence, 'none');
eq('null yields no value', resolveRow({ party: 'BP', figures: null, words: null }, E).value, null);
eq('whitespace counts as empty', resolveRow({ party: 'BP', figures: '   ', words: '' }, E).value, 0);
// A drawn stroke is how most officers write "no votes" — 29-20-08-001 has
// twelve such rows on a sheet that is otherwise perfectly legible.
eq('a lone dash is an empty cell', resolveRow({ party: 'BP', figures: '-', words: '—' }, E).value, 0);
eq('and reads as agreement', resolveRow({ party: 'BP', figures: '-', words: '—' }, E).confidence, 'both');
eq('a ruled line too', resolveRow({ party: 'BP', figures: '___', words: '' }, E).value, 0);
// ...but decoration around a real figure is NOT an empty cell. This is the line
// that keeps the rule from eating live votes.
eq('dash-wrapped 02 keeps its value', resolveRow({ party: 'BP', figures: '-02-', words: 'TWO' }, E).value, 2);
eq('dash-wrapped 2 is not empty', resolveRow({ party: 'BP', figures: '—2—', words: null }, E).confidence, 'figures');
eq('OLD data: a lone dash stays unreadable', resolveRow({ party: 'BP', figures: '-', words: '—' }).value, null);
// THE OTHER HALF OF THE CONTRACT. The archive holds 252 empty cells produced
// under the old prompt, which never defined "" — reading those as zero would
// invent votes-that-weren't out of readings that meant nothing. Off by default,
// and this is the test that keeps it that way.
eq('OLD data: blank stays unreadable', resolveRow({ party: 'BP', figures: '', words: '' }).value, null);
eq('OLD data: blank is not agreement', resolveRow({ party: 'BP', figures: '', words: '' }).confidence, 'none');
eq('OLD data: lone blank yields nothing', resolveRow({ party: 'BP', figures: '', words: 'ZERO' }).confidence, 'words');
// A sheet resting on a lone blank must not be publishable — one observation is
// one observation, whatever it observed.
const loneEmpty = verifySheet({
  registered: 500, ballotsIssued: 500, unusedBallots: 210,
  accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
  parties: [
    { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
    { party: 'PDP', figures: 130, words: 'ONE HUNDRED AND THIRTY' },
    { party: 'LP', figures: '', words: null },
  ],
}, { expectedParties: 3, emptyMeansZero: true });
eq('lone blank counted as single-sourced', loneEmpty.summary.single, 1);
eq('lone blank reported', loneEmpty.summary.emptyCells, 1);
eq('sum still computes', statusOf(loneEmpty, 'party_sum'), 'pass/none');
eq('but not publishable', loneEmpty.summary.verdict, 'review');

// ------------------------------------------------ a spent constraint is not a pass
//
// The whole point of adjudication is that a constraint used to CHOOSE a value
// cannot then testify that the value is right. If this ever reports `pass` the
// audit is certifying its own assumption.
console.log('spent constraints');
const spentSheet = {
  registered: 500, ballotsIssued: 500, unusedBallots: 210,
  accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
  parties: [
    { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
    { party: 'PDP', figures: 130, words: 'ONE HUNDRED AND THIRTY' },
  ],
};
const spent = verifySheet(spentSheet, { spentChecks: new Set(['ballot_account']) });
eq('spent check is not a pass', statusOf(spent, 'ballot_account'), 'assumed/none');
eq('counted as assumed', spent.summary.assumed, 1);
eq('not counted as a pass', spent.summary.pass, verifySheet(spentSheet).summary.pass - 1);
eq('the independent check survives', statusOf(spent, 'ballot_stock'), 'pass/none');
// Spending must never hide a genuine failure elsewhere.
const spentButBroken = verifySheet({ ...spentSheet, unusedBallots: 999 }, { spentChecks: new Set(['ballot_account']) });
eq('other failures still surface', spentButBroken.summary.verdict, 'flagged');
// A check that could not run at all stays unknown — downgrading it to
// `assumed` would claim we adjudicated something we never read.
const spentUnknown = verifySheet({ ...spentSheet, usedBallots: null }, { spentChecks: new Set(['ballot_account']) });
eq('unreadable stays unknown, not assumed', statusOf(spentUnknown, 'ballot_account'), 'unknown/none');

// ------------------------------------------- fifteen rows that are not the ballot
//
// The bug this guards: a row COUNT of 15 satisfied the "nothing is missing"
// test while the row SET held APC twice and no A, double-counting one party's
// votes, dropping another's, and flagging the sheet for our own error.
console.log('row integrity');
const dupRows = {
  registered: 500, ballotsIssued: 500, unusedBallots: 210,
  accredited: 300, spoiled: 2, rejected: 8, totalValid: 280, usedBallots: 290,
  parties: [
    { party: 'APC', figures: 150, words: 'ONE HUNDRED AND FIFTY' },
    { party: 'APC', figures: 130, words: 'ONE HUNDRED AND THIRTY' },
  ],
};
const naive = verifySheet(dupRows, { expectedParties: 2 });
eq('without the guard the bad sum is a finding', statusOf(naive, 'party_sum'), 'pass/none');
const guarded = verifySheet(dupRows, {
  expectedParties: 2,
  rowIntegrity: { ok: false, duplicates: [{ party: 'APC', times: 2 }], missing: ['A'], stray: [] },
});
eq('a broken row set yields no sum', statusOf(guarded, 'party_sum'), 'unknown/none');
eq('and no manufactured finding', guarded.summary.fail, 0);
eq('names the duplicate', guarded.checks.find((c) => c.name === 'party_sum').detail.duplicates[0].party, 'APC');
// An intact row set must be unaffected.
const intact = verifySheet(dupRows, { expectedParties: 2, rowIntegrity: { ok: true, duplicates: [], missing: [], stray: [] } });
eq('a good row set is untouched', statusOf(intact, 'party_sum'), statusOf(naive, 'party_sum'));

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);

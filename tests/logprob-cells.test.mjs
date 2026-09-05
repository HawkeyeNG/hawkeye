/**
 * Per-cell confidence from token logprobs.
 *
 *   node tests/logprob-cells.test.mjs
 *
 * WHY. The party pass emitted 0 nulls in 21,630 cells and called 10,983 of them
 * empty; 2,813 of those are provably wrong (the words cell on the same row has a
 * value). Forbidding "" makes abstention expressible, but a confidently-wrong
 * model just writes BLANK instead. The thing that separates "I can see this cell
 * is empty" from "I could not read it" is the model's uncertainty at the token it
 * chose — which vLLM has computed on every request since the first run and which
 * nothing has ever read.
 *
 * The claim this test exists to check is that the alignment is EXACT: token
 * strings concatenate back to the response text byte for byte, so a running
 * offset gives every token a character span. If that is off by one anywhere, a
 * cell gets its neighbour's confidence and the whole signal is noise.
 */
import assert from 'node:assert';
import { tokenSpans, valueSpans, spanConfidence, cellConfidences } from '../backend/src/services/logprob_cells.js';

// A vLLM-shaped response: one confident reading, one confident blank, one guess.
const toks = [
  ['{"parties":[{"party":"A","figures":"', -0.001],
  ['110', -0.002], ['","words":"ONE HUNDRED AND TEN"},', -0.001],
  ['{"party":"B","figures":"', -0.001],
  ['BLANK', -0.004],                                   // confident: cell really is empty
  ['","words":"BLANK"},', -0.001],
  ['{"party":"C","figures":"', -0.001],
  ['BLANK', -2.9],                                     // a GUESS — barely preferred
  ['","words":"FIFTY"}]}', -0.001],
];
const text = toks.map((t) => t[0]).join('');
const logprobs = { content: toks.map(([token, logprob]) => ({ token, logprob, top_logprobs: [] })) };

// ---- 1. alignment is exact --------------------------------------------------
const spans = tokenSpans(logprobs);
assert.strictEqual(spans.map((s) => s.token).join(''), text, 'tokens must reconstruct the text exactly');
for (const s of spans) assert.strictEqual(text.slice(s.start, s.end), s.token, `span ${s.start}-${s.end} must hold its own token`);
console.log(`  PASS  ${spans.length} token spans reconstruct the response byte for byte`);

// ---- 2. values are found, in order ------------------------------------------
const vs = valueSpans(text, 'figures');
assert.strictEqual(vs.length, 3, `expected 3 figures values, got ${vs.length}`);
assert.deepStrictEqual(vs.map((v) => text.slice(v.start, v.end)), ['"110"', '"BLANK"', '"BLANK"']);
console.log('  PASS  three figures values located in document order');

// ---- 3. the point: the two BLANKs are distinguishable -----------------------
const conf = cellConfidences(text, logprobs, 'figures');
const [read, realBlank, guess] = conf;
assert.strictEqual(read.text, '"110"');
assert.ok(realBlank.minLogprob > -0.5, `a confident BLANK should be near 0, got ${realBlank.minLogprob}`);
assert.ok(guess.minLogprob < -1, `a guessed BLANK should be clearly worse, got ${guess.minLogprob}`);
assert.ok(realBlank.minLogprob - guess.minLogprob > 2, 'the two BLANKs must be separable by a wide margin');
console.log(`  PASS  confident BLANK ${realBlank.minLogprob} vs guessed BLANK ${guess.minLogprob} — separable`);
console.log(`        (the guess is row C, whose WORDS cell says FIFTY — a known-false blank)`);

// ---- controls ---------------------------------------------------------------
// A checker that returned the same number for both would be useless.
assert.notStrictEqual(realBlank.minLogprob, guess.minLogprob, 'CONTROL FAILED: identical confidence for both blanks');
// Missing logprobs must degrade to empty, never throw — the pass must still read.
assert.deepStrictEqual(cellConfidences(text, null, 'figures'), [], 'CONTROL FAILED: must degrade quietly without logprobs');
assert.deepStrictEqual(cellConfidences(text, { content: [] }, 'figures'), [], 'CONTROL FAILED: empty content must degrade quietly');
// An off-by-one in alignment would hand a cell its neighbour's number.
const shifted = tokenSpans({ content: toks.map(([t, lp]) => ({ token: t, logprob: lp })) });
assert.strictEqual(spanConfidence(shifted, vs[2].start, vs[2].end).minLogprob, -2.9,
  'CONTROL FAILED: the guessed cell must map to ITS OWN token, not a neighbour');
console.log('  PASS  3 controls — separable, degrades quietly, no off-by-one');

console.log('\nConfidence is per-cell and exactly aligned. Threshold is a calibration decision, not a guess.');

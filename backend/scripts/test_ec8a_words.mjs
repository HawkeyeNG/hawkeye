/**
 * Regression test for the EC8A figures-vs-words cross-check.
 *
 * Every string below is REAL PaddleOCR output from sheets 13-13-02-001/002 —
 * not invented noise. If a Paddle upgrade changes how it mangles handwriting,
 * this is where it shows up first.
 *
 *   node scripts/test_ec8a_words.mjs
 */
import { wordsToNumber } from '../src/services/ec8a_words.js';

const CASES = [
  // [observed OCR text, expected number]
  ['ZERO', 0], ['-2ERD', 0], ['-2BRO', 0], ['-26R0-', 0], ['ZORO-', 0],
  ['26RO-', 0], ['—2620-', 0], ['-2ER0-', 0], ['2BR0-', 0],
  ['ONE', 1], ['—ONE——', 1], ['—OND', 1], ['GONE', 1],
  ['THREE', 3], ['FOUR', 4], ['s1x', 6],
  ['THREE HUNDRED AND EIGHT', 308],
  ['CNE HUNDRED AHD FORTH HIREE', 143],
  ['ONE HUNDRED ATID FORTH HINE', 149],
  ['THREE HUNDRED AND NINETEEN', 319],
  ['THREE HUNDRED', 300],
  // must NOT invent a number
  ['RASI MUSA ADEWOLE', null],
  ['POLLING AGENT', null],
  ['', null],
];

let pass = 0, fail = 0;
for (const [input, expected] of CASES) {
  const got = wordsToNumber(input);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  if (!ok) console.log(`  FAIL  ${JSON.stringify(input)} -> ${got} (expected ${expected})`);
}
console.log(`\nwordsToNumber: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

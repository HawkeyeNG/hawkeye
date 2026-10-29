/* Party counts off a recognised sheet — run: node tests/sheet_counts_test.mjs
 *
 * Imports native/src/lib/sheet-counts.ts directly (Node strips the types), so
 * this measures the code the app runs, not a copy of it. Every check then runs
 * a second time against app/sheet-counts.js, the website's and Lite's mirror of
 * it, so the three cannot drift apart unnoticed.
 *
 * THE FIXTURE IS THE OWNER'S SHEET. On 28 Oct 2026 the native app read a printed
 * practice specimen on an iPhone — "Readable — 26 lines with figures" — and
 * paired nothing. The positions below were measured off that video: each cell
 * comes back as its own line, as Apple Vision returns a ruled table, and the
 * printed "Party A" sits at the TOP of its row while the handwritten 42 sits
 * lower, with no vertical overlap between the two boxes.
 *
 * The CONTROL runs the parser the app shipped with on the same input and must
 * pair nothing. If it pairs something, the fixture has stopped reproducing the
 * bug and every "ok" below proves nothing.
 */
import fs from 'node:fs';
import { parseCounts as appParse } from '../native/src/lib/sheet-counts.ts';

import { execFileSync } from 'node:child_process';

globalThis.window = {};
await import('../app/sheet-counts.js');
const webParse = globalThis.window.HAWKEYE_SHEETCOUNTS.parseCounts;

let failed = 0;
let tag = '';
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${tag}${label}\n        got ${a}${ok ? '' : `, want ${e}`}`);
};

const L = (text, left, right, top, bottom) => ({ text, left, right, top, bottom });
const textOf = (lines) => lines.map((l) => l.text).join('\n');
const PRACTICE = ['Party A', 'Party B', 'Party C', 'Party D'];

// ── the owner's sheet, cell by cell ──────────────────────────────────────────
const SUMMARY = [
  L('#7 Total Valid Votes', 670, 820, 92, 104), L('63', 968, 1003, 84, 108),
  L('#8 Total Used Ballot Papers (#5 + #6 + #7)', 670, 915, 130, 142), L('67', 968, 1005, 122, 150),
];
const HEADER = [
  L('S/N', 152, 176, 196, 206), L('POLITICAL', 236, 298, 192, 202), L('PARTY', 248, 286, 208, 218),
  L('VOTES IN', 430, 490, 192, 202), L('FIGURES', 432, 488, 208, 218),
  L('VOTES IN', 700, 758, 192, 202), L('WORDS', 706, 752, 208, 218),
  L('NAME / SIGNATURE', 900, 1015, 192, 202), L('OF POLLING AGENT', 898, 1017, 208, 218),
];
const row = (sn, label, y, fig, figBox, words, wordsBox) => [
  L(sn, 162, 168, y + 1, y + 12), L(label, 238, 297, y, y + 14),
  ...(fig == null ? [] : [L(fig, ...figBox)]), ...(words == null ? [] : [L(words, ...wordsBox)]),
];
const ROWS = {
  A: row('1', 'Party A', 246, '42', [398, 475, 265, 307], 'FORTY-TWO', [600, 825, 265, 300]),
  B: row('2', 'Party B', 335, '17', [412, 466, 358, 394], 'SEVENTEEN', [612, 808, 358, 392]),
  C: row('3', 'Party C', 423, '0', [418, 455, 445, 478], 'ZERO', [625, 715, 445, 478]),
  D: row('4', 'Party D', 511, '4', [420, 460, 528, 570], 'FOUR', [630, 720, 510, 550]),
};
const TOTAL = [L('TOTAL VALID VOTES', 155, 292, 594, 608), L('63', 408, 468, 605, 640), L('SIXTY-THREE', 610, 855, 600, 642)];
const FOOTER = [L('I, ............ (Presiding Officer) certify that the', 140, 610, 693, 705)];
const sheet = (rows = ROWS, total = TOTAL) =>
  [...SUMMARY, ...HEADER, ...rows.A, ...rows.B, ...rows.C, ...rows.D, ...total, ...FOOTER];

// The parser the app shipped with until 28 Oct 2026, verbatim.
function shippedParseCounts(text, partyCodes) {
  const tokenised = (line) => line.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const codes = new Set(partyCodes.map((c) => c.toUpperCase()));
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(\d)[.,](?=\d{3}\b)/g, '$1');
    const tokens = tokenised(line);
    const code = tokens.find((t) => codes.has(t));
    if (!code) continue;
    const numbers = tokens.filter((t) => /^\d{1,6}$/.test(t)).map(Number);
    if (!numbers.length) continue;
    if (out[code] === undefined) out[code] = numbers[numbers.length - 1];
  }
  return out;
}

console.log('\n── the website copy is generated from the app\'s ──');
let fresh = true;
try {
  execFileSync(process.execPath, ['--no-warnings', new URL('../scripts/gen_sheet_counts_web.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' });
} catch { fresh = false; }
eq('app/sheet-counts.js matches native/src/lib/sheet-counts.ts (else run scripts/gen_sheet_counts_web.mjs)', fresh, true);

console.log('\n── CONTROL: the shipped parser on the owner\'s sheet ──');
eq('shipped parser pairs nothing (reproduces the video)', shippedParseCounts(textOf(sheet()), PRACTICE), {});
eq('shipped parser pairs nothing even when the reader merges "Party A 42"',
  shippedParseCounts('Party A 42 FORTY-TWO', PRACTICE), {});

for (const [copy, parseCounts] of [['app', appParse], ['web', webParse]]) {
tag = `[${copy}] `;
console.log(`\n════ ${copy}: ${copy === 'app' ? 'native/src/lib/sheet-counts.ts' : 'app/sheet-counts.js'} ════`);

console.log('\n── the owner\'s sheet ──');
const S = sheet();
eq('all four practice parties pair', parseCounts(textOf(S), PRACTICE, S),
  { 'Party A': 42, 'Party B': 17, 'Party C': 0, 'Party D': 4 });
eq('keys are the codes exactly as passed (the fields are indexed by them)',
  Object.keys(parseCounts(textOf(S), PRACTICE, S)), PRACTICE);
eq('without boxes, a split row cannot be paired — and is not guessed', parseCounts(textOf(S), PRACTICE, []), {});

// Handwritten 0 read as a letter, and ZERO read as "2ERO". Taking the 2 that
// starts the words cell would propose a 2; reading it as the word it is gives 0.
const misread = { ...ROWS, C: row('3', 'Party C', 423, 'O', [418, 455, 445, 478], '2ERO', [625, 715, 445, 478]) };
const M = sheet(misread);
eq('"2ERO" is ZERO, not 2: Party C comes from its words', parseCounts(textOf(M), PRACTICE, M),
  { 'Party A': 42, 'Party B': 17, 'Party C': 0, 'Party D': 4 });

// A total written high in its row sits within one pitch of Party D's label.
const highTotal = [L('TOTAL VALID VOTES', 155, 292, 594, 608), L('63', 404, 470, 575, 610)];
const H = sheet(ROWS, highTotal);
eq('the TOTAL row keeps its own figure (D stays 4, not 63)', parseCounts(textOf(H), PRACTICE, H)['Party D'], 4);

// The same high total, with Party D's own cell blank: only the TOTAL label
// stands between that 63 and Party D.
const blankD = { ...ROWS, D: row('4', 'Party D', 511, null, null, null, null) };
const HB = sheet(blankD, highTotal);
eq('a blank party row does not take the total below it', parseCounts(textOf(HB), PRACTICE, HB)['Party D'], undefined);

// No TOTAL row read at all, Party D blank, and a date far down the page: a
// number more than a row pitch away belongs to no one.
const far = sheet(blankD, [L('16/01/2027', 420, 560, 760, 790)]);
eq('a blank party row does not take a date from the footer', parseCounts(textOf(far), PRACTICE, far)['Party D'], undefined);

// Vision misses one label. Its figure must not drift to a neighbour.
const noC = { ...ROWS, C: ROWS.C.filter((l) => l.text !== 'Party C') };
const N = sheet(noC);
eq('an unread label pairs nothing, and its 0 goes to no neighbour', parseCounts(textOf(N), PRACTICE, N),
  { 'Party A': 42, 'Party B': 17, 'Party D': 4 });

// Rows C, D and E were read without their labels; F's label was read. The gap
// B→F spans four rows. A row height taken as the median gap would cover C's
// figure and words from B, and B's cell would no longer add up.
const noCDE = [...HEADER, ...ROWS.A, ...ROWS.B,
  ...ROWS.C.filter((l) => l.text !== 'Party C'), ...ROWS.D.filter((l) => l.text !== 'Party D'),
  ...row('5', 'Party E', 599, '3', [420, 460, 618, 656], 'THREE', [630, 730, 618, 652]).filter((l) => l.text !== 'Party E'),
  ...row('6', 'Party F', 687, '2', [420, 460, 706, 744], 'TWO', [630, 700, 706, 740])];
const SIX = [...PRACTICE, 'Party E', 'Party F'];
eq('rows nobody read do not stretch the row height', parseCounts(textOf(noCDE), SIX, noCDE),
  { 'Party A': 42, 'Party B': 17, 'Party F': 2 });

// Only one label read: the pitch falls back to four label heights.
const onlyA = [...HEADER, ...ROWS.A];
eq('a single label still pairs its own figure', parseCounts(textOf(onlyA), PRACTICE, onlyA), { 'Party A': 42 });

eq('reader merged the row: same-line rule', parseCounts('Party A 42 FORTY-TWO', PRACTICE, [L('Party A 42 FORTY-TWO', 238, 825, 246, 307)]),
  { 'Party A': 42 });
eq('"PartyA" and "PARTY A" are the same code', parseCounts('PartyA 12\nPARTY B 7', PRACTICE), { 'Party A': 12, 'Party B': 7 });
eq('"Party Agent" is not Party A', parseCounts('Party Agent 5', PRACTICE), {});

console.log('\n── a real EC8A layout: codes centred in their rows ──');
// Rows 60 px apart, label centred, figures within a few pixels of centre.
const REAL = ['A', 'AA', 'AAC', 'ADC', 'APC', 'LP', 'PDP', 'NNPP'];
const realRow = (i, code, fig, dy = 0, words = null) => {
  const y = 300 + 60 * i;
  return [
    L(String(i + 1), 40, 52, y - 8, y + 8), L(code, 100, 160, y - 8, y + 8),
    ...(fig == null ? [] : [L(fig, 260, 320, y - 12 + dy, y + 12 + dy)]),
    ...(words == null ? [] : [L(words, 400, 600, y - 10 + dy, y + 10 + dy)]),
  ];
};
const R = [
  L('FORM EC8A', 400, 520, 40, 60), L('0000388', 700, 790, 40, 60),
  L('S/N', 40, 70, 250, 262), L('POLITICAL PARTY', 90, 200, 250, 262), L('VOTES IN FIGURES', 250, 360, 250, 262),
  ...realRow(0, 'A', '12', 3, 'TWELVE'),
  ...realRow(1, 'AA', null),                       // blank figures cell
  ...realRow(2, 'AAC', '7', -10, 'SEVEN'),         // written above centre
  ...realRow(3, 'ADC', '33', 6),
  ...realRow(4, 'APC', '1,204', 0, 'ONE THOUSAND TWO HUNDRED AND FOUR'),
  ...realRow(5, 'LP', '58', 12),
  ...realRow(6, 'PDP', '1OO', 0, 'ONE HUNDRED'),   // O read for 0
  ...realRow(7, 'NNPP', '9', 0),
  L('08031234567', 700, 820, 535, 552),            // an agent's phone number, APC's row
  L('2', 700, 712, 594, 606),                      // an agent's mark in LP's row, nearer LP's centre than its figure
  L('ONYE', 700, 760, 294, 306),                   // an agent's name in A's row, one letter from ONE
  L('TOTAL VALID VOTES', 90, 230, 772, 788), L('1,423', 255, 330, 768, 794),
];
eq('every row pairs with its own figure', parseCounts(textOf(R), REAL, R),
  { A: 12, AAC: 7, ADC: 33, APC: 1204, LP: 58, PDP: 100, NNPP: 9 });
eq('a blank figures cell stays blank (AA borrows nothing)', parseCounts(textOf(R), REAL, R).AA, undefined);
eq('"A" does not match "AA" or "AAC"', parseCounts('AA 5\nAAC 6', ['A']), {});
eq('the S/N before the code is not the count', parseCounts('3 APC 126', ['APC']), { APC: 126 });
eq('a seven-digit run is not a tally', parseCounts('APC 0000388', ['APC']), {});
eq('the first number after the code is the figures column', parseCounts('APC 126 ONE HUNDRED AND TWENTY-SIX 2', ['APC']), { APC: 126 });

// A code that also stands alone outside the table (a stamp's letter, a margin
// mark): the label nearest the party column wins.
const dup = [L('A', 300, 316, 52, 68), ...R.filter((l) => l.text !== 'FORM EC8A')];
eq('a stray "A" outside the party column does not move A\'s row', parseCounts(textOf(dup), REAL, dup).A, 12);

console.log('\n── number words (same line, no geometry) ──');
const one = (line) => parseCounts(line, ['APC']).APC;
eq('words alone give the count', one('APC ONE HUNDRED AND TWENTY-SIX'), 126);
eq('figures and words that agree', one('APC 126 ONE HUNDRED AND TWENTY-SIX'), 126);
eq('figures and words that disagree leave it blank', one('APC 125 ONE HUNDRED AND TWENTY-SIX'), undefined);
eq('number words that do not add up block the figure too', one('APC 10 ONE HURAREI AND'), undefined);
eq('"ONE HUNDRED AND" with nothing after is incomplete', one('APC ONE HUNDRED AND'), undefined);
eq('NIL is 0', one('APC NIL'), 0);
eq('NONE is 0, not a misread ONE', one('APC NONE'), 0);
eq('a lone smudge reads as the word it is closest to (ZERD)', one('APC ZERD'), 0);
eq('a misspelling one letter out (NINTY)', one('APC NINTY'), 90);
eq('a fuzzy word beside a clean one (FOURTY TWO)', one('APC FOURTY TWO'), 42);
eq('two smudged words with no clean one are not trusted (FOURTY TWU)', one('APC FOURTY TWU'), undefined);
eq('"OND" mid-phrase is AND', one('APC ONE HUNDRED OND FIVE'), 105);
eq('"OND" alone is ONE or AND — refused', one('APC OND'), undefined);
eq('"T0" (a misread 90) is not TWO', one('APC T0'), undefined);
eq('"NINE TEEN" is a split NINETEEN — refused', one('APC NINE TEEN'), undefined);
eq('words in the wrong order are refused', one('APC FIVE TWENTY'), undefined);
eq('HUNDRED HUNDRED HUNDRED is not a million', one('APC HUNDRED HUNDRED HUNDRED'), undefined);
eq('a thousands separator does not shift the words', one('APC 1,204 ONE THOUSAND TWO HUNDRED AND FOUR'), 1204);
eq('"1OO" beside ONE HUNDRED', one('APC 1OO ONE HUNDRED'), 100);

console.log('\n── what is not a party label ──');
// The website's Tesseract read of the Osun photo: no party code survived in the
// table, but this noise did, and the stray "a" plus "#2" made Accord a 2.
eq('a lowercase "a" in OCR noise is not party A', parseCounts('3 ee a ae\na #2 | Number of Accredited Voters', ['A']), {});
eq('an uppercase A that starts its row still is', parseCounts('1 A 12 TWELVE', ['A']), { A: 12 });
eq('"#2" is an item number, not a count', one('APC #2 Number of Accredited Voters'), undefined);
eq('a code inside a heading or address labels nothing', one('Registration Area APC 12'), undefined);
eq('a code at the very start of the line', one('APC 126'), 126);
eq('a misread S/N before the code is still a row number ("1O APC 7")', one('1O APC 7'), 7);
eq('table rules before the code are fine ("| 3 | APC | 45 |")', one('| 3 | APC | 45 |'), 45);

// ── Apple Vision's own output (tests/fixtures/vision/), the 29 Oct probe ──────
// Whatever these propose must be RIGHT; a blank is acceptable, a wrong count is not.
const fixture = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/vision/${f}`, import.meta.url), 'utf8'));
const wrong = (got, truth) => Object.entries(got).filter(([k, v]) => truth[k] !== v).map(([k, v]) => `${k}=${v} (sheet says ${truth[k]})`);

console.log('\n── Apple Vision on a real Osun EC8A (29-01-01-001) ──');
const OSUN_CODES = ['A', 'AA', 'AAC', 'ADC', 'ADP', 'APC', 'APGA', 'APM', 'APP', 'BP', 'NNPP', 'PRP', 'SDP', 'YPP', 'ZLP'];
const OSUN_TRUTH = { A: 110, AA: 1, AAC: 1, ADC: 9, ADP: 0, APC: 90, APGA: 0, APM: 0, APP: 0, BP: 0, NNPP: 0, PRP: 0, SDP: 0, YPP: 1, ZLP: 1 };
const osun = fixture('osun-29-01-01-001.json');
// CONTROL: Vision returned almost none of the handwritten figures, so a
// figures-only reader cannot work on this sheet; only the words make it readable.
const figuresRead = osun.lines.filter((l) => /^\d{1,3}$/.test(l.text) && l.left > 700 && l.left < 900).length;
eq('control: Vision read at most 2 of 15 handwritten figures', figuresRead <= 2, true);
const osunGot = parseCounts(osun.text, OSUN_CODES, osun.lines);
eq('nothing proposed is wrong', wrong(osunGot, OSUN_TRUTH), []);
eq('13 of 15 parties pre-fill from the words', osunGot,
  { AA: 1, AAC: 1, ADC: 9, ADP: 0, APC: 90, APGA: 0, APM: 0, APP: 0, NNPP: 0, PRP: 0, SDP: 0, YPP: 1, ZLP: 1 });
eq('A stays blank: Vision read 110 as "10" and its words do not parse', osunGot.A, undefined);

console.log('\n── Apple Vision on the owner\'s practice sheet (re-film frame) ──');
const refilm = fixture('practice-specimen-refilm-frame.json');
const refilmGot = parseCounts(refilm.text, PRACTICE, refilm.lines);
eq('nothing proposed is wrong (Party B was read as "Panty•"; C must not take its 17)',
  wrong(refilmGot, { 'Party A': 42, 'Party B': 17, 'Party C': 0, 'Party D': 4 }), []);
eq('A from its figure and words, C from "26RO" (ZERO)', refilmGot, { 'Party A': 42, 'Party C': 0 });

console.log('\n── the website\'s reader (Tesseract.js) on the same Osun photo ──');
// It read almost nothing of the party table, so pre-filling nothing is right;
// the first port of this parser proposed A = 2 here, from "a #2 | Number of …".
const tess = JSON.parse(fs.readFileSync(new URL('./fixtures/ocr/tesseract-web-osun-29-01-01-001.json', import.meta.url), 'utf8'));
const tessGot = parseCounts(tess.text, OSUN_CODES, tess.lines);
eq('nothing proposed is wrong', wrong(tessGot, OSUN_TRUTH), []);

// The hard case (29-01-04-001). The website's old pairing proposed A = 5
// (sheet: 101) and APC = 1263 (sheet: 126) from this same read.
const HARD_TRUTH = { A: 101, AA: 0, AAC: 1, ADC: 5, ADP: 2, APC: 126, APGA: 2, APM: 0, APP: 0, BP: 0, NNPP: 0, PRP: 0, SDP: 1, YPP: 0, ZLP: 2 };
const hard = JSON.parse(fs.readFileSync(new URL('./fixtures/ocr/tesseract-web-osun-29-01-04-001.json', import.meta.url), 'utf8'));
const hardGot = parseCounts(hard.text, OSUN_CODES, hard.lines);
eq('hard case: nothing proposed is wrong', wrong(hardGot, HARD_TRUTH), []);
eq('hard case: APGA 2 from "7 APGA =2= -TWO-"', hardGot.APGA, 2);
}
tag = '';

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

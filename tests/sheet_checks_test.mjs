/* What a sheet photo says besides its counts — run: node tests/sheet_checks_test.mjs
 *
 * sheetOffice / raceOffice / partiesSeen / partiesMissing in
 * native/src/lib/sheet-counts.ts: the phone warns when the photo is another
 * race's sheet or poster, and when ballot parties are missing from it
 * (docs/private/EC60E-RESULT-POSTER.md). Every check runs against the
 * TypeScript the app runs AND app/sheet-counts.js, the website's and Lite's
 * generated copy, so the three cannot drift apart.
 *
 * The fixtures are real reads: Apple Vision and Tesseract.js on Osun 2026
 * governorship EC8As (tests/fixtures/vision, tests/fixtures/ocr). The Osun
 * sheet says "Presiding Officer" in its certificate, so "it reads GOV" is also
 * the control that PRESIDING is never PRESIDENT: a sheet naming two offices
 * reads as null.
 */
import fs from 'node:fs';
import * as app from '../native/src/lib/sheet-counts.ts';

globalThis.window = {};
await import('../app/sheet-counts.js');
const web = globalThis.window.HAWKEYE_SHEETCOUNTS;

let failed = 0;
let tag = '';
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${tag}${label}${ok ? '' : `\n        got ${a}, want ${e}`}`);
};
const fixture = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const OSUN = ['A', 'AA', 'AAC', 'ADC', 'ADP', 'APC', 'APGA', 'APM', 'APP', 'BP', 'NNPP', 'PRP', 'SDP', 'YPP', 'ZLP'];
const vision = fixture('./fixtures/vision/osun-29-01-01-001.json');
const tess = fixture('./fixtures/ocr/tesseract-web-osun-29-01-01-001.json');
const tessHard = fixture('./fixtures/ocr/tesseract-web-osun-29-01-04-001.json');

for (const [name, m] of [['app', app], ['web', web]]) {
  tag = `[${name}] `;
  const { sheetOffice, raceOffice, partiesSeen, partiesMissing } = m;
  console.log(`\n── ${name}: which election the photo names ──`);
  eq('Apple Vision, Osun EC8A: GOV (its "Presiding Officer" line is not PRES)', sheetOffice(vision.text), 'GOV');
  eq('Tesseract.js, same sheet: GOV from "026 OSUN STATE GOVERNORSHIP ELECTION"', sheetOffice(tess.text), 'GOV');
  eq('Tesseract.js, hard sheet: heading unread, so no claim', sheetOffice(tessHard.text), null);
  eq('poster: "Election to the office of PRESIDENT"', sheetOffice('PUBLICATION OF RESULT OF POLL\nElection to the office of PRESIDENT\nState: KADUNA'), 'PRES');
  eq('poster: "...office of SENATOR"', sheetOffice('Election to the office of SENATOR'), 'SEN');
  eq('EC8A area line: Senatorial District', sheetOffice('Senatorial\nDistrict: Kaduna Central'), 'SEN');
  eq('EC8A area line: Federal Constituency', sheetOffice('FEDERAL CONSTITUENCY: Kaduna North'), 'REP');
  eq('heading across lines: House of / Representatives', sheetOffice('ELECTION TO THE HOUSE OF\nREPRESENTATIVES'), 'REP');
  eq('State House of Assembly', sheetOffice('STATE HOUSE OF ASSEMBLY ELECTION'), 'SHA');
  eq('State Constituency', sheetOffice('State Constituency: Zaria City'), 'SHA');
  eq('Presiding Officer alone names nothing', sheetOffice('Name of Presiding Officer'), null);
  eq('two offices on one photo: no claim', sheetOffice('GOVERNORSHIP ELECTION\nSenatorial District'), null);
  eq('no office words: no claim', sheetOffice('Party A 42 FORTY-TWO'), null);
  eq('empty text', sheetOffice(''), null);

  console.log(`\n── ${name}: the office a race code is for ──`);
  eq('PRES SEN REP GOV SHA', ['PRES', 'SEN', 'REP', 'GOV', 'SHA'].map(raceOffice), ['PRES', 'SEN', 'REP', 'GOV', 'SHA']);
  eq('by-elections take their prefix', [raceOffice('REP_BYE_GOMBE_2026'), raceOffice('SHA_BYE_DELTA_UDU_2026')], ['REP', 'SHA']);
  eq('anything else: null', [raceOffice('LGC'), raceOffice(''), raceOffice('PRESIDENT')], [null, null, null]);

  console.log(`\n── ${name}: the ballot's parties on the photo ──`);
  eq('Apple Vision, Osun: all 15 rows found', partiesSeen(vision.text, OSUN), OSUN);
  eq('a code counts only where it starts a row (after an S/N)', partiesSeen('3 APC 120\nNOTE: PDP agent absent\nLP. 7', ['APC', 'PDP', 'LP']), ['APC', 'LP']);
  // CUT OFF: the same read with its last four party rows gone, as when the
  // bottom of a poster is out of frame.
  const cut = new Set(['PRP', 'SDP', 'YPP', 'ZLP']);
  const rowOf = (line) => OSUN.find((c) => new RegExp(`^\\W*\\d{0,2}\\W*${c}(?![A-Za-z0-9])`).test(line));
  const topOnly = vision.text.split('\n').filter((l) => !cut.has(rowOf(l))).join('\n');
  const seenTop = partiesSeen(topOnly, OSUN);
  eq('bottom four rows cut off: 11 found', seenTop.length, 11);
  eq('... and those four are the ones reported missing', partiesMissing(seenTop, OSUN), ['PRP', 'SDP', 'YPP', 'ZLP']);
  eq('nothing missing when all were found', partiesMissing(partiesSeen(vision.text, OSUN), OSUN), []);
  eq('reader failed (Tesseract.js found 0): no blame on the photo', partiesMissing(partiesSeen(tess.text, OSUN), OSUN), []);
  eq('reader weak (5 of 15, under half): still silent', partiesMissing(partiesSeen(tessHard.text, OSUN), OSUN), []);
  eq('small ballot: 2 of 4 found is under three rows: silent', partiesMissing(['A', 'B'], ['A', 'B', 'C', 'D']), []);
  eq('small ballot: 3 of 4 found names the fourth', partiesMissing(['A', 'B', 'C'], ['A', 'B', 'C', 'D']), ['D']);
  eq('exactly half of 18 (9) is enough', partiesMissing(Array.from({ length: 9 }, (_, i) => `P${i}`), Array.from({ length: 18 }, (_, i) => `P${i}`)).length, 9);
  eq('8 of 18 is not', partiesMissing(Array.from({ length: 8 }, (_, i) => `P${i}`), Array.from({ length: 18 }, (_, i) => `P${i}`)), []);
}
tag = '';

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

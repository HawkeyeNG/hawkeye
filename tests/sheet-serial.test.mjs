/* EC8A serial extraction — run: node tests/sheet-serial.test.mjs
 *
 * WHY THE FIXTURES LOOK LIKE THIS. tests/pu-code.test.js records that the first
 * polling-unit extractor "was written against INVENTED strings and was inert on
 * real sheets". parseSerial started in exactly that position, so the cases below
 * are not typed from imagination: they are lines an OCR engine actually produced
 * from three genuine 2026 Osun EC8A photographs in
 * audits/2026-osun-governorship/sheets, mangling and all.
 *
 * The printed truth on those sheets, read by eye:
 *   29-01-01-001  S/N 0000001
 *   29-02-01-001  S/N 0000078
 *   29-05-03-002  S/N 0000388
 *
 * Two of the three do NOT come back cleanly, and the tests assert that they
 * return null rather than a guess. That is the intended behaviour, not a gap:
 * backend/src/services/integrity.js logs `duplicate_serial` at HIGH severity as
 * forgery, so a wrong serial accuses two innocent polling units while a missing
 * one merely leaves a field for the observer to fill.
 */
import { parseSerial } from '../native/src/lib/sheet-serial.ts';

let failed = 0;
const eq = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}\n        got ${JSON.stringify(actual)}`
    + `${ok ? '' : `, want ${JSON.stringify(expected)}`}`);
};

// ── REAL recogniser output ────────────────────────────────────────────────
// tesseract --psm 6 over sheet 29-05-03-002. Clean enough to use.
eq('real sheet 29-05-03-002 (lowercase "sn", trailing comma)',
  parseSerial('EMENT OF RESULT OF POLL FROM POLLING UNIT\nsn 0000388, z\n| Local Government'),
  '0000388');

// Same engine over 29-02-01-001: the label survived as "SIN" but the zeros came
// back as Qs and the run was split. Stripped of letters it is 4 digits.
eq('real sheet 29-02-01-001 (zeros read as Q) refuses rather than guesses',
  parseSerial('SIN nQQQ00 78. esnrnnnrcnn !\npaseo... OSUN'),
  null);

// 29-01-01-001: the serial line was not recognised at all.
eq('real sheet 29-01-01-001 (serial line unreadable) returns null',
  parseSerial('TL ISNT Mote ont ea pataal a ey\n~~ POLITICAL SNATURE OF |'),
  null);

// ── the collision that matters ────────────────────────────────────────────
// Also real, from 29-05-03-002 line 18: the PARTY TABLE header carries "SN".
// Without the table-word guard this is where a row number becomes a serial.
eq('party-table header carrying SN is refused',
  parseSerial('p | SN ____ PARTY LIN FIGURES | IN WORDS POLLING AGENT :'),
  null);

eq('party table header, spelled out',
  parseSerial('S/N  POLITICAL PARTY  VOTES IN FIGURES  VOTES IN WORDS  1234567'),
  null);

// ── the printed form, as it reads when recognised cleanly ─────────────────
eq('canonical S/N with dot leaders', parseSerial('FORM EC 8A\nS/N ....0000001'), '0000001');
eq('S/N with the value on the NEXT line', parseSerial('S/N\n0000078\nState OSUN'), '0000078');
eq('single space inside the run (anchored, so tolerated)',
  parseSerial('S/N 0000 388'), '0000388');

// ── things that must never be mistaken for a serial ───────────────────────
eq('no label anywhere → null', parseSerial('FORM EC 8A\n0000388\nState OSUN'), null);
eq('row number is far too short', parseSerial('S/N 1'), null);
eq('a vote count on an unlabelled line', parseSerial('APC 213\nPDP 178'), null);
eq('ten digits is not a serial', parseSerial('S/N 1234567890'), null);
eq('empty input', parseSerial(''), null);

// ── the control: a checker that cannot fail is not a checker ──────────────
// If the two below ever disagree, the harness is broken, not the code.
eq('CONTROL known-good must match', parseSerial('S/N 0000042'), '0000042');
eq('CONTROL known-bad must not match', parseSerial('nothing here at all'), null);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

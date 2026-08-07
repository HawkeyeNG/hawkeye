/* Polling-unit code extraction — run: node tests/pu-code.test.js
 *
 * These cases exist because the first version of the extractor was written
 * against INVENTED strings and was inert on real sheets: it hunted a contiguous
 * NN-NN-NN-NNN run, while a real EC8A prints the code as four separately
 * labelled boxes on four lines. The REAL_SHEET fixture below is transcribed from
 * IReV sheet 37-05-04-027 (FCT / Kwali / Kilankwa / Sheda Sarki II Village
 * Square), dot leaders and all. Keep it that way — if the extractor is ever
 * changed, this is the case that proves it still works on the actual form.
 *
 * app/pu-code.js and native/src/lib/pu-code.ts are mirrors; this exercises the
 * web copy, so any change to one must be made to both.
 */
global.window = {};
require('../app/pu-code.js');
const P = global.window.HAWKEYE_PUCODE;

let failed = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ok   ${label}`); return; }
  failed++;
  console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
}

const REAL_SHEET = `INDEPENDENT NATIONAL ELECTORAL COMMISSION
STATEMENT OF RESULT OF POLL FROM POLLING UNIT
2026 FCT AREA COUNCIL ELECTIONS
KWALI CHAIRMANSHIP
FORM EC 8A
State............FCT............Code 3 7    S/N........0000111
Area Council ........KWALI...........Code 0 5
Registration Area(WARD)........KILANKWA.........Code 0 4
Polling Unit......SHEDA SARKI II VILLAGE SQUARE......Code 0 2 7
S/N POLITICAL PARTY VOTES SCORED
1 A =0= ZERO
5 APC 8 EIGHT
9 PDP 3 THREE
TOTAL VALID VOTES 12 TWELVE`;

console.log('extractCandidates:');
eq('real EC8A layout', P.extractCandidates(REAL_SHEET), ['37-05-04-027']);
eq('letters read for digits in boxes',
  P.extractCandidates(REAL_SHEET.replace('Code 0 5', 'Code O 5').replace('Code 0 2 7', 'Code O 2 7')),
  ['37-05-04-027']);
// OCR joins columns; the S/N run must never be absorbed into the state field.
eq('S/N column not swallowed', P.extractCandidates(
  'State....FCT....Code 3 7 S/N 0000111\nArea Council...KWALI...Code 0 5\n'
  + 'Registration Area(WARD)...K...Code 0 4\nPolling Unit...X...Code 0 2 7'), ['37-05-04-027']);
eq('positional fallback when labels unreadable', P.extractCandidates(
  'xxxx....Code 2 9\nyyyy....Code 2 1\nzzzz....Code 0 4\nwwww....Code 0 0 6'), ['29-21-04-006']);
eq('contiguous code still supported', P.extractCandidates('PU CODE 29-01-01-001'), ['29-01-01-001']);
eq('no code present', P.extractCandidates('TOTAL VALID VOTES 12 TWELVE'), []);
eq('three boxes does not invent a fourth', P.extractCandidates(
  'State..Code 3 7\nArea Council..Code 0 5\nRegistration Area(WARD)..Code 0 4'), []);

// Resolution: the register is the arbiter, ambiguity refuses, GPS may only veto.
const REG = {
  '29-01-01-001': { name: 'Town Hall Iwara', lat: 7.9, lng: 4.6 },
  '29-01-01-003': { name: 'L.A. School, Iwikun', lat: 7.91, lng: 4.61 },
  '29-01-01-009': { name: 'Open Space Revenue Office', lat: 7.92, lng: 4.62 },
};
const resolve = async (c) => REG[c] || null;

(async () => {
  console.log('resolveUnitFromText:');
  const exact = await P.resolveUnitFromText('POLLING UNIT 29-01-01-001 TOWN HALL IWARA', { resolve });
  eq('exact hit is high confidence', [exact.code, exact.source, exact.confidence],
    ['29-01-01-001', 'exact', 'high']);

  const rep = await P.resolveUnitFromText('UNIT 29-01-01-109 OPEN SPACE REVENUE OFFICE', { resolve });
  eq('unique single-digit repair accepted', [rep.code, rep.source], ['29-01-01-009', 'repaired']);

  // 002 is one digit from BOTH 001 and 003 — an unreadable sheet, not a tie.
  eq('ambiguous repair refused',
    await P.resolveUnitFromText('UNIT 29-01-01-002 SOMEWHERE', { resolve }), null);

  // A partial sweep cannot PROVE uniqueness, so a low ceiling must refuse rather
  // than trust whatever it happened to find first.
  eq('partial sweep refuses',
    await P.resolveUnitFromText('UNIT 29-01-01-109 OPEN SPACE', { resolve, maxRepair: 24 }), null);

  const veto = await P.resolveUnitFromText('29-01-01-001 TOWN HALL IWARA', { resolve, fix: { lat: 6.5, lng: 3.4 } });
  eq('distant GPS vetoes to low', [veto.gpsAgrees, veto.confidence], [false, 'low']);

  const near = await P.resolveUnitFromText('29-01-01-001 TOWN HALL IWARA', { resolve, fix: { lat: 7.9, lng: 4.6 } });
  eq('nearby GPS keeps high', [near.gpsAgrees, near.confidence], [true, 'high']);

  eq('no candidates resolves to nothing',
    await P.resolveUnitFromText('NO CODE HERE AT ALL', { resolve }), null);

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();

/* REGRESSION: what ML Kit actually returns from a photographed EC8A.
 * Each boxed digit is its own text block, so Code and its digits land on
 * SEPARATE lines. The first parser demanded them on one line and therefore
 * never fired on a real capture — the failure this fixture exists to prevent. */
(function () {
  const OCR_BLOCKS = [
    'INDEPENDENT NATIONAL ELECTORAL COMMISSION',
    'STATEMENT OF RESULT OF POLL FROM POLLING UNIT',
    '2026 FCT AREA COUNCIL ELECTIONS',
    'KWALI CHAIRMANSHIP',
    'FORM EC 8A',
    'State', 'FCT', 'Code', '3', '7',
    'S/N', '0000111',
    'Area Council', 'KWALI', 'Code', '0', '5',
    'Registration Area(WARD)', 'KILANKWA', 'Code', '0', '4',
    'Polling Unit', 'SHEDA SARKI II VILLAGE SQUARE', 'Code', '0', '2', '7',
    'APC', '8', 'EIGHT',
  ].join('\n');
  eq('ML Kit block layout (digits on their own lines)',
    P.extractCandidates(OCR_BLOCKS), ['37-05-04-027']);
}());

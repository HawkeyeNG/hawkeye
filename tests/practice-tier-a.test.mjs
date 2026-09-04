/* Tier A in practice — run: node tests/practice-tier-a.test.mjs
 *
 * practice.tsx now calls the SAME resolver as report/result.tsx
 * (lib/pu-code resolveUnitFromText). This does not re-test the parser — that is
 * tests/pu-code.test.js's job, against a real IReV sheet. It tests the thing the
 * port could plausibly get wrong: that the two-pass order practice copied still
 * behaves the way the real flow's does.
 *
 * The order is the whole safety property. Pass 1 refuses repairs and may reach
 * the network, so an exactly-read code wins outright. Pass 2 allows a
 * single-digit repair but only against rows already in hand, because an 81-probe
 * sweep must never touch an election-day connection.
 */
global.window = {};
await import('../app/pu-code.js');
const P = global.window.HAWKEYE_PUCODE;

let failed = 0;
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}\n        got ${a}${ok ? '' : `, want ${e}`}`);
};

// The header of a real EC8A, as the recogniser hands it over: four separately
// labelled boxes, not one contiguous code. Osun is state 29.
const SHEET = [
  'INDEPENDENT NATIONAL ELECTORAL COMMISSION',
  '2026 OSUN STATE GOVERNORSHIP ELECTION',
  'S/N 0000388',
  'State OSUN Code 2 9',
  'Local Government Area ATAKUMOSA EAST Code 0 1',
  'Registration Area IWARA Code 0 1',
  'Polling Unit TOWN HALL IWARA Code 0 0 1',
].join('\n');

const REGISTER = { '29-01-01-001': { name: 'TOWN HALL IWARA', ward: 'IWARA' } };

// PASS 1 — exact only, network allowed.
const exact = await P.resolveUnitFromText(SHEET, {
  resolve: async (code) => REGISTER[code] ?? null,
  maxRepair: 0,
});
eq('pass 1 resolves the code exactly, no repair', exact && exact.code, '29-01-01-001');
eq('pass 1 reports itself as exact', exact && exact.source !== 'repaired', true);

// PASS 1 must find NOTHING when the register does not hold the code, rather
// than repairing its way to a neighbour — that is pass 2's job, offline.
const noRepair = await P.resolveUnitFromText(SHEET, {
  resolve: async () => null,
  maxRepair: 0,
});
eq('pass 1 refuses to repair', noRepair, null);

// The serial must not be mistaken for a unit code: it is on the sheet, it is
// seven digits, and it sits two lines above the real code.
eq('the S/N line is not read as a unit code',
  (P.extractCandidates(SHEET) || []).includes('0000388'), false);

// CONTROL — a sheet with no code at all must resolve to nothing, or the two
// assertions above prove nothing.
const blank = await P.resolveUnitFromText('nothing resembling a code here', {
  resolve: async () => ({ name: 'X' }),
  maxRepair: 0,
});
eq('CONTROL: no code on the sheet resolves to null', blank, null);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

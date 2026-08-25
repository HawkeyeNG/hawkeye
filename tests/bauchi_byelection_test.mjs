/**
 * THE BAUCHI BY-ELECTION, AND THE THREE THINGS THAT KEPT IT OFF THE APP.
 *
 * INEC's 19 Sep 2026 table lists four by-elections. Three were in contests.json
 * and Bauchi was not, for reasons that are structural rather than an oversight:
 *
 *  1. It is the only INEC row naming TWO constituencies. The other three are one
 *     seat each and map 1:1 onto a contest.
 *  2. INEC's names do not appear in our seat table at all. "Disina" and "Sakwa"
 *     are PARENTHETICALS: the seats are "Shira I (Disina)" and "Sakwa (Zaki I)".
 *     Gating on INEC's strings would have matched zero register rows and failed
 *     CLOSED — every unit rejected behind an opaque contest_not_applicable.
 *  3. Both seats sit in LGAs that elect TWO state members (Shira II and Azare
 *     are not up for election), and the register does not separate them. Delta's
 *     Udu and Kano's Dawakin Kudu each own their LGA outright.
 *
 * (3) is why `seat` exists on a contest: the gate is an LGA, and an LGA
 * returning two members cannot name either of them. Titling off the gate would
 * have produced "Shira State Constituency" — the name of the SIBLING seat, on a
 * page about a race that seat is not having.
 *
 * TWO CONTESTS, NOT ONE. `code` is identity: it is what /api/national is keyed
 * by and what the ledger partitions a race's subchain on. One shared code would
 * merge two separate seats' results into a single partition, and once anchored
 * that is unrecoverable.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const CONTESTS = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));
const BYE = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/by-elections.json`, 'utf8'));
const SEATS = JSON.parse(fs.readFileSync(`${ROOT}/app/seat_lgas.json`, 'utf8'));

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

console.log('=== every by-election INEC lists has a contest ===');
// The check that would have caught this: the transcription and the catalogue
// must agree on how many races there are, not merely overlap.
const inecSeats = BYE.byElections.flatMap((b) => b.constituencies.map((c) => ({ state: b.state, c })));
const byeContests = CONTESTS.filter((c) => c.tier);
check(`INEC lists ${inecSeats.length} seats across ${BYE.byElections.length} rows`, inecSeats.length, 5);
check('and there is one contest per SEAT, not per row', byeContests.length, inecSeats.length);
for (const st of ['Gombe', 'Bauchi', 'Delta', 'Kano']) {
  const n = byeContests.filter((c) => (c.states || []).includes(st)).length;
  const want = BYE.byElections.find((b) => b.state === st).constituencies.length;
  check(`${st}: ${want} seat(s) -> ${want} contest(s)`, n, want);
}

console.log('\n=== codes are identity: unique, and never shared between seats ===');
const codes = CONTESTS.map((c) => c.code);
check('every contest code is unique', codes.length, new Set(codes).size);
const bauchi = byeContests.filter((c) => (c.states || []).includes('Bauchi'));
check('Bauchi is TWO contests', bauchi.length, 2);
check('with different codes', bauchi[0].code !== bauchi[1].code, true);
check('and different gates', bauchi[0].constituencies[0] !== bauchi[1].constituencies[0], true);

console.log('\n=== the gate matches the register, or it fails closed ===');
// A `constituencies` value is exact string equality against a register column.
// seat_lgas.json is built FROM the register, so its lgas[] are register values.
const lgaValues = new Set(
  Object.values(SEATS.SHA).flatMap((v) => v.lgas || []),
);
for (const c of byeContests.filter((c) => c.tier === 'SHA')) {
  for (const name of c.constituencies) {
    check(`${c.code}: "${name}" is a real register LGA`, lgaValues.has(name), true);
  }
}
// THE CONTROL: INEC's own spelling would NOT have matched, which is the whole
// reason this cannot be copied across from by-elections.json mechanically.
check('control: "Disina" is NOT a register LGA', lgaValues.has('Disina'), false);
check('control: "Sakwa" is NOT a register LGA', lgaValues.has('Sakwa'), false);
check('control: "Dawakin Kudu" (INEC) is NOT one either', lgaValues.has('Dawakin Kudu'), false);

console.log('\n=== the seat named is the seat voting, not its sibling ===');
for (const c of byeContests.filter((c) => c.tier === 'SHA')) {
  const key = `${c.states[0]}|${c.seat}`;
  check(`${c.code} names a real seat (${c.seat})`, !!SEATS.SHA[key], true);
  const info = SEATS.SHA[key];
  if (info) {
    check(`  and it sits in the LGA it gates on`, (info.lgas || [])[0], c.constituencies[0]);
  }
}
// The failure this prevents, stated as itself: Shira LGA holds two seats, and
// the one NOT voting is the one the gate value is named after.
const shiraSeats = Object.entries(SEATS.SHA).filter(([k, v]) => k.startsWith('Bauchi|') && (v.lgas || [])[0] === 'Shira');
check('Shira LGA really does elect two members', shiraSeats.length, 2);
check('and the by-election is for exactly one of them',
  bauchi.filter((c) => c.constituencies[0] === 'Shira').length, 1);
const disina = bauchi.find((c) => c.constituencies[0] === 'Shira');
check('titled Shira I (Disina), not "Shira"', disina.seat, 'Shira I (Disina)');
check('which is NOT the sibling seat', disina.seat !== 'Shira II (Shira)', true);

console.log('\n=== a shared LGA is disclosed, not presented as the seat\'s own ===');
for (const c of bauchi) {
  const info = SEATS.SHA[`${c.states[0]}|${c.seat}`];
  check(`${c.seat} is flagged sharedRegister`, info?.sharedRegister, true);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

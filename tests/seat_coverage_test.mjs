// EVERY SEAT A MAP LINKS TO MUST HAVE A PAGE.
//
// The leaderboard draws 109 senatorial districts and 364 federal constituencies
// and makes each one tappable. Twenty-nine of the federal ones landed on
// "Hawkeye has no page for this race yet" — about seats we hold every fact for.
// The names simply disagreed: the boundary file writes a constituency's LGAs in
// one order, the register in another, so "Abaji/Gwagwalada/Kwali/Kuje" and
// "Kuje/Abaji/Gwagwalada/Kwali" were two strangers to an exact-match lookup.
//
// This walks every region name in the boundary files through the SHIPPED
// resolver — not a copy of the rule — because the copy is what drifts.
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const A = '/home/elrio/hawkeye/app';
const seats = JSON.parse(fs.readFileSync(`${A}/seat_lgas.json`, 'utf8'));
const dgeo = JSON.parse(fs.readFileSync(`${A}/district_geo.json`, 'utf8'));
const cgeo = JSON.parse(fs.readFileSync(`${A}/constituency_geo.json`, 'utf8'));
const political = JSON.parse(fs.readFileSync(`${A}/political_data.json`, 'utf8'));

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// Load race.js as the page loads it.
const sandbox = { window: {}, document: { title: '' }, fetch: async () => ({}), console: { log() {}, warn() {}, error() {} } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${A}/race.js`, 'utf8'), sandbox);
const { seatRace, stateRace } = sandbox.window;

const names = (g) => (g.regions || []).map((r) => r.name).filter(Boolean);
const dNames = names(dgeo), cNames = names(cgeo);
const contest = { date: '2027-01-16', states: [] };

console.log('=== every map region reaches a page ===');
const senDead = dNames.filter((n) => !seatRace(seats, 'SEN', n, contest));
const repDead = cNames.filter((n) => !seatRace(seats, 'REP', n, contest));
check(`all ${dNames.length} senatorial regions resolve`, senDead, []);
check(`all ${cNames.length} federal regions resolve`, repDead, []);

console.log('\n=== the reported dead end ===');
// Both spellings must reach the SAME seat — one of them is what the map links.
const a = seatRace(seats, 'REP', 'Abaji/Gwagwalada/Kwali/Kuje', contest);
const b = seatRace(seats, 'REP', 'Kuje/Abaji/Gwagwalada/Kwali', contest);
check('the map spelling resolves', !!a, true);
check('the register spelling resolves', !!b, true);
check('and both reach one seat', a?.office, b?.office);
check('with real figures behind it', a?.stats?.lgas > 0 && a?.stats?.pollingUnits > 0, true);

console.log('\n=== order and punctuation must not matter ===');
for (const [label, one, two] of [
  ['LGA order', 'Guma/Makurdi', 'Makurdi/Guma'],
  ['hyphens', 'Ovia North East/Ovia South West', 'Ovia South-West/Ovia North-East'],
  ['stray spaces', 'Umuahia North/ Umuahia South/Ikwuano', 'Ikwuano/Umuahia North/Umuahia South'],
  ['a short name vs its LGA list', 'Warri', 'Warri North/Warri South/Warri South West'],
]) {
  const x = seatRace(seats, 'REP', one, contest), y = seatRace(seats, 'REP', two, contest);
  check(`${label}: both spellings reach one seat`, !!x && x?.office === y?.office, true);
}

console.log('\n=== a name that identifies nothing gets NO page ===');
// Guessing is worse than the absence message: it sends a reader to another
// seat's figures under the name they asked for.
for (const bogus of ['', 'Atlantis', 'Nowhere/Nothing', 'Lagos']) {
  check(`"${bogus}" builds no page`, seatRace(seats, 'REP', bogus, contest), null);
}

console.log('\n=== seats the register cannot separate say so ===');
const shared = Object.entries(seats.REP).filter(([, v]) => v.sharedRegister);
check('some exist (the Lagos double seats)', shared.length > 0, true);
check('they come in pairs', shared.length % 2, 0);
const one = seatRace(seats, 'REP', shared[0][0], contest);
check('and the page states the figures cover both', one?.note,
  (t) => /does not separate this seat/i.test(t || ''));

console.log('\n=== governorships ===');
const states = Object.keys(political.stateStats || {});
const govDead = states.filter((s) => !/^fct$/i.test(s) && !stateRace(political, s, contest));
check(`all ${states.length - 1} governorships resolve`, govDead, []);
// The FCT has a minister, not a governor. It is in every state-shaped dataset,
// so it has to be excluded deliberately at both ends.
check('and the FCT still builds none', stateRace(political, 'FCT', contest), null);

console.log('\n=== native uses the same rule ===');
const nat = fs.readFileSync('/home/elrio/hawkeye/native/src/lib/political.ts', 'utf8');
check('native has matchSeatName', /function matchSeatName/.test(nat), true);
check('and its third tier reads the seat LGA list', /table\[k\] as \{ lgas\?: string\[\] \}/.test(nat), true);
check('and it declares sharedRegister', /sharedRegister\?: boolean/.test(nat), true);

console.log(fail ? `\n${fail} check(s) failed` : '\nall passed');
process.exit(fail ? 1 : 0);

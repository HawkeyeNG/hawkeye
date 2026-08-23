/**
 * THE TWO CLIENTS MUST BUILD THE SAME RACE.
 *
 * app/race.js and native/src/lib/political.ts are twins by intent and by
 * comment, and nothing has ever checked that they still are. They drifted:
 * native had no `byElectionRace` at all, its `seatRace` took no tier so every
 * by-election resolved to nothing, its `RaceJoin` had no `'lga'` level so a
 * state constituency could not typecheck, and its stat block had no `wards` —
 * so the app showed "1 LGAs" where the site showed a ward count.
 *
 * The check is not "does native have a function of that name". It runs BOTH
 * shipped implementations over the REAL seat table and compares the objects
 * they return, field by field, on every seat in the country. A copy of the rule
 * would pass a copy-shaped test; only the real pair can disagree.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/native/`);
const { transform } = require_('sucrase');

const seats = JSON.parse(fs.readFileSync(`${ROOT}/app/seat_lgas.json`, 'utf8'));
const political = JSON.parse(fs.readFileSync(`${ROOT}/app/political_data.json`, 'utf8'));
const contests = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- the WEB implementation, loaded the way race.html loads it ----------
const sandbox = {
  window: {},
  document: { title: '' },
  fetch: async () => ({}),
  console: { log() {}, warn() {}, error() {} },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${ROOT}/app/race.js`, 'utf8'), sandbox);
const web = sandbox.window;

// ---- the NATIVE implementation, transpiled from the shipped source ------
const SRC = `${ROOT}/native/src/lib/political.ts`;
const code = transform(fs.readFileSync(SRC, 'utf8'), {
  transforms: ['typescript', 'imports'],
  filePath: SRC,
}).code;
const module_ = { exports: {} };
new Function('require', 'module', 'exports', 'process', code)(
  () => ({}), module_, module_.exports, { env: {} },
);
const rn = module_.exports;

console.log('=== both sides export the same builders ===');
for (const fn of ['seatRace', 'byElectionRace', 'assemblyRace', 'assemblySeats', 'assemblySeatsInLga', 'shaStats', 'stateRace', 'seatFieldOf', 'wholeFieldOf']) {
  check(`native exports ${fn}`, typeof rn[fn], 'function');
  check(`web exports ${fn}`, typeof web[fn], 'function');
}

/**
 * Compare only what a screen renders. `note` is deliberately included: the
 * shared-register caveat is the difference between a figure that describes this
 * seat and one that describes the LGA, and a client that dropped it would be
 * printing a number it cannot support.
 */
const shape = (r) =>
  r && {
    office: r.office,
    election: r.election,
    date: r.date ?? null,
    stats: r.stats ?? null,
    note: r.note ?? null,
    join: r.join ?? null,
  };
const same = (a, b) => JSON.stringify(shape(a)) === JSON.stringify(shape(b));

const CONTEST = { code: 'SEN', name: 'Senate', date: '2027-02-27', states: [] };

console.log('\n=== every SEN and REP seat, both clients ===');
for (const tier of ['SEN', 'REP']) {
  const names = Object.keys(seats[tier]);
  const def = { ...CONTEST, code: tier };
  const bad = names.filter((n) => !same(web.seatRace(seats, tier, n, def), rn.seatRace(seats, tier, n, def)));
  check(`all ${names.length} ${tier} seats agree`, bad.slice(0, 4), []);
  // And they are not agreeing on null.
  const nulls = names.filter((n) => !rn.seatRace(seats, tier, n, def));
  check(`all ${names.length} ${tier} seats actually build`, nulls.slice(0, 4), []);
}

console.log('\n=== every state constituency, both clients ===');
{
  const keys = Object.keys(seats.SHA);
  const def = { code: 'SHA', name: 'State Assembly', date: '2027-03-13' };
  const bad = [];
  const nulls = [];
  for (const k of keys) {
    const [state, seat] = [seats.SHA[k].state, seats.SHA[k].seat];
    const a = web.assemblyRace(seats, state, seat, def);
    const b = rn.assemblyRace(seats, state, seat, def);
    if (!b) nulls.push(k);
    else if (!same(a, b)) bad.push(k);
  }
  check(`all ${keys.length} SHA seats agree`, bad.slice(0, 4), []);
  check(`all ${keys.length} SHA seats build`, nulls.slice(0, 4), []);
}

console.log('\n=== wards, not "1 LGAs" — the reason the block exists ===');
{
  const def = { code: 'SHA', name: 'State Assembly' };
  const r = rn.assemblyRace(seats, 'Bayelsa', 'Brass II', def);
  check('a state seat is measured in wards', r?.stats?.wards > 0, true);
  check("and the join is the backend's own level", r?.join?.level, 'lga');
  check('a shared LGA says so in the note', /more than one state member/.test(r?.note ?? ''), true);
  const sen = rn.seatRace(seats, 'SEN', 'Abia Central', { ...CONTEST });
  check('a senatorial seat carries wards too', sen?.stats?.wards > 0, true);
}

console.log('\n=== by-elections: the tier is the category, the code is identity ===');
for (const def of contests.filter((c) => c.tier)) {
  const a = web.byElectionRace(def, seats, political);
  const b = rn.byElectionRace(def, seats, political);
  check(`${def.code} builds on both`, !!a && !!b, true);
  check(`${def.code} agrees field for field`, same(a, b), true);
  // The whole point: the page is filed under the BY-ELECTION's code, never the
  // general election's — `join.contest` is the ledger's race partition.
  check(`${def.code} keeps its own contest code`, b?.join?.contest, def.code);
  check(`${def.code} is not filed under ${def.tier}`, b?.join?.contest !== def.tier, true);
  /**
   * REAL FIGURES ON THE ONE PAGE MOST LIKELY TO BE READ.
   *
   * A by-election's `constituencies` entry is an LGA name — that is the level
   * the backend buckets a state-assembly contest by. Kano's is "Dawaki Kudu"
   * while the seat is "Dawakin Kudu", so a seat-name lookup missed and BOTH
   * clients printed `1 LGAs` and nothing else. The card is four facts; three of
   * them were absent from a live race.
   */
  check(`${def.code} carries a real ward count`, b?.stats?.wards > 0, true);
  check(`${def.code} carries a real unit count`, b?.stats?.pollingUnits > 0, true);
}

console.log('\n=== the LGA a board hands over resolves to seats, not a guess ===');
{
  // Southern Ijaw elects four. Offering one of them would be a page about a race
  // the reader did not tap on.
  const four = rn.assemblySeatsInLga(seats, 'Bayelsa', 'Southern Ijaw');
  check('Southern Ijaw returns every seat on it', four.length, 4);
  check('and the web twin returns the same', web.assemblySeatsInLga(seats, 'Bayelsa', 'Southern Ijaw').length, 4);
  check(
    'the same seats, in the same order',
    four.map((s) => s.seat),
    web.assemblySeatsInLga(seats, 'Bayelsa', 'Southern Ijaw').map((s) => s.seat),
  );
  // A whole state's picker.
  const all = rn.assemblySeats(seats, 'Bayelsa');
  check('Bayelsa lists all 24 constituencies', all.length, 24);
  check('web agrees', web.assemblySeats(seats, 'Bayelsa').length, all.length);
}

console.log('\n=== the candidate-layout rule agrees on both clients ===');
/**
 * A seat lists its field; a region profiles it. The two RENDERERS cannot be
 * compared — one builds template strings, the other JSX — so the decision is a
 * function on each side and THAT is what is held against itself here.
 *
 * Every seat in the country is checked, plus the region shapes that must NOT
 * take the seat treatment.
 */
{
  const cases = [];
  const def = { ...CONTEST };
  for (const tier of ['SEN', 'REP']) {
    for (const n of Object.keys(seats[tier])) cases.push([`${tier} ${n}`, rn.seatRace(seats, tier, n, { ...def, code: tier }, tier)]);
  }
  for (const k of Object.keys(seats.SHA)) {
    const s = seats.SHA[k];
    cases.push([`SHA ${k}`, rn.assemblyRace(seats, s.state, s.seat, { code: 'SHA', name: 'SHA' })]);
  }
  for (const d of contests.filter((c) => c.tier)) cases.push([d.code, rn.byElectionRace(d, seats, political)]);
  cases.push(['GOV Kano', rn.stateRace(political, 'Kano', { code: 'GOV', name: 'Governorship', states: ['Kano'] })]);
  cases.push(['GOV Osun (written)', political.raceOsun2026]);
  cases.push(['PRES 2027 (no join)', political.race2027]);

  const disagree = cases.filter(([, r]) => web.seatFieldOf(r) !== rn.seatFieldOf(r)).map(([n]) => n);
  check(`all ${cases.length} races agree on seat-vs-region`, disagree.slice(0, 4), []);

  // And the answer is RIGHT, not merely identical — two clients can agree on a
  // wrong rule. Named cases, from both sides of the line.
  const by = Object.fromEntries(cases);
  check('a senatorial seat lists', rn.seatFieldOf(by['SEN Abia Central']), true);
  check('a federal seat lists', rn.seatFieldOf(by['REP Aba North/Aba South']), true);
  check('a state constituency lists', rn.seatFieldOf(by['SHA Bayelsa|Brass II']), true);
  check('a REP by-election lists', rn.seatFieldOf(by.REP_BYE_GOMBE_2026), true);
  check('a governorship PROFILES', rn.seatFieldOf(by['GOV Kano']), false);
  check('the written Osun race PROFILES', rn.seatFieldOf(by['GOV Osun (written)']), false);
  check('the presidency PROFILES', rn.seatFieldOf(by['PRES 2027 (no join)']), false);

  // The merged list: same names, same order, on both sides — including the
  // three-shape case a real seat will have once INEC publishes.
  const withField = {
    ...by['SEN Abia Central'],
    candidates: [{ name: 'Ada Nwosu', party: 'LP', incumbent: true }],
    others: [{ name: 'Bello Musa', party: 'APC' }, { name: 'Chidi Eze', party: 'PDP' }],
    minors: [{ name: 'Dele Okon', party: 'SDP', meta: 'SDP · running mate' }],
  };
  check(
    'candidates + others + minors merge identically',
    rn.wholeFieldOf(withField).map((c) => `${c.party}:${c.name}`),
    web.wholeFieldOf(withField).map((c) => `${c.party}:${c.name}`),
  );
  check('and merge ALL THREE shapes, sorted by party',
    rn.wholeFieldOf(withField).map((c) => c.party), ['APC', 'LP', 'PDP', 'SDP']);
  check('an empty field merges to nothing', rn.wholeFieldOf(by['SEN Abia Central']).length, 0);
}

console.log('\n=== controls: these must FAIL to resolve ===');
{
  const def = { ...CONTEST };
  check('an invented senatorial seat builds nothing', rn.seatRace(seats, 'SEN', 'Atlantis North', def), null);
  check('an invented state constituency builds nothing', rn.assemblyRace(seats, 'Bayelsa', 'Atlantis IV', def), null);
  check('an invented state has no constituencies', rn.assemblySeats(seats, 'Atlantis').length, 0);
  check('an LGA with no seat on it returns none', rn.assemblySeatsInLga(seats, 'Bayelsa', 'Ikeja').length, 0);
  // And the comparison itself can tell two races apart — a `same()` that always
  // returned true would have passed every assertion above.
  check(
    'the comparator can see a difference',
    same(rn.seatRace(seats, 'SEN', 'Abia Central', def), rn.seatRace(seats, 'SEN', 'Abia North', def)),
    false,
  );
}

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

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
/**
 * ENOUGH DOM FOR race.js TO FINISH LOADING, and no more.
 *
 * This test went red the day race.js grew a page-level click listener for the
 * ward maps: the stub `document` had no addEventListener, the whole file threw
 * on load, and the ONE test that holds web and native in step reported a
 * TypeError instead of a comparison. A parity test that cannot load one of the
 * two implementations is not testing parity - so the stub grows with the file.
 *
 * Deliberately inert rather than a real DOM: nothing here is under test, the
 * race BUILDERS are, and they touch none of it.
 */
const sandbox = {
  window: {},
  document: {
    title: '',
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      style: {}, classList: { add() {}, remove() {} }, setAttribute() {},
      appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
  },
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
/**
 * THE i18n STUB HAS TO BE REAL, because `note` is what this test compares.
 *
 * `require` used to return `{}` for everything, which was fine while political.ts
 * imported nothing. It imports `t` now, so every builder threw the moment it
 * reached its first translated string and this file died before its first
 * comparison. Returning an EMPTY `t` would be worse than throwing: every note
 * would collapse to '' on the native side and to the English sentence on the
 * web side, and the test would report a parity failure that is really a stub
 * failure.
 *
 * So `t` reads native's own en.json - the strings the app actually ships in
 * English - and interpolates {v0}, {v1} the way lib/i18n does.
 */
const nativeEn = JSON.parse(fs.readFileSync(`${ROOT}/native/src/lib/i18n/en.json`, 'utf8'));
const stubT = (key, vars) => {
  const raw = nativeEn[key];
  if (raw === undefined) throw new Error(`native en.json has no key ${key} - add it, do not fall back`);
  return String(raw).replace(/\{(v\d+)\}/g, (_, v) => String((vars || {})[v] ?? ''));
};
const module_ = { exports: {} };
new Function('require', 'module', 'exports', 'process', code)(
  () => ({ t: stubT, currentLang_: () => 'en' }), module_, module_.exports, { env: {} },
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
    /**
     * THE BALLOT IS COMPARED TOO. It is the newest thing both clients build and
     * the only one read off the contest catalogue rather than the register, so
     * it is exactly where they can drift: a client that dropped `fieldLabel`
     * would print six parties under the heading "Declared candidates", and one
     * that dropped the field would show an empty ballot on a race that has one.
     */
    fieldLabel: r.fieldLabel ?? null,
    field: (r.candidates ?? []).map((c) => [c.name, c.party, c.meta ?? null]),
    asOf: r.asOf ?? null,
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

/**
 * THE BALLOT, ASSERTED - not merely agreed on.
 *
 * Parity says the two clients build the same thing; it cannot say the thing is
 * right. These check the three states a by-election ballot can be in, each with
 * the others as its control: published names, published parties without names,
 * and nothing published at all. Without the third, a bug that showed every seat
 * a ballot would pass the first two.
 */
console.log('\n=== the by-election ballot: names, parties, or neither ===');
{
  const of = (code) => contests.find((c) => c.code === code);
  const race = (code) => rn.byElectionRace(of(code), seats, political);

  const gombe = race('REP_BYE_GOMBE_2026');
  check('Gombe lists four candidates', (gombe?.candidates ?? []).length, 4);
  check('Gombe is labelled candidates', gombe?.fieldLabel, 'candidates');
  check('Gombe carries every party', (gombe?.candidates ?? []).map((c) => c.party).sort(),
    ['APC', 'APM', 'APP', 'NNPP']);
  check('Gombe names no candidate twice',
    new Set((gombe?.candidates ?? []).map((c) => c.name)).size, 4);
  check('Gombe says where the list came from', /Secretary to the Commission/.test(gombe?.note ?? ''), true);
  check('Gombe does NOT say the list is missing',
    /has not published the candidate list/.test(gombe?.note ?? ''), false);

  const kano = race('SHA_BYE_KANO_DAWAKINKUDU_2026');
  check('Dawakin Kudu lists six parties', (kano?.candidates ?? []).length, 6);
  check('Dawakin Kudu is labelled parties', kano?.fieldLabel, 'parties');
  check('Dawakin Kudu says the names are not published',
    (kano?.candidates ?? []).every((c) => c.meta === 'Candidate name not published'), true);
  check('Dawakin Kudu keeps the party CODE as the join key, not the long name',
    (kano?.candidates ?? []).map((c) => c.party).sort(), ['ADP', 'APC', 'APP', 'LP', 'PDP', 'PRP']);
  check('Dawakin Kudu points the reader at the notice',
    /notice posted at your polling/.test(kano?.note ?? ''), true);

  // THE CONTROL. Three of the five seats have no published ballot at all, and
  // their pages must still say so in the old words.
  for (const code of ['SHA_BYE_DELTA_UDU_2026', 'SHA_BYE_BAUCHI_SAKWA_2026', 'SHA_BYE_BAUCHI_DISINA_2026']) {
    const r = race(code);
    check(`${code} shows no ballot`, (r?.candidates ?? []).length, 0);
    check(`${code} still says the list is missing`,
      /INEC has not published the candidate list for this by-election yet/.test(r?.note ?? ''), true);
  }

  // A GENERAL contest must never take a by-election's ballot: it covers 360
  // seats and the ballot belongs to one.
  const general = contests.find((c) => c.code === 'REP');
  check('the general REP contest carries no ballot', rn.contestBallot(general, 'race').field.length, 0);
  check('a by-election ballot needs constituencies to apply',
    rn.contestBallot({ ...of('REP_BYE_GOMBE_2026'), constituencies: [] }, 'race').field.length, 0);
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
  // A GOVERNORSHIP LISTS TOO, since 2026-08-24. It used to take the presidential
  // treatment — front-runner cards and a quick-compare table — with nothing to
  // fill them: no running mate, no home base, no prose, so five columns of "—".
  check('a governorship lists', rn.seatFieldOf(by['GOV Kano']), true);
  check('the written Osun race lists', rn.seatFieldOf(by['GOV Osun (written)']), true);
  // THE PRESIDENCY IS THE ONLY ONE LEFT PROFILING, which is now the whole rule
  // — so this case is what stops it collapsing into "always true".
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

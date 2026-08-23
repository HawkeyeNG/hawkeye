// Render app/race.js offline and assert both the unchanged and the new cases.
// The Osun page is LIVE mid-election, so this must not touch production: the
// script is injected into a blank page with the real data files.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';

const RACE_JS = fs.readFileSync('/home/elrio/hawkeye/app/race.js', 'utf8');
const POLITICAL = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/app/political_data.json', 'utf8'));
// A COMMITTED FIXTURE, not the generator's scratch output. This read
// /tmp/races_out/, which does not survive a reboot, and the test died on ENOENT
// without ever exercising the code it exists to check. Regenerate with
// tests/fixtures/make_sen_fixture.py; the shape is copied from the generator's
// own emit block.
const SENATE = JSON.parse(fs.readFileSync(
  '/home/elrio/hawkeye/tests/fixtures/sen-ebonyi-south.json', 'utf8'));

const b = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});
const p = await b.newPage();
await p.setContent('<main id="m"></main>');
await p.addScriptTag({ content: RACE_JS });

const render = (race, opts) => p.evaluate(([r, o]) => {
  const m = document.getElementById('m');
  m.innerHTML = '';
  window.mountRace(m, r, {}, o || {});
  return {
    h1: m.querySelector('h1')?.textContent,
    headings: [...m.querySelectorAll('h2')].map((h) => h.textContent),
    cards: m.querySelectorAll('.cand').length,
    compareRows: m.querySelectorAll('.race-compare tbody tr').length,
    ballotRows: m.querySelectorAll('.ballot .b').length,
    // The NAMES, not just the count — a section printed twice is the failure
    // mode the seat rule can produce, and two lists of four look like one list
    // of eight only if you read the names.
    ballotNames: [...m.querySelectorAll('.ballot .b strong')].map((e) => e.textContent),
    // `> div > span`, not `.b span`: with no logo map, flagIcon emits its own
    // <span class="fallback"> as a direct child of .b, so the looser selector
    // returned two spans per row and read as eight candidates where there are
    // four.
    ballotSubs: [...m.querySelectorAll('.ballot .b > div > span')].map((e) => e.textContent),
    statCells: [...m.querySelectorAll('.race-statbar .l')].map((e) => e.textContent),
    statValues: [...m.querySelectorAll('.race-statbar .n')].map((e) => e.textContent),
  };
}, [race, opts]);

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};

console.log('=== Osun 2026 — the LIVE page, must be unchanged ===');
const osun = await render(POLITICAL.raceOsun2026, { compare: false });
check('title still carries 2026', osun.h1, 'Governor of Osun State — 2026');
check('3 front-runner cards', osun.cards, 3);
// 'Declared result' leads now: a finished race says who won before it lists who
// stood. It is a SECTION name, not the winner's name — an <h2> reading "Ademola
// Adeleke" would put a person in the page outline where a section belongs, and
// would read as Hawkeye announcing him rather than recording INEC's declaration.
check('headings, declaration first', osun.headings, ['Declared result', 'Front-runners', 'Full ballot — 14 candidates', 'Quick compare']);
check('compare table has its 3 rows', osun.compareRows, 3);
check('full ballot 14', osun.ballotRows, 14);

console.log('\n=== Presidency 2027 ===');
// This object carries no `office`, so the title falls back to `election` — the
// year fix does not apply to it and must not corrupt it.
const pres = await render(POLITICAL.race2027, { compare: true });
check('title falls back to election, unharmed', pres.h1, POLITICAL.race2027.election);

console.log('\n=== Generated Senate race — down-ballot, candidates[] empty ===');
// Expectations read off the file, not guessed: it was generated with
// --cycle 2023 against INEC's 2022 list, so 2023 IS the right year to print.
const senYear = String(SENATE.dateText);
const senCount = SENATE.others.length;
const sen = await render(SENATE, {});
check(`title derives ${senYear} from dateText`, sen.h1, `${SENATE.office} — ${senYear}`);
// ONE SECTION ON A SEAT. The presidency and a governorship are read as a
// contest between named people and keep cards + full ballot + quick compare; a
// seat's field is a list of names with no prose to profile, so it gets a single
// "Declared candidates" list in the compact format. See race.js:seatField.
check('a seat gets one heading', sen.headings, ['Declared candidates']);
check('no empty candidate cards', sen.cards, 0);
check('no empty compare rows', sen.compareRows, 0);
check('every name is listed', sen.ballotRows, senCount);
check('and listed exactly once', new Set(sen.ballotNames).size, senCount);
check('stat bar keeps LGAs + polling units', sen.statCells, ['Election year', 'Candidates', 'LGAs', 'Polling units']);

console.log('\n=== A seat WITH a published field — the case this rule is for ===');
// Nothing in the repo exercises this: no seat has candidate data yet, so the
// restructure is invisible until INEC publishes and then it is everywhere at
// once. Synthetic, and deliberately carrying ALL THREE shapes — candidates,
// others and minors — because a seat merges them and a region does not.
const seatWithField = {
  ...SENATE,
  candidates: [
    { name: 'Ada Nwosu', party: 'LP', home: 'Ivo', bids: '1st bid', status: 'Nominee', incumbent: true },
  ],
  others: [{ name: 'Bello Musa', party: 'APC' }, { name: 'Chidi Eze', party: 'PDP' }],
  minors: [{ name: 'Dele Okon', party: 'SDP', meta: 'SDP · running mate N. Bala' }],
};
const seatFull = await render(seatWithField, {});
check('still one heading', seatFull.headings, ['Declared candidates']);
check('no front-runner cards on a seat', seatFull.cards, 0);
check('no quick compare on a seat', seatFull.compareRows, 0);
check('all four names, merged', seatFull.ballotRows, 4);
check('sorted by party', seatFull.ballotNames, ['Bello Musa', 'Ada Nwosu', 'Chidi Eze', 'Dele Okon']);
check('nobody listed twice', new Set(seatFull.ballotNames).size, 4);
// The sub-line: a minor's own `meta` wins, otherwise party (+ incumbent).
check('sub-lines carry party or meta', seatFull.ballotSubs,
  ['APC', 'LP · incumbent', 'PDP', 'SDP · running mate N. Bala']);
// The card must agree with the list directly beneath it. The old expression
// added `others || minors` and would have said 3 where the list shows 4.
check('the count matches the list', seatFull.statValues[1], '4');

console.log('\n=== A state constituency (level lga) follows the same rule ===');
const sha = await render({
  ...seatWithField,
  office: 'Southern Ijaw II State Constituency',
  stats: { lgas: 1, wards: 17, pollingUnits: 466 },
  join: { contest: 'SHA', level: 'lga', value: 'Southern Ijaw', state: 'Bayelsa', lgas: ['Southern Ijaw'] },
}, {});
check('one heading', sha.headings, ['Declared candidates']);
check('no cards', sha.cards, 0);
check('measured in wards', sha.statCells, ['Election year', 'Candidates', 'Wards', 'Polling units']);

console.log('\n=== CONTROL: a governorship keeps all four sections ===');
// If seatField ever went true for a region, this is what would catch it.
const gov = await render(POLITICAL.raceOsun2026, {});
check('governorship still has its cards', gov.cards, 3);
check('and its compare table', gov.compareRows, 3);
check('and both headings', gov.headings.includes('Front-runners')
  && gov.headings.some((h) => h.startsWith('Full ballot')), true);

console.log('\n=== CONTROL: the presidency keeps "Other declared candidates" ===');
const pres2 = await render(POLITICAL.race2027, {});
check('presidency keeps its minors heading',
  pres2.headings.includes('Other declared candidates'), true);
check('and its front-runner cards', pres2.cards, POLITICAL.race2027.candidates.length);
check('and its compare rows', pres2.compareRows, POLITICAL.race2027.candidates.length);

await b.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

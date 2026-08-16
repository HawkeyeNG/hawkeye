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
    statCells: [...m.querySelectorAll('.race-statbar .l')].map((e) => e.textContent),
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
check('headings unchanged', osun.headings, ['Front-runners', 'Full ballot — 14 candidates', 'Quick compare']);
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
check('no empty Front-runners / Quick compare', sen.headings, [`Full ballot — ${senCount} candidates`]);
check('no empty candidate cards', sen.cards, 0);
check('no empty compare rows', sen.compareRows, 0);
check('full ballot rendered', sen.ballotRows, senCount);
check('stat bar keeps LGAs + polling units', sen.statCells, ['Election year', 'Candidates', 'LGAs', 'Polling units']);

await b.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

// Render app/race.js offline and assert the race map behaves at each branch.
// Serves the real app/ over http so relative fetches (lga_geo.json etc.) resolve
// exactly as they do in production, without touching production.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sqlite3 from 'node:sqlite';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html' };
const server = http.createServer((req, res) => {
  const f = path.join(APP, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// Real seats, with their LGA members taken from the register.
const db = new sqlite3.DatabaseSync('/home/elrio/hawkeye/backend/storage/hawkeye.db', { readOnly: true });
const lgasOf = (col, v) => db.prepare(
  `SELECT DISTINCT lga FROM polling_units WHERE ${col} = ? AND lga IS NOT NULL ORDER BY lga`).all(v).map((r) => r.lga);
const senName = db.prepare("SELECT senatorial v, state s FROM polling_units WHERE senatorial='Ebonyi South' LIMIT 1").get();

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage();
await p.goto(`${base}/race.html`, { waitUntil: 'domcontentloaded' });
await p.addScriptTag({ url: '/race.js' });

const render = (race) => p.evaluate(async (r) => {
  const m = document.getElementById('race-main') || document.querySelector('main');
  m.innerHTML = '';
  window.mountRace(m, r, {}, {});
  for (let i = 0; i < 60 && !m.querySelector('.race-map') && m.querySelector('#race-map-slot'); i++) {
    await new Promise((z) => setTimeout(z, 100));
  }
  const svg = m.querySelector('.race-map');
  return {
    hasMap: !!svg,
    shapes: svg ? svg.querySelectorAll('path').length : 0,
    viewBox: svg ? svg.getAttribute('viewBox') : null,
    slotLeft: !!m.querySelector('#race-map-slot'),
    titles: svg ? [...svg.querySelectorAll('title')].slice(0, 3).map((t) => t.textContent) : [],
  };
}, race);

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`);
};

const base_ = { election: '2027', dateText: '2027', candidates: [], others: [{ name: 'A B', party: 'APC' }] };

console.log('=== senatorial: cut from LGA polygons ===');
const senLgas = lgasOf('senatorial', 'Ebonyi South');
const sen = await render({ ...base_, office: 'Senator — Ebonyi South',
  join: { level: 'senatorial', value: 'Ebonyi South', state: senName.s, lgas: senLgas } });
check(`map drawn (${senLgas.length} LGAs expected)`, sen.hasMap, true);
check('one path per LGA', sen.shapes, senLgas.length);
check('viewBox is fitted, not the national one', sen.viewBox, (v) => v && v !== '0 0 800 660');
console.log(`      LGAs: ${senLgas.join(', ')}`);
console.log(`      titles: ${sen.titles.join(', ')}`);

console.log('\n=== federal that SPLITS an LGA: outline fallback ===');
const split = await render({ ...base_, office: 'House — Lagos Island I',
  join: { level: 'federal_constituency', value: 'Lagos Island I', state: 'Lagos', lgas: [] } });
check('falls back to the seat outline', split.hasMap, true);
check('single shape, not an LGA cut', split.shapes, 1);

console.log('\n=== a seat with no geometry at all ===');
const none = await render({ ...base_, office: 'House — Nowhere',
  join: { level: 'federal_constituency', value: 'Not A Real Seat', state: 'Lagos', lgas: [] } });
check('no map, and the empty slot is removed', none.hasMap || none.slotLeft, false);

const POL = JSON.parse(fs.readFileSync(`${APP}/political_data.json`, 'utf8'));

console.log('\n=== governorship: the state, cut into its LGAs ===');
const osun = await render(POL.raceOsun2026);
check('Osun draws a map', osun.hasMap, true);
check('one path per Osun LGA (30)', osun.shapes, 30);
check('viewBox is cropped to Osun', osun.viewBox, (v) => v && v !== '0 0 800 660');

console.log('\n=== a generated state page: every state, no data written per state ===');
// The point of the state branch: 36 states + FCT all draw from lga_geo's own
// keys, so this is the whole feature under test at once rather than a spot check.
const govContest = JSON.parse(fs.readFileSync(
  '/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8')).find((c) => c.code === 'GOV');
// FCT is in stateStats (it has LGAs and polling units) but has no governor, so
// it is excluded here and asserted separately below.
const expectLgas = Object.fromEntries(Object.entries(POL.stateStats)
  .filter(([k]) => k !== 'FCT').map(([k, v]) => [k, v.lgas]));
const sweep = await p.evaluate(async ([pol, contest, want]) => {
  const out = [];
  for (const state of Object.keys(want)) {
    const race = window.stateRace(pol, state, contest);
    const m = document.getElementById('race-main') || document.querySelector('main');
    m.innerHTML = '';
    window.mountRace(m, race, {}, {});
    for (let i = 0; i < 60 && !m.querySelector('.race-map') && m.querySelector('#race-map-slot'); i++) {
      await new Promise((z) => setTimeout(z, 50));
    }
    const svg = m.querySelector('.race-map');
    out.push({ state, shapes: svg ? svg.querySelectorAll('path').length : 0, dated: !!race.date });
  }
  return out;
}, [POL, govContest, expectLgas]);
const wrong = sweep.filter((s) => s.shapes !== expectLgas[s.state]);
check(`all ${sweep.length} states draw their own LGA count`, wrong.length, 0);
if (wrong.length) console.log('      ', wrong.slice(0, 6));
// Osun resolves to its WRITTEN race, which carries a date of its own; the other
// eight off-cycle states have none, and must not borrow the general-election one.
const dated = sweep.filter((s) => s.dated).map((s) => s.state);
check('only the 28 in-cycle states + Osun are dated', dated.length, 29);
check('Anambra (off-cycle) carries no date', dated.includes('Anambra'), false);
check('Kano (in-cycle) is dated', dated.includes('Kano'), true);

console.log('\n=== the guards ===');
const guards = await p.evaluate((pol) => ({
  unknown: window.stateRace(pol, 'Wakanda', null),
  injected: window.stateRace(pol, '<img src=x onerror=alert(1)>', null),
  fct: window.stateRace(pol, 'FCT', null),
  fctGeoSpelling: window.stateRace(pol, 'Fct', null),
  osunKey: (window.findRace(pol, 'GOV', 'Osun') || {}).key,
  osunLower: (window.findRace(pol, 'GOV', 'osun') || {}).key,
  senate: window.findRace(pol, 'SEN', 'Osun Central'),
}), POL);
check('an unknown state builds no page', guards.unknown, null);
check('a query-string injection builds no page', guards.injected, null);
check('the FCT gets no governorship page', guards.fct, null);
check('nor under the geo files\' spelling', guards.fctGeoSpelling, null);
check('GOV/Osun resolves to the written race', guards.osunKey, 'raceOsun2026');
check('region match is case-insensitive', guards.osunLower, 'raceOsun2026');
check('a contest with no pages resolves to nothing', guards.senate, null);

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

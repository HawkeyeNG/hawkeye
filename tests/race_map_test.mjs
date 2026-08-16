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

console.log('\n=== Osun 2026 (no join block) must be untouched ===');
const osun = JSON.parse(fs.readFileSync(`${APP}/political_data.json`, 'utf8')).raceOsun2026;
const o = await render(osun);
check('no map slot left behind', o.slotLeft, false);
check('no map (race carries no join)', o.hasMap, false);

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

// Clicking a region of the leaderboard map must reach that region's race page.
//
// Serves the real app/ with a stubbed API, so the board renders exactly as it
// does in production without a backend. Asserts the whole path a reader takes:
// click a state -> the caption offers its race -> the link resolves to a page
// that actually exists.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));

// A board with one reporting state, so both the reported and the silent branch
// of the caption are exercised by the same run.
const board = (contest, level, regions) => ({
  contest, level, scope: null, subunits: [], updatedAt: Date.now(),
  unitsReporting: 0, inDispute: 0,
  national: [{ party: 'APC', votes: 900 }, { party: 'PDP', votes: 700 }],
  regions,
});
const BOARDS = {
  GOV: board('GOV', 'state', [{ region: 'Kano', leader: 'APC', leaders: ['APC'], votes: { APC: 900 }, unitsReporting: 3, unitsVerified: 1 }]),
  SEN: board('SEN', 'senatorial', [{ region: 'Ebonyi South', leader: 'PDP', leaders: ['PDP'], votes: { PDP: 700 }, unitsReporting: 2, unitsVerified: 0 }]),
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: c.date })));
  if (url.startsWith('/api/national/')) return json(BOARDS[url.split('/').pop()] || board('X', 'state', []));
  if (url.startsWith('/api/coverage/')) return json({ missing: [] });
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 900, height: 1000 } });

/** Click the shape whose tooltip names `region`, and report what the caption says. */
const clickRegion = async (region) => p.evaluate((r) => {
  const paths = [...document.querySelectorAll('#map path')];
  const hit = paths.find((x) => (x.querySelector('title')?.textContent || '').split(':')[0].trim() === r);
  if (!hit) return { found: false };
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const info = document.getElementById('map-info');
  const a = info.querySelector('a');
  return { found: true, text: info.textContent, href: a ? a.getAttribute('href') : null, hidden: info.hidden };
}, region);

console.log('=== governorship board: every state reaches its race ===');
await p.goto(`${base}/results.html?contest=GOV`, { waitUntil: 'networkidle' });
await p.waitForSelector('#map path', { timeout: 10000 });

const kano = await clickRegion('Kano');
check('Kano is on the board', kano.found, true);
check('caption shows the region detail', kano.text, (t) => /Kano/.test(t) && /APC leads/.test(t));
check('caption offers the race', kano.href, 'race.html?contest=GOV&state=Kano');

// Osun has a WRITTEN race, and must resolve to it rather than to a generated page.
const osun = await clickRegion('Osun');
check('Osun links to its own written race', osun.href, 'race.html?race=raceOsun2026');

// The FCT is on every state map and has no governor — it must not be offered a
// governorship page, and must still show its detail like any other region.
const fct = await clickRegion('Fct');
check('FCT still shows its detail', fct.text, (t) => /Fct/.test(t));
check('FCT is offered no governorship', fct.href, null);

console.log('\n=== a second click on the same region opens it ===');
await Promise.all([
  p.waitForURL(/race\.html/, { timeout: 10000 }),
  p.evaluate(() => {
    const paths = [...document.querySelectorAll('#map path')];
    const hit = paths.find((x) => (x.querySelector('title')?.textContent || '').startsWith('Kano:'));
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // select
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // open
  }),
]);
check('navigated to the race page', p.url(), (h) => h.includes('race.html?contest=GOV&state=Kano'));

console.log('\n=== the destination is a real page, not a 404 ===');
await p.waitForSelector('.race-map, .race-absence', { timeout: 10000 });
const landed = await p.evaluate(() => ({
  h1: document.querySelector('h1')?.textContent,
  shapes: document.querySelectorAll('.race-map path').length,
}));
check('lands on the Kano governorship', landed.h1, (t) => /Kano/.test(t));
check('with its 44 LGAs drawn', landed.shapes, 44);

console.log('\n=== senatorial districts now have pages of their own ===');
await p.goto(`${base}/results.html?contest=SEN`, { waitUntil: 'networkidle' });
await p.waitForSelector('#map path', { timeout: 10000 });
const sen = await clickRegion('Ebonyi South');
check('senatorial region still shows its detail', sen.text, (t) => /Ebonyi South/.test(t));
// This asserted "no link" while SEN had no seat pages. It has them now — every
// one of the 109 districts is built from the register — so the board links there.
check('and offers its seat page', sen.href, 'race.html?contest=SEN&seat=Ebonyi%20South');

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

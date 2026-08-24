// A national board of 109 districts is only worth having if a district goes
// somewhere. Every senatorial district and federal constituency now has its own
// page, built from the register, and the board links to it.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));
const SEATS = JSON.parse(fs.readFileSync(`${APP}/seat_lgas.json`, 'utf8'));
const DGEO = JSON.parse(fs.readFileSync(`${APP}/district_geo.json`, 'utf8'));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) {
    return json({
      contest: url.split('/').pop(), level: 'senatorial', scope: null,
      subunits: DGEO.regions.map((r) => r.name), updatedAt: Date.now(),
      unitsReporting: 0, inDispute: 0, national: [], regions: [],
    });
  }
  if (url.startsWith('/api/coverage/')) return json({ missing: [], unit: 'senatorial district', unitPlural: 'senatorial districts', statesTotal: 109 });
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

console.log('=== the generated membership matches the maps ===');
check('109 senatorial districts', Object.keys(SEATS.SEN).length, 109);
check('every district the map draws has a page',
  DGEO.regions.filter((r) => !SEATS.SEN[r.name]).map((r) => r.name), []);
check('and every seat knows its state', Object.values(SEATS.SEN).every((s) => !!s.state), true);

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

console.log('\n=== a senatorial seat page ===');
const seat = 'Ebonyi South';
const want = SEATS.SEN[seat];
await p.goto(`${base}/race.html?contest=SEN&seat=${encodeURIComponent(seat)}`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-map', { timeout: 10000 });
check('titled for the seat', await p.textContent('h1'), `Senator — ${seat} — 2027`);
check(`drawn as its ${want.lgas.length} LGAs`, await p.$$eval('.race-map path', (n) => n.length), want.lgas.length);
check('captioned', await p.textContent('.race-map + .hint'), `${seat} — ${want.lgas.length} local government areas`);
check('sized from the register', await p.$$eval('.race-statbar .s', (n) => n.map((x) => x.textContent.replace(/\s+/g, ' ').trim())),
  (c) => c.some((x) => x.includes(String(want.lgas.length))) && c.some((x) => /Polling units/.test(x)));
check('and it says why there are no candidates', await p.textContent('.race-ctx'),
  (t) => /has not published the candidate list/.test(t));
// The board link is a RULE now, not a button: a seat page draws its own LGAs
// coloured from the same board data, so it no longer offers a way to a less
// specific view of itself. The rule still has to name the seat, so it is
// checked where it lives. URLSearchParams encodes a space as "+", not %20 —
// both are valid in a query string, and this asserts what the code builds.
check('its board link carries the seat',
  await p.evaluate((s) => window.resultsHrefFor({
    join: { contest: 'SEN', level: 'senatorial', value: s.seat, state: s.state },
  }), { seat, state: want.state }),
  `results.html?${new URLSearchParams({ contest: 'SEN', state: want.state, scope: seat })}`);
check('and the seat page itself asks only for a report',
  await p.$$eval('.race-cta a, .race-cta button', (n) => n.map((x) => x.dataset.cta)),
  (c) => c.includes('observe') && !c.includes('results'));

console.log('\n=== a federal constituency, including a single-LGA one ===');
const single = Object.entries(SEATS.REP).find(([, s]) => s.lgas.length === 1);
await p.goto(`${base}/race.html?contest=REP&seat=${encodeURIComponent(single[0])}`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-map, .race-absence', { timeout: 10000 });
check('a one-LGA seat falls back to its outline, not a lone shape',
  await p.$$eval('.race-map path', (n) => n.length).catch(() => 0), (n) => n <= 1);
check('and is still titled', await p.textContent('h1'), (t) => t.includes(single[0]));

console.log('\n=== unknown seats build nothing ===');
await p.goto(`${base}/race.html?contest=SEN&seat=Nowhere%20Central`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-absence', { timeout: 10000 });
check('no page for a seat that does not exist', await p.textContent('.race-absence'), (t) => /unavailable/i.test(t));

console.log('\n=== the board links every district ===');
await p.goto(`${base}/results.html?contest=SEN`, { waitUntil: 'networkidle' });
await p.waitForSelector('#map path', { timeout: 10000 });
const link = await p.evaluate(() => {
  const hit = [...document.querySelectorAll('#map path')]
    .find((x) => (x.querySelector('title')?.textContent || '').startsWith('Ebonyi South:'));
  hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return document.getElementById('map-info').querySelector('a')?.getAttribute('href');
});
check('a district offers its page', link, 'race.html?contest=SEN&seat=Ebonyi%20South');
await p.goto(`${base}/${link}`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-map', { timeout: 10000 });
check('and the link resolves to a real page', await p.textContent('h1'), (t) => /Ebonyi South/.test(t));

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

// "See Live Results" must land on THIS race's board. It used to go to the
// leaderboard's default — the presidency — so every governorship page sent its
// readers to a nationwide presidential map.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));
const LGAS = JSON.parse(fs.readFileSync(`${APP}/lga_geo.json`, 'utf8'));
const lgasOf = (st) => LGAS.lgas.filter((l) => l.key.split('|')[0] === st.toLowerCase())
  .map((l) => l.key.split('|')[1].replace(/\b[a-z]/g, (c) => c.toUpperCase()));

// The API as it really behaves: ?state= crops and subdivides, an unknown state
// is a 404, and no crop means the whole federation.
const asked = [];
const server = http.createServer((req, res) => {
  const [url, qs] = req.url.split('?');
  const q = new URLSearchParams(qs || '');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) {
    const contest = url.split('/').pop();
    const state = q.get('state');
    asked.push({ contest, state, level: q.get('level') });
    if (state && !lgasOf(state).length) return json({ error: 'unknown_state' }, 404);
    return json({
      contest, level: state ? 'lga' : 'state',
      scope: state ? { state } : null,
      subunits: state ? lgasOf(state) : ['Kano', 'Osun', 'Lagos'],
      updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [],
    });
  }
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
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const ctaHref = () => p.$eval('.race-cta a.btn-quiet', (a) => a.getAttribute('href'));

console.log('=== the link carries the race ===');
await p.goto(`${base}/race.html?contest=GOV&state=Kano`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
check('a generated state page points at its own board', await ctaHref(),
  'results.html?contest=GOV&state=Kano');

await p.goto(`${base}/osun.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
check('osun.html keeps working (it passes its own href)', await ctaHref(), (h) => /contest=GOV/.test(h) && /Osun/.test(h));

// The page that had NO href of its own — the bug as reported.
await p.goto(`${base}/race.html?race=raceOsun2026`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
check('and the generic race page no longer falls back to the presidency', await ctaHref(),
  'results.html?contest=GOV&state=Osun');

// A seat FINER than its state crop keeps a scope, because there the follow
// picker really does have a choice to preselect.
check('a senatorial seat scopes within its state', await p.evaluate(() => window.__h = null || (() => {
  const el = document.createElement('main');
  window.mountRace(el, {
    office: 'Senator — Ebonyi South', election: '2027', candidates: [], others: [],
    join: { contest: 'SEN', level: 'senatorial', value: 'Ebonyi South', state: 'Ebonyi' },
  }, {}, {});
  return el.querySelector('.race-cta a.btn-quiet').getAttribute('href');
})()), 'results.html?contest=SEN&state=Ebonyi&scope=Ebonyi+South');

console.log('\n=== following it crops the board ===');
asked.length = 0;
await p.goto(`${base}/${await ctaHref()}`, { waitUntil: 'networkidle' });
await p.waitForSelector('#map path', { timeout: 10000 });
check('the board was asked for Osun, not the federation', asked.filter((a) => a.contest === 'GOV'),
  (a) => a.length > 0 && a.every((x) => x.state === 'Osun'));
check('the race picker shows the governorship', await p.$eval('#sel-contest', (s) => s.value), 'GOV');
check('the map is titled for the state', await p.textContent('#map-title'), (t) => /in Osun/.test(t));
check('and draws its 30 LGAs', await p.$$eval('#map path', (n) => n.length), 30);
// Cropped to Osun, "everywhere" already MEANS everywhere in Osun — so the empty
// option is the right selection, and its label has to say which everywhere.
check('follow defaults to the whole state, not a stale region',
  await p.$eval('#sel-scope', (s) => ({ value: s.value, label: s.options[0].textContent })),
  { value: '', label: 'Everywhere in Osun' });
check('and its choices are Osun LGAs', await p.$$eval('#sel-scope option', (n) => n.length), 31);

console.log('\n=== choosing another race drops the crop ===');
asked.length = 0;
await p.evaluate(() => {
  document.getElementById('btn-race').click();
  document.querySelector('.race-opt[data-code="PRES"]').click();
});
await p.waitForFunction(() => document.getElementById('sel-contest').value === 'PRES', { timeout: 8000 });
await p.waitForTimeout(400);
check('the presidency is asked for uncropped', asked.filter((a) => a.contest === 'PRES'),
  (a) => a.length > 0 && a.every((x) => x.state === null));

console.log('\n=== a crop the API rejects does not take the board down ===');
asked.length = 0;
await p.goto(`${base}/results.html?contest=GOV&state=Wakanda`, { waitUntil: 'networkidle' });
await p.waitForSelector('#map path', { timeout: 10000 });
check('it retried without the crop', asked.map((a) => a.state), (s) => s.includes('Wakanda') && s.includes(null));
check('and still drew a board', await p.$$eval('#map path', (n) => n.length), (n) => n > 30);

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

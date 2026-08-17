// The leaderboard must ASK which race, not pick one. Opening it used to paint
// the presidency, which reads as "the results" rather than as one race of five.
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

const asked = [];
const server = http.createServer((req, res) => {
  const [url, qs] = req.url.split('?');
  const q = new URLSearchParams(qs || '');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) {
    const contest = url.split('/').pop();
    const state = q.get('state');
    asked.push({ contest, state });
    if (state && !lgasOf(state).length) return json({ error: 'unknown_state' }, 404);
    return json({
      contest, level: state ? 'lga' : 'state', scope: state ? { state } : null,
      subunits: state ? lgasOf(state) : ['Kano', 'Osun', 'Lagos'],
      updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [],
    });
  }
  if (url.startsWith('/api/coverage/')) return json({ missing: [], unit: 'state', statesTotal: 37 });
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

console.log('=== arriving with no race named ===');
asked.length = 0;
await p.goto(`${base}/results.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-opt', { timeout: 10000 });
check('the chooser is open', await p.$eval('#race-picker', (e) => !e.hidden), true);
check('the board is withheld', await p.$eval('#board', (e) => e.hidden), true);
check('and it says so', await p.textContent('#race-name'), 'Choose a race');
check('all five races are offered', await p.$$eval('.race-opt b', (n) => n.map((x) => x.textContent)),
  ['Presidential (2027)', 'Governorship (2027)', 'Senate (2027)', 'House of Representatives (2027)', 'State House of Assembly (2027)']);
check('NO board was fetched for a race nobody picked', asked, []);
check('none is preselected', await p.$$eval('.race-opt.on', (n) => n.length), 0);

console.log('\n=== picking one opens its board ===');
await p.click('.race-opt[data-code="GOV"]');
await p.waitForSelector('#map path', { timeout: 10000 });
check('the board appears', await p.$eval('#board', (e) => e.hidden), false);
check('the chooser closes', await p.$eval('#race-picker', (e) => e.hidden), true);
check('and it is the race that was picked', asked.map((a) => a.contest), ['GOV']);
check('named on the card', await p.textContent('#race-name'), 'Governorship (2027)');

console.log('\n=== the scope picker now FILTERS, as its label claims ===');
asked.length = 0;
await p.selectOption('#sel-scope', 'Osun');
await p.waitForFunction(() => /in Osun/.test(document.getElementById('map-title').textContent), { timeout: 10000 });
check('choosing a state crops the board to it', asked.map((a) => a.state), (s) => s.includes('Osun'));
check('the map says which state', await p.textContent('#map-title'), (t) => /in Osun/.test(t));
check('and draws its LGAs', await p.$$eval('#map path', (n) => n.length), 30);
check('a way back is offered', await p.$$eval('#sel-scope option', (o) => o.map((x) => x.value)), (v) => v.includes('__all'));

asked.length = 0;
await p.selectOption('#sel-scope', '__all');
await p.waitForFunction(() => !/in Osun/.test(document.getElementById('map-title').textContent), { timeout: 10000 });
check('and it uncrops', asked.map((a) => a.state), (s) => s.every((x) => x === null));

console.log('\n=== a deep link still opens its board directly ===');
asked.length = 0;
await p.goto(`${base}/results.html?contest=GOV&state=Osun`, { waitUntil: 'networkidle' });
await p.waitForSelector('#map path', { timeout: 10000 });
check('no chooser in the way', await p.$eval('#race-picker', (e) => e.hidden), true);
check('board shown', await p.$eval('#board', (e) => e.hidden), false);
check('cropped as asked', asked.map((a) => a.state), (s) => s.includes('Osun'));

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

/**
 * Every by-election has a page, and it is ITS OWN page.
 *
 * race.html used to dispatch on the literal strings 'GOV' | 'SEN' | 'REP', so a
 * by-election code matched nothing and fell through to `data['raceOsun2026']` —
 * rendering the Osun governorship, a real page about a different election, with
 * nothing on screen to say so. The control at the bottom is what makes this test
 * mean something: it asserts the Osun page still renders, so "no Osun" here is a
 * statement about the by-election and not about a broken fixture.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) {
    return json({ contest: url.split('/').pop(), level: 'lga', scope: null, subunits: [], regions: [], national: [], unitsReporting: 0, inDispute: 0, updatedAt: Date.now() });
  }
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
const errs = [];

/**
 * WAIT FOR A SIGNAL, NOT A DURATION. The first version of this slept 600ms and
 * reported the Gombe page as blank — it renders, it just takes one more network
 * hop than the others (contests, then seat_lgas, then lga_geo). A fixed sleep
 * turns "slower" into "broken", which is the same mistake as reading a spinner
 * as a failure.
 */
async function open(qs, { expectMap = true } = {}) {
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  p.on('pageerror', (e) => errs.push(`${qs}: ${e}`));
  await p.goto(`${base}/race.html?${qs}`, { waitUntil: 'networkidle' });
  await p
    .waitForFunction(
      (wantMap) => {
        const main = document.getElementById('race-main');
        if (!main || !main.textContent.trim()) return false;
        return wantMap ? document.querySelectorAll('.race-map path').length > 0 : true;
      },
      expectMap,
      { timeout: 8000 },
    )
    .catch(() => {});
  const out = await p.evaluate(() => ({
    title: document.querySelector('.race-office, h1, h2')?.textContent?.trim() ?? null,
    body: document.getElementById('race-main')?.textContent ?? '',
    shapes: document.querySelectorAll('.race-map path').length,
    titles: [...document.querySelectorAll('.race-map path title')].map((t) => t.textContent),
  }));
  await p.close();
  return out;
}

console.log('=== the Gombe House by-election ===');
let r = await open('contest=REP_BYE_GOMBE_2026');
check('has its own page, not Osun', r.body, (t) => !/Osun/i.test(t));
check('titled for the seat', r.title, (t) => /Gombe\/Kwami\/Funakaye/.test(String(t)));
check('and draws its 3 member LGAs', r.shapes, 3);
check('named Funakaye, Gombe and Kwami', [...r.titles].sort(), ['Funakaye', 'Gombe', 'Kwami']);

console.log('\n=== the Delta state-assembly by-election ===');
r = await open('contest=SHA_BYE_DELTA_UDU_2026');
check('has its own page, not Osun', r.body, (t) => !/Osun/i.test(t));
check('titled for the seat', r.title, (t) => /Udu/.test(String(t)));
check('draws the one LGA it is held in', r.shapes, 1);
check('named Udu', r.titles, ['Udu']);

console.log('\n=== the Kano state-assembly by-election ===');
r = await open('contest=SHA_BYE_KANO_DAWAKINKUDU_2026');
check('has its own page, not Osun', r.body, (t) => !/Osun/i.test(t));
// The register spells it "Dawaki Kudu"; lga_geo.json spells it "Dawakin Kudu".
// Without the stem match this page draws no map at all.
check('resolves the register spelling to the map spelling', r.titles, ['Dawakin Kudu']);
check('one shape, not the state', r.shapes, 1);

console.log('\n=== an unknown contest builds NO page ===');
r = await open('contest=NOT_A_REAL_CONTEST', { expectMap: false });
check('and does not quietly render a different race', r.body, (t) => !/Osun/i.test(t));

console.log('\n=== control: the pages this used to fall through to still work ===');
r = await open('race=raceOsun2026');
check('the Osun page still renders', r.body, (t) => /Osun/i.test(t));
r = await open('contest=GOV&state=Bauchi');
check('a generated governorship still renders its LGAs', r.shapes, (n) => n === 20);
r = await open('contest=REP&seat=Gombe%2FKwami%2FFunakaye');
check('the 2027 general seat page still renders', r.shapes, 3);

check('no page errors anywhere', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

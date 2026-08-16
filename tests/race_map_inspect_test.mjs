// A race map you can interrogate: tap an area and it says what came in from
// there, or WHY nothing did. The three silences are genuinely different — an
// election months away, one under way, one finished — and collapsing them into
// "no data" would read as a failure on polling day and as a silence in advance.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));

// Kano's board, with two LGAs reporting and one of them a tie.
let BOARD = { contest: 'GOV', level: 'lga', scope: { state: 'Kano' }, subunits: [], regions: [] };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) return json(BOARD);
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

async function open(url, at) {
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  if (at) {
    await p.addInitScript((iso) => {
      const Real = Date;
      const fixed = new Real(iso).getTime();
      function Fake(...a) { return a.length === 0 ? new Real(fixed) : new Real(...a); }
      Fake.prototype = Real.prototype; Fake.now = () => fixed; Fake.parse = Real.parse; Fake.UTC = Real.UTC;
      window.Date = Fake;
    }, at);
  }
  await p.goto(base + url, { waitUntil: 'networkidle' });
  await p.waitForSelector('.race-map', { timeout: 10000 });
  await p.waitForSelector('.race-map-info', { timeout: 10000 });
  if (errs.length) { fail++; console.log(`FAIL  page errors ${JSON.stringify(errs)}`); }
  return p;
}
/** Click the area named `name` and read the panel back, line by line. */
const tap = (p, name) => p.evaluate((n) => {
  const el = document.querySelector(`.race-map path[data-region="${n}"]`);
  if (!el) return null;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return [...document.querySelectorAll('.race-map-info span')].map((s) => s.textContent);
}, name);

console.log('=== an election still ahead says WHEN, not "no data" ===');
BOARD.regions = [];
let p = await open('/race.html?contest=GOV&state=Kano', '2026-08-16T10:00:00+01:00');
check('every LGA is inspectable', await p.$$eval('.race-map path[data-region]', (n) => n.length), 44);
check('panel invites a tap before one happens', await p.textContent('.race-map-info'),
  (t) => /Tap an area/.test(t));
check('polls-open date, per area', await tap(p, 'Dala'), ['Dala', 'Polls open on 6 February 2027.']);
await p.close();

console.log('\n=== ON polling day, silence means no reports YET ===');
p = await open('/race.html?contest=GOV&state=Kano', '2027-02-06T10:00:00+01:00');
check('open-polls wording', await tap(p, 'Dala'), ['Dala', 'Polls are open — no reports from here yet.']);
await p.close();

console.log('\n=== after the election, silence is final ===');
p = await open('/race.html?contest=GOV&state=Kano', '2027-03-01T10:00:00+01:00');
check('past-tense wording', await tap(p, 'Dala'), ['Dala', 'No reports were filed from here.']);
await p.close();

console.log('\n=== an off-cycle state has no date to give ===');
p = await open('/race.html?contest=GOV&state=Anambra', '2026-08-16T10:00:00+01:00');
check('says so instead of inventing one', await tap(p, 'Awka North'),
  ['Awka North', 'No date has been set for this election yet.']);
await p.close();

console.log('\n=== reported areas show their numbers, and are tinted ===');
BOARD.regions = [
  { region: 'Dala', leader: 'APC', leaders: ['APC'], votes: { APC: 4200, PDP: 3100, NNPP: 900 }, unitsReporting: 7, unitsVerified: 3 },
  { region: 'Nassarawa', leader: 'PDP', leaders: ['PDP', 'APC'], votes: { PDP: 1000, APC: 1000 }, unitsReporting: 1, unitsVerified: 0 },
];
p = await open('/race.html?contest=GOV&state=Kano', '2027-02-06T10:00:00+01:00');
check('leader, units and top parties', await tap(p, 'Dala'),
  ['Dala — APC leads', '7 units reporting, 3 verified', 'APC 4,200 · PDP 3,100 · NNPP 900']);
check('an exact tie is called a tie, not a win', await tap(p, 'Nassarawa'),
  (l) => l[0] === 'Nassarawa — PDP and APC tied' && l[1] === '1 unit reporting, 0 verified');
check('singular "unit" for one', await tap(p, 'Nassarawa'), (l) => /1 unit reporting/.test(l[1]));
const fills = await p.$$eval('.race-map path[data-region]', (n) => Object.fromEntries(
  n.map((x) => [x.dataset.region, x.style.fill || x.getAttribute('fill')])));
check('the sole leader is tinted its party colour', fills.Dala, 'rgb(46, 125, 50)');
check('a tie is NOT tinted for either side', fills.Nassarawa, 'currentColor');
check('a silent LGA stays neutral', fills.Bebeji, 'currentColor');

// The selected shape has to be findable among 44 at a glance: a heavier stroke
// in the same colour as every other border is not a highlight.
const sel = await p.evaluate(() => {
  const el = document.querySelector('.race-map path[data-region="Gwale"]');
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const all = [...document.querySelectorAll('.race-map path[data-region]')];
  return {
    width: el.style.strokeWidth,
    stroke: el.style.stroke,
    last: all[all.length - 1].dataset.region,
    othersPlain: all.filter((x) => x !== el).every((x) => !x.style.strokeWidth),
  };
});
check('selected area is outlined heavier', sel.width, '3');
check('and in a contrasting colour', sel.stroke, (s) => /var\(--link/.test(s) || /rgb/.test(s));
check('and raised above its neighbours', sel.last, 'Gwale');
check('only one area is ever selected', sel.othersPlain, true);

console.log('\n=== reachable without a mouse ===');
const opts = await p.$$eval('.race-map-pick option', (n) => n.length);
check('every area is in the picker too', opts, 45);   // 44 + the prompt
check('picking one fills the panel', await p.evaluate(() => {
  const sel = document.querySelector('.race-map-pick');
  sel.value = 'Dala';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return document.querySelector('.race-mi-lead').textContent;
}), 'Dala — APC leads');
check('the panel announces itself', await p.$eval('.race-map-info', (n) => n.getAttribute('aria-live')), 'polite');
await p.close();

console.log('\n=== a board that never answers costs the map nothing ===');
BOARD = null;   // /api/national now returns "null", i.e. no usable board
p = await open('/race.html?contest=GOV&state=Kano', '2027-02-06T10:00:00+01:00');
check('map still drawn', await p.$$eval('.race-map path', (n) => n.length), 44);
check('and still explains the silence', await tap(p, 'Dala'),
  ['Dala', 'Polls are open — no reports from here yet.']);
await p.close();

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

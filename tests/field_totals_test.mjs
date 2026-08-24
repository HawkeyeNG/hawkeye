/**
 * ONE LIST OF NAMES, WITH WHAT HAS BEEN REPORTED BESIDE THEM.
 *
 * A governorship used to get the presidential furniture — front-runner cards, a
 * full ballot and a quick-compare table — with nothing to put in it. No running
 * mate, no home base, no prose: five columns of "—" for what is, like every
 * other race, a list of names. Osun made it plainest, re-arguing a finished
 * contest under a card that already carried the declared result.
 *
 * Now only the presidency profiles its field. Everything else lists it, and the
 * list carries each candidate's running total once reports start arriving.
 *
 * THE HONESTY CONSTRAINT IS THE POINT. Those totals are what OBSERVERS have
 * sent in, and on a completed race they sit on the same page as INEC's declared
 * figures. The two must never be confusable, and nothing may be shown at all
 * before there is something to show — a column of zeroes claims nobody voted,
 * which is the opposite of "no reports yet".
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const ROOT = '/home/elrio/hawkeye';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));

// The board, with a knob: how many units have reported, and the party totals.
let BOARD = { unitsReporting: 0, national: [] };
const server = http.createServer((req, res) => {
  const [url] = req.url.split('?');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) {
    return json({
      contest: url.split('/').pop(), level: 'lga', scope: null, subunits: [],
      updatedAt: Date.now(), inDispute: 0, regions: [],
      unitsReporting: BOARD.unitsReporting, national: BOARD.national,
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 900, height: 1400 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

const sections = () => p.$$eval('main h2', (h) => h.map((x) => x.textContent.trim()));

console.log('=== a governorship lists its field, like every other race ===');
BOARD = { unitsReporting: 0, national: [] };
await p.goto(`${base}/osun.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
const osunSections = await sections();
check('no front-runners', osunSections, (s) => !s.some((x) => /Front-runner/i.test(x)));
check('no quick compare', osunSections, (s) => !s.some((x) => /Quick compare/i.test(x)));
check('one declared-candidates list instead', osunSections,
  (s) => s.filter((x) => /^Declared candidates$/.test(x)).length === 1);
check('and it holds the whole field', await p.$$eval('#field-list .b', (n) => n.length), (n) => n > 1);
// The declared result is INEC's and is untouched by any of this.
check('the declared result card survives', await p.$('.declared'), (v) => v !== null);

console.log('\n=== the presidency keeps its profile ===');
await p.goto(`${base}/candidates.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
const presSections = await sections();
// "Presidential Race — Major Candidates", the profiled treatment's own heading.
check('the profiled candidate section stays', presSections,
  (s) => s.some((x) => /Major Candidates/i.test(x)));
check('quick compare stays', presSections, (s) => s.some((x) => /Quick compare/i.test(x)));

console.log('\n=== nothing reported: the list says nothing about votes ===');
// Osun, because it HAS a published field. A governorship whose candidates INEC
// has not published yet renders no list at all — correct, and nothing to assert
// about here.
BOARD = { unitsReporting: 0, national: [] };
await p.goto(`${base}/osun.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('#field-list', { timeout: 10000 });
await p.waitForTimeout(400);
check('no totals are shown', await p.$$eval('#field-list .b-votes:not([hidden])', (n) => n.length), 0);
check('and the hint makes no claim about counts',
  await p.textContent('#field-hint'), (t) => !/reported so far/.test(t));

console.log('\n=== reports arrive: totals appear beside the names ===');
// APC and ADC are on Osun's ballot; PDP is NOT — a party the board has votes
// for but this race has no candidate for. It must not conjure a row: the list
// is the declared field, and the join only ever fills a name that is already
// there. (Found the honest way — the first draft of this test used PDP and it
// silently matched nothing.)
BOARD = {
  unitsReporting: 42,
  national: [{ party: 'APC', votes: 12345 }, { party: 'ADC', votes: 9876 }, { party: 'PDP', votes: 4321 }],
};
await p.goto(`${base}/osun.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('#field-list .b-votes:not([hidden])', { timeout: 10000 });
const shown = await p.$$eval('#field-list .b[data-party]', (rows) => rows
  .map((r) => ({ party: r.dataset.party, votes: r.querySelector('.b-votes').hidden ? null : r.querySelector('.b-votes').textContent }))
  .filter((x) => x.votes));
check('only parties with reports get a number', shown.map((x) => x.party).sort(), ['ADC', 'APC']);
check('a party not on this ballot adds no row',
  await p.$$eval('#field-list .b[data-party="PDP"]', (n) => n.length), 0);
check('formatted with separators', shown.find((x) => x.party === 'APC').votes, '12,345');
// THE CLAIM IS LABELLED. Observer totals on the same page as INEC's declared
// figures, with no note saying which is which, is the one outcome that matters.
const hint = await p.textContent('#field-hint');
check('the hint says whose numbers these are', hint, (t) => /observers have reported/i.test(t));
check('and how many units they came from', hint, (t) => /42 polling units/.test(t));
check('and that they are not official', hint, (t) => /not an official count/i.test(t));

console.log('\n=== a party nobody reported stays blank, not zero ===');
BOARD = { unitsReporting: 7, national: [{ party: 'APC', votes: 500 }] };
await p.goto(`${base}/osun.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('#field-list .b-votes:not([hidden])', { timeout: 10000 });
const withZero = await p.$$eval('#field-list .b-votes', (n) => n.map((x) => (x.hidden ? null : x.textContent)));
check('exactly one row shows a number', withZero.filter(Boolean), ['500']);
check('no row shows a zero', withZero, (v) => !v.includes('0'));

console.log('\n=== the board is fetched once, not once per reader ===');
// The map and the list both want it; two requests for one payload on every race
// page is a cost with nothing to show for it.
let calls = 0;
p.on('request', (r) => { if (/\/api\/national\//.test(r.url())) calls++; });
await p.goto(`${base}/race.html?contest=GOV&state=Kano`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
check('one /api/national call', calls, 1);

console.log('\n=== control: the fixture can show a difference ===');
check('an empty board and a full one do not render the same',
  JSON.stringify(withZero) !== JSON.stringify([null, null]), true);
check('no page errors', errs, []);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
await b.close();
server.close();
process.exit(fail ? 1 : 0);

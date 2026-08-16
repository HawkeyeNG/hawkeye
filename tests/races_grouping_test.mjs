// The races page groups by polling date, so the grouping is only correct
// relative to a day. This drives the page with the clock FROZEN at three
// different dates and asserts a race moves between groups on its own — the
// thing a hand-written "Osun is live now" list could never do.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));

// The Osun governorship as it was BEFORE it was retired from the catalogue —
// added back for the frozen-clock runs, so the "a live race is in the catalogue,
// a finished one is only in political_data" split is actually exercised.
const OSUN = { code: 'GOV_OSUN', name: 'Osun Governorship', election: 'Osun 2026', date: '2026-08-15', states: ['Osun'] };

let withOsun = false;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/contests') {
    const list = withOsun ? [...CONTESTS, OSUN] : CONTESTS;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(list.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` }))));
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

/** Load races.html with the page's clock frozen at `iso`. */
async function pageOn(iso) {
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript((at) => {
    const Real = Date;
    const fixed = new Real(at).getTime();
    // Only the no-argument form is frozen; parsing "2027-02-06T00:00:00" has to
    // keep working, since that is how the page reads every polling date.
    function Fake(...a) {
      return a.length === 0 ? new Real(fixed) : new Real(...a);
    }
    Fake.prototype = Real.prototype;
    Fake.now = () => fixed;
    Fake.parse = Real.parse;
    Fake.UTC = Real.UTC;
    window.Date = Fake;
  }, iso);
  await p.goto(`${base}/races.html`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.rc-group', { timeout: 10000 });
  if (errs.length) { fail++; console.log(`FAIL  page errors: ${JSON.stringify(errs)}`); }
  return p;
}

/** Race names under each group heading. */
const groups = (p) => p.evaluate(() => Object.fromEntries(
  [...document.querySelectorAll('.rc-group')].map((s) => [
    s.dataset.status,
    [...s.querySelectorAll('.rc-body h2')].map((h) => h.textContent),
  ]),
));

console.log('=== on Osun polling day, it is ONGOING ===');
withOsun = true;
let p = await pageOn('2026-08-15T12:00:00+01:00');
let g = await groups(p);
check('Osun is being reported now', g.ongoing, (v) => v.some((n) => /Osun/.test(n)));
check('and is not in completed', g.completed, (v) => !v.some((n) => /Osun/.test(n)));
check('the 2027 races are still upcoming', g.upcoming, (v) => v.length === 5);
await p.close();

console.log('\n=== the morning after, it is COMPLETED — no edit required ===');
withOsun = false;   // a finished contest leaves the catalogue
p = await pageOn('2026-08-16T09:00:00+01:00');
g = await groups(p);
check('Osun moved to completed', g.completed, ['Osun Governorship (2026)']);
check('nothing is being reported', g.ongoing, []);
check('the five 2027 races are upcoming', g.upcoming.length, 5);
check('and the empty group says so', await p.textContent('.rc-group[data-status="ongoing"] .rc-empty'),
  (t) => /No election is being reported today/.test(t));

console.log('\n=== the filter shows one group at a time ===');
await p.$eval('#rc-completed', (el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
check('only Completed is visible', await p.$$eval('.rc-group:not([hidden]) > h2', (n) => n.map((x) => x.textContent)), ['Completed']);
await p.$eval('#rc-all', (el) => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
check('All brings them back', await p.$$eval('.rc-group:not([hidden])', (n) => n.length), 3);
check('chip counts match the cards', await p.$$eval('.rc-filter label', (n) => n.map((x) => x.textContent.trim())),
  ['All 6', 'Ongoing 0', 'Upcoming 5', 'Completed 1']);

console.log('\n=== governorship opens into the states, and they resolve ===');
const gov = await p.evaluate(() => {
  const links = [...document.querySelectorAll('.rc-grid a')];
  return { n: links.length, hrefs: links.map((a) => a.getAttribute('href')) };
});
check('all 36 governorships listed', gov.n, 36);
check('the FCT is not among them', gov.hrefs, (h) => !h.some((x) => /state=FCT/i.test(x)));
check('every one points at a race page', gov.hrefs, (h) => h.every((x) => x.startsWith('race.html?contest=GOV&state=')));
// Follow one, and confirm it is a real page rather than a plausible URL.
await p.goto(`${base}/${gov.hrefs.find((h) => /state=Bauchi/.test(h))}`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-map', { timeout: 10000 });
check('a listed state lands on its own map', await p.$$eval('.race-map path', (n) => n.length), 20);
check('titled for that state', await p.textContent('h1'), 'Governor of Bauchi State — 2027');
await p.close();

console.log('\n=== a future date rolls the general election into completed ===');
p = await pageOn('2027-06-01T09:00:00+01:00');
g = await groups(p);
check('nothing is upcoming any more', g.upcoming, []);
check('all six are completed', g.completed.length, 6);
await p.close();

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

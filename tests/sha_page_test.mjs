/**
 * The 1,005 state constituencies have pages, and the board never sends a reader
 * to a race they did not click on.
 *
 * The SHA board buckets by LGA, but a page is about a SEAT, and 240 of the 768
 * LGAs elect two, three or four members. Resolving that by taking the first one
 * would be a page about the wrong race — the same failure class as race.html's
 * old fallthrough to the Osun page, which looked completely normal.
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
const SHA = JSON.parse(fs.readFileSync(`${APP}/seat_lgas.json`, 'utf8')).SHA;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) return json({ contest: url.split('/').pop(), level: 'lga', scope: null, subunits: [], regions: [], national: [], unitsReporting: 0, inDispute: 0, updatedAt: Date.now() });
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
async function open(qs) {
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  p.on('pageerror', (e) => errs.push(`${qs}: ${e}`));
  await p.goto(`${base}/race.html?${qs}`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => (document.getElementById('race-main')?.textContent || '').trim().length > 40, null, { timeout: 8000 }).catch(() => {});
  const out = await p.evaluate(() => ({
    body: document.getElementById('race-main')?.textContent || '',
    h1: document.querySelector('h1')?.textContent?.trim() || null,
    links: [...document.querySelectorAll('.rc-grid a')].map((a) => a.textContent.trim()),
    stats: Object.fromEntries([...document.querySelectorAll('.race-statbar .s')]
      .map((s) => [s.querySelector('.l')?.textContent?.trim(), s.querySelector('.n')?.textContent?.trim()])),
  }));
  await p.close();
  return out;
}

// A state where one LGA carries four seats.
const FOUR = Object.values(SHA).filter((v) => v.state === 'Bayelsa' && v.lgas.includes('Southern Ijaw'));

console.log('=== a state constituency now has a page ===');
let r = await open('contest=SHA&state=Delta&seat=Udu');
check('titled for the seat', r.h1, (t) => /Udu/.test(String(t)));
check('carries the four facts', Object.keys(r.stats).length, (n) => n >= 3);
check('counts wards', r.stats.Wards, (v) => Number(v) > 0);
check('and is not the Osun page', r.body, (t) => !/Osun/i.test(t));

console.log('\n=== a state opens a picker, not a race ===');
r = await open('contest=SHA&state=Delta');
check('lists that state’s constituencies', r.links.length, (n) => n > 10);
check('every entry belongs to Delta', r.links, (v) =>
  v.every((n) => Object.values(SHA).some((x) => x.state === 'Delta' && x.seat === n)));

console.log('\n=== an LGA with ONE seat resolves straight to it ===');
r = await open('contest=SHA&state=Delta&lga=Udu');
check('goes to the seat, not a chooser', r.h1, (t) => /Udu/.test(String(t)));
check('no chooser shown', r.links.length, 0);

console.log('\n=== an LGA with FOUR seats offers the choice ===');
r = await open('contest=SHA&state=Bayelsa&lga=Southern%20Ijaw');
console.log('    offered:', JSON.stringify(r.links));
check('offers every seat in that LGA', r.links.length, FOUR.length);
check('and picks none of them', r.stats.Wards, undefined);

console.log('\n=== control: the pages this could have broken ===');
r = await open('race=raceOsun2026');
check('the Osun page still renders', r.body, (t) => /Osun/i.test(t));
r = await open('contest=SHA_BYE_DELTA_UDU_2026');
check('the by-election page still renders', r.stats.Wards, (v) => Number(v) > 0);
r = await open('contest=SEN&seat=Abia%20Central');
check('a senatorial page still renders', r.stats.LGAs, (v) => Number(v) > 0);

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

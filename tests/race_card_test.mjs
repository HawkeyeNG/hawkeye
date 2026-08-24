/**
 * Every race page carries the same four facts, and the seat tiers count wards.
 *
 * The card used to DROP its candidate cell when the count was zero, which made
 * it shortest on exactly the pages that have least — a seat with no published
 * field looked half-built. And the LGA count, which describes a governorship
 * fine, described a state constituency as the number 1.
 *
 * Asserted against a rendered page, not against the builder, because the card is
 * assembled in the renderer and a builder test would pass while the markup
 * dropped a cell.
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
const SEATS = JSON.parse(fs.readFileSync(`${APP}/seat_lgas.json`, 'utf8'));

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

/** The stat bar as {label: value}. */
async function card(qs) {
  const p = await b.newPage({ viewport: { width: 900, height: 1200 } });
  p.on('pageerror', (e) => errs.push(`${qs}: ${e}`));
  await p.goto(`${base}/race.html?${qs}`, { waitUntil: 'networkidle' });
  await p.waitForFunction(() => document.querySelectorAll('.race-statbar .s').length > 0, null, { timeout: 8000 }).catch(() => {});
  const out = await p.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.race-statbar .s')].map((s) => [
      s.querySelector('.l')?.textContent?.trim(), s.querySelector('.n')?.textContent?.trim()])));
  await p.close();
  return out;
}

/**
 * A FEDERAL SEAT COUNTS LGAs — the unit its own map draws.
 *
 * It was briefly measured in wards, on the grounds that 2-4 LGAs describes a
 * constituency poorly. True, but the map above the bar is cut from those same
 * 2-4 LGAs, so naming a different unit than the one on screen asks a reader to
 * reconcile two numbers for nothing. Wards stay where the LGA count genuinely
 * says nothing: a state constituency, 986 of whose 1,005 sit inside one LGA.
 */
console.log('=== a federal seat counts LGAs, matching its map ===');
let c = await card('contest=REP&seat=Gombe%2FKwami%2FFunakaye');
console.log('   ', JSON.stringify(c));
// The year may arrive as its own cell or inside the election day — assert it
// is READABLE, not which box holds it.
check('a year is visible on the card', JSON.stringify(c), (v) => /20\d\d/.test(v));
check('says Candidates TBD rather than dropping the cell', c.Candidates, 'TBD');
check('counts LGAs', c.LGAs, (v) => Number(v) > 0);
check('and does NOT show a ward count', 'Wards' in c, false);
check('the LGA count matches the seat table',
  Number(c.LGAs), SEATS.REP['Gombe/Kwami/Funakaye'].lgas.length);
check('polling units present', c['Polling units'], (v) => /^~[\d,]+$/.test(String(v)));

console.log('\n=== a senatorial district keeps LGAs ===');
c = await card('contest=SEN&seat=Abia%20Central');
console.log('   ', JSON.stringify(c));
check('counts LGAs', c.LGAs, (v) => Number(v) > 0);
check('and not wards', 'Wards' in c, false);
check('Candidates TBD', c.Candidates, 'TBD');

console.log('\n=== a governorship keeps LGAs and gains a year ===');
c = await card('contest=GOV&state=Bauchi');
console.log('   ', JSON.stringify(c));
check('counts LGAs', c.LGAs, (v) => Number(v) > 0);
// The year may arrive as its own cell or inside the election day — assert it
// is READABLE, not which box holds it.
check('a year is visible on the card', JSON.stringify(c), (v) => /20\d\d/.test(v));

console.log('\n=== a state-assembly by-election gets REAL figures, not "1 LGAs" ===');
c = await card('contest=SHA_BYE_DELTA_UDU_2026');
console.log('   ', JSON.stringify(c));
check('counts wards', c.Wards, (v) => Number(v) > 0);
check('wards match the seat table', Number(c.Wards), SEATS.SHA['Delta|Udu'].wards);
check('polling units, which it never had', c['Polling units'], (v) => /^~[\d,]+$/.test(String(v)));
check('Candidates TBD', c.Candidates, 'TBD');

console.log('\n=== control: a race WITH candidates shows the number, not TBD ===');
c = await card('race=raceOsun2026');
console.log('   ', JSON.stringify(c));
check('shows a real candidate count', c.Candidates, (v) => Number(v) > 0);

console.log('\n=== no fact is stated twice ===');
for (const [qs, label] of [
  ['contest=REP&seat=Gombe%2FKwami%2FFunakaye', 'federal seat'],
  ['race=raceOsun2026', 'the Osun page'],
  ['contest=GOV&state=Bauchi', 'a governorship'],
]) {
  const k = Object.keys(await card(qs));
  check(`${label}: every cell label is distinct`, k.length, new Set(k).size);
}

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

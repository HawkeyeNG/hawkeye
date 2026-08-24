/**
 * THE STAT BAR NAMES WHAT THE MAP DRAWS — with one exception, and it is stated.
 *
 * The map on a race page is cut from LGAs at every level, so the LGA count and
 * the shapes on screen are the same fact twice: a governorship's whole state, a
 * senatorial district's 3-8, a federal constituency's 2-4. Naming a different
 * unit than the one being drawn makes a reader reconcile two numbers for no
 * gain, which is why REP is measured in LGAs and not, as it briefly was, wards.
 *
 * A STATE CONSTITUENCY IS THE EXCEPTION. 986 of the 1,005 sit inside a single
 * LGA, so "1 LGA" is a fact about the register not separating them rather than
 * about the seat. Wards are the grain it is actually built from.
 *
 * Also pinned: every seat at every level HAS both figures (so nothing falls
 * back), and a count of one is singular — "1 LGAs" is on 80 federal
 * constituencies and 986 state seats, which is not a rare edge.
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
const SEATS = JSON.parse(fs.readFileSync(`${APP}/seat_lgas.json`, 'utf8'));

const server = http.createServer((req, res) => {
  const [url] = req.url.split('?');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) return json({ contest: 'x', level: 'lga', scope: null, subunits: [], updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [] });
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

console.log('=== the data behind the bar is complete ===');
// If any seat lacked these the bar would silently fall back to the LGA count,
// which is the "1 LGAs" this whole rule exists to remove.
for (const tier of ['SEN', 'REP', 'SHA']) {
  const rows = Object.values(SEATS[tier]);
  check(`${tier}: every seat has a ward count`, rows.filter((v) => !(v.wards > 0)).length, 0);
  check(`${tier}: every seat has a unit count`, rows.filter((v) => !(v.pollingUnits > 0)).length, 0);
}

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

const bar = async (url) => {
  await p.goto(`${base}/${url}`, { waitUntil: 'networkidle' });
  await p.waitForSelector('.race-statbar', { timeout: 10000 });
  return p.$$eval('.race-statbar .s', (n) => n.map((x) => `${x.querySelector('.n').textContent.trim()} ${x.querySelector('.l').textContent.trim()}`));
};
const labels = (cells) => cells.map((c) => c.replace(/^\S+\s/, ''));

console.log('\n=== a state constituency is measured in wards, and has units ===');
const shaKey = Object.keys(SEATS.SHA)[0];
const [shaState, shaSeat] = shaKey.split('|');
const sha = await bar(`race.html?contest=SHA&state=${encodeURIComponent(shaState)}&seat=${encodeURIComponent(shaSeat)}`);
check('wards, not LGAs', labels(sha), (l) => l.includes('Wards') && !l.some((x) => /^LGAs?$/.test(x)));
check('AND a polling-unit count', labels(sha), (l) => l.some((x) => /Polling unit/.test(x)));
check('a real number, not a placeholder', sha.find((c) => /Polling unit/.test(c)), (c) => /~\d/.test(c));

console.log('\n=== a SHA by-election too — the page most likely to be read ===');
for (const code of ['SHA_BYE_DELTA_UDU_2026', 'SHA_BYE_KANO_DAWAKINKUDU_2026']) {
  const cells = await bar(`race.html?contest=${code}`);
  check(`${code} is measured in wards`, labels(cells), (l) => l.includes('Wards'));
  check(`${code} carries its units`, cells.find((c) => /Polling unit/.test(c)), (c) => /~\d/.test(c));
}

console.log('\n=== REP keeps LGAs, because that is what its map draws ===');
const rep = await bar(`race.html?contest=REP&seat=${encodeURIComponent('Aba North/Aba South')}`);
check('LGAs, not wards', labels(rep), (l) => l.includes('LGAs') && !l.includes('Wards'));
const repBye = await bar('race.html?contest=REP_BYE_GOMBE_2026');
check('and so does a REP by-election', labels(repBye), (l) => l.includes('LGAs') && !l.includes('Wards'));
check('the count matches the seat it names', repBye.find((c) => /LGA/.test(c)), '3 LGAs');

console.log('\n=== a senatorial district was always LGAs and still is ===');
const sen = await bar(`race.html?contest=SEN&seat=${encodeURIComponent('Abia Central')}`);
check('LGAs', labels(sen), (l) => l.includes('LGAs') && !l.includes('Wards'));

console.log('\n=== one is singular ===');
// 80 federal constituencies sit in a single LGA. "1 LGAs" was on every one.
const single = Object.entries(SEATS.REP).find(([, v]) => (v.lgas || []).length === 1);
const one = await bar(`race.html?contest=REP&seat=${encodeURIComponent(single[0])}`);
check(`${single[0]} reads "1 LGA"`, one.find((c) => /LGA/.test(c)), '1 LGA');
check('and not "1 LGAs"', one.join(' '), (s) => !/1 LGAs/.test(s));

console.log('\n=== control: the probe can tell the two apart ===');
check('SHA and REP bars differ', JSON.stringify(labels(sha)) !== JSON.stringify(labels(rep)), true);
check('no page errors', errs, []);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
await b.close();
server.close();
process.exit(fail ? 1 : 0);

// A FINISHED RACE SHOULD SAY WHO WON — AND WHOSE CLAIM THAT IS.
//
// The badge exists because a completed race page that lists candidates and stops
// is useless to anyone who wants the one fact the election produced. But the
// result is INEC's declaration, not Hawkeye's count, and this product's entire
// standing rests on not being mistaken for INEC. So the badge has two jobs that
// pull against each other: state the result plainly, and never look like INEC
// issued it.
//
// The tests below are mostly about the second job, because that is the one where
// a well-meaning change (adding "the INEC logo, for credibility") does real
// damage — to the nonpartisan claim, and to somebody else's trademark.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const POLITICAL = JSON.parse(fs.readFileSync(`${APP}/political_data.json`, 'utf8'));
const CONTESTS = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const server = http.createServer((req, res) => {
  const [url] = req.url.split('?');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false })));
  if (url.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 900 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

console.log('=== the data itself ===');
const D = POLITICAL.raceOsun2026?.declared;
check('Osun carries a declared result', !!D?.winner, true);
check('attributed to a declaring body', D?.by, 'INEC');
check('with the date it was declared', D?.date, (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || ''));
// SOURCES ARE NOT DECORATION. This is a hand-recorded claim about a real
// election; without somewhere to check it, it is just an assertion in a JSON file.
check('and more than one source to check it against', (D?.sources || []).length, (n) => n >= 2);
check('every source is a real URL', D?.sources || [], (s) => s.every((u) => /^https:\/\/.+\..+/.test(u)));
// The winner must actually BE in the results rows, and must actually be top of
// them — a badge that crowns someone the rows contradict is worse than no badge.
const rows = D?.results || [];
const top = [...rows].sort((a, b) => b.votes - a.votes)[0];
check('the declared winner tops the recorded rows', top?.party, D?.party);
check('and their vote count agrees with the headline', top?.votes, D?.votes);

console.log('\n=== the badge on a completed race ===');
await p.goto(`${base}/race.html?race=raceOsun2026`, { waitUntil: 'networkidle' });
const shown = (sel) => p.$$eval(sel, (n) => n.some((e) => e.getClientRects().length));
check('renders', await shown('.declared'), true);
check('labelled as a declaration, not as a Hawkeye result',
  (await p.$eval('.declared-tag', (e) => e.textContent)).trim(), 'Declared result');
// The <h2> names the SECTION ('Declared result'); the winner is the content
// under it, so that the page outline offers a section rather than a person.
check('the heading names the section', await p.$eval('#declared-h', (e) => e.textContent.trim()),
  'Declared result');
check('names the winner', await p.$eval('.declared-winner', (e) => e.textContent.replace(/\s+/g, ' ').trim()),
  (t) => t.startsWith(D.winner));
check('says who declared it, and when',
  await p.$eval('.declared-by', (e) => e.textContent),
  (t) => t.includes('INEC') && t.includes('August 2026'));
check('lists every recorded row',
  await p.$$eval('.declared-rows li', (n) => n.length), rows.length);
check('the figures are printed exactly, not rounded',
  await p.$$eval('.declared-rows .dv', (n) => n.map((e) => e.textContent.trim())),
  rows.map((r) => r.votes.toLocaleString('en-US')));
check('the winner is the row marked won',
  await p.$$eval('.declared-rows li.won .dp', (n) => n.map((e) => e.textContent.trim().replace(/\s+/g, ''))),
  (v) => v.length === 1 && v[0] === D.party);
check('sources are reachable links',
  await p.$$eval('.declared-src a', (n) => n.map((a) => a.href)), (h) => h.length >= 2);

console.log('\n=== and it must not look like INEC issued it ===');
// The whole product says "Not government or INEC affiliated". A crest, seal or
// emblem here would contradict that at a glance — and is not ours to use.
check('no INEC emblem or crest anywhere in the badge',
  await p.$$eval('.declared img', (n) => n.map((i) => i.getAttribute('src') || '')),
  (srcs) => !srcs.some((s) => /inec|crest|seal|coat|emblem|gov\.ng/i.test(s)));
check('attribution is carried in words',
  await p.$eval('.declared', (e) => e.textContent), (t) => /Declared by INEC/i.test(t));
check('and it says plainly that Hawkeye did not certify it',
  await p.$eval('.declared', (e) => e.textContent),
  (t) => /not INEC|does not certify/i.test(t));
check('the page still carries the not-affiliated notice',
  await p.evaluate(() => document.body.innerText), (t) => /not (a )?government|INEC affiliated/i.test(t));

console.log('\n=== a race with no declaration recorded ===');
// Every generated seat page is in this state, and will be until someone records
// a declaration by hand. It must show NOTHING rather than an empty frame — and
// certainly never invent a winner.
await p.goto(`${base}/race.html?contest=SEN&seat=Kano%20Central`, { waitUntil: 'networkidle' });
check('shows no badge at all', await shown('.declared'), false);
check('and does not claim a winner', await p.evaluate(() => document.body.innerText),
  (t) => !/declared result/i.test(t));

console.log('\n=== on a phone ===');
check('the badge fits the viewport',
  await p.goto(`${base}/race.html?race=raceOsun2026`, { waitUntil: 'networkidle' })
    .then(() => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)), true);

console.log('\n=== native says the same thing ===');
const nat = fs.readFileSync(`${ROOT}/native/src/components/race.tsx`, 'utf8');
check('has a Declared component', /function Declared\(/.test(nat), true);
check('rendered only when a declaration exists', /race\.declared\?\.winner \? <Declared/.test(nat), true);
check('cites the declaring body in words', /Declared by \{d\.by \|\| 'INEC'\}/.test(nat), true);
// PartyMark draws the PARTY's emblem, which is correct and is not INEC's mark.
check('no INEC asset referenced', /inec.*\.(png|svg|jpg)/i.test(nat), false);

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nall passed');
process.exit(fail ? 1 : 0);

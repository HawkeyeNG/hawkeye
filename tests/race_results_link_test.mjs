/**
 * WHERE A RACE'S BOARD IS, AND WHO STILL HAS A BUTTON TO IT.
 *
 * The link had to land on THIS race's board; it used to go to the leaderboard's
 * default — the presidency — so every governorship page sent its readers to a
 * nationwide presidential map. That rule still holds and is still tested here.
 *
 * What changed: the BUTTON is gone from every race page but the presidency,
 * because a race page draws its own regions coloured from the same board data,
 * so "See Live Results" pointed somewhere less specific than where the reader
 * already was. The presidency carries no join, renders no map, and keeps it.
 *
 * So the href rule is now tested on the FUNCTION — window.resultsHrefFor, the
 * twin of native lib/political.ts — and the button's presence is tested
 * separately, on the pages. Reading the href out of the DOM would only have
 * been able to test the one page that still has one.
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
/** The shipped rule, called directly. */
const hrefFor = (join) => p.evaluate((j) => window.resultsHrefFor(j ? { join: j } : {}), join);
const ctas = () => p.$$eval('.race-cta a, .race-cta button', (n) => n.map((x) => x.dataset.cta));

console.log('=== the link carries the race ===');
await p.goto(`${base}/race.html?contest=GOV&state=Kano`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
check('a state race resolves to its own board',
  await hrefFor({ contest: 'GOV', level: 'state', value: 'Kano', state: 'Kano' }),
  'results.html?contest=GOV&state=Kano');
// A seat FINER than its state crop keeps a scope, because there the follow
// picker really does have a choice to preselect.
check('a senatorial seat scopes within its state',
  await hrefFor({ contest: 'SEN', level: 'senatorial', value: 'Ebonyi South', state: 'Ebonyi' }),
  'results.html?contest=SEN&state=Ebonyi&scope=Ebonyi+South');
// The presidency has no join. This used to fall through to a bare
// results.html, which seeds itself from the picker — so the one button on the
// presidential page opened "choose an election".
check('the presidency names its contest instead of opening the picker',
  await hrefFor(null), 'results.html?contest=PRES');

console.log('\n=== but only the presidency still shows a button ===');
check('a live state race asks for a report and nothing else', await ctas(),
  (c) => c.includes('observe') && !c.includes('results'));

await p.goto(`${base}/osun.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
// Osun 2026 is past, so it must not still be recruiting observers for it — and
// with the board link gone the only thing left is the ledger.
check('a completed race drops the recruitment CTA too', await ctas(), ['verify']);

await p.goto(`${base}/candidates.html`, { waitUntil: 'networkidle' });
await p.waitForSelector('.race-cta', { timeout: 10000 });
check('the presidency keeps its board link', await ctas(), (c) => c.includes('results'));
check('and it points at the presidential board',
  await p.$eval('.race-cta a[data-cta="results"]', (a) => a.getAttribute('href')),
  'results.html?contest=PRES');
check('labelled in sentence case, like every other button',
  await p.textContent('.race-cta a[data-cta="results"]'), (t) => /^\s*Live results\s*$/.test(t));

console.log('\n=== following it crops the board ===');
asked.length = 0;
// The link Osun's page WOULD produce. Its button is gone (the race is over and
// the page is its own record), but the rule that produced it still has to send
// a reader to Osun's board rather than the federation's.
await p.goto(`${base}/${await hrefFor({ contest: 'GOV', level: 'state', value: 'Osun', state: 'Osun' })}`,
  { waitUntil: 'networkidle' });
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
// 30 LGAs + "Everywhere in Osun" + the "← All states" way back out of the crop.
check('and its choices are Osun LGAs', await p.$$eval('#sel-scope option', (n) => n.length), 32);
check('with an escape from the crop', await p.$$eval('#sel-scope option', (o) => o.map((x) => x.value)),
  (v) => v.includes('__all'));

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

// What the leaderboard DOWNLOADS, per board. All four map layers used to be
// awaited before anything rendered — 1.8 MB on a page whose default board needs
// 23 KB of it, which measured 30-40s to first paint against production. This
// asserts the bytes, because a load-time fix that nothing measures comes back.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/backend/src/data/contests.json', 'utf8'));
const DGEO = JSON.parse(fs.readFileSync(`${APP}/district_geo.json`, 'utf8'));

const LEVEL = { PRES: 'state', GOV: 'state', SEN: 'senatorial', REP: 'federal', SHA: 'lga' };
const server = http.createServer((req, res) => {
  const [url, qs] = req.url.split('?');
  const q = new URLSearchParams(qs || '');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) {
    const code = url.split('/').pop();
    const state = q.get('state');
    return json({
      contest: code, level: state ? 'lga' : LEVEL[code], scope: state ? { state } : null,
      subunits: LEVEL[code] === 'senatorial' ? DGEO.regions.map((r) => r.name) : [],
      updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [],
    });
  }
  if (url.startsWith('/api/coverage/')) return json({ missing: [], unit: 'state', unitPlural: 'states', statesTotal: 37 });
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

const GEO = ['states_geo.json', 'lga_geo.json', 'district_geo.json', 'constituency_geo.json'];
const sizeOf = (f) => fs.statSync(path.join(APP, f)).size;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** Which geo layers a page actually asks for, and their combined raw size. */
async function layersFor(url, waitFor) {
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  const asked = new Set();
  p.on('request', (r) => {
    const n = r.url().split('/').pop().split('?')[0];
    if (GEO.includes(n)) asked.add(n);
  });
  await p.goto(base + url, { waitUntil: 'domcontentloaded' });
  if (waitFor) await p.waitForSelector(waitFor, { timeout: 15000 });
  await p.waitForTimeout(1200);   // let any straggler fire
  const bytes = [...asked].reduce((s, f) => s + sizeOf(f), 0);
  await p.close();
  return { layers: [...asked].sort(), kb: Math.round(bytes / 1024) };
}

const ALL_KB = Math.round(GEO.reduce((s, f) => s + sizeOf(f), 0) / 1024);
console.log(`(all four layers together are ${ALL_KB} KB raw)`);

console.log('\n=== the race chooser needs no geometry at all ===');
const chooser = await layersFor('/results.html', '.race-opt');
check('nothing but the shared projection is fetched', chooser.layers, ['states_geo.json']);
/**
 * 80 KB RAW, which is about 25 KB on the wire.
 *
 * This was 40, calibrated against a states_geo.json that was 23 KB — and tore.
 * That file was per-state ArcGIS output at 47.8% shared vertices, so blocks of
 * same-coloured states had visible slivers running through them. It is now
 * dissolved from wards through one topology: 72.6 KB raw, 24.6 KB gzipped,
 * 81.2% shared.
 *
 * The number that matters is the gzipped one, because that is what a phone
 * downloads, and this page PRE-WARMS the file without awaiting it — so the cost
 * is 16 KB more background traffic, not 16 KB more before the chooser paints.
 * The assertion still exists to catch the real regression it was written for:
 * a board's heavy layers (1.8 MB of LGA/constituency/district geometry) leaking
 * into a page that draws no map.
 */
check('and that is small', chooser.kb, (n) => n < 80);

console.log('\n=== a presidential board: states only ===');
const pres = await layersFor('/results.html?contest=PRES', '#map path');
check('states_geo only', pres.layers, ['states_geo.json']);
// Same 80 KB for the same reason as the chooser above: this board draws the
// state map, so states_geo.json is exactly what it SHOULD fetch — and
// nothing else. The guard is that the heavy layers stay out.
check(`~${ALL_KB} KB down to states only`, pres.kb, (n) => n < 80);

console.log('\n=== a Senate board: districts, and NOT the 774 LGAs ===');
const sen = await layersFor('/results.html?contest=SEN', '#map path');
check('districts plus the projection', sen.layers, ['district_geo.json', 'states_geo.json']);
check('lga_geo is not fetched', sen.layers, (l) => !l.includes('lga_geo.json'));
check('constituency_geo is not fetched', sen.layers, (l) => !l.includes('constituency_geo.json'));

console.log('\n=== a House board: constituencies only ===');
const rep = await layersFor('/results.html?contest=REP', '#map path');
check('constituencies plus the projection', rep.layers, ['constituency_geo.json', 'states_geo.json']);

console.log('\n=== a cropped board does need the LGAs ===');
const crop = await layersFor('/results.html?contest=GOV&state=Osun', '#map path');
check('lga_geo is fetched when the board is per-LGA', crop.layers, (l) => l.includes('lga_geo.json'));

console.log('\n=== and the numbers are painted before the map ===');
const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
let mapSeen = null, boardSeen = null;
const t0 = Date.now();
// Hold the big layer back so the ordering is observable rather than a race.
await p.route('**/constituency_geo.json', async (route) => {
  await new Promise((r) => setTimeout(r, 2500));
  await route.continue();
});
await p.goto(`${base}/results.html?contest=REP`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#board-rows tr', { timeout: 15000 });
boardSeen = Date.now() - t0;
await p.waitForSelector('#map path', { timeout: 20000 });
mapSeen = Date.now() - t0;
check(`board at ${boardSeen}ms, map at ${mapSeen}ms — board first`, boardSeen < mapSeen, true);
check('and the board did not wait on the held-back layer', boardSeen, (n) => n < 2500);
await p.close();

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

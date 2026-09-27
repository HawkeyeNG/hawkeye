/**
 * THE BASEMAP MUST NOT DEPEND ON tile.openstreetmap.org — AND MUST FALL BACK.
 *
 * Map a Polling Unit drew OSM's own raster tiles, which OSM's usage policy
 * forbids at election-night scale. app/basemap.js now draws our Nigeria PMTiles
 * (tiles.hawkeye.com.ng) and switches to OpenFreeMap only when ours fails.
 *
 * Every scenario loads the REAL page from app/ in headless Chromium. Our tile
 * host is answered from tests/fixtures/basemap_nigeria_z0-5.pmtiles (a real
 * Protomaps extract, z0-5) with genuine range responses; OpenFreeMap is the real
 * service, so the fallback scenarios need network.
 *
 *   primary        fixture served         → draws ours, never touches OpenFreeMap
 *   unreachable    connection refused     → OpenFreeMap
 *   not-pmtiles    200 HTML error page    → OpenFreeMap
 *   dies-later     header OK, tiles 503   → OpenFreeMap after 3 failures
 *   both-down      control                → 'none', and the page survives
 *   sw             page controlled by sw.js → still ours (tile hosts bypass the SW)
 *
 * "Drew" means tile canvases with more than one colour in them, not a flag.
 * When the private backend is checked out, its real CSP header is applied to
 * every response, so a missing connect-src host fails here too.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const FIXTURE = fs.readFileSync(`${ROOT}/tests/fixtures/basemap_nigeria_z0-5.pmtiles`);
const PRIMARY = 'https://tiles.hawkeye.com.ng/nigeria.pmtiles';
const SECURITY = `${ROOT}/backend/src/services/security.js`;
const securityHeaders = fs.existsSync(SECURITY) ? (await import(SECURITY)).securityHeaders : null;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- static server: app/ + stub API + (when available) the production CSP ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.geojson': 'application/json' };
const API = {
  '/api/mapping/stats': { verified: 10, total: 176846, crowdMapped: 2 },
  '/api/mapping/nearby': { units: [] },
  '/api/register/states': [],
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  req.path = u.pathname;
  const go = () => {
    if (u.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(API[u.pathname] ?? {}));
    }
    let p = path.join(APP, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!p.startsWith(APP) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  };
  if (securityHeaders) securityHeaders(req, res, go); else go();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(securityHeaders ? 'CSP: production header applied' : 'CSP: backend/ not checked out — CSP not enforced in this run');

// ---- the tile host, answered from the fixture with real range semantics ----
function serveRange(route, { dieAfterHeader = false } = {}) {
  const m = /bytes=(\d+)-(\d+)/.exec(route.request().headers().range || '');
  if (!m) return route.fulfill({ status: 200, body: FIXTURE, headers: { 'access-control-allow-origin': '*' } });
  const a = Number(m[1]); const b = Math.min(Number(m[2]), FIXTURE.length - 1);
  if (dieAfterHeader && a > 0) return route.fulfill({ status: 503, body: 'down', headers: { 'access-control-allow-origin': '*' } });
  return route.fulfill({
    status: 206,
    body: FIXTURE.subarray(a, b + 1),
    headers: {
      'content-type': 'application/vnd.pmtiles',
      'content-range': `bytes ${a}-${b}/${FIXTURE.length}`,
      'accept-ranges': 'bytes',
      etag: '"fixture-1"',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'ETag, Content-Range, Content-Length, Accept-Ranges',
    },
  });
}

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

async function run(name, primaryHandler, { sw = false, expect = null } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: sw ? 'allow' : 'block', viewport: { width: 900, height: 900 } });
  await ctx.route('https://tiles.hawkeye.com.ng/**', primaryHandler);
  const page = await ctx.newPage();
  const seen = { primary: 0, ofmJson: 0, ofmTiles: 0, osm: 0 };
  const errors = [];
  page.on('request', (r) => {
    const h = new URL(r.url()).hostname;
    if (h === 'tiles.hawkeye.com.ng') seen.primary++;
    else if (h === 'tiles.openfreemap.org') { if (r.url().endsWith('.pbf')) seen.ofmTiles++; else seen.ofmJson++; }
    else if (/openstreetmap\.org$/.test(h)) seen.osm++;
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    // Signed in (authgate.js bounces a signed-out visitor off this page).
    localStorage.setItem('hawkeye_token', `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.y`);
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });

  await page.goto(`${BASE}/map-unit.html`);
  let controlled = null;
  if (sw) {
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready));
    await page.reload();
    controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  }
  // Wait for the EXPECTED outcome when there is one: a mid-session switch lands
  // after the first basemap has already reported itself.
  await page.waitForFunction((want) => { const k = document.getElementById('lmap').dataset.basemap; return want ? k === want : k; }, expect, { timeout: 30000 }).catch(() => {});
  const kind = await page.evaluate(() => document.getElementById('lmap').dataset.basemap || '(unset)');
  // Tiles render after a short stagger; wait for Leaflet to mark them loaded.
  if (kind !== 'none') await page.waitForFunction(() => document.querySelectorAll('#lmap canvas.leaflet-tile-loaded').length >= 4, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const drawn = await page.evaluate(() => {
    const colours = new Set();
    let tiles = 0;
    for (const c of document.querySelectorAll('#lmap canvas.leaflet-tile-loaded')) {
      tiles++;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let y = 0; y < c.height; y += 16) for (let x = 0; x < c.width; x += 16) {
        const i = (y * c.width + x) * 4; colours.add(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
      }
    }
    return { tiles, colours: colours.size };
  });
  const attribution = await page.evaluate(() => (document.querySelector('.leaflet-control-attribution') || {}).textContent || '');
  const csp = await page.evaluate(() => window.__csp);
  await ctx.close();
  const out = { name, kind, seen, errors, drawn, attribution, csp, controlled };
  if (process.env.BASEMAP_DEBUG) console.log(JSON.stringify(out));
  return out;
}

const isNetFail = (e) => /Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR_FAILED/.test(e);
const onlyTileErrors = (e) => isNetFail(e) || /Bad response code|503|tile/i.test(e);

// 1. Ours works → ours is used, OpenFreeMap never contacted, OSM never contacted.
let r = await run('primary', (route) => serveRange(route));
check('primary: basemap is ours', r.kind, 'primary');
check('primary: range requests reached our tile host', r.seen.primary, (n) => n >= 1);
check('primary: OpenFreeMap never contacted', r.seen.ofmJson + r.seen.ofmTiles, 0);
check('primary: tile.openstreetmap.org never contacted', r.seen.osm, 0);
check('primary: tiles actually drawn (≥4 canvases, >2 colours)', r.drawn, (d) => d.tiles >= 4 && d.colours > 2);
check('primary: attribution credits Protomaps + OSM contributors', r.attribution, (t) => /Protomaps/.test(t) && /OpenStreetMap contributors/.test(t));
check('primary: no console errors', r.errors, []);
check('primary: no CSP violations', r.csp, []);

// 2. CONTROL — ours unreachable → OpenFreeMap.
r = await run('unreachable', (route) => route.abort('connectionrefused'));
check('unreachable: falls back to OpenFreeMap', r.kind, 'fallback');
check('unreachable: OpenFreeMap TileJSON + tiles fetched', r.seen, (s) => s.ofmJson >= 1 && s.ofmTiles >= 1);
check('unreachable: fallback tiles actually drawn', r.drawn, (d) => d.tiles >= 4 && d.colours > 2);
check('unreachable: attribution credits OpenFreeMap + OpenMapTiles + OSM', r.attribution, (t) => /OpenFreeMap/.test(t) && /OpenMapTiles/.test(t) && /OpenStreetMap contributors/.test(t));
check('unreachable: only the refused request errors', r.errors.filter((e) => !isNetFail(e)), []);
check('unreachable: no CSP violations', r.csp, []);

// 3. Ours answers with something that is not a PMTiles archive (an edge error page).
r = await run('not-pmtiles', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>502 Bad Gateway</html>'.padEnd(20000, ' '), headers: { 'access-control-allow-origin': '*' } }));
check('not-pmtiles: falls back to OpenFreeMap', r.kind, 'fallback');

// 4. Header loads, then every tile read fails (R2/edge dies mid-session).
r = await run('dies-later', (route) => serveRange(route, { dieAfterHeader: true }), { expect: 'fallback' });
check('dies-later: switches to OpenFreeMap', r.kind, 'fallback');
check('dies-later: fallback tiles drawn', r.drawn, (d) => d.tiles >= 4 && d.colours > 2);
check('dies-later: no errors beyond the failing tiles', r.errors.filter((e) => !onlyTileErrors(e)), []);

// 5. CONTROL — both down: the harness can see a failure, and the page survives it.
const ctxBlock = async (route) => route.abort('connectionrefused');
{
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.route('https://tiles.hawkeye.com.ng/**', ctxBlock);
  await ctx.route('https://tiles.openfreemap.org/**', ctxBlock);
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('hawkeye_token', `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.y`));
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/map-unit.html`);
  await page.waitForFunction(() => document.getElementById('lmap').dataset.basemap, null, { timeout: 30000 }).catch(() => {});
  check('both-down: reports no basemap', await page.evaluate(() => document.getElementById('lmap').dataset.basemap), 'none');
  check('both-down: map still exists, no uncaught errors', { map: await page.evaluate(() => !!document.querySelector('#lmap.leaflet-container')), errs }, { map: true, errs: [] });
  await ctx.close();
}

// 6. A page controlled by the service worker (its own CSP) still reaches our tiles.
r = await run('sw', (route) => serveRange(route), { sw: true });
check('sw: page really is controlled by sw.js', r.controlled, true);
check('sw: basemap is ours', r.kind, 'primary');
check('sw: tiles drawn', r.drawn, (d) => d.tiles >= 4 && d.colours > 2);
check('sw: no console errors', r.errors, []);
check('sw: no CSP violations', r.csp, []);

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

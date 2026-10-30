/**
 * Prove sw.js refills a SHELL entry whose precache fetch failed.
 *
 *   node check_sw_refill.mjs [--sw path/to/sw.js] [--fail '/sheet-counts.js?v=1']
 *
 * Serves app/ no-store from a throwaway server that answers 503 for one SHELL
 * URL, installs the worker in a fresh headless Chromium, views the page that
 * needs that URL once online, then kills the server (sockets destroyed) and
 * opens that page again. Two faults:
 *   once     the first request fails     -> the install's retry must fill it
 *   install  every request fails until the worker is active
 *                                        -> one online view must fill it
 * and the page must then work offline in both. --sw swaps in another worker
 * (the previous one from git, say) as the control: it must FAIL this check.
 * Observed live on 30 Oct 2026: a fresh install held 40/45 with every missing
 * URL answering 200, and kept the holes until the next CACHE bump.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../../app');
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i > -1 ? argv[i + 1] : d;
};
const SW = path.resolve(arg('sw', path.join(APP, 'sw.js')));
const FAIL = arg('fail', '/sheet-counts.js?v=1');
const PAGE = arg('page', '/observe.html'); // a SHELL page that loads FAIL
const PROBE = arg('probe', 'HAWKEYE_SHEETCOUNTS'); // a global FAIL defines

const swSrc = fs.readFileSync(SW, 'utf8');
const CACHE = swSrc.match(/const CACHE = '([^']+)'/)[1];
const SHELL = JSON.parse(swSrc.match(/const SHELL = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
if (!SHELL.includes(FAIL)) throw new Error(`${FAIL} is not in SHELL`);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.geojson': 'application/json',
};

/** failFirst: how many requests for FAIL get a 503 (Infinity = until heal()). */
function serve(failFirst) {
  const s = { n503: 0, n200: 0, failing: true };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const exact = u.pathname + u.search;
    if (exact === FAIL && s.failing && s.n503 < failFirst) {
      s.n503++;
      res.writeHead(503, { 'cache-control': 'no-store' });
      res.end('try again');
      return;
    }
    const rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
    const file = rel === '/sw.js' ? SW : path.join(APP, rel);
    if (file !== SW && !file.startsWith(APP + path.sep)) { res.writeHead(404); res.end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
      if (exact === FAIL) s.n200++;
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  server.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(Object.assign(s, {
    port: server.address().port,
    heal: () => { s.failing = false; },
    kill: () => new Promise((k) => { server.close(k); for (const c of sockets) c.destroy(); }),
  }))));
}

const shellHeld = (page) => page.evaluate(async ([name, shell]) => {
  const keys = (await (await caches.open(name)).keys()).map((r) => { const u = new URL(r.url); return u.pathname + u.search; });
  return { n: shell.filter((u) => keys.includes(u)).length, keys };
}, [CACHE, SHELL]);

async function scenario(browser, label, failFirst) {
  const srv = await serve(failFirst);
  const base = `http://127.0.0.1:${srv.port}`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const r = { label };
  try {
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); // install, retries included, has settled
    srv.heal();
    const inst = await shellHeld(page);
    r.afterInstall = inst.n;
    r.n503 = srv.n503;

    // One online view of the page that needs FAIL.
    await page.goto(base + PAGE, { waitUntil: 'domcontentloaded' });
    r.onlineControlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    r.onlineWorks = await page.evaluate((g) => typeof window[g] !== 'undefined', PROBE);
    let view = await shellHeld(page);
    for (let i = 0; i < 20 && !view.keys.includes(FAIL); i++) { await page.waitForTimeout(250); view = await shellHeld(page); }
    r.afterView = view.n;

    await srv.kill();
    // Control: a URL the cache cannot hold must fail now, or "offline" proves nothing.
    r.serverGone = await page.evaluate(() => fetch('/about.html?probe=' + Date.now()).then(() => false, () => true));
    await page.goto(base + PAGE, { waitUntil: 'domcontentloaded' });
    r.offlineWorks = await page.evaluate((g) => typeof window[g] !== 'undefined', PROBE);
  } catch (err) {
    r.error = String(err.message || err).split('\n')[0];
  } finally {
    await ctx.close();
    await srv.kill().catch(() => {});
  }
  return r;
}

const browser = await chromium.launch();
console.log(`worker ${SW}\nCACHE ${CACHE}, SHELL ${SHELL.length}, fault on ${FAIL}, page ${PAGE}\n`);
const once = await scenario(browser, 'once', 1);
const install = await scenario(browser, 'install', Infinity);
await browser.close();

const N = SHELL.length;
let ok = true;
for (const r of [once, install]) {
  // The fault must actually have fired, the page must have been under the
  // worker, and the server must really be gone — or the run proves nothing.
  const valid = !r.error && r.n503 >= 1 && r.onlineControlled && r.serverGone;
  const filled = r.label === 'once' ? r.afterInstall === N : r.afterView === N;
  const pass = valid && filled && r.offlineWorks;
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${r.label.padEnd(8)} 503s=${r.n503}  after install ${r.afterInstall}/${N}`
    + `  after 1 online view ${r.afterView}/${N}  online page ok=${r.onlineWorks}`
    + `  server gone=${r.serverGone}  offline page ok=${r.offlineWorks}${valid ? '' : '  (INVALID RUN)'}${r.error ? '  ' + r.error : ''}`);
}
process.exit(ok ? 0 : 1);

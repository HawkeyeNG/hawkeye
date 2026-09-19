import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/admin_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.startsWith('/api/')) return json({ ok: true, observers: [], incidents: [], labels: [], stats: {}, rows: [], items: [] });
  const f = path.join(APP, decodeURIComponent(u));
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
/**
 * A TOKEN authgate.js WILL ACCEPT — it base64-decodes the JWT payload and
 * checks `exp` rather than calling the server, and admin.html is not on its
 * public list. Without this the page redirects to observe.html and every
 * assertion below is made against the sign-in screen, which is how this first
 * failed against markup that was perfectly correct.
 */
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript((t) => {
  try { localStorage.setItem('hawkeye_token', t); } catch (e) { /* about:blank */ }
}, jwt);
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

// ---- LOCKED: the console has nothing to navigate, so no tabs ------------
await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
check('CONTROL the auth gate let us onto the console', p.url(), (u) => /admin\.html/.test(u));
check('locked: the tab strip is hidden', await p.evaluate(() => document.getElementById('panelbar').hidden), true);
check('locked: nothing renders it anyway', await p.evaluate(() => {
  const el = document.getElementById('panelbar');
  return getComputedStyle(el).display === 'none' || el.getBoundingClientRect().height === 0;
}), true);
check('the crest is the hawk, not an emoji', await p.evaluate(() => {
  const c = document.querySelector('.crest');
  return c && c.tagName === 'IMG' && /logo\.svg/.test(c.getAttribute('src'));
}), true);
check('its own manifest is linked', await p.evaluate(() =>
  document.querySelector('link[rel=manifest]')?.getAttribute('href')), (h) => /admin\.webmanifest/.test(h || ''));
check('install is hidden until the browser offers it', await p.evaluate(() =>
  document.getElementById('btn-install').hidden), true);
await p.screenshot({ path: `${OUT}/locked.png` });

// ---- UNLOCKED ----------------------------------------------------------
await p.evaluate(() => {
  sessionStorage.setItem('hawkeye_admin', 'test');
  localStorage.setItem('hawkeye_admin', 'test');
});
await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(700);
const shown = await p.evaluate(() => !document.getElementById('panelbar').hidden);
check('unlocked: the tab strip appears', shown, true);
if (shown) {
  check('all nine buttons are there', await p.evaluate(() =>
    [...document.querySelectorAll('#panelbar .tab')].map((t) => t.textContent.trim())),
    (v) => v.length === 9 && v[0] === 'Reach' && /Lock/.test(v[8]));
  check('they sit inside the header', await p.evaluate(() =>
    !!document.querySelector('header #panelbar')), true);
  // The header must not scroll away from a long panel: that was the point.
  check('and above the main content', await p.evaluate(() => {
    const bar = document.getElementById('panelbar').getBoundingClientRect();
    const main = document.querySelector('main').getBoundingClientRect();
    return bar.bottom <= main.top + 1;
  }), true);
  /**
   * EVERY LABEL IS READABLE. The first version of this header put white pills
   * on the dark green bar and set no text colour, so the tabs inherited the
   * header's #fff and eight of the nine labels were white on white — laid out
   * perfectly, and invisible. A layout assertion cannot see that.
   */
  check('every tab label contrasts with its own pill', await p.evaluate(() => {
    const lum = (c) => {
      const [r, g, b] = (c.match(/\d+/g) || [0, 0, 0]).map(Number);
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    };
    return [...document.querySelectorAll('#panelbar .tab')].every((t) => {
      const st = getComputedStyle(t);
      return Math.abs(lum(st.color) - lum(st.backgroundColor)) > 0.35;
    });
  }), true);

  // Switching still works after the move — the handler binds by id.
  await p.click('#panelbar .tab[data-p="push"]');
  await p.waitForTimeout(250);
  check('clicking a tab still switches the panel', await p.evaluate(() => {
    const on = document.querySelector('#panelbar .tab.on')?.dataset.p;
    const vis = [...document.querySelectorAll('.panel')].filter((x) => !x.hidden).map((x) => x.dataset.p);
    return { on, vis };
  }), (r) => r.on === 'push' && r.vis.length === 1 && r.vis[0] === 'push');
  await p.screenshot({ path: `${OUT}/unlocked.png` });
}
check('no page errors', errs, []);

await b.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

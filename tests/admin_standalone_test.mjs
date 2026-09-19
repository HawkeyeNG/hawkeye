/**
 * THE CONSOLE AS AN INSTALLED APP — the window nothing ever tested.
 *
 * Every other admin test opens a browser TAB. In a tab the Install button
 * exists, so the code path that removed it never ran, and the bug it caused
 * could not appear:
 *
 *   if (INSTALLED) btn.remove();
 *   ...
 *   document.getElementById('btn-install').addEventListener(...)   // null
 *
 * That TypeError killed the rest of its <script> — and the rest of that script
 * was the observer that reveals the tab strip. An installed console rendered
 * with no navigation at all, while a tab rendered perfectly and twenty
 * assertions passed.
 *
 * Chrome's --app= is how an installed PWA is launched, and it is the only way
 * to get display-mode: standalone honestly. Emulating it through CDP silently
 * did nothing — the run reported "browser" in both modes and agreed with
 * itself, which is worse than not testing at all.
 */
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
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"rows":[],"items":[],"stats":{},"observers":[]}'); }
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

const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';

const ctx = await chromium.launchPersistentContext('', {
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: [`--app=${base}/admin.html`],
  viewport: { width: 1280, height: 900 },
});
const p = ctx.pages()[0] || await ctx.waitForEvent('page');
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await p.addInitScript((t) => {
  localStorage.setItem('hawkeye_token', t);
  sessionStorage.setItem('hawkeye_admin', 'test');
  localStorage.setItem('hawkeye_admin', 'test');
}, jwt);
await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);

const state = await p.evaluate(() => {
  const bar = document.getElementById('panelbar');
  const r = bar && bar.getBoundingClientRect();
  return {
    standalone: matchMedia('(display-mode: standalone)').matches,
    consoleOpen: !document.getElementById('console').hidden,
    barDrawn: !!r && r.width > 100 && r.height > 20,
    // The nine PANEL tabs — Install is a .tab with no data-p and is asserted
    // separately, because in an installed window it is present and not drawn.
    tabs: bar ? [...bar.querySelectorAll('.tab[data-p]')].map((t) => t.textContent.trim()) : [],
    installDrawn: (() => {
      const b = document.getElementById('btn-install');
      if (!b) return 'REMOVED';
      return b.getBoundingClientRect().width > 0;
    })(),
    headerH: Math.round(document.querySelector('header').getBoundingClientRect().height),
    spread: (() => {
      const t = bar ? [...bar.querySelectorAll('.tab')] : [];
      if (!t.length) return -1;
      const tops = t.map((x) => x.getBoundingClientRect().top);
      return Math.round(Math.max(...tops) - Math.min(...tops));
    })(),
  };
});

// CONTROL: if this is not actually an app window, everything below is a
// re-run of the tab tests and proves nothing.
check('CONTROL this really is an installed window', state.standalone, true);
check('the console is open', state.consoleOpen, true);
check('NO page errors', errs, []);
check('the tab strip is drawn', state.barDrawn, true);
check('with the nine panel tabs', state.tabs,
  ['Reach', 'Incidents', 'Labels', 'Pairs', 'Push', 'Races', 'Social', 'Register', 'Lock 🔒']);
// Hidden, not removed — removing it is what produced the null.
check('Install is present but not drawn', state.installDrawn, false);
check(`on one line (spread ${state.spread}px)`, state.spread, (v) => v >= 0 && v < 12);
check(`header is one row tall (${state.headerH}px)`, state.headerH, (v) => v < 90);

// A tab must still switch panels — the click handler lives in the same script
// that used to die.
const switched = await p.evaluate(async () => {
  const t = document.querySelector('#panelbar .tab[data-p="incidents"]');
  if (!t) return 'no tab';
  t.click();
  await new Promise((r) => setTimeout(r, 150));
  const open = [...document.querySelectorAll('.panel')].filter((x) => !x.hidden);
  return open.length === 1 ? open[0].dataset.p : `open=${open.length}`;
});
check('and clicking one still switches the panel', switched, 'incidents');

await p.screenshot({ path: `${OUT}/standalone.png` });
await ctx.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — the installed console has its navigation');
process.exit(fail ? 1 : 0);

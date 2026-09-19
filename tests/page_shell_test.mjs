/**
 * THE DESKTOP SHELL, on every page that has a header and a main.
 *
 * The header becomes a flex row of its own and the scroll container starts
 * below it, so the platform scrollbar no longer runs past the header. That is a
 * change to the document structure of 44 pages made from one script, which is
 * exactly the kind of change that is cheap to make and expensive to get wrong —
 * so this walks a spread of them and asserts the page still works, not just
 * that the wrapper exists.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.geojson': 'application/json' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"contests":[],"races":[],"rows":[],"items":[],"observers":[]}'); }
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
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
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';

/* A spread: the landing page, a long data page, a form-heavy one, the console,
   and a page behind the auth gate. */
const PAGES = ['index.html', 'dashboard.html', 'results.html', 'faq.html', 'admin.html', 'profile.html'];

async function look(page, width) {
  const ctx = await b.newContext({ viewport: { width, height: 800 } });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('hawkeye_token', t);
      sessionStorage.setItem('hawkeye_admin', 'test');
      localStorage.setItem('hawkeye_admin', 'test');
    } catch (e) {}
  }, jwt);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  await p.goto(`${base}/${page}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    const hdr = document.querySelector('.gov-header');
    const pane = document.getElementById('page-scroll');
    const shell = document.documentElement.classList.contains('has-shell');
    const bodyScrolls = document.documentElement.scrollHeight > window.innerHeight + 2;
    return {
      shell,
      hasPane: !!pane,
      // INSIDE the pane, not a direct child of it: index.html nests main in
      // the hero wrapper, and a :scope > main assertion called that a failure
      // when the page was wrapped correctly.
      mainInPane: !!pane && !!document.querySelector('main') && pane.contains(document.querySelector('main')),
      footInPane: !!pane && (!document.querySelector('footer') || pane.contains(document.querySelector('footer'))),
      paneTop: pane ? Math.round(pane.getBoundingClientRect().top) : null,
      hdrBottom: hdr ? Math.round(hdr.getBoundingClientRect().bottom) : null,
      paneScrolls: pane ? getComputedStyle(pane).overflowY : null,
      bodyScrolls,
      // Nothing may be hidden behind a collapsed pane.
      paneH: pane ? Math.round(pane.getBoundingClientRect().height) : null,
    };
  });
  r.errs = errs;
  await ctx.close();
  return r;
}

console.log('=== desktop: the pane starts below the header ===');
for (const page of PAGES) {
  const r = await look(page, 1280);
  check(`${page}: wrapped`, [r.shell, r.hasPane, r.mainInPane], [true, true, true]);
  check(`${page}: the pane owns the scrolling`, r.paneScrolls, 'auto');
  // THE POINT OF ALL OF IT: the scroll container begins where the header ends.
  check(`${page}: pane starts at the header's bottom edge`, Math.abs(r.paneTop - r.hdrBottom), (d) => d <= 2);
  check(`${page}: the document itself does not scroll`, r.bodyScrolls, false);
  check(`${page}: the pane has real height`, r.paneH, (h) => h > 300);
  check(`${page}: no page errors`, r.errs, []);
}

console.log('\n=== a phone is left alone ===');
{
  // CONTROL. Below 900px menu.js still hides the header on scroll, and that
  // listener only fires while the DOCUMENT scrolls — so the shell must not
  // apply, or a phone would be left with whatever state the header was in.
  const r = await look('index.html', 420);
  check('the wrapper still exists (inert)', r.hasPane, true);
  check('but the pane does not take the scrolling', r.paneScrolls, (v) => v !== 'auto');
  check('and the document scrolls as it always did', r.bodyScrolls, true);
}

await b.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

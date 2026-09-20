/**
 * THE CONSOLE FOOTERS ARE PINNED, AND THE ROOM'S IS REACHABLE AT ALL.
 *
 * The room's copyright line was in the HTML from the day it was asked for, and
 * was reported as never delivered — because it sat INSIDE #sr-scroll, after
 * every board, table and roster. Grepping the file said "present"; the screen
 * said "missing". Both were right.
 *
 * So this asserts the two things a grep cannot: WHERE the footer sits in the
 * tree, and what pins it. Checked on the parsed page rather than the source,
 * and with a control so "not inside the scroller" cannot pass because the
 * scroller is gone.
 */
/**
 * SERVED OVER HTTP AND SIGNED IN, because neither is optional here.
 *
 * The first version of this file loaded app/admin.html over file:// and
 * asserted against whatever came back. authgate.js redirects a signed-out
 * visitor to observe.html, so every "admin" assertion was actually measuring
 * the PUBLIC page's footer — it reported position:static and the site nav, and
 * it was right about a page nobody asked it to look at. localStorage is
 * unavailable on file://, so seeding a token needs a real origin too.
 *
 * The URL is asserted after each load. A test that silently follows a redirect
 * is a test of the redirect.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const file = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!file.startsWith(APP) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}`);
};

const b = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});
/* authgate.js does not check that a token EXISTS, it decodes the payload and
   checks `exp` — so a placeholder string is treated as signed out and the page
   bounces. A real shape with a future expiry is the only thing that opens it. */
const jwt = 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
  .toString('base64').replace(/=+$/, '') + '.s';
const ctx = await b.newContext();
await ctx.addInitScript((t) => {
  try {
    localStorage.setItem('hawkeye_token', t);
    localStorage.setItem('hawkeye_admin', 'test-secret');
  } catch (e) { /* no storage, and the URL check below will catch the fallout */ }
}, jwt);
const page = await ctx.newPage();
const open = async (name) => {
  await page.goto(`${base}/${name}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  check(`CONTROL still on ${name}, not redirected`,
    await page.evaluate(() => location.pathname.split('/').pop()), name);
};

console.log('\n=== situation room ===');
await open('situation-room.html');
const room = await page.evaluate(() => {
  const f = document.querySelector('footer.gov-footer');
  const cs = f && getComputedStyle(f);
  return {
    exists: !!f,
    parent: f && f.parentElement.tagName,
    inScroller: !!(f && f.closest('#sr-scroll')),
    scrollerExists: !!document.getElementById('sr-scroll'),
    marginTop: cs && cs.marginTop,
    flexShrink: cs && cs.flexShrink,
    bodyColumn: getComputedStyle(document.body).flexDirection,
    text: f && f.textContent.trim().slice(0, 40),
  };
});
check('CONTROL the scroller still exists, so the next check means something',
  room.scrollerExists, true);
/* Parentage was the wrong assertion: shell.js re-homes body children, so
   "child of BODY" fails for a footer that is nonetheless pinned. What was
   asked for is positional — so measure the position. */
const pinned = await page.evaluate(() => {
  const f = document.querySelector('footer.gov-footer');
  const before = f.getBoundingClientRect();
  const sc = document.getElementById('sr-scroll');
  sc.scrollTop = sc.scrollHeight;                       // drive it to the end
  const after = f.getBoundingClientRect();
  return {
    parent: f.parentElement.tagName + (f.parentElement.id ? '#' + f.parentElement.id : ''),
    gapToViewportFloor: Math.round(window.innerHeight - before.bottom),
    movedWhenScrolled: Math.round(Math.abs(after.top - before.top)),
    scrolled: sc.scrollTop > 0,
  };
});
console.log(`        (footer parent: ${pinned.parent})`);
check('it sits on the viewport floor', pinned.gapToViewportFloor, (g) => g <= 1);
check('CONTROL the pane really did scroll', pinned.scrolled, true);
check('and it does not move when the pane scrolls', pinned.movedWhenScrolled, 0);
check('nothing puts it back inside #sr-scroll', room.inScroller, false);
check('body is the flex column that pins it', room.bodyColumn, 'column');
check('it does not shrink away', room.flexShrink, '0');
check('the document-footer top margin is gone', room.marginTop, '0px');
check('and it is the copyright line', room.text, (t) => /IniXien, LLC/.test(t || ''));

console.log('\n=== admin console ===');
await open('admin.html');
const admin = await page.evaluate(() => {
  const f = document.querySelector('footer.gov-footer');
  const cs = f && getComputedStyle(f);
  return {
    exists: !!f,
    position: cs && cs.position,
    bottom: cs && cs.bottom,
    text: f && f.textContent.trim().slice(0, 40),
  };
});
check('the footer is there', admin.exists, true);
check('pinned to the bottom of the screen', admin.position, 'sticky');
check('at the floor, not floating', admin.bottom, '0px');
check('and it is the same copyright line', admin.text, (t) => /IniXien, LLC/.test(t || ''));

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

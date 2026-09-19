/**
 * THE CONSOLE CAN ACTUALLY BE INSTALLED.
 *
 * An Install button that is hidden until beforeinstallprompt fires is only as
 * good as the page's installability, and Chrome will not fire that event for a
 * page no service worker controls. admin.html registered none — app.js is the
 * only file that does, and the console does not load it — so the button was
 * correct, the manifest was correct, and the event could never fire. It shipped
 * that way twice.
 *
 * This asserts Chrome's own preconditions rather than the button's markup,
 * because the markup was never the thing that was wrong.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
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
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((t) => {
  try {
    localStorage.setItem('hawkeye_token', t);
    sessionStorage.setItem('hawkeye_admin', 'test');
    localStorage.setItem('hawkeye_admin', 'test');
  } catch (e) {}
}, jwt);
const p = await ctx.newPage();
await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);

console.log('=== Chrome\'s installability preconditions ===');

// 1. A service worker CONTROLS the page. This is the one that was missing.
const sw = await p.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const regs = await navigator.serviceWorker.getRegistrations();
  return { supported: true, count: regs.length, scopes: regs.map((r) => r.scope) };
});
check('a service worker is registered', sw, (v) => v.supported && v.count > 0);
check('and its scope covers /admin.html', sw.scopes || [], (s2) => s2.some((x) => new URL(x).pathname === '/'));

// 2. The manifest is its own, reachable, and has what Chrome requires.
const man = await p.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.getAttribute('href');
  if (!href) return null;
  const m = await fetch(href).then((r) => r.json());
  return {
    href, id: m.id, start: m.start_url, display: m.display,
    icons: (m.icons || []).map((i) => i.sizes),
    maskable: (m.icons || []).some((i) => (i.purpose || '').includes('maskable')),
    name: m.name,
  };
});
check('the console has its OWN manifest', man && man.href, (h) => /admin\.webmanifest/.test(h || ''));
check('starting at the console, not the observer app', man && man.start, '/admin.html');
check('display: standalone', man && man.display, 'standalone');
check('a 192 and a 512 icon', man && man.icons, (s2) => s2.includes('192x192') && s2.includes('512x512'));
check('and a maskable one', man && man.maskable, true);

// 3. The button exists and is correctly hidden until the event fires.
const btn = await p.evaluate(() => {
  const el = document.getElementById('btn-install');
  return el ? { present: true, hidden: el.hidden, display: getComputedStyle(el).display } : { present: false };
});
check('the Install button is in the header', btn.present, true);
// CONTROL: hidden means hidden. An author display rule beats [hidden], which is
// how the situation room once drew an empty pill in its installed window.
check('hidden, and actually not drawn', [btn.hidden, btn.display], [true, 'none']);

await b.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed — Chrome can offer the install');
process.exit(fail ? 1 : 0);

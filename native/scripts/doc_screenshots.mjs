/**
 * Native screens for the funding document's Section 3.
 *
 * Separate from play_screenshots_native.mjs on purpose. That script shoots the
 * seven STORE-LISTING frames and enforces a Play rule — every frame must carry
 * the "not government or INEC affiliated" disclaimer, because the app was
 * rejected twice for exactly that. These have a different job: each frame must
 * demonstrate a specific anti-fraud claim made beside it in the document.
 *
 * Same mechanism as its sibling: `expo export --platform web` renders the SAME
 * React Native components through react-native-web, so these are the real native
 * screens, not the separate web app's UI.
 *
 * ── THE NETWORK PROBLEM, AND WHY THE FLAG IS HERE ────────────────────────────
 * src/lib/api.ts points at https://hawkeye.com.ng, baked in at export time. From
 * a 127.0.0.1 page those calls are cross-origin, production sends no
 * Access-Control-Allow-Origin, and every data screen renders "Could not load —
 * check your network". api.ts documents this exactly. It makes a working app
 * look broken, and five of the seven store frames currently show it.
 *
 * Three fixes were tried before this one. Baking EXPO_PUBLIC_API_BASE into a
 * fresh export: the value never reached the bundle. Fetching each request
 * through Playwright and re-serving it with the CORS header: the auth endpoints
 * then SUCCEEDED, the app learned the screenshot token was not real, signed
 * itself out, and every guarded route bounced to /welcome. Blocking only
 * /api/observers/*: same bounce. What works is the blunt flag — the origin check
 * off and nothing else disturbed.
 *
 * ── WHAT THE SESSION DOES AND DOES NOT BUY ───────────────────────────────────
 * app/_layout.tsx bounces a signed-out visitor to /welcome from everything
 * except /welcome and /sign-in, so most screens need a seeded session to render
 * themselves rather than the door. bootstrapAuth (src/lib/auth.ts:271) trusts a
 * stored token without revalidating it, so writing the two keys is enough.
 *
 * NOTHING SHOWN IS FABRICATED. Every screen reads public endpoints — the
 * integrity summary, the Benford and IReV series, the ledger head, the docket —
 * and displays exactly what production returns, zeros included. The session buys
 * the app's own navigation, not its contents. /sign-in is shot signed OUT,
 * because with a session it redirects and the frame carrying "your number is
 * never stored — only a one-way hash" would be lost.
 *
 *   node scripts/doc_screenshots.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const DIST = '/home/elrio/hawkeye/native/dist';
const OUT = '/home/elrio/hawkeye/tmp/native-sec3';
const API = 'https://hawkeye.com.ng';
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/') || (/\.(json)$/.test(url) && !fs.existsSync(path.join(DIST, url)))) {
    try {
      const r = await fetch(API + req.url, { headers: { 'user-agent': 'hawkeye-shots' } });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      return res.end(buf);
    } catch { res.writeHead(502); return res.end('{}'); }
  }
  let f = path.join(DIST, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(f) && fs.existsSync(`${f}.html`)) f = `${f}.html`;
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// name, route, signed-in?, the claim it is meant to evidence
//
// ORDER MATTERS. The signed-out frame clears localStorage to escape the
// redirect, and one page is shared across the run, so anything shot after it
// starts signed out and bounces to /welcome. Shooting it last confines that to
// itself — with signin first, all four guarded screens came back as the welcome
// page.
const SHOTS = [
  ['integrity', '/integrity', true, 'The machine flags; Nigerians decide'],
  ['ledger', '/ledger', true, 'An unbroken chain, anchored where we cannot reach it'],
  ['docket', '/docket', true, 'A disputed number stops travelling'],
  ['races', '/races', true, 'Every race, followable'],
  ['signin', '/sign-in', false, 'One phone, one race'],
];

const browser = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: [
    '--force-device-scale-factor=2',
    '--font-render-hinting=none',
    // See the note above. Screenshots only; nothing built or shipped goes
    // through this browser.
    '--disable-web-security',
  ],
});

const page = await browser.newPage({
  viewport: { width: 540, height: 960 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile',
});

await page.addInitScript(() => {
  try {
    localStorage.setItem('hawkeye.auth.token', 'screenshot-session');
    localStorage.setItem('hawkeye.auth.observer', '1');
    // expo-secure-store's web shim has used a prefix in some versions; set both
    // rather than depend on which one this SDK ships.
    localStorage.setItem('secure-store.hawkeye.auth.token', 'screenshot-session');
    localStorage.setItem('secure-store.hawkeye.auth.observer', '1');
  } catch { /* storage blocked — the run will land on welcome and say so */ }
});

const report = [];
for (const [name, route, signedIn, evidences] of SHOTS) {
  // /sign-in must be reached WITHOUT a session, or the router redirects away
  // from it — so the seeded keys are cleared for that one frame only.
  if (!signedIn) {
    await page.goto(`${BASE}/welcome`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* blocked */ } });
  }

  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 60000 });
  } catch {
    // networkidle never settles on a screen that polls; the paint is what matters.
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(4000);

  const text = await page.evaluate(() => document.body.innerText);
  // Both failures must be caught by name, because either would put a frame into
  // a funding document showing something other than what its caption claims.
  const bounced = /Welcome to Hawkeye|Independent Election Results Monitor/i.test(text);
  const errored = /Could not (load|refresh|reach)|No connection|did not reach this device/i.test(text);
  await page.screenshot({ path: `${OUT}/${name}.png`, type: 'png' });
  report.push({ name, route, signedIn, evidences, bounced, errored, chars: text.length,
                head: text.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 84) });
  const flag = bounced ? 'BOUNCED' : errored ? 'ERRORED' : 'ok     ';
  console.log(`${flag} ${name.padEnd(10)} ${String(text.length).padStart(5)} chars  ${report.at(-1).head}`);
}

await browser.close();
server.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const usable = report.filter((r) => !r.bounced && !r.errored);
console.log(`\n${usable.length}/${report.length} usable: ${usable.map((r) => r.name).join(', ') || 'none'}`);

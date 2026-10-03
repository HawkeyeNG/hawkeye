/**
 * NO SIGNAL IS NOT SIGNED OUT (design audit 2026-10 X1, P1).
 *
 * Home (index.html) dropped hawkeye_token on ANY failed /api/observers/me, so
 * an observer at a polling unit with one bar was shown the sign-up screen
 * (Lite) or the landing page (web). The rule now, for web AND Lite: a session
 * ends only on a 401 whose JSON names an auth error (backend requireObserver:
 * missing_token / invalid_token / unknown_observer / signed_in_elsewhere /
 * device_mismatch). Offline, a 5xx, a Cloudflare HTML page, an unparseable
 * 200, or a 401 that is not an auth error keep the session and say "Could not
 * reach Hawkeye".
 *
 * Proven on Home, Profile and Alerts, as the website and as Lite (Capacitor
 * stub: every /api call goes to https://hawkeye.com.ng and is intercepted here):
 *   - offline / 500 / HTML 502 / HTML 200 / 401 non-auth  -> still signed in,
 *     the offline line shows, Home/Profile paint from the last /me kept;
 *   - CONTROL 401 invalid_token and 401 signed_in_elsewhere -> signed out;
 *   - CONTROL the same offline run against the PREVIOUS index.html (git HEAD
 *     at the time this test was written, or --old <file>) signs out — so this
 *     harness can see the bug it guards against;
 *   - Try again recovers once the server answers;
 *   - Alerts offline says "could not reach", never "No notifications yet".
 *
 *   node tests/offline_session_test.mjs
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/json' };
const argv = process.argv.slice(2);
const oldIdx = argv.indexOf('--old');
/* The pre-fix Home: the committed copy that still has the bug, so the control
   keeps meaning something after this change is committed. */
const OLD_INDEX = oldIdx > -1
  ? fs.readFileSync(argv[oldIdx + 1], 'utf8')
  : execFileSync('git', ['-C', '/home/elrio/hawkeye', 'show', '6cd86e3b:app/index.html'], { encoding: 'utf8' });

let serveOld = false;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (serveOld && (url === '/' || url === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(OLD_INDEX); }
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const ME = { ok: true, observerId: 7, identityHash: 'ab'.repeat(32), createdAt: Date.now() - 864e5, hasPassword: true, unit: null, subscriptions: [], reports: [], collation: [], incidents: [], mappings: [] };
/* What the API does in each mode. 'offline' aborts at the network layer. */
let mode = 'ok';
const API = {
  ok: (p) => ({ status: 200, json: p.startsWith('/api/observers/me') ? ME : p.startsWith('/api/notifications') ? { items: [], unread: 0 } : p.startsWith('/api/mapping/stats') ? { total: 0, verified: 0, crowdMapped: 0 } : [] }),
  '500': () => ({ status: 500, json: { error: 'internal' } }),
  '502html': () => ({ status: 502, html: '<!DOCTYPE html><html><body><h1>502 Bad gateway</h1>cloudflare</body></html>' }),
  '200html': () => ({ status: 200, html: '<!DOCTYPE html><html><body>Checking your browser…</body></html>' }),
  '401other': () => ({ status: 401, json: { error: 'tg_initdata_invalid' } }),
  '401html': () => ({ status: 401, html: '<html><body>401</body></html>' }),
  '401invalid': () => ({ status: 401, json: { error: 'invalid_token' } }),
  '401elsewhere': () => ({ status: 401, json: { error: 'signed_in_elsewhere', hint: 'x' } }),
};

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const TOKEN = 'x.' + Buffer.from(JSON.stringify({ sub: '7', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.y';

async function newCtx(lite) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([tok, lite]) => {
    try {
      if (!sessionStorage.getItem('seeded') && !localStorage.getItem('seeded-once')) {
        localStorage.setItem('hawkeye_token', tok); localStorage.setItem('seeded-once', '1');
      }
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('hawkeye_lang', 'en'); localStorage.setItem('hawkeye_lang_prompted', '1'); localStorage.setItem('hawkeye_tour_done', '1');
    } catch (e) { /* about:blank */ }
    if (lite) window.Capacitor = { isNativePlatform: () => true, Plugins: {}, getPlatform: () => 'android' };
  }, [TOKEN, lite]);
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/')) {
      if (mode === 'offline') return route.abort('internetdisconnected');
      const a = API[mode](u.pathname);
      return a.html
        ? route.fulfill({ status: a.status, contentType: 'text/html', body: a.html })
        : route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.json) });
    }
    if (u.origin === base) return route.continue();
    // Lite rewrites leading-slash URLs to the live host: answer from app/.
    if (u.hostname === 'hawkeye.com.ng') {
      const f = path.join(APP, decodeURIComponent(u.pathname));
      if (f.startsWith(APP) && fs.existsSync(f) && !fs.statSync(f).isDirectory()) {
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
      }
    }
    return route.abort();
  });
  return ctx;
}

async function open(ctx, page) {
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  await pg.goto(`${base}/${page}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForLoadState('networkidle').catch(() => {});
  await pg.waitForTimeout(600);
  return { pg, errs };
}
/* A sign-out may navigate (authgate.js sends signed_in_elsewhere to sign-in):
   read again once the new page has settled instead of failing on a context
   that went away mid-read. */
const settle = async (pg, fn) => {
  for (let i = 0; i < 3; i++) {
    try { return await pg.evaluate(fn); } catch (e) { await pg.waitForTimeout(600); }
  }
  return pg.evaluate(fn);
};
const homeState = (pg) => settle(pg, () => ({
  page: location.pathname.split('/').pop() || 'index.html',
  token: !!localStorage.getItem('hawkeye_token'),
  obsHome: document.documentElement.classList.contains('obs-home'),
  offline: !!document.getElementById('home-offline') && !document.getElementById('home-offline').hidden,
  greet: (document.getElementById('home-greet') || {}).textContent || '',
  alerts: ((document.getElementById('home-alerts') || {}).innerText || '').trim(),
  welcome: !!document.querySelector('.hero') && getComputedStyle(document.querySelector('.hero')).display !== 'none',
}));

for (const lite of [false, true]) {
  const S = lite ? 'Lite' : 'web';
  console.log(`\n===== ${S}: Home =====`);
  /* A good load first: Home paints and the /me it got is kept on the phone. */
  let ctx = await newCtx(lite);
  mode = 'ok';
  let r = await open(ctx, 'index.html');
  let s = await homeState(r.pg);
  check(`${S} ok: signed-in Home, greeting names the observer`, [s.obsHome, s.token, s.offline, s.greet], [true, true, false, 'Welcome back, Observer #7']);
  await r.pg.close();

  for (const m of ['offline', '500', '502html', '200html', '401other', '401html']) {
    mode = m;
    r = await open(ctx, 'index.html');
    s = await homeState(r.pg);
    check(`${S} ${m}: STILL SIGNED IN (token kept, Home shown)`, [s.token, s.obsHome, s.page], [true, true, 'index.html']);
    check(`${S} ${m}: says it could not reach Hawkeye`, s.offline, true);
    check(`${S} ${m}: Home painted from the kept /me`, s.greet, 'Welcome back, Observer #7');
    check(`${S} ${m}: alerts do not sit on "Loading…"`, s.alerts, (t) => /could not reach hawkeye/i.test(t));
    check(`${S} ${m}: no page errors`, r.errs, []);
    await r.pg.close();
  }

  /* Try again: the server comes back, one tap reloads Home fresh. */
  mode = 'offline';
  r = await open(ctx, 'index.html');
  mode = 'ok';
  await Promise.all([r.pg.waitForNavigation({ timeout: 8000 }).catch(() => {}), r.pg.click('#home-offline button')]);
  await r.pg.waitForTimeout(800);
  s = await homeState(r.pg);
  check(`${S} Try again after signal returns: offline line gone, still signed in`, [s.offline, s.token, s.obsHome], [false, true, true]);
  await r.pg.close();

  /* CONTROLS — the server refusing the token DOES end the session. */
  for (const m of ['401invalid', '401elsewhere']) {
    mode = m;
    r = await open(ctx, 'index.html');
    s = await homeState(r.pg);
    check(`${S} CONTROL ${m}: signed out (token dropped, no Observer Home)`, [s.token, s.obsHome], [false, false]);
    await r.pg.close();
    await ctx.close();
    ctx = await newCtx(lite);
    mode = 'ok';
    r = await open(ctx, 'index.html'); await r.pg.close();
  }
  await ctx.close();

  /* Offline on a phone that never loaded /me: session kept, no invented figures. */
  ctx = await newCtx(lite);
  mode = 'offline';
  r = await open(ctx, 'index.html');
  s = await homeState(r.pg);
  check(`${S} offline, nothing kept yet: still signed in, offline line, generic greeting`, [s.token, s.obsHome, s.offline, s.greet], [true, true, true, 'Welcome Back']);
  check(`${S} offline, nothing kept yet: stats are "–", not 0`, await r.pg.evaluate(() => document.getElementById('ms-reports').textContent), '–');
  await ctx.close();

  /* CONTROL the harness sees the bug: the previous Home signs out offline. */
  ctx = await newCtx(lite);
  mode = 'ok'; r = await open(ctx, 'index.html'); await r.pg.close();
  serveOld = true; mode = 'offline';
  r = await open(ctx, 'index.html');
  s = await homeState(r.pg);
  check(`${S} CONTROL previous index.html offline: signs the observer out (the bug)`, [s.token, s.obsHome], [false, false]);
  serveOld = false;
  await ctx.close();

  console.log(`\n===== ${S}: Profile =====`);
  ctx = await newCtx(lite);
  mode = 'ok';
  r = await open(ctx, 'profile.html');
  const prof = (pg) => pg.evaluate(() => ({
    token: !!localStorage.getItem('hawkeye_token'),
    profile: !document.getElementById('profile').hidden,
    signedOut: !document.getElementById('signed-out').hidden,
    offline: !document.getElementById('p-offline').hidden,
    id: document.getElementById('p-id').textContent.trim(),
  }));
  let p = await prof(r.pg);
  check(`${S} profile ok: shown`, [p.profile, p.offline, p.signedOut, p.id], [true, false, false, 'Observer #7']);
  await r.pg.close();
  for (const m of ['offline', '500', '502html']) {
    mode = m;
    r = await open(ctx, 'profile.html');
    p = await prof(r.pg);
    check(`${S} profile ${m}: still signed in, painted from the kept /me, offline line`, [p.token, p.profile, p.offline, p.signedOut, p.id], [true, true, true, false, 'Observer #7']);
    check(`${S} profile ${m}: no page errors`, r.errs, []);
    await r.pg.close();
  }
  mode = 'offline';
  r = await open(ctx, 'profile.html');
  mode = 'ok';
  await r.pg.click('#p-retry');
  await r.pg.waitForTimeout(800);
  p = await prof(r.pg);
  check(`${S} profile Try again: offline line gone`, [p.offline, p.profile], [false, true]);
  await r.pg.close();
  mode = '401invalid';
  r = await open(ctx, 'profile.html');
  p = await prof(r.pg);
  check(`${S} profile CONTROL 401 invalid_token: signed out`, [p.token, p.signedOut, p.profile], [false, true, false]);
  await ctx.close();

  console.log(`\n===== ${S}: Alerts =====`);
  ctx = await newCtx(lite);
  const alerts = (pg) => pg.evaluate(() => ({
    token: !!localStorage.getItem('hawkeye_token'),
    text: document.getElementById('list').innerText.trim(),
    retry: !!document.getElementById('nf-retry'),
  }));
  mode = 'ok';
  r = await open(ctx, 'notifications.html');
  let a = await alerts(r.pg);
  check(`${S} alerts ok + empty: the empty state (control)`, a.text, (t) => /No notifications yet/.test(t));
  await r.pg.close();
  for (const m of ['offline', '500', '502html']) {
    mode = m;
    r = await open(ctx, 'notifications.html');
    a = await alerts(r.pg);
    check(`${S} alerts ${m}: "could not reach" + Try again, never "No notifications yet"`, [a.token, /could not reach hawkeye/i.test(a.text), /No notifications yet/.test(a.text), a.retry], [true, true, false, true]);
    await r.pg.close();
  }
  mode = '401invalid';
  r = await open(ctx, 'notifications.html');
  a = await alerts(r.pg);
  check(`${S} alerts CONTROL 401 invalid_token: session expired, token dropped`, [a.token, /session has expired/i.test(a.text)], [false, true]);
  await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

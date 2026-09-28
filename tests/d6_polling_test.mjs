/**
 * D6: SIGNED-IN READS ARE PUSH-DRIVEN PLUS 120 s, AND A HIDDEN BOARD DOES NOT POLL.
 *
 * MEASURED, not grepped: the same scenarios run against the committed app/
 * (git HEAD, "before") and the working tree ("after"), each served by its own
 * local server that counts every /api request. Nothing leaves this machine:
 * the signed-in endpoints are fixtures, /api/national and /api/contests are the
 * real backend router over a throwaway database, and every other host is
 * aborted. Timers run on Playwright's fake clock, so "10 minutes" is exact.
 *
 * Controls: every "fewer requests" claim is paired with the before-run doing
 * the thing (so the scenario can fail), and the situation room must make the
 * SAME requests before and after (and its file must be byte-identical).
 *
 *   node tests/d6_polling_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const requireB = createRequire(path.join(ROOT, 'backend', 'package.json'));
const express = requireB('express');
const { chromium } = createRequire(HERE + '/ui/')('playwright-core');
const CHROME = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-d6-'));
process.env.DB_PATH = path.join(tmp, 'd6.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
const { nationalRouter } = await import(path.join(ROOT, 'backend/src/routes/national.js'));

/* The BEFORE tree: app/ exactly as committed. */
const beforeDir = path.join(tmp, 'before');
fs.mkdirSync(beforeDir);
execFileSync('bash', ['-c', `git -C '${ROOT}' archive HEAD app | tar -x -C '${beforeDir}'`]);
const TREES = { before: path.join(beforeDir, 'app'), after: path.join(ROOT, 'app') };

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? `   [${typeof got === 'string' ? got : JSON.stringify(got)}]` : ''}`);
  if (!ok) failed++;
};

function serve(appDir) {
  const hits = [];
  let unread = 1;
  const app = express();
  // Lite calls the production origin cross-origin (the route below brings it
  // here), so answer like the real backend does for the app: CORS, preflight.
  app.use((req, res, next) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-device-id',
      'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use((req, _res, next) => { if (req.path.startsWith('/api/')) hits.push(`${req.method} ${req.path}`); next(); });
  app.get('/api/notifications', (_req, res) => res.json({
    items: [{ id: 1, kind: 'result', title: 'A result', body: 'x', read: 0, created_at: Date.now(), url: 'results.html' }],
    unread: unread++,
  }));
  app.post('/api/notifications/read', (_req, res) => res.json({ ok: true, unread: 0 }));
  app.get('/api/observers/me', (_req, res) => res.json({ observerId: 7, subscriptions: [], reports: [], incidents: [], collation: [], unit: null }));
  app.get('/api/my/rooms', (_req, res) => res.json({ rooms: [] }));
  app.get('/api/practice/nudge', (_req, res) => res.json({ show: false }));
  app.use('/api', nationalRouter);
  app.use('/api', (_req, res) => res.status(404).json({}));
  app.get('/room/:slug', (_req, res) => res.sendFile(path.join(appDir, 'situation-room.html')));
  app.use(express.static(appDir));
  return new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r({ s, base: `http://127.0.0.1:${s.address().port}`, hits }));
  });
}
const servers = { before: await serve(TREES.before), after: await serve(TREES.after) };
const count = (hits, re) => hits.filter((h) => re.test(h)).length;
/* A token authgate.js and app.js accept as fresh (JWT exp in 2100); the
   fixtures never check it. Without one, gated pages bounce to sign-in and the
   test measures observe.html instead of the page it names. */
const jwt = (who) => 'eyJhbGciOiJIUzI1NiJ9.'
  + Buffer.from(JSON.stringify({ sub: who, exp: 4102444800 })).toString('base64url') + '.sig-' + who + '-0123456789';

const browser = await chromium.launch({ executablePath: CHROME });

/** A signed-in page on `tree`, fake clock installed, foreign hosts aborted. */
async function open(tree, { lite = false, clock = true } = {}) {
  const srv = servers[tree];
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(srv.base)) return route.continue();
    // Lite rewrites /api/... to the production origin (native.js); serve it here.
    if (lite && u.startsWith('https://hawkeye.com.ng/')) {
      return route.fetch({ url: srv.base + u.slice('https://hawkeye.com.ng'.length) })
        .then((resp) => route.fulfill({ response: resp })).catch(() => route.abort());
    }
    return route.abort();
  });
  await ctx.addInitScript(({ lite: isLite, token }) => {
    // Once per context, not per page: a test that swaps accounts must keep it.
    if (!localStorage.getItem('hawkeye_token')) localStorage.setItem('hawkeye_token', token);
    window.__vis = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => window.__vis, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => window.__vis === 'hidden', configurable: true });
    window.__setVis = (v) => { window.__vis = v; document.dispatchEvent(new Event('visibilitychange')); };
    if (isLite) {
      // Just enough Capacitor for native.js's Lite path: the App plugin.
      const listeners = {};
      window.__app = (active) => (listeners.appStateChange || []).forEach((cb) => cb({ isActive: active }));
      window.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          App: {
            addListener: (n, cb) => { (listeners[n] = listeners[n] || []).push(cb); return Promise.resolve({ remove() {} }); },
            getState: () => Promise.resolve({ isActive: true }),
            getInfo: () => Promise.resolve({ build: '1' }),
            getLaunchUrl: () => Promise.resolve(null),
          },
        },
      };
    }
  }, { lite, token: jwt('first') });
  const page = await ctx.newPage();
  if (clock) await page.clock.install({ time: new Date('2026-10-01T09:00:00Z') });
  return { ctx, page, srv };
}
const settle = (page) => page.waitForTimeout(400);
const landedElsewhere = [];
async function goto(page, srv, p) {
  await page.goto(srv.base + '/' + p, { waitUntil: 'load' });
  await settle(page);
  // A bounce (to sign-in, say) would measure the wrong page. Lite serves the
  // same path; only the origin differs, so compare paths.
  const want = new URL(srv.base + '/' + p).pathname;
  if (new URL(page.url()).pathname !== want) landedElsewhere.push(`${p} -> ${page.url()}`);
}

/* ---------------------------------------------------------------- */
console.log('=== signed in, browsing five pages in a minute ===');
const PAGES = ['index.html', 'results.html', 'docket.html', 'index.html', 'results.html'];
const browse = {};
for (const tree of ['before', 'after']) {
  const { ctx, page, srv } = await open(tree);
  srv.hits.length = 0;
  for (const p of PAGES) {
    await goto(page, srv, p);
    await page.clock.runFor(12_000);
    await settle(page);
  }
  browse[tree] = { notifications: count(srv.hits, /^GET \/api\/notifications$/), me: count(srv.hits, /^GET \/api\/observers\/me$/) };
  await ctx.close();
}
console.log(`  /api/notifications  before ${browse.before.notifications}  after ${browse.after.notifications}`);
console.log(`  /api/observers/me   before ${browse.before.me}  after ${browse.after.me}`);
check('control: before, every page asked for the unread feed', browse.before.notifications >= PAGES.length, browse.before);
check('after: ONE unread request for the whole minute', browse.after.notifications === 1, browse.after);
check('after: /me asked once, not per Home visit', browse.after.me <= 1 && browse.after.me < browse.before.me, browse);

/* ---------------------------------------------------------------- */
console.log('\n=== signed in, one page left open for 10 minutes ===');
const idle = {};
for (const tree of ['before', 'after']) {
  const { ctx, page, srv } = await open(tree);
  await goto(page, srv, 'index.html');
  srv.hits.length = 0;
  for (let i = 0; i < 10; i++) { await page.clock.runFor(60_000); await settle(page); }
  idle[tree] = count(srv.hits, /^GET \/api\/notifications$/);
  srv.hits.length = 0;
  await page.evaluate(() => window.__setVis('hidden'));
  for (let i = 0; i < 10; i++) { await page.clock.runFor(60_000); await settle(page); }
  idle[tree + 'Hidden'] = count(srv.hits, /^GET \/api\/notifications$/);
  await ctx.close();
}
console.log(`  in front, after load:  before ${idle.before}  after ${idle.after}   (the 120 s backstop; there was no poll before)`);
console.log(`  hidden, 10 min:        before ${idle.beforeHidden}  after ${idle.afterHidden}`);
check('after: the backstop runs at most every 120 s in front (<= 5 in 10 min)', idle.after >= 4 && idle.after <= 5, idle.after);
check('after: nothing while hidden', idle.afterHidden === 0, idle.afterHidden);

/* ---------------------------------------------------------------- */
console.log('\n=== a push ends the 120 s; a write ends it; otherwise it holds ===');
{
  const { ctx, page, srv } = await open('after');
  await goto(page, srv, 'index.html');
  await page.clock.runFor(20_000); await settle(page);
  srv.hits.length = 0;
  await page.clock.runFor(30_000); await settle(page);
  check('control: 50 s in, no push -> no request', count(srv.hits, /notifications$/) === 0, srv.hits);
  const dotBefore = await page.evaluate(() => document.querySelector('.bell-dot')?.textContent || '');
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'hawkeye-push', at: Date.now() } })));
  await settle(page);
  check('a push (the sw.js message) re-reads at once', count(srv.hits, /^GET \/api\/notifications$/) === 1, srv.hits);
  const dotAfter = await page.evaluate(() => document.querySelector('.bell-dot')?.textContent || '');
  check('  ...and repaints the bell', dotAfter !== dotBefore && dotAfter !== '', `${dotBefore} -> ${dotAfter}`);

  srv.hits.length = 0;
  await goto(page, srv, 'docket.html');
  check('control: next page inside 120 s, no write -> answered locally', count(srv.hits, /notifications$/) === 0, srv.hits);
  await page.evaluate(() => fetch('/api/notifications/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"all":true}' }));
  await page.clock.runFor(6_000);
  srv.hits.length = 0;
  await goto(page, srv, 'results.html');
  check('a write from the page (mark read) -> the next page asks again', count(srv.hits, /^GET \/api\/notifications$/) === 1, srv.hits);
  srv.hits.length = 0;
  await page.evaluate((t) => localStorage.setItem('hawkeye_token', t), jwt('second'));
  await goto(page, srv, 'docket.html');
  check('another account\'s token never reads the first one\'s answer', count(srv.hits, /^GET \/api\/notifications$/) === 1, srv.hits);
  await ctx.close();
}
{
  /* RELOAD, on the REAL clock: Playwright's fake clock replaces `performance`,
     so navigation timing (how native.js knows it was a reload) reads empty
     under it. A few real seconds are well inside the 120 s. */
  const { ctx, page, srv } = await open('after', { clock: false });
  await goto(page, srv, 'docket.html');
  srv.hits.length = 0;
  await goto(page, srv, 'index.html');
  check('control (real clock): the next page is answered locally', count(srv.hits, /^GET \/api\/notifications$/) === 0, srv.hits);
  srv.hits.length = 0;
  await page.reload({ waitUntil: 'load' });
  await settle(page);
  check('an explicit reload asks the server again (pull to refresh means the server)', count(srv.hits, /^GET \/api\/notifications$/) === 1, srv.hits);
  srv.hits.length = 0;
  await goto(page, srv, 'docket.html');
  check('  ...and the pages after it are answered locally again', count(srv.hits, /^GET \/api\/notifications$/) === 0, srv.hits);
  await ctx.close();
}

/* ---------------------------------------------------------------- */
console.log('\n=== results.html: the 30 s board poll, hidden ===');
const board = {};
for (const lite of [false, true]) {
  for (const tree of ['before', 'after']) {
    const { ctx, page, srv } = await open(tree, { lite });
    await goto(page, srv, 'results.html?contest=PRES');
    await page.clock.runFor(1_000); await settle(page);
    srv.hits.length = 0;
    await page.clock.runFor(60_000); await settle(page);
    const front = count(srv.hits, /^GET \/api\/national\//);
    srv.hits.length = 0;
    // Web: the tab is hidden. Lite: the APP leaves the screen and the WebView
    // says nothing (visibility stays 'visible') — the case that kept polling.
    await page.evaluate((isLite) => (isLite ? window.__app(false) : window.__setVis('hidden')), lite);
    for (let i = 0; i < 5; i++) { await page.clock.runFor(60_000); await settle(page); }
    const away = count(srv.hits, /^GET \/api\/national\//);
    srv.hits.length = 0;
    await page.evaluate((isLite) => (isLite ? window.__app(true) : window.__setVis('visible')), lite);
    await settle(page);
    const back = count(srv.hits, /^GET \/api\/national\//);
    board[`${lite ? 'lite' : 'web'}-${tree}`] = { front, away, back };
    await ctx.close();
  }
}
for (const [k, v] of Object.entries(board)) console.log(`  ${k.padEnd(12)} in front 60 s: ${v.front}   away 5 min: ${v.away}   on return: ${v.back}`);
check('control: in front, the board still polls every 30 s (after, web)', board['web-after'].front === 2, board['web-after']);
check('control: in front, the board still polls every 30 s (after, Lite)', board['lite-after'].front === 2, board['lite-after']);
check('control: before, the hidden web board kept polling', board['web-before'].away >= 9, board['web-before']);
check('control: before, Lite kept polling with the app away', board['lite-before'].away >= 9, board['lite-before']);
check('after: the hidden web board does not poll', board['web-after'].away === 0, board['web-after']);
check('after: Lite does not poll with the app away', board['lite-after'].away === 0, board['lite-after']);
check('after: coming back refreshes at once (web)', board['web-after'].back === 1, board['web-after']);
check('after: coming back refreshes at once (Lite)', board['lite-after'].back === 1, board['lite-after']);

/* ---------------------------------------------------------------- */
console.log('\n=== the situation room is unchanged ===');
/* Byte-identical apart from the ?v= cache-busters: a release bumps every
   page's script pins (authgate.js, native.js, menu.js …) without changing the
   page itself. */
const unpinned = (buf) => buf.toString('utf8').replace(/\?v=\d+/g, '?v=');
const sameAsHead = (rel) => unpinned(execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}`])) === unpinned(fs.readFileSync(path.join(ROOT, rel)));
check('situation-room.html is byte-identical to HEAD (script ?v= aside)', sameAsHead('app/situation-room.html'));
check('dashboard.html is byte-identical to HEAD (script ?v= aside)', sameAsHead('app/dashboard.html'));
check('CONTROL one changed character still counts as a change',
  unpinned(Buffer.from('<p>a</p><script src="x.js?v=1">')) !== unpinned(Buffer.from('<p>b</p><script src="x.js?v=2">')));
const room = {};
for (const tree of ['before', 'after']) {
  const { ctx, page, srv } = await open(tree);
  srv.hits.length = 0;
  await goto(page, srv, 'room/test-room');
  for (let i = 0; i < 5; i++) { await page.clock.runFor(60_000); await settle(page); }
  room[tree] = srv.hits.slice().sort();
  room[tree + 'Path'] = new URL(page.url()).pathname;
  await ctx.close();
}
check('the room stayed the room for all 5 minutes (before and after)', room.beforePath === '/room/test-room' && room.afterPath === '/room/test-room', [room.beforePath, room.afterPath]);
console.log(`  requests over 5 min: before ${room.before.length}  after ${room.after.length}`);
check('the room makes the same requests before and after', JSON.stringify(room.before) === JSON.stringify(room.after), { before: room.before, after: room.after });
check('  (and it did make some, so the comparison means something)', room.before.length > 0, room.before.length);

check('every page measured is the page named (no bounce to sign-in)', landedElsewhere.length === 0, landedElsewhere);

await browser.close();
for (const s of Object.values(servers)) s.s.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

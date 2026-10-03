/**
 * A SIGNED-OUT ROOM LINK SURVIVES THE SIGN-IN ROUND TRIP, TAB INCLUDED.
 *
 * A manager who opens /room/<slug>?tab=team signed out is sent to sign-in and,
 * once signed in, must land on THAT room on THAT tab — not on the room's
 * Overview (the tab was dropped) or on whichever room is first (the room was).
 *
 *   1. signed out, /room/<slug>?tab=… → sign-in, and `next` carries room + tab;
 *      the in-scope address /situation-room.html?room=…&tab=… does the same;
 *   2. the round trip: sign-in completes (the device resume hands back a
 *      token) and the page opens the right room on the right tab;
 *   3. a token the server refuses (401 mid-session) also keeps room + tab;
 *   CONTROLS: no ?tab= → Overview, and the other slug → the other room, so a
 *   test that always answered "team" / "Second Room" would fail here.
 *
 *   node tests/room_signin_tab_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const TOKEN = enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x';

const room = (id, name, slug) => ({
  id, name, kind: 'campaign', contest: 'PRES', scope: '', party: null, slug, scope_kind: '', members: 1, assigned: 0,
  pending: 0, reported: 0, zones: [], me_id: 1, admits: true, me: { role: 'owner', scope_kind: '', scope_value: '' },
  managers: [{ observer_id: 1, role: 'owner', scope_kind: '', scope_value: '' }],
});
const ROOMS = { 7: room(7, 'Alpha Room', 'alpha-room'), 8: room(8, 'Second Room', 'second-room') };

// What the stub backend does right now: whether the device resume signs the
// visitor in, and whether the room API refuses the token.
const mode = { resume: false, deny: false };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/observers/resume') return mode.resume ? json({ token: TOKEN }) : json({});
  // The code backend requireObserver really sends: only an auth error ends a
  // session now (design audit X1), so a made-up code would be "not ours".
  if (mode.deny && url.startsWith('/api/groups')) return json({ error: 'invalid_token' }, 401);
  if (url === '/api/groups') return json({ managing: Object.values(ROOMS).map((g) => ({ id: g.id, name: g.name, kind: g.kind, contest: 'PRES', scope: '', slug: g.slug })), member: [] });
  const m = /^\/api\/groups\/(\d+)$/.exec(url);
  if (m && ROOMS[m[1]]) return json(ROOMS[m[1]]);
  if (/^\/api\/groups\/\d+\/team$/.test(url)) return json({ contest: 'PRES', members: [] });
  if (url.startsWith('/api/')) return json({});
  // As backend/src/server.js: /room/:slug is the room page itself.
  if (/^\/room\/[^/]+$/.test(url)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return fs.createReadStream(path.join(APP, 'situation-room.html')).pipe(res);
  }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const errs = [];

async function open(p, { token = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(String(e) + ' @ ' + p));
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('hawkeye_lang', 'en');
      // Seed once per context: a reload must see what the page itself stored.
      if (t && !sessionStorage.getItem('seeded')) { localStorage.setItem('hawkeye_token', t); sessionStorage.setItem('seeded', '1'); }
    } catch (e) { /* private mode */ }
  }, token ? TOKEN : '');
  await page.goto(base + p, { waitUntil: 'commit' }).catch(() => {});
  return { ctx, page };
}
// Where sign-in will send them: the `next` that observe.html was given, parsed.
async function signInNext(page) {
  await page.waitForURL((u) => u.pathname === '/observe.html', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const u = new URL(page.url());
  const n = u.searchParams.get('next') || '';
  const nu = new URL(n, base + '/');
  return { at: u.pathname, next: nu.pathname.replace(/^\//, ''), room: nu.searchParams.get('room'), tab: nu.searchParams.get('tab') };
}
// The room the page shows and the tab it has selected.
async function roomState(page, name) {
  await page.waitForURL((u) => u.pathname === '/situation-room.html', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction((n) => new RegExp(n).test((document.getElementById('sr') || {}).textContent || '')
    && document.querySelector('.sr-tabs button[aria-selected="true"]'), name, { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => ({
    path: location.pathname,
    shows: ((document.getElementById('sr') || {}).textContent || '').match(/Alpha Room|Second Room/)?.[0] || null,
    tab: document.querySelector('.sr-tabs button[aria-selected="true"]')?.dataset.tab || null,
  }));
}

try {
  console.log('=== 1. signed out: sign-in is told the room AND the tab ===');
  mode.resume = false; mode.deny = false;
  let v = await open('/room/second-room?tab=team');
  const first = await signInNext(v.page);
  check('/room/second-room?tab=team → observe.html, next = situation-room.html?room=second-room&tab=team',
    first, { at: '/observe.html', next: 'situation-room.html', room: 'second-room', tab: 'team' });

  console.log('\n=== 2. the round trip: sign-in completes → that room, that tab ===');
  mode.resume = true;                       // the device resume now signs them in
  await v.page.reload({ waitUntil: 'commit' }).catch(() => {});
  check('after sign-in: Second Room, Team tab', await roomState(v.page, 'Second Room'),
    { path: '/situation-room.html', shows: 'Second Room', tab: 'team' });
  await v.ctx.close();

  mode.resume = false;
  v = await open('/situation-room.html?room=second-room&tab=incidents');
  check('in-scope address: next keeps room + tab (incidents)', await signInNext(v.page),
    { at: '/observe.html', next: 'situation-room.html', room: 'second-room', tab: 'incidents' });
  await v.ctx.close();

  console.log('\n=== CONTROLS ===');
  mode.resume = false;
  v = await open('/room/alpha-room');
  check('CONTROL: /room/alpha-room (no tab) → next names alpha-room, no tab', await signInNext(v.page),
    { at: '/observe.html', next: 'situation-room.html', room: 'alpha-room', tab: null });
  mode.resume = true;
  await v.page.reload({ waitUntil: 'commit' }).catch(() => {});
  check('CONTROL: after sign-in: Alpha Room, Overview', await roomState(v.page, 'Alpha Room'),
    { path: '/situation-room.html', shows: 'Alpha Room', tab: 'overview' });
  await v.ctx.close();

  console.log('\n=== 3. a refused token (401 mid-session) keeps room + tab too ===');
  mode.resume = false; mode.deny = true;
  v = await open('/room/second-room?tab=team', { token: true });
  check('401 on /room/second-room?tab=team → next keeps room + tab', await signInNext(v.page),
    { at: '/observe.html', next: 'situation-room.html', room: 'second-room', tab: 'team' });
  await v.ctx.close();
  v = await open('/room/alpha-room', { token: true });
  check('CONTROL: 401 on /room/alpha-room → next names alpha-room, no tab', await signInNext(v.page),
    { at: '/observe.html', next: 'situation-room.html', room: 'alpha-room', tab: null });
  await v.ctx.close();
  mode.deny = false;

  check('no page errors', errs, []);
} finally {
  await b.close();
  server.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);

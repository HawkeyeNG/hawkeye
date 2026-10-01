/**
 * THE ROOM'S ADDRESSES INSIDE ITS NEW SCOPE (room.webmanifest scope =
 * /situation-room.html, so it no longer covers the admin console's pages).
 *
 *   1. /room/<slug>[?…][#…] — the shared address, served as situation-room.html
 *      the way backend server.js does — forwards to
 *      /situation-room.html?…&room=<slug>#…, keeps the rest of the query and the
 *      hash, and opens THAT room (a CONTROL slug opens the other one);
 *   2. a malformed slug is dropped, never carried;
 *   3. the web+hawkeye: protocol handler (?join=<the whole web+hawkeye:… URL>)
 *      forwards to /join.html?t=<token>, encoded or with a raw "+";
 *   4. anything that is not a token (javascript:, markup) is dropped: the page
 *      stays put and ?join= leaves the address.
 *
 *   node tests/room_address_forward_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const room = (id, name, slug) => ({
  id, name, kind: 'campaign', contest: 'PRES', scope: '', party: null, slug, scope_kind: '', members: 1, assigned: 0,
  pending: 0, reported: 0, zones: [], me_id: 1, admits: true, me: { role: 'owner', scope_kind: '', scope_value: '' },
  managers: [{ observer_id: 1, role: 'owner', scope_kind: '', scope_value: '' }],
});
const ROOMS = { 7: room(7, 'Alpha Room', 'alpha-room'), 8: room(8, 'Second Room', 'second-room') };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
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
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const errs = [];
async function visit(p, until) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(String(e) + ' @ ' + p + ' ' + String(e.stack || '').split(/\n/).slice(1, 3).join(' | ')));
  await page.addInitScript(() => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    try {
      localStorage.setItem('hawkeye_lang', 'en');
      localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
    } catch (e) { /* private mode */ }
  });
  await page.goto(base + p, { waitUntil: 'commit' }).catch(() => {});
  await page.waitForURL(until, { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  const u = new URL(page.url());
  const out = { path: u.pathname, q: Object.fromEntries(u.searchParams), hash: u.hash, page };
  return { ...out, ctx };
}
const roomName = (page) => page.evaluate(() => (document.getElementById('sr') || document.body).textContent);

try {
  console.log('=== 1. /room/<slug> forwards into the scope, and opens that room ===');
  let v = await visit('/room/second-room?tab=team#top', (u) => u.pathname === '/situation-room.html');
  check('/room/second-room?tab=team#top → /situation-room.html, room + tab + hash kept',
    [v.path, v.q.room, v.q.tab, v.hash], ['/situation-room.html', 'second-room', 'team', '#top']);
  await v.page.waitForFunction(() => /Second Room/.test((document.getElementById('sr') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('…and the page opens Second Room', /Second Room/.test(await roomName(v.page)), true);
  await v.ctx.close();
  v = await visit('/room/alpha-room', (u) => u.pathname === '/situation-room.html');
  await v.page.waitForFunction(() => /Alpha Room/.test((document.getElementById('sr') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('CONTROL: /room/alpha-room opens Alpha Room, not the other', [v.path, v.q.room, /Alpha Room/.test(await roomName(v.page))], ['/situation-room.html', 'alpha-room', true]);
  await v.ctx.close();
  v = await visit('/situation-room.html?room=second-room', (u) => u.pathname === '/situation-room.html');
  await v.page.waitForFunction(() => /Second Room/.test((document.getElementById('sr') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('?room= selects the room exactly as the path did, and the address stays in scope',
    [v.path, v.q.room, /Second Room/.test(await roomName(v.page))], ['/situation-room.html', 'second-room', true]);
  await v.ctx.close();

  console.log('\n=== 2. a malformed slug is dropped ===');
  v = await visit('/room/%3Cscript%3E', (u) => u.pathname === '/situation-room.html');
  check('/room/<script> → /situation-room.html with no room carried', [v.path, v.q.room || null], (g) => g[0] === '/situation-room.html' && g[1] !== '<script>');
  await v.ctx.close();

  console.log('\n=== 3. the protocol handler forwards the token to the join page ===');
  const TOKEN = 'AbCdEfGhIjKlMnOpQr_-12';
  v = await visit('/situation-room.html?join=' + encodeURIComponent('web+hawkeye:' + TOKEN), (u) => u.pathname === '/join.html');
  check('?join=web%2Bhawkeye%3A<token> → /join.html?t=<token>', [v.path, v.q.t], ['/join.html', TOKEN]);
  await v.ctx.close();
  v = await visit('/situation-room.html?join=web+hawkeye:' + TOKEN, (u) => u.pathname === '/join.html');
  check('a raw "+" (read as a space) forwards the same', [v.path, v.q.t], ['/join.html', TOKEN]);
  await v.ctx.close();
  v = await visit('/situation-room.html?join=' + encodeURIComponent('web+hawkeye://' + TOKEN), (u) => u.pathname === '/join.html');
  check('web+hawkeye://<token> forwards the same', [v.path, v.q.t], ['/join.html', TOKEN]);
  await v.ctx.close();

  console.log('\n=== 4. anything that is not a token is dropped ===');
  for (const bad of ['javascript:alert(1)', 'web+hawkeye:<img src=x onerror=alert(1)>', 'web+hawkeye:', 'https://evil.example/x']) {
    v = await visit('/situation-room.html?room=second-room&tab=team&join=' + encodeURIComponent(bad), (u) => !u.searchParams.has('join'));
    check(`${JSON.stringify(bad)}: stays on the room, ?join= gone, the rest kept`, [v.path, 'join' in v.q, v.q.tab], ['/situation-room.html', false, 'team']);
    await v.ctx.close();
  }
  check('no page errors', errs, []);
} finally {
  await b.close();
  server.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);

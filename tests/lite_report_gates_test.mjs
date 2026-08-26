/**
 * THE THINGS THAT SHIPPED BROKEN ON LITE, EACH PINNED.
 *
 * Reported from a device, 2026-08-26:
 *   1. Step 4 had NOWHERE to enter party counts — /api/parties yielded nothing
 *      and buildVoteRows() rendered an empty div, so the card was a filter box,
 *      a serial field and no inputs at all.
 *   2. "Verify counts" then looked broken, because it can only refuse when there
 *      are no inputs to count.
 *   3. Sign & submit was live before the last card was finished — on BOTH the
 *      result and collation flows. The user's words: "we've been through this
 *      before", which is the definition of something that needs a test.
 *   4. Refusals were written into a status line under the button, which on a
 *      phone is below the fold at the moment of the tap, so the button read as
 *      dead. Result, collation and incidents all did this.
 *
 * Every check drives the shipped page. None of them reads the source.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
/** Contests must be a real array or step 3 is a dead end; parties is the thing
 *  under test, so each case decides what it serves. */
let servePartiesEmpty = true;
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (u === '/api/parties') return json(servePartiesEmpty ? [] : [{ code: 'ZZZ', name: 'Served Party' }]);
  if (u === '/api/contests') return json([{ code: 'GOV', name: 'Governorship', states: ['Osun'], reportingOpen: true }]);
  if (u.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (l, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
/** app/authgate.js parses the payload and bounces anything it cannot read, so a
 *  placeholder never reaches a signed-in screen. See tests/tour_test.mjs. */
const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;

const lite = async (page, { signedIn = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await ctx.addInitScript((o) => {
    if (o.signedIn) {
      Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
    }
    const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
    mark(); document.addEventListener('readystatechange', mark);
    try {
      if (o.signedIn) localStorage.setItem('hawkeye_token', o.token);
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch (e) { /* ignore */ }
  }, { signedIn, token: JWT() });
  const p = await ctx.newPage();
  await p.goto(`${base}/${page}`);
  await p.waitForTimeout(signedIn ? 900 : 700);
  return { ctx, p };
};

const UNIT = { pu_code: '30-05-07-001', name: 'Akepe Street', ward: 'Ward 5', lga: 'Ede North', state: 'Osun', lat: 7.7, lng: 4.4, tier: 'verified' };

console.log('=== 1-2. the counts step always has somewhere to type ===');
for (const [label, empty] of [['/api/parties returns []', true], ['/api/parties returns a list', false]]) {
  servePartiesEmpty = empty;
  const { ctx, p } = await lite('observe.html');
  await p.evaluate((u) => { enterReportFlow(); selectUnit(u); }, UNIT);
  await p.waitForTimeout(600);
  const rows = await p.evaluate(() => document.querySelectorAll('#vote-inputs input').length);
  console.log(`      ${label} -> ${rows} party input(s)`);
  check(`${label}: the observer has somewhere to enter counts`, rows > 0);
  await ctx.close();
}

console.log('\n=== 3. submit is dead until the last card is finished ===');
{
  servePartiesEmpty = false;
  const { ctx, p } = await lite('observe.html');
  const disabled = () => p.evaluate(() => document.getElementById('btn-submit').disabled);
  await p.evaluate((u) => {
    enterReportFlow();
    shots.sheet = { blob: new Blob(['x']), url: 'x' };
    shots.venue = { blob: new Blob(['x']), url: 'x' };
    selectUnit(u);
    updateSubmitState();
  }, UNIT);
  await p.waitForTimeout(500);
  check('photos + unit, but no counts confirmed -> submit is disabled', await disabled(), true);
  await p.evaluate(() => {
    const i = document.querySelector('#vote-inputs input');
    if (i) { i.value = '120'; i.dispatchEvent(new Event('input', { bubbles: true })); }
    document.getElementById('btn-verify-counts').click();
  });
  await p.waitForTimeout(300);
  check('after Verify counts -> submit is enabled', await disabled(), false);
  await ctx.close();
}

console.log('\n=== 4. a refusal is a modal, not a line under the button ===');
{
  servePartiesEmpty = false;
  const { ctx, p } = await lite('observe.html');
  await p.evaluate((u) => { enterReportFlow(); selectUnit(u); }, UNIT);
  await p.waitForTimeout(500);
  await p.evaluate(() => document.getElementById('btn-verify-counts').click());
  await p.waitForTimeout(250);
  const m = await p.evaluate(() => {
    const a = document.querySelector('.hk-alert');
    if (!a || a.hidden) return null;
    return { title: a.querySelector('h3').textContent, onTop: document.elementFromPoint(195, 425) === a || a.contains(document.elementFromPoint(195, 425)) };
  });
  check('Verify counts with nothing typed opens a modal', !!m);
  check('and the modal is what the tap lands on', m && m.onTop, true);
  await ctx.close();
}

console.log('\n=== incidents: no type chosen is a modal too ===');
{
  const { ctx, p } = await lite('incidents.html', { signedIn: true });
  // The page binds btn-submit inside an async init that runs after the auth
  // check, so waiting for the ELEMENT proves nothing — the click lands on a
  // button with no handler and the test reports a bug that is not there.
  // Wait for the binding itself.
  await p.waitForFunction(
    () => !!window.HAWKEYE_ALERT && typeof (document.getElementById('btn-submit') || {}).onclick === 'function',
    null, { timeout: 12000 });
  await p.waitForTimeout(400);
  const shown = await p.evaluate(() => {
    document.getElementById('btn-submit').click();
    const a = document.querySelector('.hk-alert');
    return { open: a ? !a.hidden : false, title: a ? a.querySelector('h3').textContent : null };
  });
  check('submitting with no incident type opens a modal', shown.open);
  check('and it names what is missing', shown.title, 'Choose an incident type');
  await ctx.close();
}

console.log('\n=== the tour ring does not distort the glyphs ===');
{
  const { ctx, p } = await lite('index.html', { signedIn: true });
  const sizes = await p.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    if (!bar) return null;
    const before = [...bar.querySelectorAll('.tab svg')].map((s) => Math.round(s.getBoundingClientRect().width));
    bar.querySelectorAll('.tab').forEach((t) => t.classList.add('tour-lit'));
    const after = [...bar.querySelectorAll('.tab svg')].map((s) => Math.round(s.getBoundingClientRect().width));
    return { before, after };
  });
  if (!sizes) { check('the tab bar rendered', false); }
  else {
    console.log(`      widths before ${sizes.before.join(',')}  after ${sizes.after.join(',')}`);
    check('every glyph keeps its width when the ring is on', JSON.stringify(sizes.after), JSON.stringify(sizes.before));
    check('and none of them collapsed', sizes.after.every((w) => w >= 20), true);
  }
  await ctx.close();
}

console.log('\n=== CONTROL: the old padding ring really did squash them ===');
{
  const { ctx, p } = await lite('index.html', { signedIn: true });
  const r = await p.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    if (!bar) return null;
    const before = [...bar.querySelectorAll('.tab svg')].map((s) => Math.round(s.getBoundingClientRect().width));
    const st = document.createElement('style');
    // The exact rule that shipped.
    st.textContent = '.tabbar .tab.tour-lit:not(.tab-cta) .ti { padding: 4px; margin: -4px; }'
      + '.tabbar .tab svg { flex: 1 1 auto !important; }';
    document.head.appendChild(st);
    bar.querySelectorAll('.tab').forEach((t) => t.classList.add('tour-lit'));
    const after = [...bar.querySelectorAll('.tab svg')].map((s) => Math.round(s.getBoundingClientRect().width));
    return { before, after };
  });
  if (!r) { control('the tab bar rendered for the control', true); }
  else {
  console.log(`      sabotaged: before ${r.before.join(',')}  after ${r.after.join(',')}`);
  control('a padding ring on a shrinkable glyph changes its width', JSON.stringify(r.after) === JSON.stringify(r.before));
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

/**
 * THE PROFILE'S "CHOOSE YOUR POLLING UNIT" MODAL, MEASURED.
 *
 * Two bugs shipped here in one build, and both are invisible to a source read:
 *
 * 1. A GHOST BAR. The confirmed-choice card carries `hidden` until something is
 *    picked, but its rule was a plain `.unit-picked { display: block }` — which
 *    outranks the UA sheet's `[hidden] { display: none }`, because that is the
 *    weakest specificity in the browser. The EMPTY card therefore rendered as an
 *    unexplained outlined bar above the near-me button. This repo has hit the
 *    same trap before (`.menu-panel a[hidden]`), which is why the check here is
 *    getClientRects().length — "is it actually painted" — and not a class or a
 *    computed style, both of which looked perfectly correct while it was on
 *    screen.
 *
 * 2. ACTIONS UNDER THE TAB BAR. The modal centres in the viewport, and in the
 *    app shell the bottom 66px of that viewport is the tab bar. Cancel and Save
 *    were on screen and unreachable, which is worse than off-screen: nothing
 *    told the reader to scroll, and scrolling would not have helped, because the
 *    whole card scrolled together.
 *
 * So this asserts what a thumb can reach, at a small phone size, in the shell.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const ME = { observerNo: 2, createdAt: '2026-07-15T00:00:00Z', idHash: 'ef3bbd06d5cfa472763699eed658d864a6dbf6e86019c69e36acd762a0155a30' };
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (u === '/api/observers/me') return json(ME);
  if (u === '/api/observers/my-unit') return json({});
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

const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;
const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript((t) => {
    Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
    const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
    mark();
    document.addEventListener('readystatechange', mark);
    try { localStorage.setItem('hawkeye_token', t); localStorage.setItem('hawkeye_tour_seen', '1'); } catch (e) { /* ignore */ }
  }, JWT());
  const p = await ctx.newPage();
  await p.goto(`${base}/profile.html`);
  await p.waitForTimeout(800);
  await p.evaluate(() => { const m = document.getElementById('unit-modal'); if (m) m.hidden = false; });
  await p.waitForTimeout(250);
  return { ctx, p };
}

console.log('=== nothing empty is painted above the near-me button ===');
{
  const { ctx, p } = await open();
  const r = await p.evaluate(() => {
    const card = document.getElementById('unit-picked');
    return {
      exists: !!card,
      hiddenAttr: card ? card.hidden : null,
      // THE ONLY QUESTION THAT MATTERS: does the browser paint a box for it?
      painted: card ? card.getClientRects().length > 0 : false,
      height: card ? Math.round(card.getBoundingClientRect().height) : 0,
    };
  });
  console.log(`      hidden=${r.hiddenAttr} painted=${r.painted} height=${r.height}`);
  check('the confirmed-choice card exists in the markup', r.exists);
  check('it carries the hidden attribute before anything is picked', r.hiddenAttr, true);
  check('and the browser paints NO box for it', r.painted, false);
  await ctx.close();
}

console.log('\n=== CONTROL: the old unscoped display rule really did paint it ===');
{
  const { ctx, p } = await open();
  await p.addStyleTag({ content: '#unit-picked { display: block !important; }' });
  await p.waitForTimeout(150);
  const painted = await p.evaluate(() => document.getElementById('unit-picked').getClientRects().length > 0);
  console.log(`      with display:block forced -> painted=${painted}`);
  control('the paint detector catches a hidden element that still renders', !painted);
  await ctx.close();
}

console.log('\n=== Cancel and Save are reachable, not under the tab bar ===');
{
  const { ctx, p } = await open();
  const r = await p.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const barTop = bar ? bar.getBoundingClientRect().top : innerHeight;
    const btn = (id) => {
      const b = document.getElementById(id);
      const q = b.getBoundingClientRect();
      const mid = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
      return {
        bottom: Math.round(q.bottom),
        clearOfBar: q.bottom <= barTop + 1,
        onScreen: q.top >= 0 && q.bottom <= innerHeight,
        hitsItself: !!mid && (mid === b || b.contains(mid)),
      };
    };
    return { barTop: Math.round(barTop), cancel: btn('btn-unit-cancel'), save: btn('btn-unit-save') };
  });
  console.log(`      tab bar top=${r.barTop}  cancel bottom=${r.cancel.bottom}  save bottom=${r.save.bottom}`);
  check('Cancel sits above the tab bar', r.cancel.clearOfBar);
  check('Save sits above the tab bar', r.save.clearOfBar);
  check('both are within the viewport', r.cancel.onScreen && r.save.onScreen);
  check('and a tap on each lands on the button itself', r.cancel.hitsItself && r.save.hitsItself);
  await ctx.close();
}

console.log('\n=== a long list scrolls the BODY, leaving the actions put ===');
{
  const { ctx, p } = await open();
  // Fill FIRST, then measure. The card is allowed to grow to its max height as
  // content arrives — that is not the bug. The bug was the actions travelling
  // with the content once it started scrolling, so that is what is measured:
  // Save's position before and after a scroll of a body that is already full.
  await p.evaluate(() => {
    const host = document.getElementById('unit-near-results');
    host.innerHTML = Array.from({ length: 40 }, (_, i) => `<div style="padding:14px">Unit ${i}</div>`).join('');
  });
  await p.waitForTimeout(200);
  const scrollable = await p.evaluate(() => {
    const b = document.querySelector('#unit-modal .pw-body');
    return b ? b.scrollHeight > b.clientHeight + 4 : false;
  });
  check('precondition: the body is now scrollable', scrollable);
  const before = await p.evaluate(() => Math.round(document.getElementById('btn-unit-save').getBoundingClientRect().top));
  await p.evaluate(() => {
    const body = document.querySelector('#unit-modal .pw-body');
    if (body) body.scrollTop = body.scrollHeight;
  });
  await p.waitForTimeout(200);
  const after = await p.evaluate(() => {
    const b = document.getElementById('btn-unit-save');
    const q = b.getBoundingClientRect();
    const bar = document.querySelector('.tabbar');
    return { top: Math.round(q.top), clearOfBar: q.bottom <= (bar ? bar.getBoundingClientRect().top : innerHeight) + 1 };
  });
  console.log(`      Save top before scroll=${before} after scrolling to the end=${after.top}`);
  check('Save does not travel with the scrolling body', Math.abs(after.top - before) <= 2);
  check('and is still clear of the tab bar', after.clearOfBar);
  await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

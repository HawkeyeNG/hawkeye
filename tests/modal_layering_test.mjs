/**
 * NOTHING FLOATS ABOVE A MODAL.
 *
 * The Ask Hawkeye button carried z-index: 1200 — above the report sheet (120),
 * the tour (130), the refusal modal (140) and the menu panel (80). With the tour
 * open it was therefore the ONLY control on screen still reacting to a tap,
 * which is indistinguishable from a frozen app, and is exactly how it was
 * reported: "only the ask hawkeye chat icon is clickable".
 *
 * The bug was not that a layer got stuck. It was that a floating control
 * outranked every blocking one. That is a whole class of bug — any new pinned
 * button can reintroduce it — so this asserts the RULE rather than the one
 * button: while a blocking layer is up, a tap in the middle of the screen must
 * land on that layer, and nothing fixed may sit above it.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
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

/** The Lite shell, tour unseen so it opens by itself. */
async function shell({ seen = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 850 } });
  await ctx.addInitScript((o) => {
    Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
    const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
    mark();
    document.addEventListener('readystatechange', mark);
    try {
      localStorage.setItem('hawkeye_token', o.token);
      if (o.seen) localStorage.setItem('hawkeye_tour_seen', '1');
      else localStorage.removeItem('hawkeye_tour_seen');
    } catch (e) { /* ignore */ }
  }, { token: JWT(), seen });
  const p = await ctx.newPage();
  await p.goto(`${base}/index.html`);
  await p.waitForTimeout(900);
  return { ctx, p };
}

/** Every fixed, visible, tappable element that outranks `z`, by class or id. */
const above = (p, z) => p.evaluate((limit) => [...document.querySelectorAll('body *')]
  .filter((el) => {
    const c = getComputedStyle(el);
    if (c.position !== 'fixed' || c.display === 'none' || c.visibility === 'hidden') return false;
    if (c.pointerEvents === 'none') return false;
    const n = Number(c.zIndex);
    return Number.isFinite(n) && n > limit;
  })
  .map((el) => `${el.id ? '#' + el.id : '.' + String(el.className).split(' ')[0]} z=${getComputedStyle(el).zIndex}`), z);

console.log('=== while the tour is open, it is the top layer ===');
{
  const { ctx, p } = await shell();
  const open = await p.evaluate(() => { const t = document.querySelector('.tour'); return !!t && !t.hidden; });
  check('precondition: the tour opened by itself', open);
  const zTour = await p.evaluate(() => Number(getComputedStyle(document.querySelector('.tour')).zIndex));
  console.log(`      .tour z=${zTour}`);
  check('nothing fixed and tappable sits above it', await above(p, zTour), (a) => a.length === 0);
  const mid = await p.evaluate(() => {
    const e = document.elementFromPoint(195, 420);
    return e ? (e.closest('.tour') ? 'tour' : (e.id ? '#' + e.id : String(e.className))) : 'none';
  });
  check('a tap in the middle of the screen lands on the tour', mid, 'tour');
  await ctx.close();
}

console.log('\n=== the Ask Hawkeye button specifically ===');
{
  // It is built by menu.js on pages that have a results board; assert the RULE
  // from the stylesheet it ships, so this holds on every page it appears on.
  const src = fs.readFileSync(`${APP}/menu.js`, 'utf8');
  const m = src.match(/#hk-fab\{[^}]*z-index:\s*(\d+)/);
  check('the Ask Hawkeye button declares a z-index', !!m);
  const zFab = m ? Number(m[1]) : Infinity;
  console.log(`      #hk-fab z=${zFab}`);
  // The blocking layers, read from the shipped stylesheet rather than retyped.
  const css = fs.readFileSync(`${APP}/styles.css`, 'utf8');
  const zOf = (sel) => {
    const r = css.match(new RegExp(`\\${sel}\\s*\\{[^}]*z-index:\\s*(\\d+)`));
    return r ? Number(r[1]) : null;
  };
  /**
   * ENUMERATE THE BLOCKERS, DO NOT NAME THREE.
   *
   * This asserted against a hardcoded list — .report-sheet, .tour, .hk-alert —
   * and so had no opinion about #camera-overlay (z-100, `position:fixed;
   * inset:0`, used on collation, incidents and practice, all of which mount the
   * assistant). The FAB shipped at z-110, above it, and this test passed.
   *
   * A blocking layer is any rule that covers the viewport, so find them that
   * way: every `position:fixed` rule with `inset:0` and a z-index. A new modal
   * added tomorrow is then covered without editing this file.
   */
  const blockers = [];
  const RULE = /([^{}]+)\{([^}]*position:\s*fixed[^}]*)\}/g;
  let r;
  while ((r = RULE.exec(css))) {
    const body = r[2];
    if (!/inset:\s*0/.test(body)) continue;          // must cover the viewport
    const z = body.match(/z-index:\s*(\d+)/);
    if (!z) continue;
    blockers.push({ sel: r[1].trim().split('\n').pop().trim(), z: Number(z[1]) });
  }
  console.log(`      blocking layers found: ${blockers.map((b) => `${b.sel}=${b.z}`).join(', ')}`);
  // The enumeration itself must not silently find nothing — that would pass
  // every assertion below for the wrong reason.
  check('the stylesheet scan found blocking layers', blockers.length >= 3);
  for (const b of blockers) check(`#hk-fab sits below ${b.sel} (${b.z})`, zFab < b.z);

  // And still above the furniture it is meant to float over.
  const tabbar = zOf('.tabbar');
  check('but still above the tab bar', zFab > (tabbar ?? 0));

  /**
   * THE PANEL, NOT ONLY THE BUTTON. #hk-panel was left at z-1200 when the FAB
   * was lowered, so the assistant's own 360px panel still floated above every
   * modal — the same defect on the element that actually covers content. The
   * DOM probe cannot see it (it runs with the panel display:none), so it is
   * asserted from the stylesheet text alongside the button.
   */
  const mp = src.match(/#hk-panel\{[^}]*z-index:\s*(\d+)/);
  check('the assistant panel declares a z-index', !!mp);
  const zPanel = mp ? Number(mp[1]) : Infinity;
  console.log(`      #hk-panel z=${zPanel}`);
  for (const b of blockers) check(`#hk-panel sits below ${b.sel} (${b.z})`, zPanel < b.z);
}

console.log('\n=== CONTROL: the detector catches a control that outranks a modal ===');
{
  const { ctx, p } = await shell();
  const zTour = await p.evaluate(() => Number(getComputedStyle(document.querySelector('.tour')).zIndex));
  await p.evaluate(() => {
    const f = document.createElement('button');
    f.id = 'control-fab';
    f.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:1200;width:56px;height:56px';
    document.body.appendChild(f);
  });
  const found = await above(p, zTour);
  console.log(`      injected a z=1200 button -> ${JSON.stringify(found)}`);
  control('a floating control above the tour is detected', found.length === 0);
  await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

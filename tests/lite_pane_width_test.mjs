/**
 * THE REPORT COLUMN FITS A 344 PX SCREEN AT ANY PHONE FONT SIZE.
 *
 * Galaxy Z Fold 5, cover screen, Lite, a large font size set on the phone:
 * every card on the report screen ran off the right edge, with "Close ▾" and
 * the end of each line out of sight. #page-scroll is a flex column and
 * main.wrap centres itself with auto margins, which turns off stretch — so
 * main was as wide as its widest unbreakable content, here the election
 * list's "House of Representatives — Opens 16 Jan" drawn at the phone's text
 * size. Desktop emulation at 344 px with normal text never showed it; the
 * phone's font size is the trigger, so this scales every font the way Android
 * does inside a WebView (1.3× and 1.6×; Android 14 goes to 2×).
 *
 * Also: an FCT unit's list carries no Governorship or State Assembly — the FCT
 * holds neither election, so they sat there "not open yet" for ever.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const CONTESTS = [
  { code: 'PRES', name: 'Presidential', open: false, date: '2027-01-16' },
  { code: 'SEN', name: 'Senate', open: false, date: '2027-01-16' },
  { code: 'REP', name: 'House of Representatives', open: false, date: '2027-01-16' },
];
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/contests') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(CONTESTS)); }
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"units":[],"rows":[],"items":[]}'); }
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, ok, got) => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const FCT_UNIT = { pu_code: '37-06-02-142', name: 'Excel Specialist Hospital And Fertility', ward: 'Garki', lga: 'Municipal', state: 'FCT', locationTier: 'verified' };
const LAGOS_UNIT = { pu_code: '24-01-01-001', name: 'Open Space', ward: 'Ward A', lga: 'Agege', state: 'LAGOS', locationTier: 'verified' };

async function report(scale, unit, css) {
  const ctx = await b.newContext({ viewport: { width: 344, height: 882 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  await p.goto(`${base}/observe.html`, { waitUntil: 'networkidle' });
  const r = await p.evaluate(async ([scale, unit, css]) => {
    document.documentElement.classList.add('native-app');   // what native.js does inside Lite
    if (css) { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); }
    show('screen-submit');
    try { await prepareReportUI(); } catch (e) { /* signed out: the race list still fills */ }
    bindUnit(unit);
    await new Promise((ok) => setTimeout(ok, 300));
    for (const d of document.querySelectorAll('details.step-card')) d.open = true;
    // Every font scaled at once, as the phone's font-size setting does in a WebView.
    const all = [...document.querySelectorAll('body, body *')];
    const fs = all.map((el) => parseFloat(getComputedStyle(el).fontSize));
    all.forEach((el, i) => { el.style.fontSize = `${fs[i] * scale}px`; });
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const pane = document.getElementById('page-scroll');
    const edge = pane.getBoundingClientRect().left + pane.clientWidth;
    return {
      fixedPane: getComputedStyle(pane).position === 'fixed',
      paneW: pane.clientWidth, paneScrollW: pane.scrollWidth,
      mainR: Math.round(document.querySelector('#page-scroll > main').getBoundingClientRect().right), edge: Math.round(edge),
      cardsR: [...document.querySelectorAll('#screen-submit .step-card')].map((c) => Math.round(c.getBoundingClientRect().right)),
      options: [...document.getElementById('sel-contest').options].map((o) => o.value).filter(Boolean),
    };
  }, [scale, unit, css || '']);
  await ctx.close();
  return { ...r, errs };
}
const fits = (r) => r.fixedPane && r.mainR <= r.edge && r.cardsR.every((x) => x <= r.edge) && r.paneScrollW <= r.paneW;

for (const k of [1, 1.3, 1.6]) {
  const r = await report(k, FCT_UNIT);
  check(`Lite at 344 px, text ×${k}: the report column and every card stay inside the screen`, fits(r), r);
  if (k === 1) {
    check('no page errors', r.errs.length === 0, r.errs);
    check('an FCT unit is offered no Governorship or State Assembly', !r.options.includes('GOV') && !r.options.includes('SHA') && r.options.includes('PRES'), r.options);
  }
}
// CONTROLS: the measurement must be able to fail.
const old = await report(1.6, FCT_UNIT, 'html.has-shell #page-scroll > main { width: auto !important; }');
check('CONTROL: with the column shrink-wrapping again (the old CSS), text ×1.6 runs off the screen', !fits(old), old);
const lagos = await report(1, LAGOS_UNIT);
check('CONTROL: a Lagos unit still lists Governorship and State Assembly', lagos.options.includes('GOV') && lagos.options.includes('SHA'), lagos.options);

await b.close();
server.close();
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);

/**
 * "Try a practice run — 5 minutes" — the home card (index.html #pnudge-card)
 * against stubbed /api/practice/nudge and /api/practice-days.
 *
 * What is proven, and the control for each:
 *  - AT MOST ONE practice card: when the nudge shows, the National Practice Day
 *    card steps aside (control: the same page with show:false shows the
 *    Practice Day card);
 *  - the server decides: show:false, an error, or a signed-out visitor hide it
 *    (control: show:true paints it);
 *  - dismissal hides it, hands the slot back to the Practice Day card, survives
 *    a reload without even asking the server, and is per observer (control: a
 *    different observer on the same browser still sees it);
 *  - translation happens at PAINT time: Hausa on load, Yorùbá after a switch
 *    without a reload (control: the English run shows English);
 *  - no page errors and no console errors in any state.
 *
 * The Hausa/Yorùbá strings come from scripts/i18n/batches/reminders_web.json
 * merged over the shipped bundle — exactly what the merge will ship.
 *
 *   node tests/practice_nudge_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const BATCH = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/scripts/i18n/batches/reminders_web.json', 'utf8'));
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const H = 3_600_000;
const DEC = { date: '2026-12-12', startsAt: Date.parse('2026-12-12T08:00:00+01:00'), endsAt: Date.parse('2026-12-12T18:00:00+01:00') };
const dayOf = (d, phase) => ({ ...d, phase, resultsUntil: d.endsAt + 5 * 24 * H, window: { start: '08:00', end: '18:00' }, timezone: 'Africa/Lagos', utcOffset: '+01:00' });
const PDAYS = {
  before: { day: dayOf(DEC, 'before'), results: null, next: null, days: [], now: Date.now() },
  live: { day: dayOf(DEC, 'live'), results: { participants: 12, runs: 12, tallied: 12, totals: [], asOf: Date.now() }, next: null, days: [], now: Date.now() },
  none: { day: null, next: null, days: [], now: Date.now() },
};
let pday = 'before';
let nudge = 'show';        // show | hide | error
let observerId = 7;
let nudgeHits = 0;

const merged = (lang) => {
  const b = JSON.parse(fs.readFileSync(path.join(APP, 'i18n', lang + '.json'), 'utf8'));
  for (const [k, v] of Object.entries(BATCH)) b[k] = v[lang];
  return b;
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/practice/nudge') {
    nudgeHits++;
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) return json({ error: 'missing_token' }, 401);
    if (nudge === 'error') return json({ error: 'boom' }, 500);
    return json({ show: nudge === 'show', practised: nudge !== 'show', practiceOpen: true, practiceDay: null });
  }
  if (url === '/api/practice-days') return json(PDAYS[pday]);
  if (url === '/api/observers/me') return json({ observerId, reports: [], collation: [], incidents: [], subscriptions: [] });
  if (url === '/api/notifications') return json({ items: [] });
  if (url === '/api/mapping/stats') return json({ total: 0, verified: 0, crowdMapped: 0 });
  if (url.startsWith('/api/')) return json([]);
  const m = /^\/i18n\/(ha|ig|yo)\.json$/.exec(url);
  if (m) return json(merged(m[1]));
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

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const TOKEN = 'x.' + Buffer.from(JSON.stringify({ sub: '7', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.y';

async function open({ lang = 'en', signedIn = true, ctx = null } = {}) {
  const c = ctx || await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  if (!ctx) {
    await c.addInitScript(([tok, l, s]) => {
      try {
        if (s && !sessionStorage.getItem('seeded')) { localStorage.setItem('hawkeye_token', tok); sessionStorage.setItem('seeded', '1'); }
        localStorage.setItem('hawkeye_lang', l); localStorage.setItem('hawkeye_tour_done', '1');
      } catch (e) {}
    }, [TOKEN, lang, signedIn]);
  }
  const pg = await c.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await pg.goto(base + '/index.html', { waitUntil: 'networkidle' });
  await pg.waitForSelector('#pnudge-card', { state: 'attached', timeout: 10000 });
  await pg.waitForTimeout(400);
  return { pg, ctx: c, errs };
}
const cards = (pg) => pg.evaluate(() => {
  const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  const n = document.getElementById('pnudge-card');
  const p = document.getElementById('pday-card');
  return {
    nudge: vis(n),
    pday: vis(p),
    visiblePracticeCards: [n, p].filter(vis).length,
    text: n.innerText.replace(/\s+/g, ' ').trim(),
    links: [...n.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    dismissLabel: n.querySelector('.pnudge-x')?.getAttribute('aria-label') || null,
    // styles.css makes every <button> full-width and green; the × must not be.
    dismissBox: (() => {
      const b = n.querySelector('.pnudge-x'); if (!b) return null;
      const q = b.getBoundingClientRect();
      const a = getComputedStyle(b, '::after');
      // The tap target: the button plus its ::after overhang on each side.
      return [Math.round(q.width), Math.round(q.height), getComputedStyle(b).boxShadow, Math.round(q.width - 2 * parseFloat(a.left))];
    })(),
  };
});

/* ---------- 1. show: the nudge takes the slot, the Practice Day card steps aside ---------- */
pday = 'before'; nudge = 'show'; observerId = 7;
let r = await open();
let c = await cards(r.pg);
check('show: nudge visible', c.nudge, true);
check('show: title and body', c.text, (t) => t.startsWith('Try a practice run — 5 minutes') && t.includes('Nothing you enter counts as a real result.'));
check('show: the button opens the practice flow', c.links, ['practice.html']);
check('show: the × has an accessible name', c.dismissLabel, 'Dismiss');
check('show: the × is small, unshadowed, with a 44px tap target (not the global full-width button)', c.dismissBox, [28, 28, 'none', 44]);
check('AT MOST ONE: Practice Day card steps aside while the nudge shows', [c.pday, c.visiblePracticeCards], [false, 1]);
const gaps = await r.pg.evaluate(() => {
  const cs = [...document.querySelectorAll('.home-stack > .home-card')].filter((el) => el.getClientRects().length);
  return cs.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - cs[i].getBoundingClientRect().bottom));
});
check('the nudge takes the stack\'s own gap (no double gap from the hidden card)', gaps, (g) => g.length >= 2 && new Set(g).size === 1);
check('show: no errors', r.errs, []);
await r.pg.evaluate(() => console.error('control-error'));
await r.pg.waitForTimeout(50);
check('CONTROL the console-error capture sees an error', r.errs.some((e) => e.includes('control-error')), true);
r.errs.length = 0;
if (process.env.NUDGE_SHOTS) await r.pg.locator('#pnudge-card').screenshot({ path: `${process.env.NUDGE_SHOTS}/nudge-en.png` });

/* ---------- 2. dismiss: hidden, slot handed back, survives reload, per observer ---------- */
await r.pg.click('#pnudge-card .pnudge-x');
await r.pg.waitForTimeout(150);
c = await cards(r.pg);
check('dismiss: nudge hidden', c.nudge, false);
check('dismiss: the Practice Day card gets the slot back', [c.pday, c.visiblePracticeCards], [true, 1]);
nudgeHits = 0;
await r.pg.reload({ waitUntil: 'networkidle' });
await r.pg.waitForTimeout(400);
c = await cards(r.pg);
check('dismissed stays dismissed after a reload', [c.nudge, c.pday], [false, true]);
check('...and the server is not even asked', nudgeHits, 0);
check('dismiss + reload: no errors', r.errs, []);
observerId = 8;                                         // same browser, another account
await r.pg.reload({ waitUntil: 'networkidle' });
await r.pg.waitForTimeout(400);
c = await cards(r.pg);
check('CONTROL per observer: observer #8 on this browser still sees it', [c.nudge, c.pday], [true, false]);
await r.ctx.close();
observerId = 7;

/* ---------- 3. the server says no: the Practice Day card holds the page ---------- */
pday = 'live'; nudge = 'hide';
r = await open(); c = await cards(r.pg);
check('show:false (practised / Practice Day near): nudge hidden, Practice Day card shown', [c.nudge, c.pday, c.visiblePracticeCards], [false, true, 1]);
check('show:false: no errors', r.errs, []);
await r.ctx.close();
nudge = 'error';
r = await open(); c = await cards(r.pg);
check('endpoint error: nudge hidden, Practice Day card untouched', [c.nudge, c.pday], [false, true]);
check('endpoint error: no page errors', r.errs.filter((e) => !/status of 500/.test(e)), []);
await r.ctx.close();
pday = 'none'; nudge = 'show';
r = await open(); c = await cards(r.pg);
check('CONTROL show:true with no Practice Day: nudge visible, nothing else', [c.nudge, c.pday, c.visiblePracticeCards], [true, false, 1]);
await r.ctx.close();

/* ---------- 4. signed out: no card, no call ---------- */
nudgeHits = 0;
r = await open({ signedIn: false }); c = await cards(r.pg);
check('signed out: no nudge, and the endpoint is never called', [c.nudge, nudgeHits], [false, 0]);
await r.ctx.close();

/* ---------- 5. translated at paint time ---------- */
pday = 'before'; nudge = 'show';
r = await open({ lang: 'ha' });
await r.pg.waitForFunction(() => /atisaye/.test(document.getElementById('pnudge-card').innerText), null, { timeout: 5000 }).catch(() => {});
c = await cards(r.pg);
check('Hausa: title, body, button and label in Hausa', [c.text.includes('Gwada gwajin atisaye — minti 5'), c.text.includes('Fara gwajin atisaye'), c.dismissLabel], [true, true, 'Rufe']);
await r.pg.evaluate(() => window.HawkeyeI18n.set('yo'));
await r.pg.waitForFunction(() => /àdánwò/.test(document.getElementById('pnudge-card').innerText), null, { timeout: 5000 }).catch(() => {});
c = await cards(r.pg);
check('switch to Yorùbá without reload: the card repaints', [c.text.includes('Gbìyànjú eré àdánwò'), c.text.includes('Gwada'), c.dismissLabel], [true, false, 'Ti']);
check('still one practice card after the repaint', c.visiblePracticeCards, 1);
check('language switch: no errors', r.errs, []);
if (process.env.NUDGE_SHOTS) await r.pg.locator('#pnudge-card').screenshot({ path: `${process.env.NUDGE_SHOTS}/nudge-yo.png` });
await r.ctx.close();

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

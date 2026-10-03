/**
 * The October 2026 design audit's web/Lite fixes, measured on the RENDERED page
 * (each with a control that shows the check can fail):
 *
 *  X6  header titles wrap instead of "Leaderb…"; below 400px the website hands
 *      language + theme to the ☰ menu's Preferences row (control: 420px keeps
 *      them in the header; the wordmark Home keeps them at 360);
 *  X7  header controls are 44x44 boxes that LOOK 36px; info dots 44 to touch;
 *  W1  the phone menu is the dark card in dark mode, sits UNDER the header row,
 *      ☰ draws as ×, and Back closes it (control: closing with × leaves history
 *      where it was);
 *  W2  a link nothing styled takes --link, not the browser's #0000EE;
 *  X5  chips read in dark mode (REQUIRED, DECLARED RESULT, follow tag, Open);
 *  X2  a pinned bar at the foot lifts the chat bubble above it (control: no
 *      bar, bubble at 18px); a bubble page reserves its height at the end;
 *  X4  a mistyped number is a line under the field, not a dialog;
 *  X9  Results with the API unreachable says so (control: reachable, no line).
 *
 *   node tests/design_audit_fixes_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
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
const CONTESTS = [{ code: 'PRES', name: 'Presidential', tier: 'PRES', date: '2027-01-16', states: [] }];

async function open(page, { width = 360, theme = 'dark', lang = 'en', signedIn = false, api = {}, lite = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 740 }, serviceWorkers: 'block', isMobile: width < 700, hasTouch: width < 700 });
  await ctx.addInitScript(([tok, theme, lang, signedIn, lite]) => {
    try {
      localStorage.setItem('hawkeye_theme', theme); localStorage.setItem('hawkeye_lang', lang);
      localStorage.setItem('hawkeye_lang_prompted', '1'); localStorage.setItem('hawkeye_tour_done', '1');
      if (signedIn) localStorage.setItem('hawkeye_token', tok); else localStorage.removeItem('hawkeye_token');
    } catch (e) { /* about:blank */ }
    if (lite) window.Capacitor = { isNativePlatform: () => true, Plugins: {}, getPlatform: () => 'android' };
  }, [TOKEN, theme, lang, signedIn, lite]);
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/')) {
      const h = api[u.pathname];
      if (h === 'offline') return route.abort('internetdisconnected');
      if (h) return route.fulfill({ status: h.status || 200, contentType: 'application/json', body: JSON.stringify(h.json) });
      if (u.pathname === '/api/contests') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTESTS) });
      if (u.pathname === '/api/assistant/health') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"enabled":true}' });
      if (u.pathname === '/api/health') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"smsOtp":false,"waInbound":true}' });
      if (u.pathname === '/api/observers/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, observerId: 7, reports: [], collation: [], incidents: [], subscriptions: [{ contest: 'PRES', state: '' }], mappings: [] }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (u.origin === base) return route.continue();
    if (u.hostname === 'hawkeye.com.ng') {
      const f = path.join(APP, decodeURIComponent(u.pathname));
      if (f.startsWith(APP) && fs.existsSync(f) && !fs.statSync(f).isDirectory()) return route.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    }
    return route.abort();
  });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${base}/${page}`, { waitUntil: 'domcontentloaded' });
  await pg.waitForLoadState('networkidle').catch(() => {});
  await pg.waitForTimeout(700);
  return { pg, ctx, errs };
}

/* ---------- X6: titles wrap; the website's narrow header hands controls to the menu ---------- */
let r = await open('results.html', { lang: 'ha' });
let h = await r.pg.evaluate(() => {
  const s = document.querySelector('.gov-header .brand-text strong');
  const shown = (sel) => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; };
  return {
    clipped: s.scrollHeight > s.clientHeight + 2 || s.scrollWidth > s.clientWidth + 1,
    lines: Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight)),
    langInHeader: shown('.gov-header .brand-row > .lang-btn'), themeInHeader: shown('.gov-header .brand-row > .theme-btn:not(.lang-btn):not(.close-btn)'),
    prefs: !!document.querySelector('#menu-panel .menu-prefs'),
  };
});
check('X6 Hausa page title at 360: not clipped', h.clipped, false);
check('X6 ...language and theme leave the header for the menu', [h.langInHeader, h.themeInHeader, h.prefs], [false, false, true]);
await r.pg.click('.menu-btn');
await r.pg.waitForTimeout(250);
const prefs = await r.pg.evaluate(() => [...document.querySelectorAll('#menu-panel .menu-pref')].filter((b) => b.getClientRects().length).map((b) => b.textContent.trim()));
check('X6 ...the menu shows Language and the theme switch', prefs.length === 2 && /HA/.test(prefs[0]), true);
await r.pg.click('#menu-panel .menu-pref >> nth=1');
await r.pg.waitForTimeout(150);
check('X6 ...the menu theme button switches the theme', await r.pg.evaluate(() => document.documentElement.dataset.theme), 'light');
await r.ctx.close();
r = await open('results.html', { width: 420 });
h = await r.pg.evaluate(() => { const e = document.querySelector('.gov-header .brand-row > .lang-btn'); return !!e && e.getClientRects().length > 0; });
check('X6 CONTROL at 420px the header keeps its language button', h, true);
await r.ctx.close();
r = await open('index.html', {});
h = await r.pg.evaluate(() => { const e = document.querySelector('.gov-header .brand-row > .lang-btn'); return !!e && e.getClientRects().length > 0; });
check('X6 CONTROL the landing (wordmark) keeps its language button at 360', h, true);
await r.ctx.close();

/* ---------- X7: header controls 44 to touch, 36 to see; info dots 44 ---------- */
r = await open('races.html', { width: 420, signedIn: true });
h = await r.pg.evaluate(() => [...document.querySelectorAll('.gov-header .brand-row > :is(.menu-btn, .theme-btn, .bell-btn)')].filter((e) => e.getClientRects().length).map((e) => {
  const b = e.getBoundingClientRect(); const i = getComputedStyle(e, '::before');
  return [Math.round(b.width) >= 44, Math.round(b.height), Math.round(b.height - parseFloat(i.top) - parseFloat(i.bottom))];
}));
check('X7 header controls: >=44 wide, 44 tall, drawn 36', h.length >= 3 && h.every(([w, hh, vis]) => w && hh === 44 && vis === 36), true);
const dot = await r.pg.evaluate(() => { const d = document.querySelector('.info-i'); if (!d) return null; const b = d.getBoundingClientRect(); const v = getComputedStyle(d, '::before'); return [Math.round(b.width), Math.round(b.height), parseFloat(v.width)]; });
check('X7 info dot: a 44x44 target drawn at 20px', dot, [44, 44, 20]);
await r.ctx.close();

/* ---------- W1: the phone menu ---------- */
r = await open('races.html', { theme: 'dark' });
const hist0 = await r.pg.evaluate(() => history.length);
await r.pg.click('.menu-btn');
await r.pg.waitForTimeout(300);
h = await r.pg.evaluate(() => {
  const p = document.getElementById('menu-panel');
  const hdr = document.querySelector('.gov-header .brand-row').getBoundingClientRect();
  const btn = document.querySelector('.menu-btn');
  return { bg: getComputedStyle(p).backgroundColor, top: Math.round(p.getBoundingClientRect().top), hdrBottom: Math.round(hdr.bottom), x: getComputedStyle(btn, '::after').content, link: getComputedStyle(p.querySelector('a')).color };
});
check('W1 dark: the sheet is the dark card, not white', h.bg, 'rgb(18, 36, 27)');
check('W1 dark: its links are light ink', h.link, 'rgb(232, 242, 236)');
check('W1 the header row stays visible above the sheet', h.top >= h.hdrBottom - 1, true);
check('W1 ☰ is drawn as × while open', h.x, '"×"');
await r.pg.goBack();
await r.pg.waitForTimeout(300);
check('W1 Back closes the menu and stays on the page', await r.pg.evaluate(() => [document.getElementById('menu-panel').hidden, location.pathname]), [true, '/races.html']);
await r.pg.click('.menu-btn');
await r.pg.waitForTimeout(200);
await r.pg.click('.menu-btn');
await r.pg.waitForTimeout(400);
check('W1 CONTROL closing with × leaves the history as it was', await r.pg.evaluate(() => history.length) <= hist0 + 1 && await r.pg.evaluate(() => !(history.state && history.state.hkMenu)), true);
await r.ctx.close();

/* ---------- W2 + X5 on one page ---------- */
r = await open('races.html', { theme: 'dark' });
h = await r.pg.evaluate(() => {
  const host = document.querySelector('main');
  host.insertAdjacentHTML('beforeend', '<div class="card" id="t"><a href="#x" id="plain">plain link</a> <span class="slot-status">Required</span> <h2 class="declared-tag">Declared result</h2> <span class="chip ok">ok</span> <span class="chip wait">wait</span></div>');
  const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  const card = getComputedStyle(document.getElementById('t')).backgroundColor;
  const c = (sel) => ratio(getComputedStyle(document.querySelector('#t ' + sel)).color, card);
  return { link: getComputedStyle(document.getElementById('plain')).color, req: c('.slot-status'), declared: c('.declared-tag'), ok: c('.chip.ok') };
});
check('W2 a link nothing styled is --link (mint in dark), not #0000EE', h.link, 'rgb(87, 217, 161)');
check('X5 dark: REQUIRED >= 4.5:1 (was 3.34)', h.req, (v) => v >= 4.5);
check('X5 dark: DECLARED RESULT >= 4.5:1 (was 1.39)', h.declared, (v) => v >= 4.5);
check('X5 dark: ok chip >= 4.5:1', h.ok, (v) => v >= 4.5);
await r.ctx.close();

/* ---------- X2: the bubble docks above a pinned bar; pages reserve its height ---------- */
r = await open('races.html', { signedIn: true });
await r.pg.waitForSelector('#hk-fab', { timeout: 8000 }).catch(() => {});
const fabBottom = () => r.pg.evaluate(() => { const f = document.getElementById('hk-fab'); return f ? Math.round(innerHeight - f.getBoundingClientRect().bottom) : null; });
check('X2 CONTROL no pinned bar: the bubble sits 18px up', await fabBottom(), 18);
await r.pg.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div data-fab-dock style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#333"></div>'));
await r.pg.waitForTimeout(500);
check('X2 a pinned bar at the foot lifts the bubble above it', await fabBottom(), (v) => v >= 80);
h = await r.pg.evaluate(() => [document.body.classList.contains('has-fab'), parseFloat(getComputedStyle(document.querySelector('.gov-footer .wrap')).paddingBottom)]);
check('X2 a bubble page reserves its height at the end (footer)', h[0] && h[1] >= 72, true);
await r.ctx.close();

/* ---------- X4: a mistyped number is a line under the field ---------- */
r = await open('observe.html?intent=observe', { api: { '/api/observers/register': { status: 400, json: { error: 'invalid_phone' } }, '/api/observers/wa-start': { status: 503, json: {} } } });
await r.pg.fill('#auth-input', '0803');
await r.pg.check('input[name="otp-channel"][value="telegram"]');
await r.pg.click('#btn-auth');
await r.pg.waitForTimeout(600);
h = await r.pg.evaluate(() => {
  const e = document.getElementById('auth-err');
  return { shown: !e.hidden, text: e.textContent, under: e.previousElementSibling && e.previousElementSibling.id, dialog: !!document.querySelector('[data-hk-dialog]'), invalid: document.getElementById('auth-input').getAttribute('aria-invalid'), title: document.getElementById('register-title').textContent.trim(), btn: document.getElementById('btn-auth').textContent.trim() };
});
check('X4 the error shows under the number, no dialog', [h.shown, h.under, h.dialog, h.invalid], [true, 'auth-input', false, 'true']);
check('X4 ...and says what is wrong', h.text, (t) => /Nigerian mobile number/.test(t));
check('X4 one title and one button with native', [h.title, h.btn], ['Create Your Account', 'Send Code']);
await r.pg.type('#auth-input', '1');
check('X4 typing clears it', await r.pg.evaluate(() => document.getElementById('auth-err').hidden), true);
await r.ctx.close();

/* ---------- X9: Results unreachable says so ---------- */
r = await open('results.html', { api: { '/api/contests': 'offline' } });
check('X9 Results with the API unreachable: the offline line + Try again', await r.pg.evaluate(() => { const o = document.getElementById('results-offline'); return !o.hidden && !!o.querySelector('button'); }), true);
await r.ctx.close();
r = await open('results.html', {});
check('X9 CONTROL reachable: no offline line', await r.pg.evaluate(() => document.getElementById('results-offline').hidden), true);
check('no page errors (results)', r.errs, []);
await r.ctx.close();

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

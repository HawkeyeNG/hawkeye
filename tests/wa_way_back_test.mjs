/**
 * THE WHATSAPP SIGN-IN SCREEN, SHORT; iOS WITHOUT THE "OPEN WHATSAPP?"
 * CONFIRM; AND THE "BACK TO HAWKEYE" LINK (owner, 2026-09-30).
 *
 *  1. "Send us this code on WhatsApp" is a title, ONE short line, the code, the
 *     button, a small spinner + "Waiting for your message…", the safety line,
 *     then small fallback links — on the web (observe.html + app.js) and native
 *     (sign-in.tsx). The long paragraph and the "nothing to type here" line are
 *     gone from both.
 *  2. iOS opens the wa.me Universal Link, not whatsapp:// (which makes iOS ask
 *     first). Android keeps whatsapp://; a desktop keeps wa.me.
 *  3. https://hawkeye.com.ng/open?to=back — the last line of the WhatsApp and
 *     Telegram sign-in replies (backend services/wayBack.js) — brings the app
 *     to the front WITHOUT navigating, so the waiting sign-in screen finishes:
 *     native +native-intent.tsx returns null while the app runs, Lite native.js
 *     ignores it, and in a browser app/open/index.html says where to go back to
 *     instead of redirecting. Every rule has a control beside it.
 *
 *   node tests/wa_way_back_test.mjs
 */
import { createRequire, stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const N = `${ROOT}/native/src/`;
const read = (f) => fs.readFileSync(f, 'utf8');
const SHOTS = process.env.SHOTS || '';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-waback-'));
const loadTs = async (rel, name, dropImports = false) => {
  let src = read(`${N}${rel}`);
  if (dropImports) src = src.replace(/^import [^;]+;\n/gm, '');
  const file = path.join(tmp, name);
  fs.writeFileSync(file, stripTypeScriptTypes(src, { mode: 'strip' }));
  return import(pathToFileURL(file).href);
};

// ------------------------------------------------------------ 3. the way back
console.log('=== native: /open?to=back is recognised, and nothing else is ===');
{
  const W = await loadTs('lib/web-routes.ts', 'web-routes.mjs');
  for (const u of ['https://hawkeye.com.ng/open?to=back', 'https://hawkeye.com.ng/open/?to=back', 'https://www.hawkeye.com.ng/open/index.html?to=back&x=1', 'hawkeye://open?to=back']) {
    check(`way back: ${u}`, W.isWayBackLink(u), true);
  }
  for (const u of ['https://hawkeye.com.ng/open?to=report', 'https://hawkeye.com.ng/open?to=backup', 'https://evil.example/open?to=back', 'https://hawkeye.com.ng/ready.html?to=back', 'hawkeye://open']) {
    check(`control, not the way back: ${u}`, W.isWayBackLink(u), false);
  }
  const intent = read(`${N}app/+native-intent.tsx`);
  check('+native-intent returns null (no navigation) for it while the app is running',
    /if \(!initial\) \{[\s\S]{0,120}if \(isWayBackLink\(path\)\) return null;/.test(intent), true);
  check('and its return type allows null (Expo Router skips the navigation)', /\): string \| null \{/.test(intent), true);
  const open = read(`${N}app/open.tsx`);
  check('a cold start on /open?to=back goes back, else home — never a target screen',
    /=== 'back'\) \{\s*if \(router\.canGoBack\(\)\) router\.back\(\);\s*else router\.replace\('\/\(tabs\)'\);\s*return;/.test(open), true);
  const lite = read(`${APP}/native.js`);
  const route = lite.slice(lite.indexOf('const route = (url) =>'), lite.indexOf("App.addListener('appUrlOpen'"));
  check('Lite: a to=back link returns before any navigation',
    route.indexOf("get('to') === 'back') return;") > 0 && route.indexOf("get('to') === 'back') return;") < route.indexOf('location.href = dest'), true);
}

// ---------------------------------------------------------- 2. WhatsApp on iOS
console.log('\n=== native: iOS opens wa.me, Android whatsapp:// ===');
{
  const S = await loadTs('lib/wa-signin.ts', 'wa-signin.mjs', true);
  const link = 'https://wa.me/2347042248544?text=Sign%20me%20in%20to%20Hawkeye.%20Code%3A%20HK-4K7Q2M';
  const opened = [];
  const ok = (u) => { opened.push(u); return Promise.resolve(true); };
  check('iOS: the first thing opened is the wa.me Universal Link', [await S.openWhatsApp(link, ok, 'ios'), opened[0]], ['link', link]);
  opened.length = 0;
  check('Android: whatsapp:// first (the control)', [await S.openWhatsApp(link, ok, 'android'), opened[0]],
    ['app', 'whatsapp://send?phone=2347042248544&text=Sign%20me%20in%20to%20Hawkeye.%20Code%3A%20HK-4K7Q2M']);
  opened.length = 0;
  const noApp = (u) => { opened.push(u); return u.startsWith('whatsapp:') ? Promise.reject(new Error('no handler')) : Promise.resolve(true); };
  check('Android without WhatsApp: falls back to wa.me', [await S.openWhatsApp(link, noApp, 'android'), opened], ['link', [opened[0], link]]);
  const signIn = read(`${N}app/sign-in.tsx`);
  check('sign-in passes the platform through', /openWhatsApp\(wa\.waLink, \(u\) => Linking\.openURL\(u\), Platform\.OS\)/.test(signIn), true);
}

// --------------------------------------------------------- 1. the short screen
console.log('\n=== native: the WhatsApp step is short ===');
{
  const signIn = read(`${N}app/sign-in.tsx`);
  const pane = signIn.slice(signIn.indexOf("step === 'wa-send' ?"), signIn.indexOf("step === 'otp' ?"));
  check('one short line (wa-body-3)', pane.includes("i18nT('n.auth.wa-body-3')"), true);
  check('the long paragraph (wa-body-2) is gone', /wa-body-2/.test(signIn), false);
  check('the waiting line is the short one', /i18nT\('n\.auth\.wa-waiting'\)/.test(signIn) && !/wa-waiting-2/.test(signIn), true);
  check('the safety line stays, small', /text-xs text-muted">\{i18nT\('n\.auth\.wa-safety'\)\}/.test(pane), true);
  const order = ['n.auth.wa-title', 'n.auth.wa-body-3', 'n.auth.wa-open', 'waLine', 'n.auth.wa-safety', 'n.auth.wa-number', 'n.auth.wa-fallback-whatsapp', 'n.auth.wa-fallback-sms', 'use-a-different-number'].map((k) => pane.indexOf(k));
  check('order: title, line, button, waiting, safety, then the fallbacks (number, code, SMS, other number)', order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), true);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const WA_LINK = 'https://wa.me/2347042248544?text=Sign%20me%20in%20to%20Hawkeye.%20Code%3A%20HK-4K7Q2M';
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/health') return json({ ok: true, waInbound: true, smsOtp: false });
  if (url === '/api/observers/wa-start') return json({ pollToken: 'p1', code: 'HK-4K7Q2M', waLink: WA_LINK, waNumber: '+234 704 224 8544', expiresInS: 600, pollAfterMs: 60000 });
  if (url === '/api/observers/wa-status') return json({ status: 'pending', mismatch: false });
  if (url.startsWith('/api/')) return json({});
  let f = path.join(APP, decodeURIComponent(url));
  if (f.startsWith(APP) && fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!f.startsWith(APP) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ctxFor = async (ua, { theme = 'light', lang = 'en', touch = 0 } = {}) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 900 }, userAgent: ua, reducedMotion: 'reduce' });
  await ctx.addInitScript(([t, l, tp]) => {
    try { localStorage.setItem('hawkeye_theme', t); localStorage.setItem('hawkeye_lang', l); } catch (e) { /* none */ }
    if (tp) Object.defineProperty(navigator, 'maxTouchPoints', { get: () => tp });
  }, [theme, lang, touch]);
  return ctx;
};

console.log('\n=== web: the WhatsApp pane is short ===');
for (const theme of ['light', 'dark']) {
  const ctx = await ctxFor(IPHONE, { theme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/observe.html?intent=signin`);
  await page.waitForFunction(() => typeof window.startWaSend === 'function');
  await page.evaluate(() => startWaSend('08031234567', ''));
  await page.waitForSelector('#wa-send:not([hidden])');
  const got = await page.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    const pane = document.getElementById('wa-send');
    return {
      title: document.querySelector('#wa-send .wa-title')?.innerText.trim(),
      body: document.getElementById('wa-body').innerText.trim(),
      code: document.getElementById('wa-code').innerText.trim(),
      waiting: document.getElementById('wa-status-text').innerText.trim(),
      spinner: vis(document.getElementById('wa-spin')),
      text: pane.innerText,
      order: ['wa-body', 'wa-code', 'wa-open', 'wa-status', 'wa-number', 'wa-paid'].map((id) => document.getElementById(id).getBoundingClientRect().top),
    };
  });
  check(`${theme}: title`, got.title, 'Send us this code on WhatsApp');
  check(`${theme}: one short line`, got.body, 'Press Send in WhatsApp — this screen continues by itself.');
  check(`${theme}: the code`, got.code, 'HK-4K7Q2M');
  check(`${theme}: spinner + "Waiting for your message…"`, [got.spinner, got.waiting], [true, 'Waiting for your message…']);
  check(`${theme}: no long paragraph, no "nothing to type here"`, /nothing to type|no code comes back|It's free/.test(got.text), false);
  check(`${theme}: line, code, button, waiting, then the fallbacks`, got.order.every((v, i) => i === 0 || v > got.order[i - 1]), true);
  check(`${theme}: no page errors`, errors, []);
  if (SHOTS) await page.locator('#wa-send').screenshot({ path: `${SHOTS}/wa-send-${theme}.png` });
  // iOS: the button opens wa.me in a new tab — never whatsapp://.
  const went = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    window.open = (u) => { seen.push(String(u)); return null; };
    const before = location.href;
    document.getElementById('wa-open').click();
    setTimeout(() => resolve({ seen, stayed: location.href === before }), 1500);
  }));
  check(`${theme}: iPhone opens the wa.me link and the page stays`, [went.seen[0], went.stayed], [WA_LINK, true]);
  await ctx.close();
}

console.log('\n=== web: only Android gets whatsapp:// ===');
for (const [label, ua, touch, want] of [
  ['iPhone', IPHONE, 0, null],
  ['iPad (reports a Mac, has touch)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5, null],
  ['Android (control)', ANDROID, 0, 'whatsapp://send?phone=2347042248544&text=Sign%20me%20in%20to%20Hawkeye.%20Code%3A%20HK-4K7Q2M'],
]) {
  const ctx = await ctxFor(ua, { touch });
  const page = await ctx.newPage();
  await page.goto(`${base}/observe.html?intent=signin`);
  await page.waitForFunction(() => typeof window.waAppLink === 'function');
  check(`${label}: waAppLink`, await page.evaluate((l) => waAppLink(l), WA_LINK), want);
  await ctx.close();
}

console.log('\n=== web fallback: /open?to=back says where to go back to ===');
for (const [label, ua, lang, appBtn] of [['phone', ANDROID, 'en', true], ['desktop', DESKTOP, 'en', false], ['phone, Hausa', IPHONE, 'ha', true]]) {
  const ctx = await ctxFor(ua, { lang });
  const page = await ctx.newPage();
  await page.goto(`${base}/open/?to=back`);
  await page.waitForTimeout(600);
  const got = await page.evaluate(() => ({
    path: location.pathname + location.search,
    shown: !document.getElementById('back').hidden,
    title: document.querySelector('#back h1').innerText.trim(),
    app: !document.getElementById('back-app-line').hidden,
    appHref: document.getElementById('back-app').getAttribute('href'),
    web: document.getElementById('back-web').getAttribute('href'),
  }));
  check(`${label}: no redirect`, got.path, '/open/?to=back');
  check(`${label}: the panel shows`, got.shown, true);
  check(`${label}: "open the app" only on a phone, via the app's own to=back`, [got.app, got.appHref], [appBtn, 'hawkeye://open?to=back']);
  check(`${label}: and the website`, got.web, '../index.html');
  if (lang === 'ha') check('Hausa: translated from app/i18n', got.title, 'Koma Hawkeye');
  if (SHOTS && lang === 'ha') await page.screenshot({ path: `${SHOTS}/open-back-ha.png` });
  await ctx.close();
}
{
  const ctx = await ctxFor(ANDROID);
  const page = await ctx.newPage();
  await page.goto(`${base}/open/?to=ready`);
  await page.waitForURL(/ready\.html/, { timeout: 5000 }).catch(() => null);
  check('control: any other target still redirects (to=ready → ready.html)', new URL(page.url()).pathname, '/ready.html');
  await ctx.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

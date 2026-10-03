/**
 * THE SIGN-UP FORM FITS ON A SMALL PHONE WITH THE KEYBOARD UP (owner, 2026-10-03).
 *
 * Owner's iPhone screenshot: Create Account with the number keypad open hid
 * "Already have an account?" and left Request OTP on the keyboard's edge. The
 * copy was shortened and the route prompt now shows only when it is needed.
 *
 * In headless Chromium at 375x667 and 320x568, in en/ha/ig/yo:
 *  - nothing is wider than the screen (no horizontal scroll, no overflowing
 *    line) — fit-to-width in all four languages;
 *  - typing in the last field (invite/ORG code), that field and Request OTP
 *    fit in the height a phone keypad leaves (screen minus ~260 px); from the
 *    number field the form scrolls, keeping the focused field in sight;
 *  - CONTROL: the same page with the OLD long copy put back measures taller,
 *    so the budget is a real measurement and not one that cannot fail.
 * The keyboard itself is a device thing: app.js keepAuthInView() (visualViewport)
 * and native sign-in.tsx keepInView() move the view; their wiring is checked here.
 *
 *   node tests/signup_fit_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const { chromium } = createRequire(`${ROOT}/tests/ui/`)('playwright-core');
let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/health') return json({ ok: true, waInbound: true, waPaidOtp: false, smsOtp: true, passkeys: false });
  if (url.startsWith('/api/')) return json({});
  let f = path.join(APP, decodeURIComponent(url));
  if (f.startsWith(APP) && fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!f.startsWith(APP) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const KEYPAD = 260;   // iOS number pad + its bar, in CSS px

const OLD = { label: 'Invite or organisation code (optional)', hint: "A friend's invite code, or an ORG- code from your party or civic group.", need: 'Choose how to verify your number first.' };

async function measure(lang, w, h, { oldCopy = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.addInitScript((l) => { try { localStorage.setItem('hawkeye_onboarded', '1'); localStorage.setItem('hawkeye_tour_done', '1'); localStorage.setItem('hawkeye_lang_prompted', '1'); localStorage.setItem('hawkeye_lang', l); } catch (e) { /* none */ } }, lang);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
  await page.goto(`${base}/observe.html`);
  await page.waitForFunction((l) => l === 'en' || (window.HawkeyeI18n && window.HawkeyeI18n.current === l), lang, { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => typeof WA_HEALTH !== 'undefined' && WA_HEALTH === true && !document.getElementById('otp-sms-opt').hidden, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  if (oldCopy) {
    await page.evaluate((o) => {
      document.querySelector('label[for="ref-input"]').textContent = o.label;
      document.getElementById('ref-hint').textContent = o.hint;
      const n = document.getElementById('channel-need'); n.textContent = o.need; n.hidden = false;   // the old always-on prompt
    }, OLD);
  }
  const m = await page.evaluate((vw) => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const card = document.getElementById('auth-card');
    const wide = [...card.querySelectorAll('*')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().right > vw + 0.5).map((e) => e.id || e.tagName);
    return {
      hscroll: document.documentElement.scrollWidth > vw,
      wide: wide.slice(0, 5),
      span: Math.round(r('btn-auth').bottom - r('auth-input').top),
      lastSpan: Math.round(r('btn-auth').bottom - r('ref-input').top),
      needHidden: document.getElementById('channel-need').hidden,
    };
  }, w);
  m.errors = errors;
  await ctx.close();
  return m;
}

for (const [w, h] of [[375, 667], [320, 568]]) {
  const budget = h - KEYPAD;
  for (const lang of ['en', 'ha', 'ig', 'yo']) {
    const m = await measure(lang, w, h);
    check(`${w}x${h} ${lang}: fits the width (no horizontal scroll, nothing past the edge)`, [m.hscroll, m.wide], [false, []]);
    // Typing in the LAST field, it and Request OTP are on screen together; from the
    // number field the form scrolls (keepAuthInView keeps the focused field, then the button).
    check(`${w}x${h} ${lang}: last field to Request OTP = ${m.lastSpan}px fits above a keypad (budget ${budget}px; whole form ${m.span}px scrolls)`, m.lastSpan <= budget, true);
    check(`${w}x${h} ${lang}: the route prompt is not on screen until it is needed; no page errors`, [m.needHidden, m.errors], [true, []]);
  }
  const old = await measure('en', w, h, { oldCopy: true });
  const now = await measure('en', w, h);
  check(`CONTROL ${w}x${h}: the old long copy measures taller (${old.span}px vs ${now.span}px; last field ${old.lastSpan} vs ${now.lastSpan})`, old.span > now.span && old.lastSpan > now.lastSpan, true);
}

console.log('\n=== keyboard up (a visual viewport KEYPAD px shorter): the page moves ===');
async function withKeypad(w, h, field, keypad = KEYPAD) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.addInitScript((kp) => {
    try { localStorage.setItem('hawkeye_onboarded', '1'); localStorage.setItem('hawkeye_tour_done', '1'); localStorage.setItem('hawkeye_lang_prompted', '1'); } catch (e) { /* none */ }
    // A phone keypad: the VISUAL viewport is shorter than the window.
    const fake = { offsetTop: 0, get height() { return window.innerHeight - kp; }, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
  }, keypad);
  const page = await ctx.newPage();
  await page.goto(`${base}/observe.html`);
  await page.waitForFunction(() => typeof WA_HEALTH !== 'undefined' && WA_HEALTH === true, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.focus(field);
  await page.waitForTimeout(700);
  const got = await page.evaluate(([f, kp]) => {
    const visBottom = window.innerHeight - kp;
    const fr = document.querySelector(f).getBoundingClientRect();
    const br = document.getElementById('btn-auth').getBoundingClientRect();
    return { fieldTop: Math.round(fr.top), fieldBottom: Math.round(fr.bottom), btnBottom: Math.round(br.bottom), visBottom };
  }, [field, keypad]);
  await ctx.close();
  return got;
}
for (const [w, h] of [[375, 667], [320, 568]]) {
  let g = await withKeypad(w, h, '#ref-input');
  check(`${w}x${h} typing the invite/ORG code: the field and Request OTP are both above the keypad`, g.fieldTop >= 0 && g.btnBottom <= g.visBottom, true);
  g = await withKeypad(w, h, '#auth-input');
  check(`${w}x${h} typing the number: the field stays in sight above the keypad`, g.fieldTop >= 0 && g.fieldBottom <= g.visBottom, true);
}
{
  const g = await withKeypad(375, 667, '#ref-input', 0);
  check('CONTROL no keypad: nothing needed moving, the button was already on screen', g.btnBottom <= g.visBottom, true);
}

console.log('\n=== keyboard: the view keeps the field and the button above it (wiring) ===');
const app = fs.readFileSync(`${APP}/app.js`, 'utf8');
check('web: visualViewport resize + focus move the page (keepAuthInView)',
  /window\.visualViewport\.addEventListener\('resize', \(\) => setTimeout\(keepAuthInView, 50\)\)/.test(app) && /function keepAuthInView\(\)/.test(app), true);
const si = fs.readFileSync(`${ROOT}/native/src/app/sign-in.tsx`, 'utf8');
check('native: the form scrolls (ScrollView, taps kept) and keepInView runs on keyboardDidShow and on a height change',
  /<ScrollView\s+ref=\{scrollRef\}\s+keyboardShouldPersistTaps="handled"/.test(si) && /Keyboard\.addListener\('keyboardDidShow'/.test(si)
  && /if \(Keyboard\.isVisible\(\)\) keepInView\(\);/.test(si) && /<View ref=\{sendRef\} collapsable=\{false\}>/.test(si), true);
check('native: the route prompt only after a tap with no route', /needChoice && !withOrgCode && !channel \?/.test(si) && /if \(!channel\) \{\s*setNeedChoice\(true\);/.test(si), true);

await browser.close();
server.close();
console.log(`\n${fail ? `${fail} FAILED` : 'ALL PASSED'}`);
process.exit(fail ? 1 : 0);

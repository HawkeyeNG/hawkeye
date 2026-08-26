/**
 * THE SHELL'S TAB BAR: the selected tab must be the most legible thing on it,
 * and the tour it launches must show once per DEVICE, not once per sign-in.
 *
 * Both were reported by the user and both were real.
 *
 * 1. CONTRAST. `.tabbar .tab.on` was a hardcoded `var(--green)` — #004225. On
 *    the white bar that is 11.63:1 and correct. On the DARK bar it measures
 *    1.40:1, against 7.12:1 for an INACTIVE tab, so the bar read INVERTED: the
 *    current tab looked disabled and its neighbours looked chosen. Native fixed
 *    exactly this with a theme-aware `activeTint`
 *    ((tabs)/_layout.tsx: `ui.dark ? ui.tint.good.ink : BRAND.green`); the web
 *    never did. The tour later introduced that very token for its ring and left
 *    the tab behind, so the correct colour was sitting one line away, unused.
 *
 *    This asserts the RENDERED contrast ratio, not the CSS. A token can be
 *    right and still be overridden by a later rule, and only the computed
 *    colour on the computed background says what a reader actually sees.
 *
 * 2. ONCE PER DEVICE. Sign-out removes `hawkeye_token` and nothing else. If a
 *    future sign-out ever reached for `localStorage.clear()`, the tour would
 *    quietly start greeting returning users on every login — a change nobody
 *    would connect to the logout handler that caused it.
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
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};
const control = (label, red) => {
  if (red) fail++;
  console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${label}`);
};

/** app/authgate.js parses the payload and bounces anything it cannot read, so a
 *  placeholder string never reaches Home. See tests/tour_test.mjs. */
const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;

/** WCAG 2.x relative luminance and contrast ratio, from rgb() strings. */
const lum = (c) => {
  const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** The Lite shell on Home, signed in, tour already seen so it is out of the way. */
async function bar({ scheme = 'light', sabotage = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, colorScheme: scheme });
  await ctx.addInitScript((o) => {
    Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
    const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
    mark();
    document.addEventListener('readystatechange', mark);
    try {
      localStorage.setItem('hawkeye_token', o.token);
      localStorage.setItem('hawkeye_tour_seen', '1');
      // Dark is OPT-IN via the header toggle, not prefers-color-scheme — see the
      // note above :root[data-theme="dark"] in styles.css. So it must be stamped.
      if (o.scheme === 'dark') localStorage.setItem('hawkeye_theme', 'dark');
    } catch (e) { /* ignore */ }
  }, { token: JWT(), scheme });
  const p = await ctx.newPage();
  await p.goto(`${base}/index.html`);
  await p.waitForTimeout(700);
  if (sabotage) await p.addStyleTag({ content: sabotage });
  const m = await p.evaluate(() => {
    const on = document.querySelector('.tabbar .tab.on');
    const off = document.querySelector('.tabbar .tab:not(.on):not(.tab-cta)');
    const el = document.querySelector('.tabbar');
    if (!on || !el) return null;
    // The bar can be transparent; walk up for the colour actually painted.
    let bg = getComputedStyle(el).backgroundColor, node = el;
    while (node && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
      node = node.parentElement;
      if (node) bg = getComputedStyle(node).backgroundColor;
    }
    return { on: getComputedStyle(on).color, off: off ? getComputedStyle(off).color : null, bg };
  });
  await ctx.close();
  return m;
}

console.log('=== the selected tab is legible, and reads as selected, in both themes ===');
for (const scheme of ['light', 'dark']) {
  const m = await bar({ scheme });
  if (!m) { check(`${scheme}: the tab bar rendered`, false); continue; }
  const on = ratio(m.on, m.bg);
  const off = m.off ? ratio(m.off, m.bg) : 0;
  console.log(`      ${scheme.padEnd(5)} selected ${m.on} on ${m.bg} = ${on.toFixed(2)}:1   inactive = ${off.toFixed(2)}:1`);
  check(`${scheme}: the selected tab meets AA for small text (4.5:1)`, on >= 4.5);
  // The real defect was not merely "hard to read" — it was RANKED WRONG.
  check(`${scheme}: and outranks an inactive tab, so the bar is not inverted`, on > off);
}

console.log('\n=== CONTROL: the old hardcoded green must fail this ===');
{
  const m = await bar({ scheme: 'dark', sabotage: '.tabbar .tab.on { color: var(--green) !important; }' });
  const on = m ? ratio(m.on, m.bg) : 99;
  const off = m && m.off ? ratio(m.off, m.bg) : 0;
  console.log(`      dark, sabotaged: selected ${on.toFixed(2)}:1   inactive ${off.toFixed(2)}:1`);
  control('the AA check catches #004225 on the dark bar', on >= 4.5);
  control('the not-inverted check catches it too', on > off);
}

console.log('\n=== the tour is once per DEVICE, not once per sign-in ===');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript((tok) => {
    Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
    const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
    mark();
    document.addEventListener('readystatechange', mark);
    try { if (!localStorage.getItem('hawkeye_token')) localStorage.setItem('hawkeye_token', tok); } catch (e) { /* ignore */ }
  }, JWT());
  const p = await ctx.newPage();
  const open = () => p.evaluate(() => { const t = document.querySelector('.tour'); return !!t && !t.hidden; });

  await p.goto(`${base}/index.html`);
  await p.waitForTimeout(800);
  check('a brand-new device gets the tour', await open());
  // The footer's left button is Back now; leaving is the corner cross.
  await p.evaluate(() => document.querySelector('.tour-x')?.click());
  await p.waitForTimeout(250);
  check('Skip closes it and writes the flag', await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen')), '1');

  // Sign out the way profile.html does — the TOKEN, and nothing else.
  await p.evaluate(() => localStorage.removeItem('hawkeye_token'));
  check('signing out leaves the tour flag alone', await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen')), '1');

  for (const n of [1, 2]) {
    await p.evaluate((tok) => localStorage.setItem('hawkeye_token', tok), JWT());
    await p.goto(`${base}/index.html`);
    await p.waitForTimeout(800);
    check(`sign-in #${n}: the tour does not come back`, await open(), false);
  }

  // CONTROL: a sign-out that wiped storage — the shape of the regression this
  // guards — must make the tour return.
  await p.evaluate(() => localStorage.clear());
  await p.evaluate((tok) => localStorage.setItem('hawkeye_token', tok), JWT());
  await p.goto(`${base}/index.html`);
  await p.waitForTimeout(800);
  control('a storage-clearing sign-out really does resurrect the tour', !(await open()));
  await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

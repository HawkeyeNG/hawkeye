/**
 * In the Capacitor shell, does every non-tab page get a way BACK?
 *
 * iPhone gives a web view no system back gesture, so before this a Lite user on
 * (say) the ledger could only leave through the tab bar. Native's rule is
 * `right='close'` everywhere and `right='none'` on the five tab screens; this
 * asserts Lite matches it, and — the part that matters — that the WEBSITE is
 * unchanged, since the same menu.js serves both.
 *
 *   node tests/lite_header_close_test.mjs [--base http://localhost:8430]
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const require_ = createRequire(HERE + '/ui/');
const { chromium } = require_('playwright-core');
const CHROME = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:8430');

/* SIGNED IN, OR THIS TESTS NOTHING.
   In the app shell authgate.js leaves only the auth funnel and practice open, so
   a signed-out run asking for ledger.html lands on observe.html — a TAB page,
   which correctly has no close button. The first version of this test read that
   as "the close button is missing" and reported four failures against working
   code. Mint a session first, the way tests/ui/capture_lite_shots.mjs does. */
const token = (() => {
  const out = execFileSync('node', ['scripts/dev_session.mjs', '--observer', '111'],
    { cwd: path.join(REPO, 'backend'), encoding: 'utf8' });
  const m = out.match(/hawkeye\.auth\.token'\s*,\s*"([^"]+)"/);
  if (!m) { console.error('could not mint a dev session:\n' + out); process.exit(2); }
  return m[1];
})();

const browser = await chromium.launch({ executablePath: CHROME });

/** Load a page either as the website or as the app shell. */
async function inspect(page, shell) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('hawkeye_token', t); } catch (e) { /* first-run origin */ }
  }, token);
  if (shell) {
    // The same two tricks tests/ui/capture_lite_shots.mjs uses: FREEZE
    // window.HAWKEYE before any page script runs (so native.js cannot repoint
    // apiBase at production) and add the class native.js would have added.
    await ctx.addInitScript(() => {
      Object.defineProperty(window, 'HAWKEYE', {
        value: Object.freeze({ native: true, capabilities: {} }), writable: false, configurable: false,
      });
      /* addInitScript runs BEFORE document.documentElement exists, so a bare
         `documentElement.classList.add` throws "Cannot read properties of null"
         and the class is never added — the harness failing while looking like
         the page failing. Add it as soon as there is an element to add it to. */
      const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
      mark();
      document.addEventListener('readystatechange', mark);
      document.addEventListener('DOMContentLoaded', mark);
    });
  }
  const p = await ctx.newPage();
  await p.goto(`${BASE}/${page}`, { waitUntil: 'networkidle' });
  const out = await p.evaluate(() => ({
    // The page we ACTUALLY ended up on. authgate.js redirects, and a test that
    // assumes it stayed put grades the wrong page — which is exactly what the
    // first run of this did.
    landed: (location.pathname.split('/').pop() || 'index.html').toLowerCase(),
    close: !!document.querySelector('.close-btn'),
    theme: !!document.querySelector('.theme-btn:not(.close-btn)'),
    menuTheme: !!document.querySelector('#menu-panel .menu-theme'),
    menuSocial: !!document.querySelector('#menu-panel .social-row'),
  }));
  await ctx.close();
  return out;
}

// page -> what the app shell should show. Tab pages mirror native's right='none';
// home keeps the toggle; everything else gets the close.
const CASES = [
  ['index.html', { close: false, theme: true }],
  ['results.html', { close: false, theme: false }],
  ['notifications.html', { close: false, theme: false }],
  ['ledger.html', { close: true, theme: false }],
  ['integrity.html', { close: true, theme: false }],
  ['faq.html', { close: true, theme: false }],
];

let bad = 0;
console.log('--- app shell ---');
for (const [page, want] of CASES) {
  const got = await inspect(page, true);
  const stayed = got.landed === page;
  const ok = stayed && got.close === want.close && got.theme === want.theme;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${page.padEnd(20)} close=${got.close} theme=${got.theme}`
    + (stayed ? '' : `  REDIRECTED to ${got.landed} — not signed in?`)
    + (ok || !stayed ? '' : `  wanted close=${want.close} theme=${want.theme}`));
}

// The toggle must still be reachable on the pages that gave it up, and the
// social links must exist somewhere in the app at all — the shell hides the
// footer, which is where they used to be.
const deep = await inspect('ledger.html', true);
for (const [label, val] of [['menu carries the theme toggle', deep.menuTheme], ['menu carries the social row', deep.menuSocial]]) {
  if (!val) { console.log(`  FAIL ${label}`); bad++; } else console.log(`  ok   ${label}`);
}

// CONTROL: the website must be untouched — same file, both surfaces.
console.log('--- website (must be unchanged) ---');
for (const page of ['ledger.html', 'faq.html']) {
  const got = await inspect(page, false);
  const ok = got.theme === true && got.close === false;
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${page.padEnd(20)} close=${got.close} theme=${got.theme}`);
}

await browser.close();
console.log(bad ? `\n${bad} failure(s)` : '\nall good');
process.exit(bad ? 1 : 0);

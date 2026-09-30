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

/* THIS NEEDS A RUNNING BACKEND (it serves the pages and the API the signed-in
   shell calls with the dev session minted below), and
   run_all.sh does not start one — so with nothing on BASE it used to die inside
   Playwright with ERR_CONNECTION_REFUSED, which reads like a page defect. Say
   what is missing instead. Still a failure (exit 2): a test that passes when it
   could not look is not a test. */
try {
  await fetch(`${BASE}/index.html`, { signal: AbortSignal.timeout(5000) });
} catch (e) {
  console.error(`NO BACKEND at ${BASE} (${e.cause?.code || e.message}).\n`
    + 'Start one first — the "hawkeye-backend" launch config, or\n'
    + '  cd backend && SMS_PROVIDER=console node src/server.js\n'
    + 'or point this at one with --base http://localhost:<port>.');
  process.exit(2);
}

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
    // By what it DOES, not only the old row's class: a re-added toggle under any
    // class name still says "Switch to light/dark mode" (text or aria-label).
    menuTheme: !!document.querySelector('#menu-panel .menu-theme, #menu-panel .theme-btn')
      || [...document.querySelectorAll('#menu-panel button, #menu-panel a')].some((el) =>
        /switch to (light|dark) mode/i.test(`${el.textContent} ${el.getAttribute('aria-label') || ''}`)),
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
  // Never loads menu.js, so it wires the same close by hand — and had none
  // until 2026-09-30, which left a Lite reader with no way off the page.
  ['my-groups.html', { close: true, theme: false }],
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

// The social links must exist somewhere in the app at all — the shell hides the
// footer, which is where they used to be.
//
// THE THEME TOGGLE IS DELIBERATELY NOT IN THE MENU any more. This asserted the
// opposite until b16f1bd (2026-09-12) removed the row: it rendered as unstyled
// text, invisible against the dark panel, and it was a second control for a
// setting the header already owns. Home's header toggle is now the single place
// to change theme — which the index.html case above already asserts
// (theme=true) — so the reachability this line used to guard is still covered,
// and what it guards now is that the duplicate does not creep back.
const deep = await inspect('ledger.html', true);
for (const [label, val] of [['menu does NOT carry a second theme control', !deep.menuTheme], ['menu carries the social row', deep.menuSocial]]) {
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

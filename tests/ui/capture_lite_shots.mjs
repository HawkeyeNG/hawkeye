/**
 * Capture raw store screenshots of HAWKEYE LITE.
 *
 *   node capture_lite_shots.mjs --token <jwt> --out /tmp/lite-raw
 *   node capture_lite_shots.mjs --token <jwt> --explore /practice.html
 *
 * Lite is the Capacitor wrapper around app/ — the same HTML the website serves,
 * in a native shell. So these are captures of the shipping Lite code, driven
 * through a browser rather than an emulator. Feed the output to
 * backend/scripts/make_store_screenshots.mjs, which adds the green plate and the
 * caption; that compositor is shared with the native set and is NOT modified
 * here, which is the point — one template, two apps.
 *
 * THREE THINGS MAKE A BROWSER INTO LITE, and each has a reason:
 *
 * 1. `window.HAWKEYE` is FROZEN before any page script runs, rather than
 *    stubbing `window.Capacitor`. native.js detects Capacitor and then sets
 *    apiBase to https://hawkeye.com.ng — a capture pointed at PRODUCTION, which
 *    would both photograph live data and write practice runs to the real chain.
 *    Freezing the object makes native.js's own assignment a no-op, so the shell
 *    turns on while the API stays local. tests/profile_unit_modal_test.mjs uses
 *    the same trick.
 *
 * 2. `html.native-app` is added by hand, because it is normally added by the
 *    branch of native.js that (1) deliberately skips. It is what draws the tab
 *    bar and strips web-only chrome like the PWA install CTA.
 *
 * 3. LIGHT MODE. This reverses the native set, which is dark because RN ships
 *    the preference as `system`. It is a listing decision, not a technical one:
 *    Lite's shots are meant to read as a distinct, lighter product beside the
 *    main app in search results. `hawkeye_theme` is a forced choice and wins
 *    over the media query, which on this codebase DEFAULTS TO DARK when the
 *    system expresses no preference — so setting colorScheme alone is not
 *    enough, and a run that only did that came back dark.
 *
 * The six filenames match the native set exactly, because the compositor keys
 * its captions off them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const require_ = createRequire(HERE + '/');
const { chromium } = require_('playwright-core');

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i > -1 ? argv[i + 1] : d;
};

const BASE = arg('base', 'http://localhost:8430');
const TOKEN = arg('token');
const OUT = arg('out', '/tmp/lite-raw');
const OBSERVER = arg('observer', '111');
const EXPLORE = arg('explore');
const ONLY = arg('only');
const CHROME = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

/* MINT THE TOKEN HERE rather than piping it in from the shell. The native
   pipeline uses run_capture.sh for this, but on this machine the Bash tool
   expands $(...) before WSL sees it, so the command-substitution form arrives
   already broken. One less moving part. */
const token = TOKEN || (() => {
  const out = execFileSync('node', ['scripts/dev_session.mjs', '--observer', OBSERVER], {
    cwd: path.join(REPO, 'backend'), encoding: 'utf8',
  });
  const m = out.match(/hawkeye\.auth\.token'\s*,\s*"([^"]+)"/);
  if (!m) { console.error('could not mint a dev session:\n' + out); process.exit(2); }
  return m[1];
})();
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({
  // SAME GEOMETRY AS THE NATIVE SET (440x956 at dsf 3 -> 1320x2868 raw). The
  // compositor places the device at a fixed width, so changing this here would
  // silently reframe every Lite shot relative to the native ones.
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'en-NG',
  colorScheme: 'light',
  permissions: ['geolocation'],
  geolocation: { latitude: 9.033, longitude: 7.49 },
});

await ctx.addInitScript((token) => {
  try {
    localStorage.setItem('hawkeye_token', token);
    localStorage.setItem('hawkeye_theme', 'light');
    localStorage.setItem('hawkeye_tour_seen', '1');   // the tour would cover every shot
  } catch { /* storage blocked — the page will simply appear signed out */ }

  Object.defineProperty(window, 'HAWKEYE', {
    value: { native: true, apiBase: '' },
    writable: false,
    configurable: false,
  });

  const mark = () => {
    if (!document.documentElement) return;
    document.documentElement.classList.add('native-app');
    document.documentElement.dataset.theme = 'light';
  };
  mark();
  document.addEventListener('readystatechange', mark);
  document.addEventListener('DOMContentLoaded', mark);
}, token);

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  ! page error:', String(e).slice(0, 120)));

const settle = async (ms = 1500) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
};

async function go(route) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  await settle();
}

/** Hide chrome a store frame should not carry. */
async function clean() {
  await page.evaluate(() => {
    const hide = (el) => el && el.style && el.style.setProperty('display', 'none', 'important');
    // The Ask Hawkeye FAB floats over content mid-scroll and reads as a
    // rendering fault at thumbnail size, exactly as it did in the native set.
    hide(document.getElementById('hk-fab'));
    document.querySelectorAll('[aria-label]').forEach((el) => {
      if (/ask hawkeye/i.test(el.getAttribute('aria-label') || '')) hide(el);
    });
  });
}

async function shot(file) {
  await clean();
  const dest = path.join(OUT, file);
  await page.screenshot({ path: dest });
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`  shot ${file}  ${kb}KB`);
}

const text = async (limit = 160) =>
  (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, limit);

/** Put a known piece of copy at the top of the frame; pixel offsets drift. */
async function scrollToText(needle, offset = 24) {
  const ok = await page.evaluate(([n, off]) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.includes(n)) continue;
      const el = node.parentElement;
      if (!el) continue;
      window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - off);
      return true;
    }
    return false;
  }, [needle, offset]);
  await page.waitForTimeout(600);
  if (!ok) console.log(`  ! could not find "${needle}" to scroll to`);
  return ok;
}

if (EXPLORE) {
  await go(EXPLORE);
  console.log(EXPLORE, '->', await text(600));
  await shot('explore.png');
  await browser.close();
  process.exit(0);
}

const want = (n) => !ONLY || ONLY.split(',').includes(String(n));

/* 2 — Home. The front door: what is coming, and the action for the day. */
if (want(2)) {
  await go('/index.html');
  console.log('  / ->', await text());
  await shot('2-home.png');
}

/* 4 — the completed Osun race page, scrolled to the DECLARED result. The
   non-affiliation notice must stay in frame: both Play rejections were for
   government information shown without a visible source. */
if (want(4)) {
  await go('/osun.html');
  await scrollToText('Not government or INEC affiliated', 24);
  console.log('  /osun ->', await text());
  await shot('4-result.png');
}

/* 5 — Political data: every governorship coloured by party, shipped in the
   bundle so it is populated on any device on any day. Same notice rule. */
if (want(5)) {
  await go('/political.html');
  await scrollToText('Not government or INEC affiliated', 24);
  console.log('  /political ->', await text());
  await shot('5-map.png');
}

/**
 * 3 and 6 — the practice flow, DRIVEN.
 *
 * Lite's practice is NOT the stepped wizard the RN app uses: /practice.html is
 * one page with all three sections stacked (Capture / Enter the Announced
 * Counts / Sign & submit). So "mid-flow" here means section 2 with the counts
 * filled in, and the receipt is what the page becomes after submitting — there
 * is no Continue button to look for, and a first pass spent several taps
 * hunting for one that does not exist.
 *
 * "Use a sample" stands in for the two photos so this needs no camera. The
 * counts are PRACTICE parties on the practice chain, so no real candidate is
 * given a number and nothing reaches a real record.
 */
if (want(3) || want(6)) {
  await go('/practice.html');

  // Both photo slots. Clicking by index rather than by name: the two cards use
  // identical labels, so a text locator would hit the first one twice.
  const samples = page.locator('button:has-text("Use a sample")');
  const n = await samples.count();
  for (let i = 0; i < n; i++) {
    await samples.nth(i).click({ timeout: 8000 }).catch((e) => console.log('  ! sample ' + i + ': ' + String(e).slice(0, 60)));
    await page.waitForTimeout(900);
  }
  console.log(`  filled ${n} photo slot(s)`);

  const nums = ['312', '204', '118', '47'];
  const inputs = page.locator('#practice-counts input, input[inputmode], input[type="number"], input[type="text"]');
  const c = await inputs.count();
  for (let i = 0; i < c && i < nums.length; i++) await inputs.nth(i).fill(nums[i]);
  await page.waitForTimeout(500);
  console.log(`  filled ${Math.min(c, nums.length)} of ${c} count field(s)`);

  if (want(6)) {
    await scrollToText('Enter the Announced Counts', 24);
    await shot('6-practice.png');
  }

  if (want(3)) {
    const submit = page.locator('button:has-text("Sign & submit")').first();
    await submit.click({ timeout: 8000 }).catch((e) => console.log('  ! submit: ' + String(e).slice(0, 80)));
    await page.waitForTimeout(4000);
    console.log('  after submit ->', await text(220));
    await shot('3-published.png');
  }
}

await browser.close();
console.log('\nraw frames in ' + OUT);

/**
 * The two shots that need a camera: the capture screen with a result sheet in
 * the viewport, and the entry step with that sheet attached.
 *
 * These were the only two missing from the store set, and the reason given was
 * that they "need a printed specimen in front of a real camera". They do not.
 * Chromium can be handed a video FILE as a fake capture device, expo-camera's
 * CameraView on web is a plain getUserMedia consumer, so the app renders the
 * sheet through its own camera path. The result is a real screenshot of a real
 * screen — not the sheet pasted over a screenshot afterwards, which would be a
 * picture of something the app never displayed.
 *
 * The sheet is the SPECIMEN from backend/scripts/make_specimen_ec8a.mjs: blank,
 * struck SPECIMEN, no INEC branding, polling unit 00-00-00-000. A real EC8A
 * carries a real unit's real votes and has no business on a store listing.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const TOKEN = arg('token');
const OUT = arg('out', '/tmp/raw');
const FEED = '/tmp/camera-feed.y4m';
const BASE = 'http://localhost:8092';

if (!TOKEN) { console.error('need --token'); process.exit(2); }
if (!fs.existsSync(FEED)) { console.error(`no fake camera feed at ${FEED}`); process.exit(2); }

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${FEED}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'en-NG',
  colorScheme: 'dark',
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 7.7719, longitude: 4.5567 },   // Osogbo, Osun
});
await ctx.addInitScript(([t]) => {
  try {
    localStorage.setItem('hawkeye.auth.token', t);
    localStorage.setItem('hawkeye.auth.observer', '111');
    localStorage.removeItem('hawkeye.auth.optedOut');
  } catch { /* storage blocked */ }
}, [TOKEN]);
const page = await ctx.newPage();

const text = async (n = 300) =>
  (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, n);
const tap = async (label) => {
  const el = page.getByText(label, { exact: false }).first();
  await el.waitFor({ timeout: 15000 });
  await el.click();
  await page.waitForTimeout(900);
};
/**
 * Hide chrome that belongs to THIS build rather than to the product — the same
 * rule capture_store_shots.mjs's clean() follows, and for the same reason.
 *
 * The web build has no native scanner module, so the capture screen explains
 * itself with "This build has no document scanner, so the sheet will be a plain
 * photo". True here, false on the phones this listing sells to, where the
 * scanner is present and the copy never appears. Leaving it in would put a
 * statement about the app on a store page that the app contradicts.
 *
 * HIDE, never remove: these nodes are inside React's tree and detaching one
 * crashes the next render.
 */
const hideBuildChrome = async () => {
  await page.evaluate(() => {
    const hide = (el) => el && el.style && el.style.setProperty('display', 'none', 'important');
    for (const el of Array.from(document.querySelectorAll('div, span'))) {
      if (el.children.length === 0 && /no document scanner/i.test(el.textContent || '')) {
        hide(el.parentElement || el);
      }
    }
    for (const el of Array.from(document.querySelectorAll('[aria-label]'))) {
      if (/ask hawkeye/i.test(el.getAttribute('aria-label') || '')) hide(el);
    }
  });
};

const shot = async (name) => {
  await hideBuildChrome();
  const p = `${OUT}/${name}`;
  await page.screenshot({ path: p });
  console.log(`  wrote ${p} (${Math.round(fs.statSync(p).size / 1024)} KB)`);
};

await page.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

console.log('[0]', await text());
await tap('Continue without a unit');
await tap('Governorship');
await tap('Lagos');
await tap('Lagos Governorship');
await tap('Continue to photos');
console.log('[5] sheet step ::', await text());

// THE LANDMARK. If the video never gets frames the screenshot is a black
// rectangle that still looks like a plausible camera screen, so refuse to shoot
// until the element reports real dimensions and a non-zero currentTime.
const live = await page.waitForFunction(() => {
  const v = document.querySelector('video');
  return !!v && v.videoWidth > 0 && v.readyState >= 2;
}, null, { timeout: 20000 }).catch(() => null);

if (!live) {
  console.error('CAMERA NEVER PRODUCED FRAMES — refusing to shoot a black frame.');
  console.error('screen said:', await text(400));
  await browser.close();
  process.exit(1);
}
const dims = await page.evaluate(() => {
  const v = document.querySelector('video');
  return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, playing: !v.paused };
});
console.log('  camera live:', JSON.stringify(dims));
await page.waitForTimeout(1200);
await shot('1-capture.png');

// Take the photo, so the sheet is genuinely attached rather than mocked.
// The shutter carries no accessibility label, so it is clicked where it is
// drawn: the gold circle, bottom centre of the 440x956 viewport.
await page.mouse.click(220, 872);
await page.waitForTimeout(3000);
console.log('[6] after shutter ::', await text(400));

// Whatever the shutter produced, the sheet must now be attached. Walk forward
// and shoot the step that shows the photo alongside the figures.
for (const label of ['Use this photo', 'Use photo', 'Keep', 'Continue']) {
  const el = page.getByText(label, { exact: false }).first();
  if (await el.count().catch(() => 0)) {
    await el.click().catch(() => {});
    await page.waitForTimeout(1500);
    console.log(`  advanced via "${label}" ::`, await text(200));
    break;
  }
}
console.log('[7] check step ::', await text(400));
await shot('2-check.png');

// On to the entry step, where the figures are typed against the sheet.
for (const label of ['Use this photo', 'Use photo', 'Continue', 'Next']) {
  const el = page.getByText(label, { exact: false }).first();
  if (await el.count().catch(() => 0)) {
    await el.click().catch(() => {});
    await page.waitForTimeout(1800);
    console.log(`  advanced via "${label}" ::`, await text(200));
    break;
  }
}
// Venue photo: a sample is right here — the venue is not the subject.
for (const label of ['Use a sample', 'Skip', 'Continue']) {
  const el = page.getByText(label, { exact: false }).first();
  if (await el.count().catch(() => 0)) {
    await el.click().catch(() => {});
    await page.waitForTimeout(1800);
    break;
  }
}
console.log('[8] after venue ::', await text(400));

const nums = ['312', '204', '118', '47', '23', '9'];
const inputs = page.locator('input');
const n = await inputs.count();
for (let i = 0; i < n && i < nums.length; i += 1) await inputs.nth(i).fill(nums[i]).catch(() => {});
await page.waitForTimeout(800);
console.log('[9] figures ::', await text(400));
await shot('2-figures.png');

await browser.close();
console.log('done');

/**
 * The one Lite shot that needs a camera: the capture screen with a result sheet
 * in the viewport.
 *
 * Chromium is handed a video FILE as a fake capture device, and Lite's camera is
 * a plain getUserMedia consumer (app/capture.js), so the app renders the sheet
 * through its own camera path. The result is a real screenshot of a real screen
 * — not a sheet composited over one afterwards, which would be a picture of
 * something the app never displayed.
 *
 * Separate from capture_lite_shots.mjs because the fake-device flags have to be
 * set at LAUNCH, and the other five shots should not run behind a fake camera.
 *
 * Run make_lite_camera_feed.mjs first; it measures nothing itself, but the
 * geometry it encodes was measured from this very overlay.
 *
 * NOTE ON THE NATIVE SHELL. capture.js only takes the getUserMedia path when
 * `native()` is false, and native() needs HAWKEYE.capabilities.camera AND
 * HAWKEYE.capturePhoto — neither of which the harness stub provides. So the
 * web path is what gets photographed here, which is correct: it is also what
 * Lite itself uses, since Lite has no capturePhoto bridge.
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
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const OUT = arg('out', '/tmp/lite-raw');
const BASE = arg('base', 'http://localhost:8430');
const FEED = arg('feed', '/tmp/lite-camera-feed.y4m');

if (!fs.existsSync(FEED)) {
  console.error(`no fake camera feed at ${FEED} — run: node tests/ui/make_lite_camera_feed.mjs`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const out = execFileSync('node', ['scripts/dev_session.mjs', '--observer', '111'],
  { cwd: path.join(REPO, 'backend'), encoding: 'utf8' });
const token = out.match(/hawkeye\.auth\.token'\s*,\s*"([^"]+)"/)[1];

const browser = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
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
  colorScheme: 'light',
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 7.7719, longitude: 4.5567 },   // Osogbo, Osun
});
await ctx.addInitScript((t) => {
  try {
    localStorage.setItem('hawkeye_token', t);
    localStorage.setItem('hawkeye_theme', 'light');
    localStorage.setItem('hawkeye_tour_seen', '1');
  } catch { /* storage blocked */ }
  Object.defineProperty(window, 'HAWKEYE', {
    value: { native: true, apiBase: '' }, writable: false, configurable: false,
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
page.on('pageerror', (e) => console.log('  ! ' + String(e).slice(0, 120)));
page.on('dialog', (d) => { console.log('  ! dialog: ' + d.message().slice(0, 100)); d.dismiss(); });

await page.goto(BASE + '/observe.html', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Open the sheet camera through the app's own entry point rather than hunting
// for a button: two "Take photo" buttons exist and a text locator hits the
// wrong one.
await page.evaluate(() => window.HAWKEYE_CAPTURE.open('sheet', {}));
await page.waitForTimeout(3500);   // let the feed start and the scanner settle

const state = await page.evaluate(() => {
  const v = document.getElementById('video');
  const q = v.getBoundingClientRect();
  return {
    overlayOpen: !document.getElementById('camera-overlay').hidden,
    intrinsic: v.videoWidth + 'x' + v.videoHeight,
    region: Math.round(q.width) + 'x' + Math.round(q.height),
    playing: !v.paused && v.readyState >= 2,
  };
});
console.log('  camera:', JSON.stringify(state));
if (!state.overlayOpen || !state.playing) {
  console.error('  the camera never came up — not writing a frame of nothing');
  await browser.close();
  process.exit(1);
}

const dest = path.join(OUT, '1-capture.png');
await page.screenshot({ path: dest });
console.log(`  shot 1-capture.png  ${Math.round(fs.statSync(dest).size / 1024)}KB`);

await browser.close();

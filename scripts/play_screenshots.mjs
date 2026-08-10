/**
 * Phone screenshots for the Play listing.
 *
 * Google Play wants 2-8 phone shots, 16:9 or 9:16, min 320px, PNG/JPEG. These
 * are captured at 1080x1920 (9:16 exactly) against the LIVE site, so what the
 * listing shows is what a user actually gets.
 *
 * Every shot must have the "Not government or INEC affiliated" disclaimer bar
 * visible — that is the point of regenerating them: Play rejected the app for
 * government information without an accessible source, and the reviewer should
 * not have to hunt for the disclaimer.
 *
 * Run: node scripts/play_screenshots.mjs   (out: app/play-shots/)
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import { mkdirSync } from 'node:fs';

const BASE = process.env.HAWKEYE_BASE || 'https://hawkeye.com.ng';
const OUT = '/home/elrio/hawkeye/app/play-shots';
mkdirSync(OUT, { recursive: true });

// Pages that show the PRODUCT, not a login wall. observe.html is the report
// flow but it opens on "Verify your phone" for a signed-out visitor, which is a
// poor first impression on a store listing and buries the disclaimer under the
// form; the flow itself is represented by how.html and guide.html instead.
const SHOTS = [
  ['01-home', '/index.html'],
  ['02-how', '/how.html'],
  ['03-results', '/results.html'],
  ['04-integrity', '/integrity.html'],
  ['05-ledger', '/ledger.html'],
  ['06-incidents', '/incident-reports.html'],
];

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const ctx = await browser.newContext({
  viewport: { width: 405, height: 720 },
  deviceScaleFactor: 2.6667,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  reducedMotion: 'reduce',
  // The app ships dark by default (hk-theme-init falls back to dark unless the
  // OS asks for light). Headless Chromium reports light, so the first run
  // produced a pale listing that looks nothing like the installed app.
  colorScheme: 'dark',
});

for (const [name, path] of SHOTS) {
  const page = await ctx.newPage();
  // domcontentloaded, not networkidle: these pages poll the API, so "idle" may
  // never arrive and the wait is spent for nothing.
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // The disclaimer bar is injected by menu.js; wait for it rather than guessing.
  const bar = await page.waitForSelector('.gov-disclaimer', { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(2000);
  /**
   * IN THE VIEWPORT, not merely in the DOM. isVisible() only means "rendered
   * and not display:none" — on the auth screen the bar is appended BELOW the
   * form, so it passed that check while sitting off the bottom of the shot.
   * The whole point of these screenshots is that a reviewer sees the notice
   * without scrolling, so measure against the viewport.
   */
  const box = bar ? await bar.boundingBox() : null;
  const vp = page.viewportSize();
  const visible = !!(box && box.y >= 0 && box.y + box.height <= vp.height);
  // animations:'disabled' — the pulsing live-dot kept the page from ever being
  // judged stable, which is what timed the screenshot out at 30s.
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled', timeout: 90000 });
  const text = bar ? (await bar.innerText()).replace(/\s+/g, ' ').trim() : '(none)';
  console.log(`${name.padEnd(14)} disclaimer=${visible ? 'VISIBLE' : 'MISSING'}  ${text.slice(0, 62)}`);
  await page.close();
}

await browser.close();
console.log(`\n${SHOTS.length} screenshots in ${OUT} (1080x1920)`);

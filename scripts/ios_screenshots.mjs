/**
 * iPhone screenshots for the App Store listing.
 *
 * Shot at the TRUE logical sizes of the two devices Apple asks for, at the real
 * @3x scale, so the layout is the one an iPhone actually renders:
 *   6.7" (iPhone 15 Pro Max)  430 x 932 CSS  @3  ->  1290 x 2796
 *   6.5" (iPhone 11 Pro Max)  414 x 896 CSS  @3  ->  1242 x 2688
 * Do NOT drop to @2 to fit more content in frame the way the Play shots do:
 * that widens the CSS viewport past the phone breakpoint and you get a tablet
 * layout in something labelled as an iPhone screenshot.
 *
 * Every shot must show the "Not government or INEC affiliated" bar inside the
 * viewport -- Apple applies the same government-affiliation scrutiny Google did,
 * and a reviewer should not have to scroll to find the disclaimer.
 *
 * Run: node scripts/ios_screenshots.mjs   (out: app/ios-shots/<size>/)
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import { mkdirSync } from 'node:fs';

const BASE = process.env.HAWKEYE_BASE || 'https://hawkeye.com.ng';
const OUT = '/home/elrio/hawkeye/app/ios-shots';

const DEVICES = [
  { name: '6.7in', width: 430, height: 932, dsf: 3 },
  { name: '6.5in', width: 414, height: 896, dsf: 3 },
];

// Deliberately no results/leaderboard page: its choropleth renders as a blank
// white panel until reports exist, which is a poor listing image before an
// election. Pages here are ones that carry real content year-round.
const SHOTS = [
  ['01-home', '/index.html'],
  ['02-how', '/how.html'],
  ['03-integrity', '/integrity.html'],
  ['04-ledger', '/ledger.html'],
  ['05-incidents', '/incident-reports.html'],
  ['06-guide', '/guide.html'],
  ['07-about', '/about.html'],
  ['08-faq', '/faq.html'],
];

const browser = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});

for (const dev of DEVICES) {
  const dir = `${OUT}/${dev.name}`;
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: dev.width, height: dev.height },
    deviceScaleFactor: dev.dsf,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    reducedMotion: 'reduce',
    // The app ships dark unless the OS asks for light; headless reports light,
    // which produced a pale listing that looks nothing like the installed app.
    colorScheme: 'dark',
  });

  for (const [name, path] of SHOTS) {
    const page = await ctx.newPage();
    // domcontentloaded, not networkidle: these pages poll the API, so "idle"
    // may never arrive and the wait is spent for nothing.
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const bar = await page.waitForSelector('.gov-disclaimer', { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(2000);
    // IN THE VIEWPORT, not merely in the DOM: isVisible() only means "rendered
    // and not display:none", and on some pages the bar sits below the fold.
    const box = bar ? await bar.boundingBox() : null;
    const vp = page.viewportSize();
    const visible = !!(box && box.y >= 0 && box.y + box.height <= vp.height);
    // Rough emptiness check, so a page that shoots blank before the election
    // does not silently become a listing image.
    const textLen = await page.evaluate(() => (document.body.innerText || '').trim().length);
    await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled', timeout: 90000 });
    console.log(
      `${dev.name} ${name.padEnd(14)} disclaimer=${visible ? 'VISIBLE' : 'MISSING'}  text=${textLen}`,
    );
    await page.close();
  }
  await ctx.close();
}

await browser.close();
console.log(`\nDone: ${OUT}/{6.7in,6.5in}  (1290x2796 and 1242x2688)`);

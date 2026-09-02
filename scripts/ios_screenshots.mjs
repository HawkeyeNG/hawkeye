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

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
  + 'Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
  + 'Version/17.0 Mobile/15E148 Safari/604.1';

const DEVICES = [
  { name: '6.7in', width: 430, height: 932, dsf: 3 },
  { name: '6.5in', width: 414, height: 896, dsf: 3 },
  // 13-inch iPad, which App Store Connect demands for any build that declares
  // iPad support — Capacitor's default template does, so Hawkeye Lite needs it.
  // 1032 x 1376 logical @2 is exactly Apple's 2064 x 2752. The @2 that the
  // header warns against for iPhones is correct HERE: the tablet layout is the
  // one an iPad genuinely renders.
  { name: '13in-ipad', width: 1032, height: 1376, dsf: 2, ua: IPAD_UA, isMobile: false },
];

// Deliberately no results/leaderboard page: its choropleth renders as a blank
// white panel until reports exist, which is a poor listing image before an
// election. Pages here are ones that carry real content year-round.
// THE HOME PAGE IS NOT IN THE APP STORE SET ANY MORE. It carries both store
// badges as of 2 Sep 2026 — they used to be platform-gated, so an iPhone
// user-agent saw only the App Store one and the home page was safe to shoot.
// Now a Play badge renders for every visitor, and App Store Review guideline
// 2.3.10 forbids imagery of other mobile platforms in screenshots. Shooting the
// home page here would put "Get it on Google Play" into an App Store listing.
// The Play set (scripts/play_screenshots.mjs) has the mirror-image problem and
// should skip it for the same reason.
const SHOTS = [
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
    // isMobile drives the mobile viewport meta path; an iPad reports false and
    // must, or the site serves the phone layout inside a 1032px frame.
    isMobile: dev.isMobile ?? true,
    hasTouch: true,
    userAgent: dev.ua ?? IPHONE_UA,
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
console.log(`\nDone: ${OUT}/{6.7in,6.5in,13in-ipad}  (1290x2796, 1242x2688, 2064x2752)`);

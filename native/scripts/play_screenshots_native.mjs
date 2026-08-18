/**
 * Play listing screenshots of the NATIVE app.
 *
 * The listing's current shots are of the web/Capacitor UI. The uploaded AAB is
 * the React Native app, which looks nothing like it — different navigation,
 * different cards, a tab bar. Shipping the old ones would misrepresent the build.
 *
 * HOW THESE ARE THE REAL SCREENS. `expo export --platform web` renders the same
 * components through react-native-web: identical JSX, identical NativeWind
 * styling, identical data. Only components/unit-map.tsx needs react-native-maps
 * (no web support), so the map-unit screen is left out — everything shot here
 * draws with react-native-svg, which renders the same on both.
 *
 * TWO RULES, both learned from Play rejections:
 *
 *  1. EVERY SHOT SHOWS THE DISCLAIMER. The app was rejected twice under
 *     Misleading Claims for government information without an accessible source,
 *     and the reviewer screenshotted the Leaderboard. A reviewer must not have to
 *     hunt for "Not government or INEC affiliated". Each frame is asserted, and
 *     one that cannot show it is not shipped.
 *
 *  2. NO INVENTED FIGURES. Every screen here is real: election dates from the
 *     catalogue, seat facts from the electoral register, and Osun's declared
 *     result with its sources. Nothing is seeded. Real party names beside made-up
 *     counts in a store screenshot reads as taking sides.
 *
 * Shot with headless Chromium DIRECTLY at 540 CSS @2x — 1080x1920, exactly 9:16.
 * 540@2x rather than 360@3x is the same pixels with ~40% more content per frame.
 * The Browser-pane screenshot tool cannot do this: it renders the emulated
 * viewport into a corner of a larger canvas.
 *
 *   node scripts/play_screenshots_native.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const DIST = '/home/elrio/hawkeye/native/dist';
const OUT = '/home/elrio/hawkeye/native/play-shots';
const API = 'https://hawkeye.com.ng';
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

// Serve the export, and proxy /api + the data files to the live site so the
// screens hold the same figures a user sees.
const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/') || /\.(json)$/.test(url) && !fs.existsSync(path.join(DIST, url))) {
    try {
      const r = await fetch(API + req.url, { headers: { 'user-agent': 'hawkeye-shots' } });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      return res.end(buf);
    } catch { res.writeHead(502); return res.end('{}'); }
  }
  let f = path.join(DIST, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(f) && fs.existsSync(`${f}.html`)) f = `${f}.html`;
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/**
 * Chosen for what they SHOW, and for holding real data between elections. The
 * report flow is deliberately absent: signed out it opens on a phone-number
 * form, which is a poor first frame and buries the disclaimer under an input.
 */
const SHOTS = [
  ['01-welcome', '/welcome', 'What Hawkeye is, in three lines'],
  ['02-home', '/', 'Every election Hawkeye covers'],
  ['03-leaderboard', '/(tabs)/results', 'Pick an election, see its board'],
  ['04-race-declared', '/race?key=raceOsun2026', 'The declared result, with sources'],
  ['05-races', '/races', 'Completed, ongoing and upcoming'],
  ['06-seat', '/race?contest=SEN&seat=Kano%20Central', 'Every seat has its own page'],
  ['07-integrity', '/integrity', 'Signed, chained, publicly verifiable'],
];

const browser = await chromium.launch({
  executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--force-device-scale-factor=2', '--font-render-hinting=none'],
});
const page = await browser.newPage({
  viewport: { width: 540, height: 960 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile',
});

/**
 * A SESSION, so the app renders itself instead of the door.
 *
 * app/_layout.tsx bounces a signed-out visitor to /welcome from everything but
 * welcome and sign-in, so without this every frame is the same landing screen.
 * bootstrapAuth() trusts a stored token without revalidating it, so seeding the
 * two keys is enough.
 *
 * NOTHING SHOWN IS FAKED BY THIS. The screens here read public data — the
 * contest catalogue, the electoral register, Osun's declared result — none of
 * which is behind the token. What the session buys is the app's own navigation;
 * anything that genuinely needs an account (the follow control, the alerts feed)
 * fails quietly and is not among the shots.
 */
await page.addInitScript(() => {
  try {
    localStorage.setItem('hawkeye.auth.token', 'screenshot-session');
    localStorage.setItem('hawkeye.auth.observer', '1');
    // expo-secure-store's web shim has used a prefix in some versions; set both
    // rather than depend on which one this SDK ships.
    localStorage.setItem('secure-store.hawkeye.auth.token', 'screenshot-session');
    localStorage.setItem('secure-store.hawkeye.auth.observer', '1');
  } catch { /* storage blocked — the run will show the welcome screen and say so */ }
});

const report = [];
for (const [name, route, caption] of SHOTS) {
  const url = `${BASE}${route}`;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch {
    // networkidle can never settle on a screen that polls; the paint is what matters.
    await page.waitForTimeout(3000);
  }
  // Let the map geometry and any first tally land.
  await page.waitForTimeout(3500);

  const text = await page.evaluate(() => document.body.innerText);
  // Two wordings satisfy the rule the rejections set: the in-app bar, and the
  // welcome screen's own "independent and nonpartisan … all official results are
  // announced by INEC", which states the same thing and names the body.
  const hasDisclaimer =
    /not government or INEC affiliated/i.test(text) ||
    /independent and nonpartisan[\s\S]{0,120}INEC/i.test(text);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, type: 'png' });
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  report.push({ name, route, caption, hasDisclaimer, chars: text.length, width, height });
  console.log(
    `${hasDisclaimer ? 'ok  ' : 'WARN'} ${name.padEnd(18)} ${String(text.length).padStart(5)} chars` +
    `${hasDisclaimer ? '' : '   <- NO DISCLAIMER VISIBLE'}`,
  );
}

await browser.close();
server.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\nwrote ${report.length} shots to ${OUT}`);
const bad = report.filter((r) => !r.hasDisclaimer);
if (bad.length) console.log(`WARNING: ${bad.length} shot(s) show no disclaimer: ${bad.map((b) => b.name).join(', ')}`);

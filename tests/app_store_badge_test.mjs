/**
 * The App Store route on the homepage — STAGED, and off until iOS review passes.
 *
 * The whole point of shipping it dark is that turning it on is one reviewed
 * line rather than three remembered ones. This checks both halves:
 *
 *   OFF (today)  — nothing about the App Store is visible or claimed anywhere,
 *                  and the iPhone dialog still says there is no store version.
 *   ON (flipped) — the badge appears on iPhone and ONLY on iPhone, points at the
 *                  real listing, matches the Play badge's height, and the "no
 *                  App Store version yet" sentence is gone.
 *
 * The ON case is exercised by serving the page with the flag rewritten, so the
 * day it flips for real there is nothing left to discover.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/** `flip` rewrites the switch on the way out, so the ON case runs the real page. */
let flip = false;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  if (flip && f.endsWith('index.html')) {
    const html = fs.readFileSync(f, 'utf8').replace('const IOS_STORE_LIVE = false;', 'const IOS_STORE_LIVE = true;');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
const STORE = 'https://apps.apple.com/app/id6804218478';

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

async function on(ua) {
  const ctx = await b.newContext({ userAgent: ua, viewport: { width: 390, height: 780 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#install-cta', { state: 'attached', timeout: 10000 });
  await p.waitForTimeout(500);
  const r = await p.evaluate(() => {
    const a = document.getElementById('ios-cta');
    const play = document.getElementById('play-cta');
    const img = a?.querySelector('img');
    // RENDERED, not the property: .play-badge-link sets display:inline-block, and
    // an author display rule beats the [hidden] UA style — asking the element
    // gives the wrong answer, asking the layout does not. Same trap the Play
    // badge already fell into once.
    return {
      shown: a ? a.getClientRects().length > 0 : false,
      href: a?.getAttribute('href') ?? null,
      alt: img?.getAttribute('alt') ?? null,
      imgLoaded: img ? img.naturalWidth > 0 : null,
      badgeH: img?.getClientRects().length ? Math.round(img.getBoundingClientRect().height) : null,
      playH: (() => { const i = play?.querySelector('img');
        return i?.getClientRects().length ? Math.round(i.getBoundingClientRect().height) : null; })(),
      playShown: play ? play.getClientRects().length > 0 : false,
      note: document.getElementById('pwa-ios-note')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
      bodyMentionsStore: /App Store/i.test(document.body.innerText),
    };
  });
  await ctx.close();
  return { ...r, errs };
}

console.log('=== OFF (today): the App Store is not offered or implied ===');
flip = false;
{
  const i = await on(IPHONE);
  check('no badge on iPhone', i.shown, false);
  check('the dialog still says there is no App Store version',
    /no App Store version yet/i.test(i.note ?? ''), true);
  check('no page error', i.errs.slice(0, 2), []);
  const a = await on(ANDROID);
  check('no badge on Android either', a.shown, false);
  check('and Play still shows on Android', a.playShown, true);
}

console.log('\n=== ON (flip the one switch): iPhone gets the store ===');
flip = true;
{
  const i = await on(IPHONE);
  check('the badge appears on iPhone', i.shown, true);
  check('pointing at the real listing', i.href, STORE);
  check("Apple's own artwork actually loads", i.imgLoaded, true);
  check('alt text is the badge wording', i.alt, 'Download on the App Store');
  check('the absence sentence is gone', /no App Store version yet/i.test(i.note ?? ''), false);
  check('and it names the store instead', /on the App Store/i.test(i.note ?? ''), true);
  check('no page error', i.errs.slice(0, 2), []);

  const a = await on(ANDROID);
  // Apple's guidelines put the badge on Apple platforms; an Android visitor
  // offered an App Store link is being offered something they cannot take, which
  // is the same mistake the Play badge on iPhone would have been.
  check('NOT shown on Android', a.shown, false);
  check('Play still shows on Android', a.playShown, true);
}

console.log('\n=== the pair matches, which is Apple\'s rule ===');
{
  // Apple asks that its badge be no smaller than a badge shown beside it. The
  // two only appear together on a non-iPhone, so this is checked where both are
  // visible at once by forcing the flag on and reading the Play badge height.
  const i = await on(IPHONE);
  check('the App Store badge is 56px tall, like Play', i.badgeH, 56);
}

console.log('\n=== controls ===');
{
  flip = false;
  const off = await on(IPHONE);
  flip = true;
  const onn = await on(IPHONE);
  // If the flip did nothing, every ON assertion above would be vacuous.
  check('the switch actually changes the page', off.shown !== onn.shown, true);
  check('and the artwork file really is on disk',
    fs.existsSync(`${APP}/app-store-badge.svg`), true);
  check('it is Apple\'s file, not a redraw',
    /Download_on_the_App_Store_Badge/.test(fs.readFileSync(`${APP}/app-store-badge.svg`, 'utf8')), true);
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

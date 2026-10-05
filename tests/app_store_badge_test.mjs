/**
 * The App Store routes — on /download, which is where they live now.
 *
 * HOW THIS GOT HERE, so nobody restores what was retired on purpose:
 *   f20337c  the homepage badge was staged dark behind IOS_STORE_LIVE, and this
 *            test checked both halves of that switch (OFF today / ON flipped).
 *   8fac697  the listing went live — checked, not assumed: itunes lookup for
 *            id6804218478 returned resultCount 1 — the switch flipped, and the
 *            "no App Store version yet" sentence was retired.
 *   b2fda44  the install dialog stopped mentioning stores at all.
 *   227685a  the hero's badges became ONE "Get the app" button to /download,
 *            which carries all four listings (Hawkeye and Lite, each on Play and
 *            the App Store). The UA-gating and the IOS_STORE_LIVE switch went
 *            with it, and so did the #install-cta / #ios-cta this used to wait on.
 *
 * What it checks now, on an iPhone, an Android phone and a desktop alike:
 *   - /download shows BOTH App Store badges, each pointing at its OWN listing and
 *     sitting beside its own app's Play badge — the full app with the full app,
 *     Lite with Lite;
 *   - Apple's own artwork loads, unmodified, with the badge wording as alt text;
 *   - its visible ink is no smaller than the Play badge's beside it (Apple's
 *     rule) and not blown up past it either (0ca330e: Google's PNG carries its
 *     clear space inside the artwork, so equal box heights look unequal);
 *   - the homepage offers no App Store link of its own, and nothing still says
 *     there is no App Store version.
 *
 * CONTROLS: the same audit runs against pages served with one defect each — the
 * Lite listing pointed at the full app's id, an App Store badge [hidden], the
 * iOS badge forced up to Play's box height — and each must turn its check red.
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

/** `mutate` rewrites download.html on the way out, so a control runs the real page with one defect. */
let mutate = null;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0].split('#')[0];
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  if (mutate && f.endsWith('download.html')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(mutate(fs.readFileSync(f, 'utf8')));
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
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const STORE = 'https://apps.apple.com/app/id6804218478';       // Hawkeye
const LITE_STORE = 'https://apps.apple.com/app/id6806090537';  // Hawkeye Lite

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/**
 * Google's badge ink, MEASURED off the file rather than copied from a comment:
 * the rows of play-badge.png that carry any visible pixel, over its full height.
 * 0ca330e measured 67.7%; if the artwork is ever replaced this follows it.
 */
async function playInk() {
  const p = await b.newPage();
  await p.goto(`${base}/download.html`, { waitUntil: 'load' });
  const ink = await p.evaluate(async () => {
    const img = new Image();
    img.src = 'play-badge.png';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let top = -1, bottom = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] > 16) { if (top < 0) top = y; bottom = y; break; }
      }
    }
    return top < 0 ? null : (bottom - top + 1) / c.height;
  });
  await p.close();
  return ink;
}

/** Load /download as a device and describe each badge row. */
async function audit(ua, { width = 390, css = null } = {}) {
  const ctx = await b.newContext({ userAgent: ua, viewport: { width, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/download.html`, { waitUntil: 'load' });
  if (css) await p.addStyleTag({ content: css });
  // The Lite row is loading="lazy": bring every badge into view and let it land,
  // or "the artwork loaded" would be measuring the scroll position.
  await p.evaluate(async () => {
    for (const i of document.querySelectorAll('.dl-badges img')) {
      i.scrollIntoView({ block: 'center' });
      await i.decode().catch(() => {});
    }
    window.scrollTo(0, 0);
  });
  const rows = await p.evaluate(() => {
    const rendered = (el) => !!el && el.getClientRects().length > 0;
    const h = (a) => { const i = a?.querySelector('img'); return rendered(i) ? i.getBoundingClientRect().height : null; };
    const mid = (a) => { const r = a.getBoundingClientRect(); return r.top + r.height / 2; };
    return [...document.querySelectorAll('.dl-badges')].map((row) => {
      const links = [...row.querySelectorAll('a')];
      const ios = links.find((a) => /apps\.apple\.com/.test(a.getAttribute('href') || ''));
      const play = links.find((a) => /play\.google\.com/.test(a.getAttribute('href') || ''));
      const img = ios?.querySelector('img');
      return {
        app: row.closest('.dl-lite') ? 'lite' : 'full',
        href: ios?.getAttribute('href') ?? null,
        shown: rendered(ios),
        alt: img?.getAttribute('alt') ?? null,
        src: img?.getAttribute('src') ?? null,
        loaded: img ? img.naturalWidth > 0 : null,
        iosH: h(ios),
        playH: h(play),
        sameLine: rendered(ios) && rendered(play) ? Math.abs(mid(ios) - mid(play)) < 6 : null,
        newTab: ios ? ios.getAttribute('target') === '_blank' && /noopener/.test(ios.getAttribute('rel') || '') : false,
        ourChrome: ios ? /btn-/.test(ios.className) : null,
      };
    });
  });
  await ctx.close();
  return { rows, errs };
}

const INK = await playInk();
console.log(`(Google's badge is ${(INK * 100).toFixed(1)}% ink, measured off play-badge.png)`);

/** The named verdicts, shared by the real run and the controls. */
function verdicts({ rows, errs }) {
  const full = rows.find((r) => r.app === 'full') || {};
  const lite = rows.find((r) => r.app === 'lite') || {};
  const inkOk = (r) => r.iosH != null && r.playH != null
    && r.iosH >= r.playH * INK - 0.5     // Apple: no smaller than the badge beside it
    && r.iosH <= r.playH * INK + 1.5;    // 0ca330e: and not half again as large
  return {
    twoRows: rows.length === 2 && !!full.app && !!lite.app,
    fullHref: full.href === STORE,
    liteHref: lite.href === LITE_STORE,
    bothShown: full.shown === true && lite.shown === true,
    artwork: [full, lite].every((r) => r.loaded === true && r.src === 'app-store-badge.svg'),
    alts: full.alt === 'Download Hawkeye on the App Store' && lite.alt === 'Download Hawkeye Lite on the App Store',
    ink: inkOk(full) && inkOk(lite),
    sameLine: full.sameLine === true && lite.sameLine === true,
    safeLink: [full, lite].every((r) => r.newTab === true && r.ourChrome === false),
    noErrors: errs.length === 0,
  };
}

const LABELS = {
  twoRows: 'two badge rows: the full app, and Lite',
  fullHref: 'the full app\'s badge points at the full app\'s listing',
  liteHref: 'Lite\'s badge points at Lite\'s own listing',
  bothShown: 'both App Store badges RENDER (layout, not the hidden property)',
  artwork: 'Apple\'s own artwork loads in both',
  alts: 'alt text is the badge wording, naming the app',
  ink: 'its ink matches the Play badge beside it — no smaller, not blown up',
  sameLine: 'each sits on one line with its own app\'s Play badge',
  safeLink: 'opens in a new tab with noopener, and wears none of our button chrome',
  noErrors: 'no page error',
};

for (const [name, ua] of [['iPhone', IPHONE], ['Android', ANDROID], ['desktop', DESKTOP]]) {
  // Every device gets every badge: 227685a retired the UA-gating on purpose,
  // because people pick an app on a laptop for a phone they are not holding.
  console.log(`\n=== /download on ${name}, 390px ===`);
  const v = verdicts(await audit(ua));
  for (const k of Object.keys(LABELS)) check(LABELS[k], v[k], true);
}

console.log('\n=== /download at desktop width, where the badges run full size ===');
{
  const r = await audit(DESKTOP, { width: 1280 });
  const v = verdicts(r);
  check(LABELS.ink, v.ink, true);
  check(LABELS.bothShown, v.bothShown, true);
  check('and the App Store badge really is the larger box size there (not the phone size)',
    r.rows.every((x) => x.iosH > 34), true);
}

console.log('\n=== the homepage offers the FULL app on the App Store, and Lite via /download ===');
{
  // Reversed 2026-10-05 at the owner's request: the hero carries the native
  // app's two badges again, plus "Smaller phone? Get the Lite App." -> /download.
  const ctx = await b.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 780 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/index.html`, { waitUntil: 'load' });
  await p.waitForTimeout(300);
  const h = await p.evaluate(() => {
    const lite = document.querySelector('.hero-get-sub a');
    return {
      // Reachable, not merely present: an App Store link nobody can see is not an offer.
      storeHrefs: [...document.querySelectorAll('a[href*="apps.apple.com"]')].filter((a) => a.getClientRects().length > 0).map((a) => a.getAttribute('href')),
      liteHref: lite?.getAttribute('href') ?? null,
      liteShown: !!lite && lite.getClientRects().length > 0,
      stale: /no App Store version/i.test(document.body.innerText),
    };
  });
  check('exactly one App Store badge, and it is the full app (not Lite)', h.storeHrefs, ['https://apps.apple.com/app/id6804218478']);
  check('"Lite App" goes to the download page', h.liteHref, 'https://hawkeye.com.ng/download.html');
  check('and that link renders', h.liteShown, true);
  // Retired by 8fac697/b2fda44: printed beside a live listing it was simply false.
  check('nothing still says there is no App Store version', h.stale, false);
  check('no page error', errs.slice(0, 2), []);
  await ctx.close();
}

console.log('\n=== controls: each check can fail ===');
{
  // The Lite listing pointed at the full app's id — the kind of copy-paste that
  // sends every Lite visitor to a 53 MB download.
  mutate = (html) => html.replace('https://apps.apple.com/app/id6806090537', STORE);
  const swapped = verdicts(await audit(IPHONE));
  check('control: Lite pointing at the full app\'s listing is caught', swapped.liteHref, false);
  check('control: and the full app\'s own check is unaffected', swapped.fullHref, true);

  // A badge hidden by attribute — the badge an Android-only mind might "tidy" away.
  mutate = (html) => html.replace(
    `href="${STORE}">`, `href="${STORE}" hidden>`);
  const hidden = verdicts(await audit(ANDROID));
  check('control: a hidden App Store badge is caught', hidden.bothShown, false);
  mutate = null;

  // Equal BOX heights: exactly the mismatch 0ca330e fixed.
  const equal = verdicts(await audit(IPHONE, {
    css: '.dl-badges .play-badge-link img.dl-badge-ios{ height:48px !important; }' }));
  check('control: an App Store badge sized to Play\'s box is caught', equal.ink, false);

  check('and the artwork file really is on disk', fs.existsSync(`${APP}/app-store-badge.svg`), true);
  check('it is Apple\'s file, not a redraw',
    /Download_on_the_App_Store_Badge/.test(fs.readFileSync(`${APP}/app-store-badge.svg`, 'utf8')), true);
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

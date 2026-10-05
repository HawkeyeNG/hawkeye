// The Play routes — on /download, which is where they live now. They must be
// offered where they can be acted on, name the right package for the right app,
// and be Google's own artwork, unsquashed and unwrapped by our button chrome.
//
// HOW THIS GOT HERE, so nobody restores what was retired on purpose:
//   6693afa / e65a716  the homepage Play badge went live beside the web-app
//                      button, and was hidden on iPhone: there was no iOS build.
//   8fac697            the App Store listing went live, so both badges showed on
//                      EVERY platform — people pick an app on a laptop for a
//                      phone they are not holding, which platform-gating hides.
//   b2fda44            the install dialog stopped re-offering the stores to the
//                      people who had just declined them to reach it.
//   227685a            the hero's badges became ONE "Get the app" button to
//                      /download, which carries all four listings; the hero's
//                      #install-cta / #play-cta went with it, and the web-app
//                      route is now /download -> index.html#install.
//
// CONTROLS at the foot: the same audit on pages served with one defect each
// (Lite pointed at the full app's package, a badge [hidden], a squashed badge,
// a Play link put back in the install dialog) must turn its check red.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
/** { 'file.html': (html) => html } — rewrite a page on the way out, for the controls. */
let mutate = {};
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0].split('#')[0];
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const m = mutate[path.basename(f)];
  if (m) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(m(fs.readFileSync(f, 'utf8'))); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const PLAY = 'https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer';
const PLAY_LITE = 'https://play.google.com/store/apps/details?id=ng.com.hawkeye.lite';
const RATIO = 646 / 250;   // play-badge.png, Google's artwork
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** Load /download as a given device and report each Play badge's state. */
async function audit(ua, { width = 390, css = null } = {}) {
  const ctx = await b.newContext({ userAgent: ua, viewport: { width, height: 900 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/download.html`, { waitUntil: 'load' });
  if (css) await p.addStyleTag({ content: css });
  // The Lite row is loading="lazy"; bring each badge in and let it land.
  await p.evaluate(async () => {
    for (const i of document.querySelectorAll('.dl-badges img')) {
      i.scrollIntoView({ block: 'center' });
      await i.decode().catch(() => {});
    }
    window.scrollTo(0, 0);
  });
  const rows = await p.evaluate(() => [...document.querySelectorAll('.dl-badges')].map((row) => {
    const a = [...row.querySelectorAll('a')].find((x) => /play\.google\.com/.test(x.getAttribute('href') || ''));
    const im = a?.querySelector('img');
    const box = im && im.getClientRects().length ? im.getBoundingClientRect() : null;
    return {
      app: row.closest('.dl-lite') ? 'lite' : 'full',
      // RENDERED, not the property. `.hidden` once read true on iPhone while the
      // badge was still on screen: .play-badge-link sets `display: inline-block`,
      // and an author display rule beats the [hidden] UA style.
      shown: a ? a.getClientRects().length > 0 : false,
      href: a ? a.getAttribute('href') : null,
      isImage: !!im,
      alt: im?.getAttribute('alt') ?? null,
      loaded: im ? im.naturalWidth > 0 : null,
      // The RENDERED ratio, not the file's: a badge squeezed by flex-shrink has
      // the right file and the wrong shape, which is the redraw Google forbids.
      ratio: box && box.height ? box.width / box.height : null,
      ourChrome: a ? /btn-/.test(a.className) : null,
      newTab: a ? a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel') || '') : false,
    };
  }));
  await ctx.close();
  return { rows, errs };
}

function verdicts({ rows, errs }) {
  const full = rows.find((r) => r.app === 'full') || {};
  const lite = rows.find((r) => r.app === 'lite') || {};
  return {
    bothShown: full.shown === true && lite.shown === true,
    fullHref: full.href === PLAY,
    liteHref: lite.href === PLAY_LITE,
    image: [full, lite].every((r) => r.isImage && r.loaded === true),
    alts: full.alt === 'Get Hawkeye on Google Play' && lite.alt === 'Get Hawkeye Lite on Google Play',
    ratio: [full, lite].every((r) => r.ratio != null && Math.abs(r.ratio - RATIO) < 0.03),
    noChrome: [full, lite].every((r) => r.ourChrome === false),
    newTab: [full, lite].every((r) => r.newTab === true),
    noErrors: errs.length === 0,
  };
}
const LABELS = {
  bothShown: 'the Play route is offered for both apps (it RENDERS)',
  fullHref: 'the full app\'s badge names the full app\'s package',
  liteHref: 'Lite\'s badge names Lite\'s package',
  image: 'rendered as the official badge image, and it loaded',
  alts: 'with alt text naming the app, since the badge carries the words as pixels',
  ratio: 'at its unaltered aspect ratio (Google forbids redrawing it)',
  noChrome: 'and no button chrome of ours around it',
  newTab: 'opening safely in a new tab',
  noErrors: 'no page error',
};

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// iPhone INCLUDED since 8fac697: there is an iOS build now, and the App Store
// badge sits beside this one; hiding Play there would hide a choice, not an
// offer the visitor cannot take.
for (const [name, ua] of [['Android', ANDROID], ['iPhone', IPHONE], ['desktop (people install on a phone from a laptop link)', DESKTOP]]) {
  console.log(`\n=== /download on ${name} ===`);
  const v = verdicts(await audit(ua));
  for (const k of Object.keys(LABELS)) check(LABELS[k], v[k], true);
}

console.log('\n=== the narrowest phone: badges wrap, they never shrink ===');
{
  const v = verdicts(await audit(ANDROID, { width: 320 }));
  check('still unsquashed at 320px', v.ratio, true);
  check('and still offered', v.bothShown, true);
}

console.log('\n=== the homepage offers the FULL app on Play, and Lite via /download ===');
{
  // Reversed 2026-10-05 at the owner's request (see app_store_badge_test.mjs).
  const ctx = await b.newContext({ userAgent: ANDROID, viewport: { width: 390, height: 780 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/index.html`, { waitUntil: 'load' });
  await p.waitForTimeout(300);
  const h = await p.evaluate(() => {
    // ONE SIZE FOR BOTH (owner): the two store buttons render identically sized,
    // and neither logo is missing (a broken image would still leave the box).
    const box = (sel) => { const e = document.querySelector(sel); const r = e && e.getBoundingClientRect(); return r ? [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] : null; };
    const play = box('.hero-badges a[href*="play.google.com"]'), apple = box('.hero-badges a[href*="apps.apple.com"]');
    return {
      playHrefs: [...document.querySelectorAll('a[href*="play.google.com"]')].filter((a) => a.getClientRects().length > 0).map((a) => a.getAttribute('href')),
      ratio: !!play && !!apple && play[0] === apple[0] && play[1] === apple[1] && play[1] >= 44
        && [...document.querySelectorAll('.hero-badges img')].every((i) => i.complete && i.naturalWidth > 0),
      liteHref: document.querySelector('.hero-get-sub a')?.getAttribute('href') ?? null,
    };
  });
  check('exactly one Play badge, and it is the full app (not Lite)', h.playHrefs, ['https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer']);
  check('both store buttons are the same size (>= 44px tall), logos loaded', h.ratio, true);
  check('"Lite App" goes to the download page', h.liteHref, 'https://hawkeye.com.ng/download.html');
  await ctx.close();
}

console.log('\n=== the web-app route: /download -> the install dialog ===');
/** Follow /download's own home-screen link and describe the dialog it opens. */
async function dialog(ua) {
  const ctx = await b.newContext({ userAgent: ua, viewport: { width: 390, height: 780 } });
  const p = await ctx.newPage();
  await p.goto(`${base}/download.html`, { waitUntil: 'load' });
  const href = await p.evaluate(() => {
    const a = [...document.querySelectorAll('#other-ways a')].find((x) => /#install$/.test(x.getAttribute('href') || ''));
    return a ? a.getAttribute('href') : null;
  });
  // Opened the way a reader opens it: unfold "If you cannot use an app store",
  // then tap the link — not by navigating to a URL this test typed.
  let open = false;
  if (href) {
    await p.click('#other-ways > summary');
    await Promise.all([p.waitForURL(/index\.html#install$/), p.click(`#other-ways a[href="${href}"]`)]);
    open = await p.waitForSelector('#install-modal[open]', { timeout: 10000 }).then(() => true, () => false);
  }
  const d = open ? await p.evaluate(() => {
    const and = document.getElementById('pwa-android');
    const ios = document.getElementById('pwa-ios');
    const apk = and.querySelector('a[href$=".apk"]');
    return {
      playInDialog: !!document.querySelector('#install-modal a[href*="play.google.com"]'),
      androidSteps: and.querySelectorAll('ol li').length,
      apk: apk ? apk.getAttribute('href') : null,
      iosSafariSteps: /Safari/.test(ios.textContent) && ios.querySelectorAll('ol li').length >= 3,
      staleNoStore: /no App Store version/i.test(document.getElementById('install-modal').textContent),
      // REACHABLE, not merely present — the distinction this file learned about
      // .hidden versus display, applied to links.
      storeLinkShown: [...document.querySelectorAll('#install-modal a[href*="apps.apple.com"], #install-modal a[href*="play.google.com"]')]
        .some((a) => a.getClientRects().length > 0),
    };
  }) : null;
  await ctx.close();
  return { href, open, d };
}
{
  const { href, open, d } = await dialog(ANDROID);
  check('/download links the home-screen route to index.html#install', href, 'index.html#install');
  check('and following it opens the install dialog', open, true);
  // b2fda44: the people who reach this dialog declined the badges to get here.
  check('the dialog does NOT re-offer Play', d?.playInDialog, false);
  check('nor any other store link', d?.storeLinkShown, false);
  check('Android keeps its manual steps', d?.androidSteps, (n) => n >= 3);
  check('and the direct APK, which exists on disk', !!d?.apk && fs.existsSync(path.join(APP, d.apk)), true);
  check('iPhone keeps its Safari instructions', d?.iosSafariSteps, true);
  check('and nothing claims there is no App Store version', d?.staleNoStore, false);
}

console.log('\n=== controls: each check can fail ===');
{
  mutate = { 'download.html': (h) => h.replace(PLAY_LITE, PLAY) };
  check('control: Lite pointing at the full app\'s package is caught', verdicts(await audit(ANDROID)).liteHref, false);

  mutate = { 'download.html': (h) => h.replace(`href="${PLAY}">`, `href="${PLAY}" hidden>`) };
  check('control: a hidden Play badge is caught', verdicts(await audit(IPHONE)).bothShown, false);
  mutate = {};

  check('control: a squashed badge is caught', verdicts(await audit(ANDROID, {
    css: '.dl-badges .play-badge-link img:not(.dl-badge-ios){ width:90px !important; }' })).ratio, false);

  // b2fda44's Play button, put back at the top of the Android steps.
  mutate = { 'index.html': (h) => h.replace('<section class="pwa-os" id="pwa-android">',
    `<section class="pwa-os" id="pwa-android"><p><a href="${PLAY}">Get it on Google Play</a></p>`) };
  const { d } = await dialog(ANDROID);
  check('control: a Play link back in the dialog is caught', d?.playInDialog, true);
  mutate = {};
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

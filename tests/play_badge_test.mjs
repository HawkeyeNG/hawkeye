// The Play route on the homepage. It must appear where it can be acted on, name
// the right package, and stay OFF iPhone — there is no iOS build, and an offer a
// visitor cannot take is worse than no offer.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
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
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** Load the homepage as a given device and report the Play CTA's state. */
async function on(uaLabel, ua) {
  const ctx = await b.newContext({ userAgent: ua, viewport: { width: 390, height: 780 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#install-cta', { state: 'attached', timeout: 10000 });
  await p.waitForTimeout(400);
  const r = await p.evaluate(() => {
    const a = document.getElementById('play-cta');
    return {
      // RENDERED, not the property. `.hidden` read true on iPhone while the badge
      // was still on screen: .play-badge-link sets `display: inline-block`, and an
      // author display rule beats the [hidden] UA style. Asking the element
      // whether it is hidden gave the wrong answer; asking the layout does not.
      shown: a ? a.getClientRects().length > 0 : false,
      label: document.getElementById('install-cta')?.textContent?.trim() ?? null,
      sameRow: (() => {
        const btn = document.getElementById('install-cta');
        if (!a || !btn || !a.getClientRects().length) return null;
        const x = a.getBoundingClientRect(); const y = btn.getBoundingClientRect();
        return Math.abs((x.top + x.height / 2) - (y.top + y.height / 2)) < 6;
      })(),
      sameHeight: (() => {
        const img = a?.querySelector('img'); const btn = document.getElementById('install-cta');
        if (!img || !btn || !img.getClientRects().length) return null;
        return Math.abs(img.getBoundingClientRect().height - btn.getBoundingClientRect().height) < 2;
      })(),
      href: a ? a.getAttribute('href') : null,
      text: a ? a.textContent.trim() : null,
      isImage: a ? !!a.querySelector('img') : false,
      imgAlt: a?.querySelector('img')?.getAttribute('alt') ?? null,
      ratio: (() => {
        const im = a?.querySelector('img');
        return im && im.naturalHeight ? im.naturalWidth / im.naturalHeight : null;
      })(),
      hasButtonClass: a ? /btn-/.test(a.className) : false,
      opensNewTab: a ? a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel') || '') : false,
    };
  });
  await ctx.close();
  if (errs.length) { fail++; console.log(`FAIL  page errors on ${uaLabel}: ${JSON.stringify(errs)}`); }
  return r;
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

console.log('=== Android ===');
const a = await on('Android', ANDROID);
check('the Play route is offered', a.shown, true);
check('the web-app button sits on the same line', a.sameRow, true);
check('and matches the badge height', a.sameHeight, true);
check('labelled for a platform that has a store', a.label, 'Install Web App');
check('pointing at the right package', a.href, PLAY);
check('opening safely in a new tab', a.opensNewTab, true);
check('rendered as the official badge image', a.isImage, true);
check('with alt text, since the badge carries the words as pixels', a.imgAlt, 'Get it on Google Play');
check('unaltered aspect ratio (Google forbids redrawing it)', a.ratio, (r) => Math.abs(r - 646 / 250) < 0.02);
check('and no button chrome of ours around it', a.hasButtonClass, false);

console.log('\n=== iPhone — there is no iOS build ===');
const i = await on('iPhone', IPHONE);
check('the badge does not RENDER on iPhone', i.shown, false);
check('and the button says which platform it is for', i.label, 'Web App for iPhone');

console.log('\n=== desktop (people install on a phone from a laptop link) ===');
const d = await on('desktop', DESKTOP);
check('offered', d.shown, true);

console.log('\n=== the install dialog ===');
const ctx = await b.newContext({ userAgent: ANDROID, viewport: { width: 390, height: 780 } });
const p = await ctx.newPage();
await p.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
await p.click('#install-cta');
await p.waitForSelector('#install-modal[open]', { timeout: 10000 });
const dlg = await p.evaluate(() => {
  const and = document.getElementById('pwa-android');
  const ios = document.getElementById('pwa-ios');
  const playLink = and.querySelector('a[href*="play.google.com"]');
  return {
    playInAndroid: !!playLink,
    playHref: playLink?.getAttribute('href') ?? null,
    // Play should come BEFORE the manual steps: it is the route with no caveats.
    playBeforeSteps: !!playLink && !!and.querySelector('ol')
      && playLink.compareDocumentPosition(and.querySelector('ol')) & Node.DOCUMENT_POSITION_FOLLOWING,
    iosSaysNoStore: /no App Store version yet/i.test(ios.textContent),
    iosStillHasSafariSteps: /Safari/.test(ios.textContent) && ios.querySelectorAll('ol li').length >= 3,
    noAppStoreLink: !document.querySelector('a[href*="apps.apple.com"]'),
  };
});
check('Play is in the Android section', dlg.playInAndroid, true);
check('with the right listing', dlg.playHref, PLAY);
check('and it comes before the manual steps', !!dlg.playBeforeSteps, true);
check('iPhone is told there is no App Store version', dlg.iosSaysNoStore, true);
check('but keeps its Safari instructions', dlg.iosStillHasSafariSteps, true);
check('and nothing links to an App Store listing that does not exist', dlg.noAppStoreLink, true);

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

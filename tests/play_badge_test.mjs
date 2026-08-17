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
      shown: a ? !a.hidden : false,
      href: a ? a.getAttribute('href') : null,
      text: a ? a.textContent.trim() : null,
      isImage: a ? !!a.querySelector('img') : false,
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
check('pointing at the right package', a.href, PLAY);
check('opening safely in a new tab', a.opensNewTab, true);
check('as a text link, since no official badge asset is present', a.isImage, false);
check('and it reads as Play', a.text, (t) => /Google Play/.test(t));

console.log('\n=== iPhone — there is no iOS build ===');
const i = await on('iPhone', IPHONE);
check('NOT offered on iPhone', i.shown, false);

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

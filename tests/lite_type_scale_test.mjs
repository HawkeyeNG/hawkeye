/**
 * LITE MUST USE THE APP'S TYPE SCALE, not the website's.
 *
 * Measured 2026-08-25: every Lite page ran about 20% larger than the app it
 * mirrors — body 17px against 14, h1 27 against 20, h2 19-22 against 16. That is
 * the whole of "Lite looks weird, the text is slightly too large": nothing was
 * misaligned, there was just more of it per line, so headings wrapped and cards
 * grew tall enough to push content below the fold.
 *
 * Scoped to html.native-app, which native.js sets only inside Capacitor — the
 * same stylesheet serves the desktop website, where 17px is a comfortable
 * reading size.
 *
 * THE CLASS HAS TO BE SET THE WAY CAPACITOR SETS IT. `document.documentElement`
 * is null when an init script first runs, so a bare classList.add() there
 * silently does nothing and every assertion below measures the WEBSITE while
 * appearing to measure Lite. That cost a full debugging round; the listener is
 * why it works.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** A page as LITE renders it. */
async function lite(file, seedAuth = false) {
  const p = await b.newPage({ viewport: { width: 375, height: 812 } });
  await p.addInitScript(() => {
    const mark = () => document.documentElement && document.documentElement.classList.add('native-app');
    mark();
    document.addEventListener('readystatechange', mark);
  });
  if (seedAuth) {
    // authgate.js base64-decodes the payload for `exp`, so a placeholder string
    // redirects to sign-in and the page under test never renders. The token must
    // also be set on the right ORIGIN — an init script runs on about:blank.
    await p.goto(`${base}/index.html`);
    await p.evaluate(() => {
      const exp = Math.floor(Date.now() / 1000) + 86400;
      localStorage.setItem('hawkeye_token', `hdr.${btoa(JSON.stringify({ exp }))}.sig`);
    });
  }
  await p.goto(`${base}/${file}`);
  await p.waitForTimeout(350);
  return p;
}

const px = (s) => Math.round(parseFloat(s));

console.log('=== the class is actually set (or everything below measures the website) ===');
{
  const p = await lite('ledger.html');
  check('html carries native-app', await p.evaluate(() => document.documentElement.classList.contains('native-app')), true);
  check('root is 15px, not the website 16', px(await p.evaluate(() => getComputedStyle(document.documentElement).fontSize)), 15);
  await p.close();
}

console.log('\n=== the app scale, across trust & verify and learn & about ===');
for (const f of ['ledger.html', 'integrity.html', 'docket.html', 'how.html', 'guide.html', 'about.html', 'terms.html']) {
  const p = await lite(f);
  const m = await p.evaluate(() => {
    const g = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontSize : null; };
    return { h1: g('main h1'), lede: g('.lede'), hint: g('.hint'), sideways: document.documentElement.scrollWidth > window.innerWidth };
  });
  if (m.h1) check(`${f}: h1 is 20px (app text-xl)`, px(m.h1), 20);
  if (m.lede) check(`${f}: lede is 14px (app text-sm)`, px(m.lede), 14);
  if (m.hint) check(`${f}: hint is 12px (app text-xs)`, px(m.hint), 12);
  check(`${f}: does not scroll sideways`, m.sideways, false);
  await p.close();
}

console.log('\n=== My Profile mirrors the app ===');
{
  const p = await lite('profile.html', true);
  check('it got past the auth gate', await p.evaluate(() => location.pathname), '/profile.html');
  const h = await p.evaluate(() => [...document.querySelectorAll('.pcard h2')].map((x) => ({
    t: x.textContent.trim(), px: getComputedStyle(x).fontSize, up: getComputedStyle(x).textTransform,
  })));
  check('there are card headings to check', h.length, (n) => n >= 4);
  check('each is a small uppercase label, not a 16px title', h.every((x) => px(x.px) <= 12 && x.up === 'uppercase'), true);
  // The app writes them in sentence case: "Account", "Races you follow".
  check('sentence case, like the app', h.map((x) => x.t), (t) =>
    t.includes('Races you follow') && t.includes('My polling unit') && t.includes('Delete my identity'));
  await p.close();
}

console.log('\n=== the WEBSITE is untouched — this is a Lite change ===');
{
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(`${base}/ledger.html`);
  await p.waitForTimeout(250);
  check('no native-app class in a browser', await p.evaluate(() => document.documentElement.classList.contains('native-app')), false);
  check('root stays at the website size', px(await p.evaluate(() => getComputedStyle(document.documentElement).fontSize)), 16);
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
await b.close();
server.close();
process.exit(fail ? 1 : 0);

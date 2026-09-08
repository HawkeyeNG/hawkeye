/**
 * THE RACE THAT ONLY SHOWED UP ON THE LIVE SITE.
 *
 * menu.js used to reason: i18n.js resolves a non-English bundle through
 * fetch().then(), so its apply() pass runs in a LATER task than menu.js's
 * synchronous body — therefore apply() always sees the footer, the ☰ links and
 * the header name that menu.js builds, and a data-i18n attribute on them is
 * enough.
 *
 * That is true only while nothing separates the two <script> tags. On
 * hawkeye.com.ng it did: index.html is the biggest page on the site and the
 * network stalled between i18n.js and menu.js long enough for the bundle fetch
 * to resolve FIRST. apply() ran against a footer that did not exist yet; menu.js
 * then replaced the page's own keyed <nav> with its English rebuild; and Home
 * shipped the exact bug this work set out to remove — while how.html, which won
 * the race, was perfectly correct. tests/chrome_i18n_test.mjs passed throughout,
 * because on localhost menu.js always won.
 *
 * SO THIS TEST MAKES i18n.js WIN. The server below delays menu.js by 400ms,
 * which is all it takes: the bundle lands, apply() runs early, and menu.js builds
 * afterwards. Anything that renders in English under this delay is relying on
 * script order.
 *
 * The fix under test is menu.js's own final i18nSweep() plus its 'hawkeye-lang'
 * listener — i.e. not relying on the order at all.
 *
 * CONTROL: the same page is also served WITHOUT the delay. Both orders must give
 * the same rendered text. A test that only ever ran the slow path could pass on
 * a build that had simply swapped which order is broken.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let DELAY_MENU = 0;
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const send = () => {
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  };
  // The whole point: hold menu.js back so the i18n bundle fetch resolves first.
  if (DELAY_MENU && u.endsWith('/menu.js')) setTimeout(send, DELAY_MENU);
  else send();
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

const browser = await chromium.launch();

async function read(lang, page = 'index.html') {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await ctx.addInitScript((code) => {
    try {
      localStorage.setItem('hawkeye_lang', code);
      localStorage.setItem('hawkeye_lang_prompt_done', '1');
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch (e) { /* private mode */ }
  }, lang);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/${page}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  const out = await p.evaluate(() => ({
    footer: [...document.querySelectorAll('.gov-footer nav a')].map((a) => a.textContent.trim()),
    groups: [...document.querySelectorAll('#menu-panel .menu-group')].map((a) => a.textContent.trim()),
    skip: (document.querySelector('.skip-link') || {}).textContent,
  }));
  await ctx.close();
  return out;
}

/**
 * CONTROL FIRST — prove the delay actually changes which script wins. Without
 * this, a delay that silently stopped applying would make the whole file a
 * second copy of chrome_i18n_test.mjs.
 */
console.log('=== CONTROL: the delay really does reorder the two scripts ===');
{
  DELAY_MENU = 0;
  const ctx = await browser.newContext();
  const fast = await ctx.newPage();
  const order = [];
  await fast.route('**/*', (r) => { const u = r.request().url(); if (/i18n\.js|menu\.js/.test(u)) order.push(u.split('/').pop().split('?')[0]); r.continue(); });
  await fast.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await ctx.close();

  DELAY_MENU = 400;
  const t0 = Date.now();
  const ctx2 = await browser.newContext();
  const slow = await ctx2.newPage();
  await slow.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  const elapsed = Date.now() - t0;
  await ctx2.close();
  check('CONTROL the delayed load really is slower (menu.js was held back)', elapsed >= 400, elapsed);
}

console.log('\n=== English, menu.js delayed — the control for the Hausa run ===');
DELAY_MENU = 400;
const enSlow = await read('en');
check('the footer still rebuilt', enSlow.footer.length >= 7, enSlow.footer);
check('  ...in English', enSlow.footer[0] === 'About', enSlow.footer);
check('the ☰ groups still rendered', enSlow.groups.length >= 4, enSlow.groups);
check('the skip link still rendered', enSlow.skip === 'Skip to content', enSlow.skip);

console.log('\n=== Hausa, menu.js delayed — i18n.js WINS the race ===');
const haSlow = await read('ha');
const moved = (n, a, b) => check(n, !!b && a !== b, { en: a, ha: b });
for (let i = 0; i < enSlow.footer.length; i++) {
  moved(`footer "${enSlow.footer[i]}" translated despite the delay`, enSlow.footer[i], haSlow.footer[i]);
}
for (let i = 0; i < enSlow.groups.length; i++) {
  moved(`☰ group "${enSlow.groups[i]}" translated despite the delay`, enSlow.groups[i], haSlow.groups[i]);
}
moved('the skip link translated despite the delay', enSlow.skip, haSlow.skip);

console.log('\n=== and the fast order gives the SAME rendered text ===');
DELAY_MENU = 0;
const haFast = await read('ha');
check('the footer reads identically either way', JSON.stringify(haFast.footer) === JSON.stringify(haSlow.footer),
  { fast: haFast.footer, slow: haSlow.footer });
check('the ☰ groups read identically either way', JSON.stringify(haFast.groups) === JSON.stringify(haSlow.groups),
  { fast: haFast.groups, slow: haSlow.groups });

await browser.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed — the chrome no longer depends on which script wins');
process.exit(failed ? 1 : 0);

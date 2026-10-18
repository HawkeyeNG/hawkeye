/**
 * A LABELLER'S PARTY NAME IS TEXT IN THE REVIEW CONSOLES (pre-election review).
 *
 * train.html lets a signed-in labeller type any party name; it is saved as a
 * key of /training/truth.json, and admin.html and review.html wrote those keys
 * (and the box figures) into innerHTML unescaped — on the pages that hold the
 * admin passphrase. A party named <img src=x onerror=…> ran in the console.
 *
 * Both shipped pages, in a browser, with the passphrase set and the training
 * files served. CONTROL: an ordinary label still renders its counts.
 *
 *   node tests/label_review_escape_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const EVIL = '<img src=x onerror="window.__ran=(window.__ran||0)+1">';
const TRAINING = {
  'sets.json': { 'evil.jpg': '3', 'plain.jpg': '3' },
  'truth.json': { evil: { [EVIL]: 7 }, plain: { APC: 12, PDP: 9 } },
  'boxes.json': { evil: { registered: EVIL, totalValid: 7 } },
};
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  const t = u.match(/^\/training\/([a-z]+\.json)$/);
  if (t) return json(TRAINING[t[1]] || {});
  if (u.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (l, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;
const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
for (const page of ['review.html', 'admin.html']) {
  console.log(`=== ${page} ===`);
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  // A signed-in session too: authgate.js sends a signed-out reader to sign-in.
  await ctx.addInitScript((tok) => {
    sessionStorage.setItem('hawkeye_admin', 'pass'); localStorage.setItem('hawkeye_admin', 'pass');
    localStorage.setItem('hawkeye_token', tok);
  }, JWT());
  const p = await ctx.newPage();
  await p.goto(`${base}/${page}`);
  if (page === 'admin.html') {
    // The console opens once the passphrase is accepted.
    await p.evaluate(() => { const i = document.getElementById('pass'); if (i) i.value = 'pass'; const b = document.getElementById('btn-login'); if (b) b.click(); });
  }
  await p.waitForFunction(() => document.querySelectorAll('#lab-list .counts').length >= 2, null, { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(500);
  const got = await p.evaluate(() => ({
    ran: window.__ran || 0,
    imgs: document.querySelectorAll('#lab-list .counts img, #lab-list .boxes img').length,
    counts: [...document.querySelectorAll('#lab-list .counts')].map((c) => c.textContent.trim()),
  }));
  check(`${page}: the typed party name does not run`, got.ran, 0);
  check(`${page}: ...and is no element`, got.imgs, 0);
  check(`${page}: ...it is shown as the text that was typed`, got.counts.some((c) => c.includes('<img src=x')), true);
  check(`${page}: CONTROL an ordinary label renders its counts`, got.counts.includes('APC 12, PDP 9'), true);
  await ctx.close();
}
await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

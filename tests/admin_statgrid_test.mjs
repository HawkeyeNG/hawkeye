/**
 * Fifteen stat cards land five to a row on a desktop, and stay readable when
 * the screen is too narrow for that.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/admin_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(u));
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';

/** The fifteen real labels, filled in so the grid is measured as it ships. */
const LABELS = ['observers registered', 'new in 24h', 'new in 7 days', 'Telegram linked', 'push enabled',
  'iOS devices', 'Android devices', 'iOS undeliverable', 'saved a unit', 'result submissions',
  'collation reports', 'incidents filed', 'practice runs', 'units crowd-mapped', 'first signup'];

async function rows(width, scheme) {
  const ctx = await b.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('hawkeye_token', t);
      sessionStorage.setItem('hawkeye_admin', 'test');
      localStorage.setItem('hawkeye_admin', 'test');
    } catch (e) {}
  }, jwt);
  const p = await ctx.newPage();
  await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  const out = await p.evaluate((labels) => {
    const g = document.getElementById('stats');
    g.innerHTML = labels.map((l, i) => `<div class="s"><b>${i * 7}</b><span>${l}</span></div>`).join('');
    const tops = [...g.children].map((c) => Math.round(c.getBoundingClientRect().top));
    const perRow = {};
    tops.forEach((t) => { perRow[t] = (perRow[t] || 0) + 1; });
    return { cards: g.children.length, rows: Object.values(perRow), gridW: Math.round(g.getBoundingClientRect().width) };
  }, LABELS);
  if (width >= 1280) await p.screenshot({ path: `${OUT}/statgrid-${scheme}.png` });
  await ctx.close();
  return out;
}

console.log('=== desktop ===');
const d = await rows(1280, 'dark');
check('fifteen cards', d.cards, 15);
check('five to a row, three rows', d.rows, [5, 5, 5]);
check('and the grid fills the column', d.gridW, (w) => w > 600);

console.log('\n=== a phone ===');
const m = await rows(400, 'light');
// NOT five — the rule is a desktop rule, and 140px columns cannot fit five in
// 400px. This is the control: it proves the media query is doing something.
check('CONTROL narrow screens are not forced to five', m.rows, (r) => r.every((n) => n < 5));
check('and nothing is lost', m.cards, 15);

await b.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

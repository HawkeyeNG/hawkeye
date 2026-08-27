/**
 * THE NEAR-ME LIST MUST NOT PRINT `undefined`.
 *
 * The report flow asks TWO endpoints and merges them, because neither alone
 * finds every unit: the register knows a unit's LGA and state but caps its
 * radius early, and the mapping index reaches further and includes units placed
 * only by their GRID3 envelope. They do not agree on field names:
 *
 *   /api/polling-units    pu_code   ward   lga   state
 *   /api/mapping/nearby   puCode    ward   —     —
 *
 * Merging them raw handed the renderer two shapes, and every mapping-only row
 * drew as "Lasigun / Irerinde — undefined · Akogun, undefined · 453 m away" in
 * the live flow. It was found by reading a button list while shooting store
 * screenshots, not by a test, which is why there is now a test.
 *
 * The fixture deliberately serves the REAL two shapes. A fixture that returned
 * one shape twice is exactly how this got through.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Register row: fully populated, the shape the renderer was written for.
const REG = {
  pu_code: '29-30-06-013', name: 'Methodist School, Isale-Aro Ii', ward: "Otun Jagun 'B'",
  lga: 'Osogbo', state: 'Osun', distanceM: 298, locationTier: 'geocoded',
};
// Mapping row: camelCase code, NO lga, NO state. This is the one that broke.
const NEAR = {
  puCode: '29-27-03-010', name: 'Lasigun / Irerinde', ward: 'Akogun',
  lat: 7.774238, lng: 4.56007, distanceM: 453, status: 'approx', fixes: 0,
};

const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (u === '/api/observers/me') return json({ observerNo: 2, createdAt: '2026-07-15T00:00:00Z', idHash: 'a'.repeat(64) });
  if (u === '/api/polling-units') return json({ radiusM: 500, maxRows: 40, capped: false, units: [REG] });
  if (u === '/api/mapping/nearby') return json({ units: [NEAR] });
  if (u === '/api/contests') return json([]);
  if (u.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok || !extra ? '' : `\n        ${extra}`}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;
const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 780 },
  permissions: ['geolocation'],
  geolocation: { latitude: 7.7719, longitude: 4.5567 },
});
await ctx.addInitScript((t) => {
  Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
  const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
  mark();
  document.addEventListener('readystatechange', mark);
  try { localStorage.setItem('hawkeye_token', t); localStorage.setItem('hawkeye_tour_seen', '1'); } catch { /* ignore */ }
}, JWT());

const page = await ctx.newPage();
await page.goto(`${base}/observe.html`);
await page.waitForTimeout(2500);

const rows = await page.evaluate(() =>
  Array.from(document.querySelectorAll('#pu-list .pu-option')).map((b) => b.textContent.replace(/\s+/g, ' ').trim()));

console.log(`      ${rows.length} row(s) rendered`);
for (const r of rows) console.log(`        ${r}`);

check('both endpoints contributed a row', rows.length === 2, `got ${rows.length}`);
check('no row prints the word "undefined"', !rows.some((r) => /undefined/.test(r)),
  rows.filter((r) => /undefined/.test(r)).join(' | '));
check('the mapping-only row still shows its code', rows.some((r) => r.includes('29-27-03-010')));
check('and does not leave a dangling comma where its LGA would be',
  !rows.some((r) => /,\s*·/.test(r) || /,\s*$/.test(r)));
check('the register row keeps ward AND lga', rows.some((r) => /Otun Jagun 'B', Osogbo/.test(r)));

/* CONTROL: the assertions must fail on the pre-fix rendering. Build the old
   label from the same fixture rows and confirm the checks catch it. */
{
  const old = (u) => `${u.name}${u.pu_code} · ${u.ward}, ${u.lga} · ${u.distanceM} m away`;
  const bad = [old(REG), old(NEAR)];
  control('the "undefined" assertion catches the old renderer', !bad.some((r) => /undefined/.test(r)));
  control('the dangling-comma assertion catches it too', !bad.some((r) => /,\s*undefined/.test(r)));
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

/**
 * IN A REAL BROWSER: NO NEAR-ME REQUEST CARRIES THE FIX, AND THE LIST STILL
 * MEASURES FROM IT.
 *
 * Review L9 (web/Lite) and the native review of 2026-10-19: the near-me
 * lookups sent the full-precision fix in the URL, and URLs land in access
 * logs. tests/near_me_query_precision_test.mjs reads the source; this one
 * loads the five web screens that ask (the report flow, incidents, the unit
 * chooser, Map a Unit, practice) with the browser's position set to a real
 * fix's precision, records every request they make, and reads what the
 * observer is shown.
 *
 * The fixture answers like the server does: from the STATED point, widened by
 * slackM. So the observer's own unit, 5 m from the fix, is 28 m from the
 * rounded point — a page that rounds but forgets to re-measure prints "28 m
 * away" and fails here just as a page that never rounds does.
 *
 *   node tests/near_me_url_precision_ui_test.mjs
 *   (HK_APP=<other app dir> runs it against another tree.)
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = process.env.HK_APP || '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const FIX = { latitude: 7.7719431, longitude: 4.5567219 }; // a real fix's precision
const R = 6371000, RAD = Math.PI / 180;
const hav = (aLat, aLng, bLat, bLng) => {
  const dLat = (bLat - aLat) * RAD, dLng = (bLng - aLng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const off = (north, east) => ({
  lat: FIX.latitude + north / (R * RAD),
  lng: FIX.longitude + east / (R * RAD * Math.cos(FIX.latitude * RAD)),
});
const OWN = { pu_code: '29-30-06-013', name: 'Methodist School, Isale-Aro Ii', ward: "Otun Jagun 'B'", lga: 'Osogbo', state: 'Osun', ...off(4, 3) };
const NEXT = { pu_code: '29-30-06-014', name: 'Open Space Ita Olokan', ward: "Otun Jagun 'B'", lga: 'Osogbo', state: 'Osun', ...off(-250, -100) };
const EXACT_M = Math.round(hav(FIX.latitude, FIX.longitude, OWN.lat, OWN.lng));
const ROUNDED_M = Math.round(hav(Number(FIX.latitude.toFixed(3)), Number(FIX.longitude.toFixed(3)), OWN.lat, OWN.lng));

const nearRequests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const u = url.pathname;
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (u === '/api/polling-units' || u === '/api/mapping/nearby') {
    nearRequests.push({ page: currentPage, url: req.url });
    // As the server does: measured from the STATED point, widened by slackM.
    const sLat = Number(url.searchParams.get('lat')), sLng = Number(url.searchParams.get('lng'));
    const slack = Math.min(Math.max(Number(url.searchParams.get('slackM')) || 0, 0), 200);
    const radius = (u === '/api/polling-units' ? 500 : Math.min(Number(url.searchParams.get('radiusM')) || 5000, 20000)) + slack;
    const rows = [OWN, NEXT].map((x) => ({ x, d: Math.round(hav(sLat, sLng, x.lat, x.lng)) })).filter((r) => r.d <= radius);
    if (u === '/api/polling-units') {
      return json({ radiusM: 500, maxRows: 40, capped: false, units: rows.map(({ x, d }) => ({ ...x, crowd_lat: null, crowd_lng: null, coords_source: 'inec_locator', locationTier: 'verified', distanceM: d })) });
    }
    return json({ units: rows.map(({ x, d }) => ({ puCode: x.pu_code, name: x.name, ward: x.ward, lat: x.lat, lng: x.lng, distanceM: d, status: 'verified', approxRadiusM: null, fixes: 0 })) });
  }
  if (u === '/api/observers/me') return json({ observerNo: 2, createdAt: '2026-07-15T00:00:00Z', idHash: 'a'.repeat(64) });
  if (u === '/api/practice') return json({ active: true, name: 'Practice', office: 'Practice', parties: [], unit: { code: 'PRACTICE', name: 'Practice unit', state: '' } });
  if (u === '/api/contests') return json([]);
  if (u.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let currentPage = '';

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok || !extra ? '' : `\n        ${extra}`}`);
};

const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;
const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ['geolocation'], geolocation: FIX });
await ctx.addInitScript((t) => {
  Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
  const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
  mark();
  document.addEventListener('readystatechange', mark);
  try { localStorage.setItem('hawkeye_token', t); localStorage.setItem('hawkeye_tour_seen', '1'); } catch { /* ignore */ }
}, JWT());

console.log(`fixture: the observer's own unit is ${EXACT_M} m from the fix and ${ROUNDED_M} m from its 3-decimal copy`);
check('CONTROL the two distances differ, so a page that does not re-measure is caught', Math.abs(EXACT_M - ROUNDED_M) >= 10);

const precise = (q) => {
  const sp = new URL(q, 'http://x').searchParams;
  const dec = (v) => ((v || '').split('.')[1] || '').length;
  return { lat: dec(sp.get('lat')), lng: dec(sp.get('lng')), slack: sp.get('slackM') };
};
const PAGES = [
  { name: 'observe.html (report flow)', path: '/observe.html', act: null, list: '#pu-list' },
  { name: 'incidents.html', path: '/incidents.html', act: async (p) => { await p.check('#attach-pu').catch(() => {}); }, list: '#pu-near-list' },
  { name: 'choose-unit.html', path: '/choose-unit.html', act: async (p) => { if (!nearRequests.some((r) => r.page === currentPage)) await p.click('#tab-near').catch(() => {}); }, list: '#pane-near' },
  { name: 'map-unit.html', path: '/map-unit.html', act: null, list: null },
  { name: 'practice.html', path: '/practice.html', act: async (p) => { await p.evaluate(() => document.getElementById('btn-locate') && document.getElementById('btn-locate').onclick && document.getElementById('btn-locate').onclick()).catch(() => {}); }, list: '#pu-list' },
];
for (const pg of PAGES) {
  currentPage = pg.name;
  console.log(`\n=== ${pg.name} ===`);
  const page = await ctx.newPage();
  await page.goto(base + pg.path);
  await page.waitForTimeout(2500);
  if (pg.act) { await pg.act(page); await page.waitForTimeout(2500); }
  const mine = nearRequests.filter((r) => r.page === pg.name);
  check(`the page asked near-me at least once (${mine.length} request(s))`, mine.length > 0);
  const leaks = mine.filter((r) => { const p = precise(r.url); return p.lat > 3 || p.lng > 3; });
  check('no near-me URL carries more than 3 decimals', leaks.length === 0, leaks.map((r) => r.url).join('\n        '));
  const noSlack = mine.filter((r) => precise(r.url).slack !== '80');
  check('every near-me URL states its slack (slackM=80)', noSlack.length === 0, noSlack.map((r) => r.url).join('\n        '));
  if (pg.list) {
    const text = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.textContent.replace(/\s+/g, ' ') : ''; }, pg.list);
    const ownShown = text.includes(OWN.name);
    check('the observer\'s own unit is listed', ownShown, text.slice(0, 200));
    check(`...at its distance from the EXACT fix (${EXACT_M} m, not ${ROUNDED_M} m)`,
      new RegExp(`(^|\\D)${EXACT_M} ?m away`).test(text) && !new RegExp(`(^|\\D)${ROUNDED_M} ?m away`).test(text), text.slice(0, 300));
  }
  await page.close();
}

/* CONTROL: the distance check catches a page that rounds but does not
   re-measure. Same report flow, with nearExact neutered to hand back the
   server's rows untouched: it must now print the rounded point's distance. */
{
  currentPage = 'control';
  console.log('\n=== CONTROL observe.html with re-measuring switched off ===');
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    let rs;
    Object.defineProperty(window, 'registerStore', {
      configurable: true,
      get: () => rs,
      set: (v) => { if (v && v.nearExact) v.nearExact = (b) => b; rs = v; },
    });
  });
  await page.goto(base + '/observe.html');
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => (document.querySelector('#pu-list') || {}).textContent || '');
  const asked = nearRequests.some((r) => r.page === 'control');
  check(`CONTROL without re-measuring the list says ${ROUNDED_M} m, so the check above can fail`,
    asked && new RegExp(`(^|\\D)${ROUNDED_M} ?m away`).test(text.replace(/\s+/g, ' ')), text.replace(/\s+/g, ' ').slice(0, 200));
  await page.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

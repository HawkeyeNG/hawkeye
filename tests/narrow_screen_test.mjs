/**
 * TEXT MUST NOT SPILL OUT OF ITS OWN BOX on a narrow screen.
 *
 * The Fold 5 (folded) bug, and why measuring the wrong thing hid it: the race
 * list gives the name `flex: 1; min-width: 0` and the date `flex: none`, which
 * is correct — the BOXES never overlap and the gap measures a healthy 10px.
 * But "Representatives" is one unbreakable word, and `min-width: 0` lets the
 * box shrink under it, so the TEXT spills out and paints over the date:
 * "RepresentativesOpens Jan 16, 2027".
 *
 * So the assertion is scrollWidth <= clientWidth (does the text fit the box it
 * was given?), NOT a bounding-box comparison, which reports everything as fine.
 *
 * Checked at Android's font-scale settings too. At default size races.html was
 * clean and results.html was not; at 160% both failed. A test at one font size
 * would have called half of this fixed.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const ROOT = '/home/elrio/hawkeye';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));

const server = http.createServer((req, res) => {
  const [url] = req.url.split('?');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00` })));
  if (url.startsWith('/api/national/')) return json({ contest: 'x', level: 'lga', scope: null, subunits: [], updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [] });
  if (url.startsWith('/api/coverage/')) return json({ missing: [] });
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
// 320x760: a Fold 5 folded, and about the narrowest phone still in real use.
const p = await b.newPage({ viewport: { width: 320, height: 760 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

/** Leaf elements whose text is wider than the box they were given. */
const spills = (scalePct) => p.evaluate((scale) => {
  document.documentElement.style.fontSize = scale ? `${scale}%` : '';
  const out = [];
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (t.length < 6) return;
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      const cs = getComputedStyle(el);
      // Deliberate truncation is not a spill: an ellipsis or a clipped box has
      // decided what to do about the overflow.
      if (cs.textOverflow === 'ellipsis') return;
      if (cs.overflowX === 'hidden' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') return;
      out.push({ text: t.slice(0, 40), box: Math.round(el.clientWidth), textW: Math.round(el.scrollWidth) });
    }
  });
  document.documentElement.style.fontSize = '';
  return out;
}, scalePct);

console.log('=== the leaderboard race picker (the reported bug) ===');
await p.goto(`${base}/results.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
await p.evaluate(() => {
  const btn = document.getElementById('btn-race');
  const panel = document.getElementById('race-picker');
  if (panel && panel.hidden && btn) btn.click();
});
await p.waitForTimeout(200);
// The row this was reported on, by name, so the test cannot pass by the list
// being empty.
const names = await p.$$eval('.race-opt b', (n) => n.map((x) => x.textContent.trim()));
check('the House of Representatives row is present', names, (v) => v.some((x) => /Representatives/.test(x)));
check('no text spills at default size', await spills(0), []);
check('and none at 130% font scale', await spills(130), []);
check('and none at 160%', await spills(160), []);

console.log('\n=== the races index, same shape ===');
await p.goto(`${base}/races.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
check('no text spills at default size', await spills(0), []);
check('and none at 160% font scale', await spills(160), []);

console.log('\n=== CONTROL: the check can actually see a spill ===');
// Force the failure back, to prove the assertion is not vacuous.
await p.goto(`${base}/results.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(400);
await p.evaluate(() => {
  const btn = document.getElementById('btn-race');
  const panel = document.getElementById('race-picker');
  if (panel && panel.hidden && btn) btn.click();
  // BOTH mechanisms have to go. There are two now — the row wraps, and the name
  // breaks — and disabling only one leaves the other covering for it, which is
  // exactly what a control is supposed to notice.
  const st = document.createElement('style');
  st.textContent = '.race-opt { flex-wrap: nowrap !important; }'
    + '.race-opt b { flex: 1 1 auto !important; overflow-wrap: normal !important; word-break: normal !important; }';
  document.head.appendChild(st);
});
await p.waitForTimeout(150);
check('with both fixes removed, the spill returns', await spills(0), (v) => v.length > 0);

check('no page errors', errs, []);
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
await b.close();
server.close();
process.exit(fail ? 1 : 0);

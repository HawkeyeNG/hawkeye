// THE SHEET MUST BE READABLE WHERE THE FIGURES ARE TYPED.
//
// Capture comes first on purpose — the EC8A is the perishable thing on election
// day and the tally can be typed later from somewhere safer
// (docs/REPORT-FLOW-CAPTURE-FIRST.md). But "later, from somewhere safer" is
// exactly where the paper is no longer in front of the observer, and the counts
// step told them to copy the figures off a sheet it did not show: their own
// photograph sat two collapsed steps up the page, and on native two whole steps
// back with nothing surfacing it.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const server = http.createServer((req, res) => {
  const [url] = req.url.split('?');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json([]);
  if (url.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 780 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
// networkidle, not domcontentloaded: app.js runs resetReportState() during init,
// which WITHDRAWS the sheet reference. Setting up before that has finished means
// init undoes the setup, and the failure reads as "the feature does not work".
await p.goto(`${base}/observe.html`, { waitUntil: 'networkidle' });
// Signed out, the whole report screen is hidden behind the auth gate; step 4 is
// also locked until the earlier steps confirm. Neither is what this test is
// about, so both are opened directly.
await p.evaluate(() => {
  document.documentElement.classList.remove('auth-screen');
  document.getElementById('screen-submit').hidden = false;
  const fold = document.getElementById('counts-fold');
  fold.classList.remove('locked');
  fold.open = true;
});
const shown = (sel) => p.$eval(sel, (e) => !!e.getClientRects().length);

console.log('=== web: observe.html, step 4 ===');
// VISIBILITY, not the hidden property. `[hidden]{display:none}` is only a UA
// rule and an author `display` beats it — this page has been bitten by exactly
// that before (the venue preview rendered as a broken-image icon).
check('nothing offered before a photo exists', await shown('#counts-sheet'), false);

await p.evaluate((src) => showSheetReference(src), PIXEL);
check('the sheet appears once captured', await shown('#counts-sheet'), true);
check(
  'and sits ABOVE the figures, not under them',
  await p.evaluate(() =>
    !!(document.getElementById('counts-sheet').compareDocumentPosition(
      document.getElementById('vote-inputs'),
    ) & Node.DOCUMENT_POSITION_FOLLOWING)),
  true,
);
check('big enough to be a reference, small enough not to be the step',
  await p.$eval('#counts-sheet', (e) => Math.round(e.getBoundingClientRect().height)),
  (h) => h > 100 && h < 220);

console.log('\n=== the full-screen viewer ===');
await p.click('#counts-sheet');
check('opens', await shown('#sheet-zoom'), true);
check('fills the screen', await p.evaluate(() => {
  const r = document.getElementById('sheet-zoom').getBoundingClientRect();
  return Math.round(r.width) === window.innerWidth && Math.round(r.height) === window.innerHeight;
}), true);
check('showing the captured photo', await p.$eval('#sheet-zoom-img', (e) => e.getAttribute('src')), PIXEL);
// A pinch is awkward one-handed and this is a one-handed moment, so a tap on the
// paper is the other way to magnify.
await p.click('#sheet-zoom-img');
check('a tap magnifies', await p.$eval('#sheet-zoom', (e) => e.classList.contains('big')), true);
await p.click('#sheet-zoom-img');
check('and returns to fit', await p.$eval('#sheet-zoom', (e) => e.classList.contains('big')), false);
await p.keyboard.press('Escape');
check('Escape closes it', await shown('#sheet-zoom'), false);

await p.click('#counts-sheet');
await p.click('#sheet-zoom-x');
check('so does the close button', await shown('#sheet-zoom'), false);

console.log('\n=== a NEW report ===');
// The one genuinely dangerous state: typing this report's figures off the last
// report's photograph.
await p.evaluate(() => showSheetReference(null));
check('does not keep the previous sheet', await shown('#counts-sheet'), false);
check('and the viewer cannot still be open on it', await shown('#sheet-zoom'), false);

console.log('\n=== native carries the same affordance ===');
// No RN harness here, so this is a wiring check, not a rendering one: the
// component exists and the VOTES step is where it is used. Web and native
// solving this differently is the failure worth catching — the web fixed the
// race chooser first and native drifted for weeks.
const comp = fs.readFileSync(`${ROOT}/native/src/components/sheet-reference.tsx`, 'utf8');
const flow = fs.readFileSync(`${ROOT}/native/src/app/report/result.tsx`, 'utf8');
check('the component exists', comp.length > 0, true);
check('it can zoom', /Gesture\.Pinch\(\)/.test(comp) && /numberOfTaps\(2\)/.test(comp), true);
check('the report flow imports it', /import \{ SheetReference \}/.test(flow), true);
check(
  'and renders it on the VOTES step, from the captured sheet',
  /step === 'votes' \? \([\s\S]{0,2000}?<SheetReference uri=\{sheet\.uri\}/.test(flow),
  true,
);

check('no page errors', errs, []);

await b.close();
server.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nall passed');
process.exit(fail ? 1 : 0);

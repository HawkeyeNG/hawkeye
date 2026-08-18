// A modal whose text runs long must SCROLL, and its Close button must stay on
// screen. The docket's "How the docket works" ran to four paragraphs and was cut
// off mid-sentence with nothing to say there was more.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
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

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
// A SHORT viewport on purpose: this bug only exists when the text outruns the
// screen, and a desktop window hides it entirely.
const p = await b.newPage({ viewport: { width: 380, height: 560 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

/** Open an info dot carrying `text` and measure the dialog. */
const openWith = (text) => p.evaluate((t) => {
  document.querySelectorAll('dialog.info-modal').forEach((d) => d.close());
  const btn = document.createElement('button');
  btn.className = 'info-i';
  btn.setAttribute('data-info-title', 'How the docket works');
  btn.setAttribute('data-info', t);
  document.body.appendChild(btn);
  btn.click();
  const dlg = document.querySelector('dialog.info-modal[open]');
  const body = dlg.querySelector('.info-body');
  const close = dlg.querySelector('.gov-disc-close');
  const cr = close.getBoundingClientRect();
  return {
    dialogFitsViewport: dlg.getBoundingClientRect().bottom <= window.innerHeight + 1,
    bodyScrolls: body.scrollHeight > body.clientHeight + 1,
    closeVisible: cr.top >= 0 && cr.bottom <= window.innerHeight + 1,
    scrolledTo: (() => { body.scrollTop = body.scrollHeight; return body.scrollTop; })(),
    closeStillVisibleAfterScroll: (() => {
      const r = close.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight + 1;
    })(),
  };
}, text);

await p.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => typeof window.HAWKEYE_MODAL === 'function', { timeout: 10000 });

console.log('=== the real docket text, on a short screen ===');
const LONG = [
  'Why a disputed result is excluded — a unit is marked disputed while a serious flag on it is unresolved, or while its case is open, upheld, or timed out without quorum. Disputed means badged everywhere, barred from ever reading as verified, and left out of the headline tallies. That is why the count above can be higher than the number of cases below: a result is held back the moment it is flagged, and the case putting it to the crowd may only be opened once polls close.',
  'Who judges, and how — verified observers worldwide answer factual questions about evidence they can see, one verdict per person, published with the answers behind it. Nobody at Hawkeye votes, and no juror picks a side: a published rule computes each verdict from the answers.',
  'How a case resolves — a case needs a quorum and a supermajority inside a fixed window. Anything short of that closes unresolved — still disputed, still revisitable.',
].join('\n\n');
const long = await openWith(LONG);
check('the dialog fits the screen', long.dialogFitsViewport, true);
check('its body scrolls', long.bodyScrolls, true);
check('Close is visible before scrolling', long.closeVisible, true);
check('the body actually scrolled', long.scrolledTo, (n) => n > 0);
check('and Close is STILL visible at the bottom', long.closeStillVisibleAfterScroll, true);

console.log('\n=== a short one is unchanged ===');
const short = await openWith('A flag never decides anything.');
check('no scrollbar when it fits', short.bodyScrolls, false);
check('Close visible', short.closeVisible, true);
check('dialog fits', short.dialogFitsViewport, true);

console.log('\n=== the disclaimer dialog gets the same treatment ===');
const disc = await p.evaluate(() => {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  const more = document.querySelector('.gov-disc-more');
  if (!more) return { missing: true };
  more.click();
  const dlg = document.getElementById('gov-disc-modal');
  const body = dlg.querySelector('.info-body');
  const close = dlg.querySelector('.gov-disc-close');
  const r = close.getBoundingClientRect();
  return {
    hasBody: !!body,
    fits: dlg.getBoundingClientRect().bottom <= window.innerHeight + 1,
    closeVisible: r.top >= 0 && r.bottom <= window.innerHeight + 1,
    linksInsideBody: !!body && body.querySelectorAll('a[href*="inec"]').length,
  };
});
check('the disclaimer has a scrolling body', disc.missing ? 'no disclaimer bar on this page' : disc.hasBody, true);
check('it fits the screen', disc.fits, true);
check('Close is reachable', disc.closeVisible, true);
check('and the INEC links are inside the scroll area', disc.linksInsideBody, 2);

console.log('\n=== A CLOSED DIALOG MUST BE INVISIBLE ===');
// This is the check whose absence shipped the bug. `display: flex` was set on
// .gov-disc-modal unconditionally, which overrides the UA's display:none for a
// closed <dialog> — so it rendered inline at the foot of every page from first
// paint, and close() changed nothing on screen. Every assertion here was about
// the OPEN state, so all of them passed.
//
// Measured, not read off the property: `open === false` was TRUE the whole time
// the thing was on screen. Only geometry catches this.
{
  const before = await p.evaluate(() => {
    const seen = [];
    for (const d of document.querySelectorAll('dialog')) {
      seen.push({
        cls: d.className,
        open: d.open,
        rects: d.getClientRects().length,
        display: getComputedStyle(d).display,
      });
    }
    return seen;
  });
  for (const d of before) {
    check(`closed dialog "${d.cls || '(no class)'}" renders nothing`,
      { open: d.open, rects: d.rects }, (v) => v.open === true || v.rects === 0);
    check(`  and is not forced visible by a display rule`,
      d.open === true || d.display === 'none', true);
  }
  check('at least one dialog exists to check', before.length > 0, true);
}

// And the round trip: open it, close it, and prove it left the screen.
{
  const roundTrip = await p.evaluate(() => {
    const d = document.querySelector('dialog.gov-disc-modal') || document.querySelector('dialog');
    if (!d) return null;
    d.showModal();
    const openRects = d.getClientRects().length;
    const openDisplay = getComputedStyle(d).display;
    d.close();
    const closedRects = d.getClientRects().length;
    return { openRects, openDisplay, closedRects };
  });
  check('a dialog can be opened', roundTrip && roundTrip.openRects > 0, true);
  // The flex layout is what pins Close while the body scrolls — it must still
  // apply once open, or the fix would have traded one bug for another.
  check('and is still laid out as a flex column while open', roundTrip?.openDisplay, 'flex');
  check('and is GONE after close()', roundTrip?.closedRects, 0);
}

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

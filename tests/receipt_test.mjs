/**
 * THE OBSERVER'S COPY — what it says, and what it refuses to say.
 *
 * The card exists to be forwarded, so the thing that matters is not how it
 * looks but what it CLAIMS. A queued report has not reached the chain, so its
 * card must carry no hash and no verify link: one that showed a verify URL
 * before the entry existed would send the reader to a 404 and teach them the
 * receipt cannot be trusted.
 *
 * `lines()` is asserted directly rather than through pixels — that is why it is
 * a function and not a paint routine. The drawing is then exercised once, in a
 * real browser, to prove the canvas is not blank and the two states differ.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- lines(), loaded the way observe.html loads it -----------------------
const sandbox = { window: {}, document: { createElement: () => ({ getContext: () => ({}) }) } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('/home/elrio/hawkeye/app/receipt.js', 'utf8'), sandbox);
const R = sandbox.window.HAWKEYE_RECEIPT;
check('receipt.js exports lines()', typeof R?.lines, 'function');

const BASE = {
  puName: 'Ogbe-Udu Primary School, Ogbe-Udu',
  puCode: '10-18-03-001',
  ward: 'Udu III', lga: 'Udu', state: 'Delta',
  contest: 'State House of Assembly By-Election (Udu)',
  votes: [{ party: 'PDP', count: 120 }, { party: 'APC', count: 98 }, { party: 'LP', count: 0 }],
  at: Date.UTC(2026, 8, 19, 13, 32),
};

console.log('\n=== a recorded report ===');
{
  const L = R.lines({ ...BASE, entryHash: 'a'.repeat(64) });
  check('not pending', L.pending, false);
  check("titled as the reader's own copy", L.title, 'Your copy of this result');
  check('carries the unit and its code', [L.unit, L.code], [BASE.puName, BASE.puCode]);
  check('locates it', L.where, 'Udu III · Udu · Delta');
  check('carries the full hash', L.hash, 'a'.repeat(64));
  check('and a verify link to that entry', L.verify, 'hawkeye.com.ng/ledger.html#' + 'a'.repeat(64));
  check('says it is on the ledger', L.status, (t) => /Recorded on the public ledger/.test(t));
  // Zero-vote parties are dropped: a sheet lists every party, a receipt is
  // about what was counted, and printing a column of noughts buries the result.
  check('drops parties with no votes', L.votes.map((v) => v.party), ['APC', 'PDP']);
  check('sorted by party, not by score — it is not a ranking', L.votes.map((v) => v.party), ['APC', 'PDP']);
  check('totals what it shows', L.total, 218);
  check('stamps local time', L.when, (t) => /^Reported 19 Sept 2026, \d{2}:\d{2}$/.test(t));
  check('always disclaims', L.foot, (t) => /does not declare results/.test(t));
}

console.log('\n=== a report still queued on the phone ===');
{
  const L = R.lines({ ...BASE, entryHash: '' });
  check('pending', L.pending, true);
  check('titled as saved, not recorded', L.title, 'Saved on your phone');
  // THE ASSERTIONS THAT MATTER. No hash, and above all no verify link.
  check('carries NO hash', [L.hash, L.hashShort], ['', '']);
  check('carries NO verify link', L.verify, '');
  check('and says it is not on the ledger yet', L.status, (t) => /Not yet on the public ledger/.test(t));
  // CONTROL: it is still a real receipt — the work is not diminished.
  check('CONTROL still names the unit and tallies', [L.unit, L.total], [BASE.puName, 218]);
}

console.log('\n=== pending is derived from the hash, not passed in ===');
{
  // A caller cannot mark a card "verified" without an entry hash, because there
  // is no flag to set — the hash IS the claim.
  check('no hash at all', R.lines({ ...BASE }).pending, true);
  check('null hash', R.lines({ ...BASE, entryHash: null }).pending, true);
  check('a hash makes it real', R.lines({ ...BASE, entryHash: 'abc' }).pending, false);
  check('an empty report still renders', R.lines({}).unit, '');
}

// ---- and the canvas actually draws --------------------------------------
console.log('\n=== the card renders ===');
const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const f = path.join(APP, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(`${base}/receipt.js`);
await p.setContent(`<script src="${base}/receipt.js"></script>`);
await p.waitForFunction(() => !!window.HAWKEYE_RECEIPT);

const out = await p.evaluate(async (data) => {
  const R2 = window.HAWKEYE_RECEIPT;
  const shot = (d) => {
    const c = R2.render(d, null);
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // How much of the card is NOT the flat background: a render that silently
    // drew nothing is a full-size canvas of one colour.
    let ink = 0;
    for (let i = 0; i < px.length; i += 4 * 97) {
      if (px[i] > 60 || px[i + 1] > 90 || px[i + 2] > 60) ink++;
    }
    return { w: c.width, h: c.height, ink, url: c.toDataURL('image/png').slice(0, 20) };
  };
  return {
    done: shot({ ...data, entryHash: 'b'.repeat(64) }),
    queued: shot({ ...data, entryHash: '' }),
  };
}, BASE);

check("a portrait card, 1080 wide, cut to its content", [out.done.w, out.done.h > 900, out.done.h < 2200], [1080, true, true]);
check('it is a PNG', out.done.url, (u) => u.startsWith('data:image/png'));
check('something was actually drawn', out.done.ink, (n) => n > 20);
check('the queued card draws too', out.queued.ink, (n) => n > 20);
// The two states must not render identically — that would mean the hash block
// silently did nothing.
check('and the two states differ', out.done.ink === out.queued.ink, false);
check('no page errors', errs, []);

await b.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

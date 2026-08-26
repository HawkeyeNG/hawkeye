/**
 * A DECLARED RACE STOPS OFFERING TO BE FOLLOWED.
 *
 * The server drops the follow rows and refuses new ones (tests/declarations_test
 * .mjs covers that). This is the other half: the control has to stop being
 * offered, or a reader taps Follow on a finished race and gets a 409 for their
 * trouble.
 *
 * THE LEADERBOARD IS THE CASE THAT MATTERS, and it is not the obvious one. A
 * race page already hides its own CTAs once polling day has passed, so Osun's
 * page never showed a Follow button anyway. The leaderboard's picker lists every
 * contest in the CATALOGUE — and a by-election stays in the catalogue after it
 * is won — so the day after the Udu by-election that board would have gone on
 * offering alerts about reports that can no longer arrive.
 *
 * Every case here is run TWICE against the same page: once with the race
 * declared and once with nothing declared. A test that only asserts the button
 * disappears would pass just as well if the button never rendered at all.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

/**
 * What the board needs to reach the point where it paints a Follow button.
 * Copied in shape from the running backend, trimmed to the fields the page
 * reads — a fixture that invented a shape would be testing the fixture.
 */
const STATES = ['Kano', 'Osun'];
let DECLARATIONS = [];
const API = {
  '/api/contests': () => [{
    code: 'GOV', name: 'Governorship', election: '2027 Governorship Election',
    date: '2027-02-06', states: STATES, open: true, opensAt: null,
  }],
  '/api/declarations': () => DECLARATIONS,
  '/api/national/GOV': () => ({
    contest: 'GOV', level: 'state', scope: null, subunits: STATES,
    updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [],
  }),
  '/api/coverage/gaps': () => ({
    contest: 'GOV', scope: null, level: 'state', unit: 'state', unitPlural: 'states',
    statesTotal: STATES.length, statesReported: 0, missing: STATES,
  }),
};

const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  if (u.startsWith('/api/')) {
    const body = API[u] ? API[u]() : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  const f = u === '/download' ? path.join(APP, 'download.html')
    : path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/**
 * Open the GOV board at a scope and report the Follow button.
 *
 * BY DEEP LINK, not by driving the <select>. Choosing a region from the picker
 * CROPS the board, which reloads it and rebuilds the options — the page says so
 * where it does it — so a scripted selectOption is undone before the assertion
 * runs. ?scope= is also the entry that matters: every follow alert the backend
 * sends points at results.html?contest=…&scope=… .
 */
async function board(scope) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto(`${base}/results.html?contest=GOV${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`);
  await p.waitForSelector('#btn-follow', { timeout: 10000 });
  await p.waitForTimeout(700);
  const r = await p.evaluate(() => {
    const btn = document.getElementById('btn-follow');
    return {
      text: btn.textContent.trim(),
      hidden: btn.hidden,
      scope: document.getElementById('sel-scope').value,
      helper: typeof window.raceIsClosed,
    };
  });
  await p.close();
  return r;
}

console.log('=== nothing declared: the board offers to follow ===');
DECLARATIONS = [];
{
  const r = await board('');
  check('the shared helper is exposed for this page', r.helper, 'function');
  check('the button is shown', r.hidden, false);
  check('and says what it follows', r.text, '🔔 Follow all governorship races');
}
{
  const r = await board('Osun');
  check('a single state too', r.hidden, false);
  check('named by its region', r.text, '🔔 Follow Osun');
}

console.log('\n=== one state declared: that state alone stops being offered ===');
DECLARATIONS = [{ contest: 'GOV', scope: 'Osun', label: 'Osun Governorship (2026)' }];
{
  const r = await board('Osun');
  check('the declared state hides the button', r.hidden, true);
}
{
  // THE CONTROL, and the whole reason the scope rule exists: following every
  // governorship has not ended because one of them has been declared.
  const r = await board('');
  check('following the whole election is untouched', r.hidden, false);
  const k = await board('Kano');
  check('and so is another state', k.hidden, false);
}

console.log('\n=== the whole contest declared: a by-election, the day after ===');
DECLARATIONS = [{ contest: 'GOV', scope: '', label: 'Governorship' }];
{
  const all = await board('');
  const one = await board('Kano');
  check('an unscoped declaration closes every region', `${all.hidden} / ${one.hidden}`, 'true / true');
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

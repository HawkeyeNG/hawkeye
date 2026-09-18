/**
 * THE INVITE, ON THE PAGE AND IN THE LINK.
 *
 * The service test covers who gets attributed and who gets refused. This asks
 * the different question: does the code reach the reader, and does the link it
 * hands out route to the right store. A rule that is right in the database and
 * absent from the screen is the same as no rule at all.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };

const REFERRAL = { code: 'H7KMN3', signedUp: 3, qualified: 1 };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/observers/referral') return json(REFERRAL);
  if (url === '/api/observers/me') {
    return json({ observerId: 42, createdAt: Date.now(), identityHash: 'abc', hasPassword: true, reports: [], subscriptions: [], incidents: [], collation: [] });
  }
  if (url === '/api/contests') return json([]);
  if (url.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
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

/** /get, as a given phone sees it. */
async function landing(ua, qs = '?r=H7KMN3') {
  const ctx = await b.newContext(ua ? { userAgent: ua } : {});
  const p = await ctx.newPage();
  await p.goto(`${base}/invite.html${qs}`, { waitUntil: 'networkidle' });
  const out = await p.evaluate(() => ({
    code: document.getElementById('g-code').textContent,
    codeShown: !document.getElementById('g-codewrap').hidden,
    storeHref: document.getElementById('g-store').href,
    storeText: document.getElementById('g-store').textContent,
    webHref: document.getElementById('g-web').href,
    iosNote: !document.getElementById('g-ios-note').hidden,
    stored: localStorage.getItem('hawkeye_referral'),
  }));
  await ctx.close();
  return out;
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

console.log('=== /get routes each phone to its own store ===');
const a = await landing(ANDROID);
check('Android goes to Play', a.storeHref, (h) => h.startsWith('https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer'));
// The ONE platform where the code survives the store. If this ever drops off,
// every Android install silently loses its attribution.
check('Android carries the code through Play Install Referrer', a.storeHref, (h) => h.includes('referrer=H7KMN3'));
check('Android is not told to retype it', a.iosNote, false);

const i = await landing(IPHONE);
check('iPhone goes to the App Store', i.storeHref, 'https://apps.apple.com/app/id6804218478');
// Apple has no install referrer, so the code travels by eye and the page has to
// say so — silently dropping it would lose the referral with no sign.
check('iPhone is told to enter the code', i.iosNote, true);
check('iPhone link carries no referrer (Apple ignores it)', i.storeHref, (h) => !h.includes('referrer'));

const d = await landing(DESKTOP);
check('a laptop goes to /download', d.storeHref, (h) => h.endsWith('/download'));
check('a laptop is not told to retype a code', d.iosNote, false);

console.log('\n=== the code is caught, shown, and carried ===');
check('shown in readable characters', a.code, 'H7KMN3');
check('the code block is visible', a.codeShown, true);
check('parked for the signup request', a.stored, 'H7KMN3');
check('"continue on web" carries it too', a.webHref, (h) => h.includes('r=H7KMN3'));

console.log('\n=== a bad or absent code degrades quietly ===');
// CONTROL: with no code the page is still a working download page — an invite
// link is not a precondition for installing Hawkeye.
const none = await landing(ANDROID, '');
check('CONTROL no code: page still routes to a store', none.storeHref, (h) => h.includes('play.google.com'));
check('no code block is shown', none.codeShown, false);
check('and no referrer is appended', none.storeHref, (h) => !h.includes('referrer'));
const bad = await landing(ANDROID, '?r=oops!!');
check('a malformed code is not shown', bad.codeShown, false);
check('and is not stored', bad.stored, null);

console.log('\n=== the profile shows the link and both counts ===');
{
  /**
   * A TOKEN authgate.js WILL ACCEPT. It does not call the server — it base64
   * decodes the JWT payload and checks `exp` — so the fixture has to be a
   * well-formed three-part token with a future expiry. A bare string sends the
   * page to observe.html?intent=signin and the test then asserts against the
   * sign-in screen, which is how this was first written and why it failed
   * against markup that was perfectly correct.
   */
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = globalThis.jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';
  const ctx = await b.newContext();
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('hawkeye_token', t); } catch (e) { /* about:blank */ }
  }, jwt);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/profile.html`, { waitUntil: 'networkidle' });
  check('CONTROL the auth gate let us onto the profile', p.url(), (u) => /profile\.html/.test(u));
  await p.waitForFunction(() => document.getElementById('p-ref-code')?.textContent !== '…', null, { timeout: 8000 }).catch(() => {});
  const out = await p.evaluate(() => ({
    code: document.getElementById('p-ref-code').textContent,
    stat: document.getElementById('p-ref-stat').textContent,
  }));
  check('the code is on the profile', out.code, 'H7KMN3');
  // BOTH numbers, because only the second would ever be paid on and a payout
  // that arrives without the distinction having been visible reads as a switch.
  check('signed up is shown', out.stat, (t) => /3/.test(t) && /signed up/i.test(t));
  check('and observed is shown separately', out.stat, (t) => /1/.test(t) && /observed/i.test(t));
  check('no page errors', errs, []);
  await ctx.close();
}

/**
 * CLICKING THE ROW DOES SOMETHING. ALWAYS.
 *
 * The first version of this test checked that the code RENDERED and never
 * clicked it — and the row shipped doing nothing at all. navigator.share exists
 * on desktop Chrome, so it ran first and returned without changing the screen;
 * in a WebView or iframe it throws, the clipboard can be blocked the same way,
 * and Chrome suppresses prompt() in exactly those contexts, so the last resort
 * was silent too.
 *
 * Both environments are exercised, because "works when the clipboard works" is
 * the half that was never the problem.
 */
async function clickInvite({ clipboard }) {
  const ctx = await b.newContext(clipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {});
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('hawkeye_token', t); } catch (e) { /* about:blank */ }
  }, jwt);
  if (!clipboard) {
    // Every way the write can be refused, in one stub: no API at all is the
    // WebView case, a rejecting one is the blocked-permission case.
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: () => ({ writeText: () => Promise.reject(new Error('blocked')) }),
      });
    });
  }
  const p2 = await ctx.newPage();
  const dialogs = [];
  p2.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss(); });
  await p2.goto(`${base}/profile.html`, { waitUntil: 'networkidle' });
  await p2.waitForFunction(() => document.getElementById('p-ref-code')?.textContent !== '\u2026', null, { timeout: 8000 });
  await p2.click('#btn-ref-copy');
  await p2.waitForTimeout(400);
  const out = await p2.evaluate(() => {
    const box = document.getElementById('ref-reveal');
    return {
      label: document.getElementById('p-ref-code').textContent,
      revealed: !!box && !box.hidden,
      revealedValue: box ? box.value : null,
    };
  });
  out.dialogs = dialogs;
  await ctx.close();
  return out;
}

console.log('\n=== clicking the invite row ===');
{
  const ok = await clickInvite({ clipboard: true });
  check('with a clipboard, it says Copied', ok.label, (t) => /copied/i.test(t));
  check('and does not need the fallback', ok.revealed, false);

  const blocked = await clickInvite({ clipboard: false });
  // THE CASE THAT SHIPPED BROKEN. Something must appear on the page.
  check('with the clipboard blocked, the link is revealed', blocked.revealed, true);
  check('and it is the real invite link', blocked.revealedValue, (v) => /\/invite\.html\?r=H7KMN3$/.test(v || ''));
  check('and the row says where to look', blocked.label, (t) => /copy it below/i.test(t));
  // A dialog is NOT an acceptable answer here: the browsers that block the
  // clipboard are the same ones that suppress prompt().
  check('no dialog is relied on', blocked.dialogs, []);
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

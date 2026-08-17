// The Register tab in the admin console. Drives the real page against a real
// backend, so the button is proven before it is pointed at production — the
// endpoint it calls rewrites thousands of register rows.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const SECRET = 'test-passphrase';

// A stand-in for the endpoint that reports the same shape the real one does,
// including the state BEFORE and AFTER so the "did it reach the real count"
// wording is exercised rather than assumed.
let state = { senatorial: 116, federal: 393 };
const calls = [];
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/admin/register/normalize') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const given = req.headers['x-admin-secret'];
      if (given !== SECRET) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'bad_passphrase' }));
      }
      const apply = JSON.parse(body || '{}').apply === true;
      calls.push({ apply });
      const before = { ...state };
      if (apply) state = { senatorial: 109, federal: 362 };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, dryRun: !apply, changed: 4013,
        applied: new Array(114).fill({ col: 'senatorial', from: 'a', to: 'b', units: 1 }),
        before, after: apply ? state : before, real: { senatorial: 109, federal: 360 },
      }));
    });
    return;
  }
  if (url === '/api/admin/auth') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
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
const ctx = await b.newContext();
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('dialog', (d) => d.accept());   // the apply confirmation

// admin.html sits behind authgate.js, which bounces a signed-OUT visitor to the
// observer sign-in before the console is even in the DOM. So the page needs a
// fresh-looking observer token in localStorage as well as the console
// passphrase — two separate gates, and the test has to pass both.
const jwt = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
})();
await p.goto(`${base}/404.html`, { waitUntil: 'domcontentloaded' });
await p.evaluate(([s, t]) => {
  sessionStorage.setItem('hawkeye_admin', s);
  localStorage.setItem('hawkeye_token', t);
}, [SECRET, jwt]);
await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
// A stored passphrase unlocks the console on load, so the login form may already
// be gone. Sign in only when it is actually on screen.
if (await p.$eval('#login', (e) => !e.hidden).catch(() => false)) {
  await p.fill('#pass', SECRET);
  await p.click('#btn-login');
}
await p.waitForSelector('#console:not([hidden])', { timeout: 10000 });

console.log('=== the tab exists and is reachable ===');
await p.click('.tab[data-p="register"]');
check('the panel opens', await p.$eval('.panel[data-p="register"]', (e) => !e.hidden), true);
check('other panels close', await p.$eval('.panel[data-p="reach"]', (e) => e.hidden), true);

console.log('\n=== apply is locked until a dry run ===');
check('Apply starts disabled', await p.$eval('#reg-apply', (e) => e.disabled), true);
check('nothing has been called', calls, []);

console.log('\n=== dry run reports without writing ===');
await p.click('#reg-dry');
await p.waitForSelector('#reg-out .status', { timeout: 10000 });
check('it asked for a DRY run', calls, [{ apply: false }]);
check('and says nothing was written', await p.textContent('#reg-out'), (t) => /nothing was written/.test(t));
check('showing the seat counts', await p.textContent('#reg-out'), (t) => /116/.test(t) && /109/.test(t));
check('Apply is now unlocked', await p.$eval('#reg-apply', (e) => e.disabled), false);

console.log('\n=== apply writes, and reads back the real counts ===');
await p.click('#reg-apply');
await p.waitForFunction || null;
for (let i = 0; i < 40 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 250));
check('it asked to apply', calls, [{ apply: false }, { apply: true }]);
check('it confirms the senatorial target was hit', await p.textContent('#reg-out'),
  (t) => /Senatorial now matches the real count/.test(t));
check('and explains the federal gap rather than crying failure', await p.textContent('#reg-out'),
  (t) => /known register limitation/.test(t));
check('Apply re-locks', await p.$eval('#reg-apply', (e) => e.disabled), true);

console.log('\n=== a wrong passphrase says so ===');
await p.evaluate(() => sessionStorage.setItem('hawkeye_admin', 'wrong'));
await p.click('#reg-dry');
await p.waitForSelector('#reg-out .bad', { timeout: 10000 });
check('the error is shown, not swallowed', await p.textContent('#reg-out'), (t) => /bad_passphrase/.test(t));

check('no page errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exitCode = fail ? 1 : 0;

/**
 * The console's "Linked accounts" view (admin.html, Reach; backend
 * services/clusters.js) renders hostile values as TEXT.
 *
 * Headless Chromium against the real admin.html; /api/admin/linked-accounts is
 * answered by this file's fake server with markup and quote-breaking payloads
 * in every field the painter prints. CONTROL: the same page with plain values
 * renders them, so "nothing injected" is the escaping working, not an empty
 * panel.
 *
 *   node tests/linked_accounts_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const X = '<img src=x onerror="window.__pwned=1">';
const Q = "' onmouseover='window.__pwned=2' x='";
const S = '"><script>window.__pwned=3</script>';
let hostile = true;
const body = () => (hostile ? {
  rules: { nearDupStrongDhash: X, nearDupStrongFine: Q, nearDupReuseFine: S, linkMinOccasions: X, linkWindowMs: 600000, linkMaxM: Q, signalRetentionDays: S },
  counts: { clusters: X, linkedAccounts: Q, watching: S, photoMerged: X, photoReview: Q, photoReused: S },
  clusters: [{
    cluster: X, accounts: Q, reports: S, members: [X, Q, S],
    links: [
      { a: X, b: Q, kind: 'place', occasions: S, linked: true, firstAt: 1, lastAt: 2,
        evidence: [{ at: 1, puCodes: [X, S], contests: [Q], secondsApart: X, metresApart: Q, sameAddress: true, siblingApps: true }] },
      { a: S, b: X, kind: X, occasions: 1, linked: true, firstAt: 1, lastAt: 2,
        evidence: [{ at: 1, puCode: X, contest: S, slot: Q, d64: X, d256: S }] },
      { a: Q, b: S, kind: 'photo', occasions: 1, linked: true, firstAt: 1, lastAt: 2,
        evidence: [{ at: 1, puCode: Q, contest: X, slot: S, d64: Q, d256: X }] },
    ],
  }],
  watching: [{ a: X, b: S, kind: 'place', occasions: 1, linked: false, firstAt: 1, lastAt: 2, evidence: [X, null, { at: 'x', puCodes: 'not-an-array' }] }],
  photos: [{ report: X, other: Q, slot: S, verdict: X, sameRace: false, d64: Q, d256: S, at: 1, puCode: X, contest: Q }],
} : {
  rules: { nearDupStrongDhash: 4, nearDupStrongFine: 8, nearDupReuseFine: 16, linkMinOccasions: 2, linkWindowMs: 600000, linkMaxM: 15, signalRetentionDays: 90 },
  counts: { clusters: 1, linkedAccounts: 2, watching: 0, photoMerged: 1, photoReview: 0, photoReused: 0 },
  clusters: [{ cluster: 'acct-abc123', accounts: 2, reports: 3, members: ['acct-abc123', 'acct-def456'],
    links: [{ a: 'acct-abc123', b: 'acct-def456', kind: 'shared', occasions: 1, linked: true, firstAt: 1, lastAt: 2, evidence: [{ at: 1, puCode: '01-01-01-001', contest: 'PRES' }] }] }],
  watching: [],
  photos: [{ report: 7, other: 5, slot: 'sheet', verdict: 'merged', sameRace: true, d64: 1, d256: 2, at: 1, puCode: '01-01-01-001', contest: 'PRES' }],
});

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(u === '/api/admin/linked-accounts' ? body() : {}));
  }
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

async function open() {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('hawkeye_token', t);
      sessionStorage.setItem('hawkeye_admin', 'test');
      localStorage.setItem('hawkeye_admin', 'test');
    } catch (e) {}
  }, jwt);
  const p = await ctx.newPage();
  await p.goto(`${base}/admin.html?p=reach`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const w = document.getElementById('la-wrap');
    w.open = true;
    w.querySelectorAll('details').forEach((d) => { d.open = true; });
  });
  await p.waitForTimeout(500);
  await p.evaluate(() => document.querySelectorAll('#la-out details').forEach((d) => { d.open = true; }));
  const out = await p.evaluate(() => {
    const el = document.getElementById('la-out');
    el.querySelectorAll('*').forEach((n) => n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    return {
      pwned: window.__pwned || null,
      imgs: el.querySelectorAll('img').length,
      scripts: el.querySelectorAll('script').length,
      handlers: [...el.querySelectorAll('*')].filter((n) => [...n.attributes].some((a) => /^on/i.test(a.name))).length,
      text: el.textContent,
      codes: el.querySelectorAll('code').length,
      bold: [...el.querySelectorAll('b')].map((x) => x.textContent),
    };
  });
  await ctx.close();
  return out;
}

console.log('=== hostile values ===');
const h = await open();
check('no script ran (window.__pwned unset)', h.pwned, null);
check('no <img>, <script> or on* attribute came from the data', [h.imgs, h.scripts, h.handlers], [0, 0, 0]);
check('the markup is shown as TEXT', h.text, (t) => t.includes('<img src=x onerror=') && t.includes('<script>window.__pwned=3</script>') && t.includes("onmouseover='window.__pwned=2'"));
check('an unknown link kind is printed escaped, not as a label', h.bold, (bs) => bs.some((x) => x.includes('<img src=x')));
check('malformed evidence (a string, null, a non-array) does not break the view', h.text, (t) => t.includes('Watched, not linked yet') && t.includes('Photo matches'));

console.log('\n=== CONTROL: plain values render ===');
hostile = false;
const c = await open();
check('cluster, members and the link kind label are shown', c.text, (t) => t.includes('acct-abc123') && t.includes('acct-def456') && t.includes('Same iPhone (shared keychain id, both apps)'));
check('counts and rules are shown', c.text, (t) => t.includes('1 cluster(s)') && t.includes('fine ≤ 8') && t.includes('after 2 occasions within 10 min and 15 m'));
check('the photo match is listed', c.text, (t) => t.includes('merged') && t.includes('01-01-01-001 PRES'));
check('masked ids sit in <code>', c.codes, (n) => n >= 4);

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

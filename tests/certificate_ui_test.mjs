/**
 * The Hawkeye Observer certificate on the web — app/certificate.html and
 * app/verify-cert.html against a stub of /api/cert/*.
 *
 * What is proven, each with a control:
 *  - GATING in the page: not practised -> the practice step, never the quiz
 *    (control: practised -> the quiz); a server 403 at the end sends the reader
 *    back to the practice step;
 *  - A WRONG ANSWER CANNOT PASS: after a wrong pick there is no way forward
 *    (options locked, no Next) and nothing is sent; the explanation shows after
 *    every answer; the only issue request carries the full right key, and
 *    nothing but { answers, version };
 *  - THE NAME NEVER LEAVES: every request the page makes (URL, headers, body)
 *    is recorded and searched for the typed name, in both ways in (signed in;
 *    the native app's #fragment hand-off). Control: the same detector flags a
 *    request that does carry it. And the name IS used — the drawn certificate
 *    changes when it is typed;
 *  - THE FRAGMENT is wiped from the address bar, the name prefilled, the page
 *    in the app's language, and a bad code shows "not valid";
 *  - VERIFY PAGE: valid (with the date in words), unknown, malformed (no request
 *    at all), server error, and the form;
 *  - translated at PAINT time (Hausa on load, Yorùbá after a switch, control:
 *    English);
 *  - no page errors, no console errors.
 *
 *   node tests/certificate_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const B = Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(fs.readFileSync(`${APP}/i18n/${l}.json`, 'utf8'))]));
const KEY = JSON.parse(/QUIZ_ANSWERS = (\[[^\]]+\])/.exec(fs.readFileSync('/home/elrio/hawkeye/backend/src/services/certificates.js', 'utf8'))[1]);

const CODE = 'ABCD-EFGH';
const NAME = 'Zainab Qwertyuiop-Okafor';
const NAME2 = 'Chidi Asdfghjklz';
let mine = { certified: false, practised: true };
let issueMode = 'grade';        // grade | 403
const issued = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const authed = /^Bearer \S+/.test(req.headers.authorization || '');
  if (u.pathname === '/api/cert/mine') {
    if (!authed) return json({ error: 'missing_token' }, 401);
    return json(mine.certified
      ? { certified: true, code: CODE, issuedOn: '2026-12-12', verifyUrl: `https://hawkeye.com.ng/verify-cert?code=${CODE}`, practised: true }
      : { certified: false, code: null, issuedOn: null, verifyUrl: null, practised: mine.practised });
  }
  if (u.pathname === '/api/cert/issue' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = null; try { b = JSON.parse(body); } catch { /* bad */ }
      issued.push(b);
      if (!authed) return json({ error: 'missing_token' }, 401);
      if (issueMode === '403') return json({ error: 'no_practice' }, 403);
      if (JSON.stringify(b?.answers) !== JSON.stringify(KEY)) return json({ error: 'quiz_failed' }, 400);
      mine = { certified: true };
      return json({ ok: true, certified: true, code: CODE, certifiedAt: Date.now(), issuedOn: '2026-12-12', verifyUrl: `https://hawkeye.com.ng/verify-cert?code=${CODE}` });
    });
    return undefined;
  }
  if (u.pathname === '/api/cert/verify') {
    const c = String(u.searchParams.get('code') || '').toUpperCase().replace(/[^2-9A-HJKMNP-TV-Z]/g, '');
    if (c.length !== 8) return json({ valid: false, error: 'bad_code' }, 400);
    if (c === '55555555') return json({ error: 'boom' }, 500);
    if (c === CODE.replace('-', '')) return json({ valid: true, code: CODE, issuedAt: Date.parse('2026-12-12T10:00:00Z'), issuedOn: '2026-12-12' });
    return json({ valid: false, code: c.slice(0, 4) + '-' + c.slice(4) }, 404);
  }
  if (u.pathname.startsWith('/api/') || u.pathname === '/echo') return json([]);
  const f = path.join(APP, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const staticFails = [];
const TOKEN = 'x.' + Buffer.from(JSON.stringify({ sub: '7', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.y';

/** Every request a page makes that could leave the device (data:/blob: cannot). */
function recorder(pg) {
  const log = [];
  pg.on('request', (rq) => {
    if (/^(data|blob):/.test(rq.url())) return;
    log.push({ url: rq.url(), headers: rq.headers(), body: rq.postData() || '' });
  });
  return log;
}
/** Does any recorded request carry `name`, in any encoding a URL or body would use? */
const carries = (log, name) => {
  const forms = [name, encodeURIComponent(name), name.replace(/ /g, '+'), name.split(' ')[1]];
  return log.filter((r) => forms.some((f) => (r.url + JSON.stringify(r.headers) + r.body).includes(f))).map((r) => r.url);
};

async function open(page, { lang = 'en', signedIn = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript(([tok, l, s]) => {
    try {
      if (s) localStorage.setItem('hawkeye_token', tok); else localStorage.removeItem('hawkeye_token');
      localStorage.setItem('hawkeye_lang', l); localStorage.setItem('hawkeye_tour_done', '1');
    } catch (e) { /* ignore */ }
    // The phone's share sheet and the print dialog, recorded instead of opened.
    window.__shared = []; window.__printed = 0;
    navigator.canShare = () => true;
    navigator.share = (d) => { window.__shared.push({ text: d.text || '', files: (d.files || []).length }); return Promise.resolve(); };
    window.print = () => { window.__printed++; };
  }, [TOKEN, lang, signedIn]);
  const pg = await ctx.newPage();
  const log = recorder(pg);
  const errs = [];
  pg.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  // A page asset that fails is a bug; an API 404/500 the test asked for is not.
  pg.on('response', (rs) => { if (rs.status() >= 400 && !new URL(rs.url()).pathname.startsWith('/api/')) staticFails.push(rs.url()); });
  await pg.goto(base + '/' + page, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(300);
  return { pg, ctx, log, errs };
}
const visible = (pg, id) => pg.evaluate((i) => { const el = document.getElementById(i); return !!el && !el.hidden && el.getClientRects().length > 0; }, id);
const text = (pg, sel) => pg.evaluate((s) => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim(), sel);

/* ---------- 1. gating in the page ---------- */
let r = await open('certificate.html', { signedIn: false });
check('signed out: the sign-in step, no quiz', [await visible(r.pg, 'c-signin'), await visible(r.pg, 'c-quiz')], [true, false]);
check('signed out: /api/cert/mine not even asked', r.log.filter((x) => x.url.includes('/api/cert/')).length, 0);
await r.ctx.close();

mine = { certified: false, practised: false };
r = await open('certificate.html');
check('NOT PRACTISED: the practice step shows, the quiz does not', [await visible(r.pg, 'c-practice'), await visible(r.pg, 'c-quiz'), await text(r.pg, '#cq-question')], [true, false, '']);
check('NOT PRACTISED: the step links to the practice run', await r.pg.getAttribute('#c-practice a', 'href'), 'practice.html');
mine = { certified: false, practised: true };
await r.pg.click('#c-recheck');
await r.pg.waitForTimeout(300);
check('CONTROL: practised (after "check again") -> the quiz', [await visible(r.pg, 'c-practice'), await visible(r.pg, 'c-quiz')], [false, true]);
check('gating: no errors', r.errs, []);
await r.ctx.close();

/* ---------- 2. the quiz: explanation every time, a wrong answer cannot pass ---------- */
issued.length = 0;
r = await open('certificate.html');
let lockedAfterWrong = true;
let explainedAfterWrong = true;
let explainedAfterRight = true;
let sentEarly = false;
for (let q = 0; q < KEY.length; q++) {
  const wrongIdx = (KEY[q] + 1) % 3;
  await r.pg.click(`#cq-options button:nth-child(${wrongIdx + 1})`);
  const st = await r.pg.evaluate(() => ({
    enabled: [...document.querySelectorAll('#cq-options button')].filter((b) => !b.disabled).length,
    next: !document.getElementById('cq-next').hidden,
    why: document.getElementById('cq-why').textContent.trim().length,
    fb: !document.getElementById('cq-feedback').hidden,
  }));
  if (st.enabled !== 0 || st.next) lockedAfterWrong = false;
  if (!st.fb || st.why < 20) explainedAfterWrong = false;
  if (issued.length) sentEarly = true;
  await r.pg.click('#cq-retry');
  await r.pg.click(`#cq-options button:nth-child(${KEY[q] + 1})`);
  const ok = await r.pg.evaluate(() => ({ next: !document.getElementById('cq-next').hidden, fb: document.getElementById('cq-feedback').className, why: document.getElementById('cq-why').textContent.trim().length }));
  if (!ok.next || !/ok/.test(ok.fb) || ok.why < 20) explainedAfterRight = false;
  if (q < KEY.length - 1) { await r.pg.click('#cq-next'); if (issued.length) sentEarly = true; }
}
check('WRONG ANSWER: options lock and there is no Next — no way forward', lockedAfterWrong, true);
check('the explanation shows after every wrong answer', explainedAfterWrong, true);
check('the explanation shows after every right answer, with Next', explainedAfterRight, true);
check('nothing is sent before all 7 are right', sentEarly, false);
check('the last button is "Get my certificate"', await text(r.pg, '#cq-next'), 'Get my certificate');
await r.pg.click('#cq-next');
await r.pg.waitForSelector('#c-done:not([hidden])', { timeout: 5000 }).catch(() => {});
check('ONE issue request, carrying the full right key', [issued.length, issued[0]?.answers], [1, KEY]);
check('the issue body is { answers, version } and nothing else', Object.keys(issued[0] || {}).sort(), ['answers', 'version']);
check('the certificate shows', await visible(r.pg, 'c-done'), true);
check('its code and public check link', [await text(r.pg, '#cert-code'), await r.pg.getAttribute('#cert-link', 'href')], [CODE, `https://hawkeye.com.ng/verify-cert?code=${CODE}`]);

/* ---------- 3. the name stays on the device ---------- */
const before = await r.pg.getAttribute('#cert-img', 'src');
await r.pg.fill('#cert-name', NAME);
await r.pg.waitForTimeout(500);
const after = await r.pg.getAttribute('#cert-img', 'src');
check('the name IS used: the drawn certificate changes when it is typed', [before?.startsWith('data:image/png'), after?.startsWith('data:image/png'), before !== after], [true, true, true]);
check('...and is kept on this device', await r.pg.evaluate(() => localStorage.getItem('hawkeye_cert_name')), NAME);
await r.pg.click('#cert-share');
await r.pg.waitForTimeout(300);
const shared = await r.pg.evaluate(() => window.__shared);
check('Share: the image (one file) and the link text go to the phone\'s share sheet', [shared.length, shared[0]?.files, /verify-cert\?code=ABCD-EFGH/.test(shared[0]?.text || '')], [1, 1, true]);
check('Share: the text itself carries no name', (shared[0]?.text || '').includes('Qwertyuiop'), false);
const dl = r.pg.waitForEvent('download', { timeout: 5000 }).catch(() => null);
await r.pg.click('#cert-save');
const d = await dl;
check('Save: a PNG download, made on the device', d ? d.suggestedFilename() : null, 'hawkeye-observer-certificate.png');
await r.pg.click('#cert-print');
await r.pg.waitForTimeout(200);
check('Print: the print dialog opens', await r.pg.evaluate(() => window.__printed), 1);
await r.pg.reload({ waitUntil: 'networkidle' });
await r.pg.waitForTimeout(300);
check('after a reload the certificate returns (mine) with the name from this device', await r.pg.inputValue('#cert-name'), NAME);
check('NAME NEVER SENT: no request (URL, headers, body) carries it — signed-in path', carries(r.log, NAME), []);
check('...and the page did make requests (the recorder is live)', r.log.filter((x) => x.url.includes('/api/cert/')).length, (n) => n >= 3);
await r.pg.evaluate((n) => fetch('/echo?who=' + encodeURIComponent(n)), NAME);
await r.pg.waitForTimeout(200);
check('CONTROL: the same detector flags a request that DOES carry the name', carries(r.log, NAME).length, 1);
check('quiz + certificate: no errors', r.errs, []);
await r.ctx.close();

/* ---------- 4. the native hand-off: #fragment ---------- */
mine = { certified: true };
r = await open(`certificate.html#code=${CODE}&name=${encodeURIComponent(NAME2)}&lang=ha`, { signedIn: false });
await r.pg.waitForSelector('#c-done:not([hidden])', { timeout: 5000 }).catch(() => {});
check('FRAGMENT: the certificate shows, signed out', await visible(r.pg, 'c-done'), true);
check('FRAGMENT: wiped from the address bar', await r.pg.evaluate(() => location.hash), '');
check('FRAGMENT: the name is prefilled', await r.pg.inputValue('#cert-name'), NAME2);
check('FRAGMENT: checked against the PUBLIC verify endpoint, without credentials',
  r.log.filter((x) => x.url.includes('/api/cert/')).map((x) => [new URL(x.url).pathname + new URL(x.url).search, !!x.headers.authorization]),
  [['/api/cert/verify?code=ABCD-EFGH', false]]);
await r.pg.waitForFunction((t) => document.querySelector('#c-done h2')?.textContent === t, B.ha['cert.done-h'], { timeout: 5000 }).catch(() => {});
check('FRAGMENT: in the app\'s language (Hausa)', await text(r.pg, '#c-done h2'), B.ha['cert.done-h']);
check('NAME NEVER SENT: no request carries it — fragment path', carries(r.log, NAME2), []);
check('fragment: no errors', r.errs, []);
await r.ctx.close();
r = await open('certificate.html#code=2345-6789&name=X', { signedIn: false });
check('FRAGMENT with an unknown code: "not valid", no certificate', [await visible(r.pg, 'c-invalid'), await visible(r.pg, 'c-done')], [true, false]);
await r.ctx.close();

/* ---------- 5. a 403 at the end sends the reader to the practice step ---------- */
mine = { certified: false, practised: true };
issueMode = '403';
r = await open('certificate.html');
for (let q = 0; q < KEY.length; q++) {
  await r.pg.click(`#cq-options button:nth-child(${KEY[q] + 1})`);
  await r.pg.click('#cq-next');
}
await r.pg.waitForTimeout(400);
check('server says no_practice (403) -> the practice step, no certificate', [await visible(r.pg, 'c-practice'), await visible(r.pg, 'c-done')], [true, false]);
await r.ctx.close();
issueMode = 'grade';

/* ---------- 6. the verify page ---------- */
r = await open(`verify-cert.html?code=abcd-efgh`, { signedIn: false });
await r.pg.waitForSelector('#vc-valid:not([hidden])', { timeout: 5000 }).catch(() => {});
check('VERIFY valid: shown, with the code and the date in words', [await visible(r.pg, 'vc-valid'), await text(r.pg, '#vc-valid-body')],
  [true, 'Hawkeye Observer certificate ABCD-EFGH, issued on 12 December 2026.']);
check('VERIFY: says nothing about who (no name field exists)', await r.pg.evaluate(() => /Qwertyuiop|Asdfghjklz/.test(document.body.innerText)), false);
await r.pg.fill('#vc-code', '2345-6789');
await r.pg.click('#vc-go');
await r.pg.waitForTimeout(400);
check('VERIFY unknown code (via the form): "not valid", the valid box gone', [await visible(r.pg, 'vc-invalid'), await visible(r.pg, 'vc-valid')], [true, false]);
check('the form puts the code in the address bar, so the result is a link', await r.pg.evaluate(() => location.search), '?code=2345-6789');
const nBefore = r.log.filter((x) => x.url.includes('/api/cert/verify')).length;
await r.pg.fill('#vc-code', 'XYZ');
await r.pg.click('#vc-go');
await r.pg.waitForTimeout(300);
check('VERIFY malformed code: "not valid" without asking the server', [await visible(r.pg, 'vc-invalid'), r.log.filter((x) => x.url.includes('/api/cert/verify')).length - nBefore], [true, 0]);
await r.pg.fill('#vc-code', '5555-5555');
await r.pg.click('#vc-go');
await r.pg.waitForTimeout(400);
check('VERIFY server error: says it could not check — never "not valid"', [await visible(r.pg, 'vc-error'), await visible(r.pg, 'vc-invalid')], [true, false]);
check('verify: no page errors (the asked-for API 404/500 aside)', r.errs.filter((e) => !/status of (404|500)/.test(e)), []);
await r.ctx.close();
r = await open(`verify-cert.html?code=ABCD-EFGH`, { signedIn: false, lang: 'yo' });
await r.pg.waitForFunction((t) => document.querySelector('#vc-valid h2')?.textContent === t, B.yo['cert.verify-valid-h'], { timeout: 5000 }).catch(() => {});
check('VERIFY in Yorùbá: heading and the month name', [await text(r.pg, '#vc-valid h2'), (await text(r.pg, '#vc-valid-body')).includes(B.yo['practiceday.months'].split(',')[11])], [B.yo['cert.verify-valid-h'], true]);
await r.ctx.close();

/* ---------- 7. translated at paint time ---------- */
mine = { certified: false, practised: true };
r = await open('certificate.html', { lang: 'ha' });
await r.pg.waitForFunction((t) => document.getElementById('cq-question').textContent === t, B.ha['cert.q1'], { timeout: 5000 }).catch(() => {});
check('Hausa on load: question, options, progress', [await text(r.pg, '#cq-question'), await text(r.pg, '#cq-options button:nth-child(2)'), await text(r.pg, '#cq-progress')],
  [B.ha['cert.q1'], B.ha['cert.q1-b'], B.ha['cert.progress'].replace('{n}', '1').replace('{total}', '7')]);
await r.pg.click(`#cq-options button:nth-child(${KEY[0] + 1})`);
await r.pg.evaluate(() => window.HawkeyeI18n.set('yo'));
await r.pg.waitForFunction((t) => document.getElementById('cq-question').textContent === t, B.yo['cert.q1'], { timeout: 5000 }).catch(() => {});
check('Yorùbá after a switch, no reload: question, explanation, button', [await text(r.pg, '#cq-question'), await text(r.pg, '#cq-why'), await text(r.pg, '#cq-next')],
  [B.yo['cert.q1'], B.yo['cert.q1-why'], B.yo['cert.next']]);
check('i18n: no errors', r.errs, []);
await r.ctx.close();
r = await open('certificate.html', { lang: 'en' });
check('CONTROL English run shows English', await text(r.pg, '#cq-question'), 'When do you photograph the result sheet (EC8A)?');
await r.ctx.close();

/* ---------- 8. the ways in ---------- */
const practiceHtml = fs.readFileSync(`${APP}/practice.html`, 'utf8');
const profileHtml = fs.readFileSync(`${APP}/profile.html`, 'utf8');
check('reached from the practice completion screen', /<section id="done"[\s\S]*href="certificate\.html"[\s\S]*<\/section>/.test(practiceHtml), true);
check('reached from Profile', profileHtml.includes('href="certificate.html"'), true);
const sw = fs.readFileSync(`${APP}/sw.js`, 'utf8');
check('both new pages are in the SW LAZY list', ['/certificate.html', '/certificate.js', '/verify-cert.html'].every((p) => new RegExp(`const LAZY = \\[[^\\]]*'${p.replace('.', '\\.')}'`).test(sw)), true);

check('no page asset failed to load, on any page, in any run', staticFails, []);

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

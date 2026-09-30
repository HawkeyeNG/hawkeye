/**
 * ONE DEVICE AT A TIME (D3), SIGN-UP CHANNEL ORDER (D2) AND ORGANISATION CODES
 * (D4) — on the clients. The server side is backend/tests/one_device_test.mjs
 * and org_codes_test.mjs; this asks what the READER sees and what the phone
 * keeps.
 *
 *   1. Channel order: Telegram, WhatsApp, SMS — web markup and native chips.
 *   2. The web outbox, flushed against a 401 signed_in_elsewhere: the signed
 *      report is KEPT (shipped app/outbox.js in a sandbox). Native: the same
 *      rule, read from outbox.ts, and the auth.ts funnel that explains it.
 *   3. In a browser: a displaced session is sent to sign-in with the message;
 *      /resume's signedInElsewhere shows it with the queued-report count; the
 *      organisation-code field is always there on sign-up, skips the OTP, and
 *      is absent on sign-in.
 *
 * Every positive has a CONTROL that shows the same harness seeing the opposite.
 *
 *   node tests/one_device_ui_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
const H = '/home/elrio/hawkeye';
const APP = `${H}/app`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

/* ---------------------------------------------------------------- 1. order */
console.log('=== D2: Telegram first, WhatsApp second, SMS last ===');
const observeHtml = fs.readFileSync(`${APP}/observe.html`, 'utf8');
const webOrder = (html) => [...html.matchAll(/name="otp-channel" value="(\w+)"/g)].map((m) => m[1]);
check('web sign-up/sign-in radios', webOrder(observeHtml), ['telegram', 'whatsapp', 'sms']);
check('CONTROL the reader sees a swapped order', webOrder(observeHtml.replace('value="telegram"', 'value="TMP"').replace('value="whatsapp"', 'value="telegram"').replace('value="TMP"', 'value="whatsapp"')),
  (o) => JSON.stringify(o) !== JSON.stringify(['telegram', 'whatsapp', 'sms']));
const signIn = fs.readFileSync(`${H}/native/src/app/sign-in.tsx`, 'utf8');
const nativeOrder = (src) => {
  const block = src.match(/const CHANNELS[^=]*=\s*\[([\s\S]*?)\];/);
  return block ? [...block[1].matchAll(/key: '(\w+)'/g)].map((m) => m[1]) : null;
};
check('native sign-in chips', nativeOrder(signIn), ['telegram', 'whatsapp', 'sms']);
check('CONTROL the pre-change native order is caught',
  nativeOrder("const CHANNELS: X = [\n { key: 'whatsapp', label: 'WhatsApp' },\n { key: 'telegram', label: 'Telegram' },\n ...(smsOk ? [{ key: 'sms' as Channel, label: 'SMS' }] : []),\n];"),
  ['whatsapp', 'telegram', 'sms']);

/* ------------------------------------------------------- 2. outbox on 401 */
console.log('\n=== the web outbox keeps a signed report on 401 signed_in_elsewhere ===');
function fakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  return {
    open(name) {
      const req = {};
      later(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name);
        const db = {
          createObjectStore(store, opts = {}) { stores.set(store, { keyPath: opts.keyPath, next: 1, data: new Map() }); },
          close() {},
          transaction(store) {
            const s = stores.get(store);
            const ops = [];
            const t = {
              objectStore() {
                const op = (fn) => { const r = {}; ops.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
                return {
                  add: (v) => op(() => { const c = structuredClone(v); const id = s.next++; if (s.keyPath) c[s.keyPath] = id; s.data.set(id, c); return id; }),
                  put: (v, k) => op(() => { s.data.set(k ?? v[s.keyPath], structuredClone(v)); return k; }),
                  get: (k) => op(() => structuredClone(s.data.get(k))),
                  delete: (k) => op(() => { s.data.delete(k); }),
                  getAll: () => op(() => [...s.data.values()].map((v) => structuredClone(v))),
                };
              },
            };
            later(() => { for (const f of ops) f(); t.oncomplete?.(); });
            return t;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}
function loadOutbox(respond) {
  const posts = [];
  const G = { navigator: { onLine: true }, addEventListener() {}, dispatchEvent() {} };
  const sandbox = {
    self: G, indexedDB: fakeIndexedDB(),
    fetch: async (url, init) => { posts.push(url); return respond(); },
    FormData, Blob, Response, Headers, CustomEvent: class { constructor(t, d) { this.type = t; this.detail = d?.detail; } },
    setTimeout, clearTimeout, setInterval, console, structuredClone,
  };
  vm.runInNewContext(fs.readFileSync(`${APP}/outbox.js`, 'utf8'), sandbox);
  return { O: G.HawkeyeOutbox, posts, sandbox };
}
async function seed(o) {
  await new Promise((r) => {
    const req = o.sandbox.indexedDB.open('hawkeye-outbox-meta');
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => { const t = req.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('tok', 'token'); t.oncomplete = r; };
  });
  await o.O.queue({ fields: { puCode: '01-01-01-001', contest: 'PRES', votes: '[]' }, sheet: new Blob(['s']), venue: new Blob(['v']) });
}
const jsonRes = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
{
  const o = loadOutbox(jsonRes(401, { error: 'signed_in_elsewhere' }));
  await seed(o);
  const r = await o.O.flush();
  check('401 signed_in_elsewhere: one attempt, report KEPT, nothing dropped', [o.posts.length, await o.O.count(), r.dropped], [1, 1, 0]);
  const again = await o.O.flush();
  check('…and it is still there after another flush (it waits for a sign-in)', [await o.O.count(), again.dropped], [1, 0]);
}
{
  const o = loadOutbox(jsonRes(400, { error: 'invalid_votes' }));
  await seed(o);
  const r = await o.O.flush();
  check('CONTROL a 400 IS dropped by the same harness (so "kept" means something)', [await o.O.count(), r.dropped], [0, 1]);
}
{
  const o = loadOutbox(jsonRes(201, {}));
  await seed(o);
  const r = await o.O.flush();
  check('CONTROL a 201 is sent and leaves the queue', [await o.O.count(), r.sent], [0, 1]);
}

console.log('\n=== native: the outbox defers a 401, and auth.ts explains it ===');
const outboxTs = fs.readFileSync(`${H}/native/src/lib/outbox.ts`, 'utf8');
const branch401 = outboxTs.match(/\} else if \(res\.status === 401\) \{([\s\S]*?)\}/);
check('outbox.ts: a 401 after the re-mint defers the job (never retire)', branch401 && /defer\(job/.test(branch401[1]) && !/retire\(/.test(branch401[1]), true);
const authTs = fs.readFileSync(`${H}/native/src/lib/auth.ts`, 'utf8');
const resumeHandled = (src) => (src.match(/if \(r\.signedInElsewhere\)/g) || []).length;
check('auth.ts: renewSession AND bootstrapAuth read /resume\'s signedInElsewhere', resumeHandled(authTs), 2);
check('CONTROL the count drops if one is removed', resumeHandled(authTs.replace('if (r.signedInElsewhere)', 'if (false)')), 1);
check('auth.ts: authedGet ends the session only if the refused token is still current',
  /if \(b\?\.error === 'signed_in_elsewhere'\) \{\s*if \(state\.token === sentToken\)/.test(authTs), true);
check('the note is on welcome and sign-in',
  ['welcome.tsx', 'sign-in.tsx'].map((f) => fs.readFileSync(`${H}/native/src/app/${f}`, 'utf8').includes('<SignedOutElsewhereNote')), [true, true]);
const appJs = fs.readFileSync(`${APP}/app.js`, 'utf8');
check('web submit: a 401 that survives resume parks the report', /const kept = await park\(elsewhere/.test(appJs), true);

/* ---------------------------------------------------------- 3. in a browser */
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
let api = {};        // path -> (req, body) => [status, json]
const calls = [];
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      let body = null;
      try { body = data ? JSON.parse(data) : null; } catch { body = null; }
      calls.push({ url, method: req.method, body, auth: req.headers.authorization || '', admin: req.headers['x-admin-secret'] || '', cls: req.headers['x-device-class'] || '' });
      const h = api[url];
      const [status, out] = h ? h(req, body) : [200, {}];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const liveToken = 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.x';
const ELSEWHERE = [401, { error: 'signed_in_elsewhere', hint: 'x' }];
const ME = [200, { ok: true, observerId: 42, createdAt: Date.now(), identityHash: 'abc', hasPassword: true, reports: [], subscriptions: [], incidents: [], collation: [], mappings: [] }];

async function page({ token, url }) {
  const ctx = await b.newContext();
  if (token) await ctx.addInitScript((t) => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('hawkeye_token', t); sessionStorage.setItem('seeded', '1'); } } catch (e) { /* about:blank */ } }, token);
  const p = await ctx.newPage();
  await p.goto(base + url, { waitUntil: 'domcontentloaded' });
  return { ctx, p };
}
const noteOf = (p) => p.evaluate(() => {
  const el = document.getElementById('elsewhere-note');
  return el ? { shown: !el.hidden, text: el.textContent } : null;
});

try {
  console.log('\n=== a displaced session is sent to sign-in, with the reason ===');
  {
    api = { '/api/observers/me': () => ELSEWHERE };
    const { ctx, p } = await page({ token: liveToken, url: '/profile.html' });
    await p.waitForURL(/observe\.html/, { timeout: 15000 }).catch(() => {});
    check('profile.html → observe.html?intent=signin&next=profile.html', new URL(p.url()).pathname + new URL(p.url()).search,
      '/observe.html?intent=signin&next=profile.html');
    await p.waitForFunction(() => { const e = document.getElementById('elsewhere-note'); return e && !e.hidden; }, null, { timeout: 10000 }).catch(() => {});
    const n = await noteOf(p);
    check('the sign-in pane says why', n, (v) => v && v.shown && /signed in on another device/.test(v.text));
    check('the dead token is gone', await p.evaluate(() => localStorage.getItem('hawkeye_token')), null);
    await ctx.close();
  }
  {
    api = { '/api/observers/me': () => ME };
    const { ctx, p } = await page({ token: liveToken, url: '/profile.html' });
    await p.waitForTimeout(1500);
    check('CONTROL a live session stays on profile.html', new URL(p.url()).pathname, '/profile.html');
    await ctx.close();
  }
  {
    api = { '/api/observers/me': () => [401, { error: 'invalid_token' }] };
    const { ctx, p } = await page({ token: liveToken, url: '/profile.html' });
    await p.waitForTimeout(1500);
    const flag = await p.evaluate(() => localStorage.getItem('hawkeye_signed_out_elsewhere'));
    check('CONTROL any other 401 does not claim "another device"', [new URL(p.url()).pathname, flag], ['/profile.html', null]);
    await ctx.close();
  }

  console.log('\n=== /resume says signedInElsewhere: the note counts what is waiting ===');
  {
    api = { '/api/observers/resume': () => [200, { ok: false, recognized: false, signedInElsewhere: true }] };
    const { ctx, p } = await page({ url: '/observe.html?intent=signin' });
    await p.waitForFunction(() => !!window.HawkeyeOutbox, null, { timeout: 10000 });
    await p.evaluate(() => window.HawkeyeOutbox.queue({ fields: { puCode: '01-01-01-001', contest: 'PRES', votes: '[]' }, sheet: new Blob(['s']), venue: new Blob(['v']) }));
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => { const e = document.getElementById('elsewhere-note'); return e && !e.hidden && /: 1\./.test(e.textContent); }, null, { timeout: 10000 }).catch(() => {});
    const n = await noteOf(p);
    check('shown from /resume alone', n && n.shown, true);
    check('…with the queued report counted', n && n.text, (t) => /Signed reports waiting on this phone: 1\. Sign in again here to send them\./.test(t));
    await ctx.close();
  }
  {
    api = {};
    const { ctx, p } = await page({ url: '/observe.html?intent=signin' });
    await p.waitForTimeout(1500);
    check('CONTROL an unknown device gets no note', (await noteOf(p)).shown, false);
    await ctx.close();
  }

  console.log('\n=== ONE code field: invite or organisation, told apart by format ===');
  const kindLine = (p) => p.evaluate(() => ({
    hint: !document.getElementById('ref-hint').hidden,
    invite: !document.getElementById('ref-kind-invite').hidden,
    org: !document.getElementById('ref-kind-org').hidden,
    picker: !document.getElementById('channel-pick').hidden,
    button: document.getElementById('btn-auth').textContent.trim(),
  }));
  {
    api = {
      '/api/observers/org-signup': () => [200, { ok: true, observerId: 77, token: liveToken, isNew: true, needsUnit: true, hasPassword: false }],
      '/api/observers/set-password': () => [200, { ok: true }],
    };
    calls.length = 0;
    const { ctx, p } = await page({ url: '/observe.html?intent=observe' });
    await p.waitForSelector('#ref-opt', { state: 'attached' });
    await p.waitForTimeout(800);
    const vis = await p.evaluate(() => ({
      fields: [...document.querySelectorAll('#screen-register input[type="text"]')].filter((i) => !i.closest('[hidden]')).map((i) => i.id),
      label: document.querySelector('label[for="ref-input"]').textContent.trim(),
    }));
    check('sign-up shows ONE optional code field', vis, { fields: ['ref-input'], label: 'Invite or organisation code (optional)' });
    check('empty: the hint, the channel picker, "Request OTP"', await kindLine(p), { hint: true, invite: false, org: false, picker: true, button: 'Request OTP' });
    await p.fill('#ref-input', 'h7k-mn3');
    check('a six-character code reads as an invite; the OTP path stays', await kindLine(p), { hint: false, invite: true, org: false, picker: true, button: 'Request OTP' });
    await p.fill('#ref-input', 'org-ab');
    check('the ORG prefix switches to the organisation path at once (no flip mid-typing)', await kindLine(p), (v) => !v.invite && !v.org && !v.picker && v.button === 'Create account');
    await p.fill('#auth-input', '08031234567');
    await p.fill('#pw-opt-input', 'a good password');
    await p.fill('#ref-input', 'org abcd efgh jkmn');
    check('a whole ORG- code is named as one', await kindLine(p), { hint: false, invite: false, org: true, picker: false, button: 'Create account' });
    // The confirmation is Hawkeye's own dialog (app/dialog.js), not window.confirm.
    await p.click('#btn-auth');
    await p.waitForSelector('.hk-dlg .hk-dlg-ok', { timeout: 8000 }).catch(() => {});
    const confirmText = await p.$eval('.hk-dlg .hk-dlg-msg', (e) => e.textContent).catch(() => '');
    check('the confirmation names the answers, not OK/Cancel',
      await p.$$eval('.hk-dlg button', (bs) => bs.map((b) => b.textContent)).catch(() => []), ['Change number', 'Yes, create my account']);
    await p.click('.hk-dlg .hk-dlg-ok').catch(() => {});
    await p.waitForURL(/choose-unit\.html\?onboard=1/, { timeout: 15000 }).catch(() => {});
    check('the number is confirmed before the code is spent', confirmText, (t) => t.includes('08031234567') && /tied to/.test(t));
    const org = calls.find((c) => c.url === '/api/observers/org-signup');
    check('org-signup carries the normalised ORG- code and the number, and no referral', org && [org.body.orgCode, org.body.phone, !!org.body.publicKeyJwk, 'referralCode' in org.body],
      ['ORG-ABCD-EFGH-JKMN', '08031234567', true, false]);
    check('NO OTP was requested', calls.filter((c) => c.url === '/api/observers/register').length, 0);
    check('the password was set with the new token', calls.some((c) => c.url === '/api/observers/set-password' && c.auth === 'Bearer ' + liveToken), true);
    check('a new account goes on to choose its unit', new URL(p.url()).pathname, '/choose-unit.html');
    await ctx.close();
  }
  {
    api = { '/api/observers/register': () => [200, { ok: true, viaTelegram: true }] };
    calls.length = 0;
    const { ctx, p } = await page({ url: '/observe.html?intent=observe' });
    await p.waitForSelector('#ref-opt', { state: 'attached' });
    await p.waitForTimeout(800);
    await p.fill('#auth-input', '08031234567');
    await p.fill('#ref-input', 'ABCDEO');
    await p.check('input[name="otp-channel"][value="telegram"]');
    await p.click('#btn-auth');
    await p.waitForTimeout(800);
    check('neither kind: the error shows and nothing is sent', [await p.evaluate(() => !document.getElementById('ref-err').hidden), calls.filter((c) => /register|org-signup/.test(c.url)).length], [true, 0]);
    await p.fill('#ref-input', 'ORG-ABCD');
    await p.fill('#ref-input', '');
    check('CONTROL clearing the field brings the picker back', await p.evaluate(() => !document.getElementById('channel-pick').hidden), true);
    await p.check('input[name="otp-channel"][value="telegram"]');
    await p.click('#btn-auth');
    await p.waitForTimeout(1000);
    check('CONTROL with no code the OTP path runs', [calls.filter((c) => c.url === '/api/observers/register').length, calls.filter((c) => c.url === '/api/observers/org-signup').length], [1, 0]);
    await ctx.close();
  }
  {
    api = { '/api/observers/org-signup': () => [409, { error: 'org_code_number_taken' }] };
    const { ctx, p } = await page({ url: '/observe.html?intent=observe' });
    await p.waitForSelector('#ref-opt', { state: 'attached' });
    await p.waitForTimeout(800);
    await p.fill('#auth-input', '08031234567');
    await p.fill('#pw-opt-input', 'a good password');
    await p.fill('#ref-input', 'ORG-ABCD-EFGH-JKMN');
    // Two in-page dialogs in turn: the number confirmation, then the refusal.
    const msgs = [];
    await p.click('#btn-auth');
    for (let i = 0; i < 2; i++) {
      await p.waitForSelector('.hk-dlg .hk-dlg-ok', { timeout: 8000 }).catch(() => {});
      msgs.push(await p.$eval('.hk-dlg .hk-dlg-msg', (e) => e.textContent).catch(() => ''));
      await p.click('.hk-dlg .hk-dlg-ok').catch(() => {});
      await p.waitForTimeout(300);
    }
    await p.waitForTimeout(500);
    check('an existing number: the conditional wording, no token stored', [msgs[1] || '', await p.evaluate(() => localStorage.getItem('hawkeye_token'))],
      (v) => /can only create a new account/.test(v[0]) && /If you deleted your account/.test(v[0]) && v[1] === null);
    await ctx.close();
  }
  {
    api = {};
    const { ctx, p } = await page({ url: '/observe.html?intent=signin' });
    await p.waitForTimeout(1200);
    check('CONTROL sign-in shows no code field (codes only create accounts)', await p.evaluate(() => document.getElementById('ref-opt').hidden), true);
    await ctx.close();
  }

  console.log('\n=== which session slot the web asks for (x-device-class) ===');
  {
    const classAt = async (opts) => {
      api = {};
      calls.length = 0;
      const ctx = await b.newContext(opts);
      const p = await ctx.newPage();
      await p.goto(base + '/observe.html?intent=signin', { waitUntil: 'domcontentloaded' });
      for (let i = 0; i < 40 && !calls.some((c) => c.url === '/api/observers/resume'); i++) await p.waitForTimeout(100);
      const r = calls.find((c) => c.url === '/api/observers/resume');
      await ctx.close();
      return r ? r.cls : null;
    };
    const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    check('a desktop browser asks for the computer slot', await classAt({}), 'computer');
    check('an Android phone browser asks for the phone slot', await classAt({ userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36', hasTouch: true, isMobile: true }), 'phone');
    check('an iPad presenting a desktop Mac UA (with touch) asks for the phone slot', await classAt({ userAgent: MAC, hasTouch: true }), 'phone');
    check('CONTROL the same Mac UA without touch is a computer', await classAt({ userAgent: MAC }), 'computer');
  }

  console.log('\n=== D4: the admin console (Reach → Organisation codes) ===');
  {
    const model = {
      batchMax: 10000, fallbackCap: 5000, coordinatorMax: 10, nationalUnits: 176846,
      contests: [
        { code: 'PRES', name: 'Presidential', seat: null, states: null },
        { code: 'GOV', name: 'Governorship', seat: null, states: ['Kano', 'Lagos'] },
        { code: 'SEN', name: 'Senate', seat: 'senatorial', states: null },
      ],
      issuers: [],
    };
    // A hostile seat name: the pickers must print it, never run it.
    const EVIL = 'Lagos West"><img src=x onerror="window.__xss=1">\'';
    const summary = (b) => ({ ...b, used: 0, created: 0, refused: 0, unused: b.revokedAt ? 0 : b.size });
    api = {
      '/api/admin/auth': () => [200, { ok: true }],
      '/api/admin/org-codes': () => [200, model],
      '/api/admin/org-codes/areas': () => [200, {
        states: ['FCT', 'Kano', 'Lagos'],
        lgas: { Kano: ['Dala'], Lagos: ['Ikeja', 'Surulere'] },
        senatorial: { Lagos: ['Lagos Central', EVIL] },
        federal_constituency: {},
      }],
      '/api/admin/org-codes/issuers': (req, body) => {
        const i = { id: model.issuers.length + 1, name: body.name, kind: body.kind, createdAt: Date.now(), issued: 0, used: 0, created: 0, refused: 0, committed: 0, cap: 5000, capSource: 'fallback', scope: null, batches: [] };
        model.issuers.push(i);
        return [200, { ok: true, issuer: i }];
      },
      '/api/admin/org-codes/issuers/1/scope': (req, body) => {
        const i = model.issuers[0];
        Object.assign(i, { scope: { contest: body.contest, state: body.state || null, seat: body.seat || null, lga: body.lga || null, units: 667 }, cap: 667, capSource: 'scope' });
        return [200, { ok: true, issuer: { id: 1, name: i.name, kind: i.kind, party: null, scope: i.scope, cap: 667, capSource: 'scope', committed: i.committed } }];
      },
      '/api/admin/org-codes/issuers/1/batches': (req, body) => {
        const i = model.issuers[0];
        const batch = summary({ id: 7, issuerId: 1, size: body.size, createdAt: Date.now(), revokedAt: null });
        i.batches.unshift(batch); i.issued += body.size; i.committed += body.size;
        return [200, { ok: true, batch, codes: Array.from({ length: body.size }, (_, n) => `ABCD-EFGH-JK${'MNPQRSTVWXYZ'[n % 12]}${'23456789'[n % 8]}`) }];
      },
      '/api/admin/org-codes/batches/7/revoke': () => {
        const b7 = model.issuers[0].batches[0];
        b7.revokedAt = Date.now(); b7.unused = 0;
        return [200, { ok: true, batch: b7 }];
      },
    };
    calls.length = 0;
    const ctx = await b.newContext({ acceptDownloads: true });
    await ctx.addInitScript((t) => { try { localStorage.setItem('hawkeye_token', t); sessionStorage.setItem('hawkeye_admin', 'test'); localStorage.setItem('hawkeye_admin', 'test'); } catch (e) { /* blank */ } }, liveToken);
    const p = await ctx.newPage();
    p.on('dialog', (d) => d.accept());
    await p.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
    await p.evaluate(() => { document.getElementById('org-wrap').open = true; document.getElementById('org-wrap').dispatchEvent(new Event('toggle')); });
    await p.waitForFunction(() => /No organisations yet/.test(document.getElementById('org-adm-out').textContent), null, { timeout: 8000 }).catch(() => {});
    check('opens on an empty list, with the identical terms stated',
      await p.evaluate(() => [document.getElementById('org-adm-out').textContent.trim(), /at most 10,000 codes per batch, and in total one code per polling unit in the race and area set for it \(all 176,846 units for the presidential race\)\. With no race set, the cap is 5,000\./.test(document.getElementById('org-adm-intro').textContent)]),
      ['No organisations yet.', true]);
    await p.fill('#org-adm-name', 'Party One');
    await p.selectOption('#org-adm-kind', 'party');
    await p.click('#org-adm-create');
    await p.waitForSelector('[data-issue="1"]', { timeout: 8000 }).catch(() => {});
    const made = calls.find((c) => c.url === '/api/admin/org-codes/issuers');
    check('create organisation posts name + kind', made && made.body, { name: 'Party One', kind: 'party' });

    /* RACE AND AREA: the scope that sets the cap. */
    const scopeText = () => p.evaluate(() => (document.getElementById('org-adm-sc-1') || {}).textContent || '');
    const optionsOf = (sel) => p.evaluate((s) => [...document.querySelectorAll(s + ' option')].map((o) => o.textContent), sel);
    check('no scope: the fallback is stated, with how to raise it',
      [await scopeText(), await p.evaluate(() => document.getElementById('org-adm-out').textContent)],
      ([s, all]) => /No race set — the fallback cap of 5,000 codes applies\. Set the race and area to raise it/.test(s) && /0 of 5000 committed/.test(all));
    await p.selectOption('#org-adm-sc-contest-1', 'GOV');
    check('a governorship offers only the states it is held in', await optionsOf('#org-adm-sc-state-1'), ['All in this race', 'Kano', 'Lagos']);
    check('CONTROL: no LGA until a state is picked', await p.evaluate(() => document.getElementById('org-adm-sc-lga-1').disabled), true);
    await p.selectOption('#org-adm-sc-state-1', 'Lagos');
    check('picking Lagos lists its LGAs', await optionsOf('#org-adm-sc-lga-1'), ['Any LGA', 'Ikeja', 'Surulere']);
    await p.selectOption('#org-adm-sc-contest-1', 'SEN');
    check('switching to the Senate keeps Lagos and lists its districts, the hostile name as text',
      [await p.evaluate(() => document.getElementById('org-adm-sc-state-1').value), await optionsOf('#org-adm-sc-seat-1'), await p.evaluate(() => window.__xss || null)],
      ['Lagos', ['Any in this state', 'Lagos Central', EVIL], null]);
    await p.selectOption('#org-adm-sc-contest-1', 'GOV');
    await p.selectOption('#org-adm-sc-state-1', 'Lagos');
    await p.selectOption('#org-adm-sc-lga-1', 'Ikeja');
    await p.click('[data-scope-save="1"]');
    await p.waitForFunction(() => /cap 667 codes/.test((document.getElementById('org-adm-sc-1') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    const saved = calls.find((c) => c.url === '/api/admin/org-codes/issuers/1/scope');
    check('saving posts the race and area', saved && saved.body, { contest: 'GOV', state: 'Lagos', seat: '', lga: 'Ikeja' });
    check('…and the card states the new cap from the server',
      [await scopeText(), await p.evaluate(() => document.getElementById('org-adm-out').textContent)],
      ([s, all]) => /Governorship · Lagos · Ikeja LGA — cap 667 codes, one per polling unit there\./.test(s) && /0 of 667 committed/.test(all));
    await p.fill('#org-adm-size-1', '3');
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }).catch(() => null), p.click('[data-issue="1"]')]);
    const csv = dl ? fs.readFileSync(await dl.path(), 'utf8') : '';
    check('issuing a batch downloads its CSV at once', dl && dl.suggestedFilename(), 'hawkeye-codes-party-one-batch-7.csv');
    check('…one row per code, under a header', csv.trim().split('\n'), (rows) => rows[0] === 'code,batch,issued' && rows.length === 4 && rows.slice(1).every((r) => /^[A-Z0-9-]{14},7,\d{4}-\d{2}-\d{2}$/.test(r)));
    await p.waitForSelector('[data-revoke="7"]', { timeout: 8000 }).catch(() => {});
    check('the batch is listed with its counts and a way to withdraw it',
      await p.evaluate(() => document.getElementById('org-adm-out').textContent), (t) => /Batch 7 · 3 codes/.test(t) && /0 accounts · 3 unused/.test(t));
    await p.click('[data-revoke="7"]');
    // Asked in Hawkeye's own dialog (app/dialog.js), destructive styling.
    await p.waitForSelector('.hk-dlg .hk-dlg-ok.danger', { timeout: 5000 }).catch(() => {});
    await p.click('.hk-dlg .hk-dlg-ok').catch(() => {});
    await p.waitForFunction(() => /Withdrawn/.test(document.getElementById('org-adm-out').textContent), null, { timeout: 8000 }).catch(() => {});
    check('withdraw posts the revoke and the row says so',
      [calls.some((c) => c.url === '/api/admin/org-codes/batches/7/revoke'), await p.evaluate(() => !document.querySelector('[data-revoke="7"]'))], [true, true]);
    const adminCalls = calls.filter((c) => c.url.startsWith('/api/admin/org-codes'));
    check('every admin call carried the console secret', [adminCalls.length >= 4, adminCalls.every((c) => c.admin === 'test')], [true, true]);
    await ctx.close();
  }
} finally {
  await b.close();
  server.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);

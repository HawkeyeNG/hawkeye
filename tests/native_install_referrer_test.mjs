/**
 * THE INVITATION, THROUGH THE PLAY STORE AND INTO NATIVE SIGN-UP (1.0.8).
 *
 *   invite.html?ref=CODE&unit=PU  →  Play link  &referrer=<encoded ref=CODE&unit=PU>
 *   →  Play hands the app `ref=CODE&unit=PU`  →  lib/invite-parse.ts
 *   →  lib/pending-invite.ts parks it  →  /verify { referralCode }  →  chooser ?unit=
 *
 * Four parts: the parser (with a naive parser as the CONTROL that must fail),
 * the parking rules (with a mutated copy as the CONTROL), the real invite.html
 * in headless Chromium, and the wiring in the native sources.
 *
 * Loads the TypeScript directly with node:module stripTypeScriptTypes — the
 * parser has no imports, and pending-invite's three imports are replaced with
 * fakes, so nothing here needs a bundler or a device.
 */
import { createRequire, stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const read = (f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

/** A TS file as an importable ESM module, its imports swapped for `prelude`. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hk-referrer-'));
let n = 0;
async function load(tsSource, prelude = '') {
  const body = stripTypeScriptTypes(tsSource.replace(/^import [^;]+;\n/gm, ''), { mode: 'strip' });
  const f = path.join(tmp, `m${n++}.mjs`);
  fs.writeFileSync(f, prelude + '\n' + body);
  return import(pathToFileURL(f).href);
}

const PARSE_TS = read('native/src/lib/invite-parse.ts');
const P = await load(PARSE_TS);

const CODE = 'H7KMN3';
const UNIT = '37-06-01-105';
const NONE = { code: null, unit: null };

// ============================================================ 1. the parser
console.log('=== parseInstallReferrer ===');
const CASES = [
  ['the new form, as Play hands it back', `ref=${CODE}&unit=${UNIT}`, { code: CODE, unit: UNIT }],
  ['still percent-encoded once more', encodeURIComponent(`ref=${CODE}&unit=${UNIT}`), { code: CODE, unit: UNIT }],
  ['a missing unit: code only', `ref=${CODE}`, { code: CODE, unit: null }],
  ['the older bare code', CODE, { code: CODE, unit: null }],
  ['lower-case is the same code', CODE.toLowerCase(), { code: CODE, unit: null }],
  ['`r=` as the web accepts it', `r=${CODE}&unit=${UNIT}`, { code: CODE, unit: UNIT }],
  ['a malformed unit (letter O) is dropped, the code kept', `ref=${CODE}&unit=37-06-01-1O5`, { code: CODE, unit: null }],
  ['a unit never rides without a code', `unit=${UNIT}`, NONE],
  ['an ORGANIC install is not an invitation', 'utm_source=google-play&utm_medium=organic', NONE],
  ['a code outside the alphabet is dropped, not mapped', 'ref=ABCDE0', NONE],
  ['a bare 6 with a zero is not a code', 'ABCDE0', NONE],
  ['a broken escape does not throw', `ref=%E0%A4%A&unit=${UNIT}`, NONE],
  ['the first ref wins', `ref=${CODE}&ref=ABCDEF`, { code: CODE, unit: null }],
  ['empty', '', NONE],
  ['null', null, NONE],
  ['a number', 123456, NONE],
  ['absurdly long', `ref=${CODE}&x=${'a'.repeat(600)}`, NONE],
];
for (const [label, raw, want] of CASES) check(label, P.parseInstallReferrer(raw), want);

/* CONTROL. The obvious shortcut — run the whole referrer through the code
   normaliser — must be caught by the table above, or the table proves nothing.
   It turns the organic referrer into a six-letter "code". */
{
  const naive = (raw) => ({ code: P.normalizeCode(raw), unit: null });
  const caught = CASES.filter(([, raw, want]) => JSON.stringify(naive(raw)) !== JSON.stringify(want)).map((c) => c[0]);
  check('CONTROL a naive parser fails the table', caught.includes('an ORGANIC install is not an invitation'), true);
  check('CONTROL and the organic string really does normalise to six letters', P.normalizeCode('utm_source=google-play&utm_medium=organic'), (c) => typeof c === 'string' && c.length === 6);
}

/* URL-ENCODING, END TO END: built exactly as invite.html builds it, decoded
   exactly as a URL parser (and Play) decodes it. */
{
  const href = 'https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer&referrer='
    + encodeURIComponent(`ref=${CODE}&unit=${UNIT}`);
  const u = new URL(href);
  check('encoded: the unit is NOT a separate Play parameter', u.searchParams.get('unit'), null);
  check('encoded: the package id survives', u.searchParams.get('id'), 'ng.com.hawkeye.observer');
  check('decoded referrer parses to code + unit', P.parseInstallReferrer(u.searchParams.get('referrer')), { code: CODE, unit: UNIT });
  const unencoded = `https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer&referrer=ref=${CODE}&unit=${UNIT}`;
  check('CONTROL left unencoded, the unit falls off the referrer',
    P.parseInstallReferrer(new URL(unencoded).searchParams.get('referrer')), { code: CODE, unit: null });
}

console.log('\n=== typedInviteCode: the sign-up field (native, and its app.js twin) ===');
{
  const TYPED = [
    ['exact', CODE, CODE],
    ['lower case', CODE.toLowerCase(), CODE],
    ['a hyphen read aloud', 'H7K-MN3', CODE],
    ['spaces around and inside', ' h7k mn3 ', CODE],
    ['empty is fine (optional field)', '', ''],
    ['blank is empty', '   ', ''],
    ['null is empty', null, ''],
    ['an O for a 0 is refused, not dropped', 'ABCDEO', null],
    ['a zero is refused', 'ABCDE0', null],
    ['a seventh stray letter is refused', 'ABCDEOF', null],
    ['five is too short', 'H7KMN', null],
    ['seven is too long', 'H7KMN33', null],
    ['U is not in the alphabet', 'H7KMNU', null],
  ];
  for (const [label, raw, want] of TYPED) check(`native: ${label}`, P.typedInviteCode(raw), want);

  /* CONTROL. The link-side normaliser drops stray characters, which is exactly
     what the typed field must NOT do: "ABCDEOF" would become someone's code. */
  check('CONTROL the drop-don\'t-refuse normaliser turns ABCDEOF into a code', P.normalizeCode('ABCDEOF'), 'ABCDEF');

  /* The web twin, lifted out of app.js and run on the same table. */
  const appJs = read('app/app.js');
  const src = /function typedInviteCode\(raw\) \{[\s\S]*?\n\}/.exec(appJs)?.[0];
  check('app.js has its own typedInviteCode', typeof src, 'string');
  const webTyped = src ? new Function(`${src}; return typedInviteCode;`)() : () => undefined;
  const drift = TYPED.filter(([, raw]) => webTyped(raw) !== P.typedInviteCode(raw)).map((c) => c[0]);
  check('web and native agree on every case', drift, []);
  check('CONTROL the parity check can fail', TYPED.filter(([, raw]) => P.normalizeCode(raw) !== P.typedInviteCode(raw)).length > 0, true);
}

console.log('\n=== parseInviteLink ===');
check('an /open App Link', P.parseInviteLink(`https://hawkeye.com.ng/open?to=x&ref=${CODE}&unit=${UNIT}#top`), { code: CODE, unit: UNIT });
check('the custom scheme', P.parseInviteLink(`hawkeye://open?r=${CODE.toLowerCase()}`), { code: CODE, unit: null });
check('the bot\'s ?pu= handoff is not an invitation', P.parseInviteLink(`https://hawkeye.com.ng/open?to=report&pu=${UNIT}`), NONE);
check('no query', P.parseInviteLink('https://hawkeye.com.ng/open'), NONE);
check('not a string', P.parseInviteLink(undefined), NONE);

// ====================================================== 2. parking the invite
console.log('\n=== pending-invite: parking, once-only, clearing ===');
const PENDING_TS = read('native/src/lib/pending-invite.ts');
const parseBody = stripTypeScriptTypes(PARSE_TS, { mode: 'strip' }).replace(/^export /gm, '');
const PRELUDE = `
const AsyncStorage = globalThis.__AS;
const Application = globalThis.__APP;
const Platform = globalThis.__PLATFORM;
${parseBody}`;

function world({ os: platform = 'android', referrer = `ref=${CODE}&unit=${UNIT}`, throws = false, hangs = false } = {}) {
  const store = new Map();
  const w = {
    store,
    calls: 0,
    AS: {
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      setItem: async (k, v) => { store.set(k, String(v)); },
      removeItem: async (k) => { store.delete(k); },
    },
    APP: {
      getInstallReferrerAsync: () => {
        w.calls++;
        if (throws) return Promise.reject(new Error('SERVICE_UNAVAILABLE'));
        if (hangs) return new Promise(() => {});
        return Promise.resolve(referrer);
      },
    },
    PLATFORM: { OS: platform },
  };
  return w;
}
async function fresh(opts, src = PENDING_TS) {
  const w = world(opts);
  globalThis.__AS = w.AS; globalThis.__APP = w.APP; globalThis.__PLATFORM = w.PLATFORM;
  return { w, M: await load(src, PRELUDE) };
}
const K = { code: 'hawkeye.invite.code', unit: 'hawkeye.invite.unit', read: 'hawkeye.invite.referrer-read' };

{
  const { w, M } = await fresh();
  await M.captureInstallReferrer(false);
  check('android fresh install: the code is pending', await M.pendingInviteCode(), CODE);
  check('and the unit is parked', w.store.get(K.unit), UNIT);
  await M.captureInstallReferrer(false);
  check('read ONCE: a second launch does not ask Play again', w.calls, 1);
  await M.settleInviteAfterVerify({ isNew: true });
  check('after a verify that created the account: code cleared', await M.pendingInviteCode(), undefined);
  check('but the unit waits for the chooser', w.store.get(K.unit), UNIT);
  check('the chooser takes it', await M.takeInviteUnit(), UNIT);
  check('and it is gone after', await M.takeInviteUnit(), null);
}
{
  const { w, M } = await fresh({ referrer: 'utm_source=google-play&utm_medium=organic' });
  await M.captureInstallReferrer(false);
  check('CONTROL an organic install parks nothing', [await M.pendingInviteCode(), w.store.get(K.unit)], [undefined, undefined]);
  check('and still counts as read', w.store.get(K.read), 'done');
}
{
  const { w, M } = await fresh();
  await M.captureInstallReferrer(true);
  check('already signed in (an update): Play is not asked', w.calls, 0);
  check('nothing parked', await M.pendingInviteCode(), undefined);
}
{
  const { w, M } = await fresh({ os: 'ios' });
  await M.captureInstallReferrer(false);
  check('iOS: no install referrer is attempted', [w.calls, w.store.size], [0, 0]);
}
{
  const { w, M } = await fresh({ throws: true });
  for (let i = 0; i < 5; i++) await M.captureInstallReferrer(false);
  check('Play unavailable: tried on three launches, then left alone', [w.calls, w.store.get(K.read)], [3, 'done']);
}
{
  const { w, M } = await fresh({ hangs: true });
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => real(fn, 0);
  try { await M.captureInstallReferrer(false); } finally { globalThis.setTimeout = real; }
  check('a referrer call that never answers times out quietly', [w.calls, w.store.get(K.read)], [1, '1']);
}
{
  const { w, M } = await fresh();
  await M.settleInviteAfterVerify({ isNew: false });
  w.store.set(K.code, CODE); w.store.set(K.unit, UNIT);
  await M.settleInviteAfterVerify({ isNew: false, needsUnit: false });
  check('verify into an EXISTING account clears both', [w.store.has(K.code), w.store.has(K.unit)], [false, false]);
}
{
  const { w, M } = await fresh({ referrer: 'ref=ABCDEF&unit=11-11-11-111' });
  M.captureInviteLink(`https://hawkeye.com.ng/open?ref=${CODE}&unit=${UNIT}`);
  await new Promise((r) => setTimeout(r, 10));
  await M.captureInstallReferrer(false);
  check('a tapped link beats the install referrer', [await M.pendingInviteCode(), w.store.get(K.unit)], [CODE, UNIT]);
  M.captureInviteLink(`hawkeye://open?ref=${CODE}`);
  await new Promise((r) => setTimeout(r, 10));
  check('the same code without a unit keeps the unit', w.store.get(K.unit), UNIT);
  M.captureInviteLink('hawkeye://open?ref=ABCDEF');
  await new Promise((r) => setTimeout(r, 10));
  check('a DIFFERENT invitation without a unit clears it', [await M.pendingInviteCode(), w.store.has(K.unit)], ['ABCDEF', false]);
}
{
  /* /open?to=invite opens sign-up AT ONCE (app/open.tsx), and sign-up reads the
     code on mount — no 10 ms grace, as above. The readers wait for the write. */
  const { M } = await fresh({ os: 'ios' });
  M.captureInviteLink(`https://hawkeye.com.ng/open?to=invite&ref=${CODE}&unit=${UNIT}`);
  check('an invite link read at once (sign-up mounting) finds the code', await M.pendingInviteCode(), CODE);
  const { M: M2 } = await fresh({ os: 'ios' });
  M2.captureInviteLink(`https://hawkeye.com.ng/open?to=invite&ref=${CODE}&unit=${UNIT}`);
  check('and the chooser, read at once, finds the unit', await M2.takeInviteUnit(), UNIT);
  /* CONTROL: without the wait the same immediate read misses the code. */
  const noWait = PENDING_TS.replaceAll('if (parking) await parking;', '');
  check('CONTROL the mutation applied', noWait !== PENDING_TS, true);
  const { M: M3 } = await fresh({ os: 'ios' }, noWait);
  M3.captureInviteLink(`https://hawkeye.com.ng/open?to=invite&ref=${CODE}&unit=${UNIT}`);
  check('CONTROL without the wait an immediate read misses it', await M3.pendingInviteCode(), undefined);
}
{
  /* CONTROL: the precedence check above must be able to fail. With the
     no-overwrite guard deleted, the install referrer wins instead. */
  const mutated = PENDING_TS.replace('if (before && !overwrite) return;', '');
  check('CONTROL the mutation applied', mutated !== PENDING_TS, true);
  const { M } = await fresh({ referrer: 'ref=ABCDEF&unit=11-11-11-111' }, mutated);
  M.captureInviteLink(`https://hawkeye.com.ng/open?ref=${CODE}&unit=${UNIT}`);
  await new Promise((r) => setTimeout(r, 10));
  await M.captureInstallReferrer(false);
  check('CONTROL without the guard the referrer overwrites the link', await M.pendingInviteCode(), 'ABCDEF');
}


// =================================================== 3. the real pages, headless
const { chromium } = require_('playwright-core');
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
/** Every POST to /api, with its body — what the sign-up actually sent. */
const posts = [];
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.startsWith('/api/') && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    return req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
      posts.push({ path: url, body });
      if (url === '/api/observers/register') return json({ ok: true, devOtp: '123456' });
      if (url === '/api/observers/verify') return json({ ok: true, token: 'tok', observerId: 7, isNew: true });
      return json({ ok: true });
    });
  }
  if (url.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const ANDROID = 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

/** Android's intent:// URL, taken apart the way Chrome takes it apart. */
function parseIntent(h) {
  const m = /^intent:\/\/([^#]*)#Intent;(.*);end$/.exec(h || '');
  if (!m) return null;
  const extras = Object.fromEntries(m[2].split(';').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  return {
    data: `${extras.scheme}://${m[1]}`,
    pkg: extras.package,
    rawFallback: extras['S.browser_fallback_url'] || '',
    fallback: decodeURIComponent(extras['S.browser_fallback_url'] || ''),
  };
}

try {
  console.log('\n=== invite.html: the Play link carries ref + unit ===');
  async function invitePage(ua, qs) {
    const ctx = await b.newContext({ userAgent: ua });
    const p = await ctx.newPage();
    await p.goto(`${base}/invite.html${qs}`, { waitUntil: 'networkidle' });
    const r = await p.evaluate(() => {
      const a = document.getElementById('g-open');
      const shown = () => getComputedStyle(a).display !== 'none';
      const out = { store: document.getElementById('g-store').href, open: a.getAttribute('href'), openShown: shown() };
      /* CONTROL for the page's own [hidden] rule: without it .btn-ghost's
         display:inline-block wins and a hidden button still shows. */
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        for (let i = rules.length - 1; i >= 0; i--) if (rules[i].selectorText === '.iv-btns a[hidden]') sheet.deleteRule(i);
      }
      out.shownWithoutRule = shown();
      return out;
    });
    await ctx.close();
    return r;
  }

  const a = await invitePage(ANDROID, `?ref=${CODE}&unit=${UNIT}`);
  const u = new URL(a.store);
  check('Android: Play, native package', `${u.origin}${u.pathname}?id=${u.searchParams.get('id')}`,
    'https://play.google.com/store/apps/details?id=ng.com.hawkeye.observer');
  check('the referrer is ONE encoded value', a.store.includes(`referrer=${encodeURIComponent(`ref=${CODE}&unit=${UNIT}`)}`), true);
  check('the unit is not a stray Play parameter', u.searchParams.get('unit'), null);
  check('what the app will read: code + unit', P.parseInstallReferrer(u.searchParams.get('referrer')), { code: CODE, unit: UNIT });

  const noUnit = new URL((await invitePage(ANDROID, `?r=${CODE}`)).store);
  check('an invite without a unit: code only', P.parseInstallReferrer(noUnit.searchParams.get('referrer')), { code: CODE, unit: null });
  const badUnit = new URL((await invitePage(ANDROID, `?ref=${CODE}&unit=37-06-01-1O5`)).store);
  check('a malformed unit never reaches the referrer', badUnit.searchParams.get('referrer'), `ref=${CODE}`);
  const none = await invitePage(ANDROID, '');
  check('CONTROL no invitation: no referrer at all', none.store.includes('referrer'), false);
  const i = await invitePage(IPHONE, `?ref=${CODE}&unit=${UNIT}`);
  check('iPhone: App Store, no referrer (Apple ignores it)', i.store.startsWith('https://apps.apple.com/') && !i.store.includes('referrer'), true);

  console.log('\n=== invite.html: "Already have the app? Open it" ===');
  const it = parseIntent(a.open);
  check('Android: shown', a.openShown, true);
  check('Android: an intent:// URL', it !== null, true);
  check('it names the PRODUCTION package only', it?.pkg, 'ng.com.hawkeye.observer');
  check('its data URI is the app scheme, and the app reads code + unit from it', P.parseInviteLink(it?.data), { code: CODE, unit: UNIT });
  check('its data URI is hawkeye://open (the /open route)', it?.data.startsWith('hawkeye://open?'), true);
  check('marked as an invite, so the app opens sign-up (open.tsx to=invite)', new URL(it?.data || 'x:').searchParams.get('to'), 'invite');
  check('not installed: falls back to the Play link, referrer and all', it?.fallback, a.store);
  check('the fallback is encoded — no raw ; or # to cut the intent short', /[;#]/.test(it?.rawFallback || ';'), false);
  check('iPhone: shown', i.openShown, true);
  check('iPhone: the bare scheme with code + unit', [i.open.startsWith('hawkeye://open?'), P.parseInviteLink(i.open)], [true, { code: CODE, unit: UNIT }]);
  const noCode = await invitePage(ANDROID, '');
  check('no invitation: the button still just opens the app', [noCode.openShown, P.parseInviteLink(parseIntent(noCode.open)?.data)], [true, NONE]);
  const d = await invitePage(DESKTOP, `?ref=${CODE}&unit=${UNIT}`);
  check('a laptop: NOT shown (phones only)', d.openShown, false);
  check('CONTROL without the page\'s [hidden] rule it WOULD show', d.shownWithoutRule, true);

  console.log('\n=== observe.html: the ONE code field ("Invite or organisation code") always on web sign-up ===');
  async function signup(qs = '') {
    const ctx = await b.newContext({ viewport: { width: 390, height: 820 } });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${base}/observe.html${qs}`, { waitUntil: 'networkidle' });
    return { ctx, p, errors };
  }
  const visible = (p, id) => p.evaluate((x) => {
    const el = document.getElementById(x);
    return !!el && !el.closest('[hidden]') && getComputedStyle(el).display !== 'none';
  }, id);
  const waitPost = async (pathName, from) => {
    for (let n = 0; n < 50; n++) {
      const hit = posts.slice(from).find((x) => x.path === pathName);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  /** Phone + channel, then Request OTP. Resolves to the /register post or null. */
  async function requestCode(p, code) {
    if (code !== undefined) await p.fill('#ref-input', code);
    await p.fill('#auth-input', '08031234567');
    await p.check('input[name="otp-channel"][value="telegram"]');
    const from = posts.length;
    await p.click('#btn-auth');
    return waitPost('/api/observers/register', from);
  }
  async function verify(p) {
    await p.fill('#auth-input', '123456');
    await p.fill('#pw-opt-input', 'correct horse 8');
    const from = posts.length;
    await p.click('#btn-auth');
    return waitPost('/api/observers/verify', from);
  }

  {
    const { ctx, p, errors } = await signup();
    check('no code: the field is visible, and empty', [await visible(p, 'ref-input'), await p.inputValue('#ref-input')], [true, '']);
    check('labelled "Invite or organisation code (optional)"', await p.evaluate(() => document.querySelector('label[for="ref-input"]').textContent.trim()), 'Invite or organisation code (optional)');
    check('no "Have an invite code?" link to find first', await p.evaluate(() => !!document.getElementById('ref-toggle')), false);
    /* CONTROL for visible(): the same field inside a [hidden] box reads hidden. */
    await p.evaluate(() => { document.getElementById('ref-opt').hidden = true; });
    check('CONTROL visible() sees a hidden field as hidden', await visible(p, 'ref-input'), false);
    check('no page error', errors, []);
    await ctx.close();
  }
  {
    const { ctx, p } = await signup();
    await requestCode(p);
    check('empty = no code: /verify sends none', await verify(p).then((v) => v !== null && !('referralCode' in v.body)), true);
    await ctx.close();
  }
  {
    const { ctx, p } = await signup(`?r=${CODE}`);
    check('a code from the link: field open and filled', [await visible(p, 'ref-input'), await p.inputValue('#ref-input')], [true, CODE]);
    await requestCode(p);
    check('it rides on /verify untouched', (await verify(p))?.body.referralCode, CODE);
    await ctx.close();
  }
  {
    const { ctx, p } = await signup();
    const sent = await requestCode(p, 'ABCDEO');
    check('a typed code with an O: NO code is sent', sent, null);
    check('and the field says why', await visible(p, 'ref-err'), true);
    await p.fill('#ref-input', 'h7k-mn3');
    check('typing again clears the message', await visible(p, 'ref-err'), false);
    const from = posts.length;
    await p.click('#btn-auth');
    check('CONTROL a real code (lower case, hyphen) goes through', (await waitPost('/api/observers/register', from)) !== null, true);
    check('/verify carries it, normalised', (await verify(p))?.body.referralCode, CODE);
    await ctx.close();
  }
  {
    const { ctx, p } = await signup(`?r=${CODE}`);
    await requestCode(p, '');
    const v = await verify(p);
    check('emptying a parked code is respected: /verify sends none', v !== null && !('referralCode' in v.body), true);
    await ctx.close();
  }
  {
    const { ctx, p } = await signup(`?intent=signin&r=${CODE}`);
    check('sign-in: no invite field at all', await visible(p, 'ref-input'), false);
    await ctx.close();
  }
} finally {
  await b.close();
  server.close();
}

// ======================================================== 4. the native wiring
console.log('\n=== native sources ===');
{
  const auth = read('native/src/lib/auth.ts');
  const verifySrc = auth.slice(auth.indexOf('export async function verifyOtp'), auth.indexOf('export async function passwordLogin'));
  check('verify sends referralCode, the field the web and /verify use', /publicKeyJwk: id\.publicKeyJwk, referralCode \}/.test(verifySrc), true);
  check('the field wins when given; the parked code otherwise', /opts\.referralCode === undefined \? await pendingInviteCode\(\) : opts\.referralCode \|\| undefined/.test(verifySrc), true);
  check('the backend reads that same field', /req\.body\?\.referralCode/.test(read('backend/src/routes/observers.js')), true);
  check('and only on /verify, never on /login', /referralCode/.test(auth.slice(auth.indexOf('export async function passwordLogin'))), false);
  check('the code is settled only after a SUCCESSFUL verify',
    verifySrc.indexOf('settleInviteAfterVerify') > verifySrc.indexOf('if (r.ok && r.token && r.observerId)'), true);

  const signIn = read('native/src/app/sign-in.tsx');
  check('sign-up opens the chooser with the invited unit',
    /takeInviteUnit\(\)[\s\S]{0,200}\/choose-unit\?onboard=1&unit=\$\{encodeURIComponent\(unit\)\}/.test(signIn), true);
  /* ALWAYS SHOWN on the create-account path: the sign-up branch renders the
     field directly, with no open/closed state in front of it. */
  const alwaysShown = (src) => /\{purpose === 'signup' \? \(\s*<View className="pt-4">\s*<Text[^>]*>\s*\{authT\('n\.auth\.code-label'\)\}/.test(src)
    && !/inviteOpen|have-an-invite-code/.test(src);
  check('the invite field is on the create-account path only, always shown', alwaysShown(signIn), true);
  check('CONTROL the old collapsed form fails that check',
    alwaysShown("{purpose === 'signup' ? (\n  inviteOpen ? (\n  <View className=\"pt-4\">\n <Text className=\"x\">\n{authT('n.auth.code-label')}"), false);

  const open = read('native/src/app/open.tsx');
  const inviteBranch = open.slice(open.indexOf("=== 'invite'"), open.indexOf('const path = TARGETS'));
  check('open.tsx to=invite: signed in goes home', /auth\.status === 'signedIn'\) \{\s*router\.replace\('\/\(tabs\)'\);/.test(inviteBranch), true);
  check('signed out goes to the create-account form',
    (inviteBranch.match(/'\/sign-in\?intent=signup'/g) || []).length, 2);
  check('with welcome under it when there is nothing to go back to',
    /router\.replace\('\/welcome'\);\s*router\.push\('\/sign-in\?intent=signup'\);/.test(inviteBranch), true);
  check('the root layout lets a signed-out reader through /open (else it races the push)',
    /const allowed = top === 'welcome' \|\| top === 'sign-in' \|\| top === 'practice' \|\| top === 'open';/.test(read('native/src/app/_layout.tsx')), true);
  const onReq = signIn.slice(signIn.indexOf('const onRequest'), signIn.indexOf('const onRequest') + 700);
  check('a bad typed code stops Send code before any code goes out',
    onReq.indexOf("typedInviteCode(inviteCode) === null") > -1 && onReq.indexOf("typedInviteCode(inviteCode) === null") < onReq.indexOf("send('Sending')"), true);
  check('sign-up verify sends the field (null when empty)',
    /purpose === 'signup' \? \{ referralCode: typedInviteCode\(inviteCode\) \|\| null \} : \{\}/.test(signIn), true);
  check('prefilled from the parked invitation', /pendingInviteCode\(\)\.then/.test(signIn), true);

  const intent = read('native/src/app/+native-intent.tsx');
  check('+native-intent routes nothing: it returns the path it was given', /return path;\s*\}\s*$/.test(intent), true);
  const layout = read('native/src/app/_layout.tsx');
  check('the root layout reads the referrer once auth has resolved',
    /if \(auth\.status === 'loading'\) return;\s*captureInstallReferrer\(auth\.status === 'signedIn'\);/.test(layout), true);
  const pkg = JSON.parse(read('native/package.json'));
  check('expo-application is a direct dependency', typeof pkg.dependencies['expo-application'], 'string');
  const appJson = JSON.parse(read('native/app.json')).expo;
  check('app version 1.0.8', appJson.version, '1.0.8');
  check('runtimeVersion follows the app version (a native module was added)', appJson.runtimeVersion, { policy: 'appVersion' });
}

// ================================================================== 5. i18n
console.log('\n=== every new string, in four languages ===');
{
  const WEB = { ...JSON.parse(read('scripts/i18n/batches/native108_web.json')), ...JSON.parse(read('scripts/i18n/batches/auth_web.json')) };
  const NATIVE = { ...JSON.parse(read('scripts/i18n/batches/native108_native.json')), ...JSON.parse(read('scripts/i18n/batches/auth_native.json')) };
  const isNFC = (s) => s === s.normalize('NFC');
  const complete = (entry) => ['en', 'ha', 'ig', 'yo'].every((l) => typeof entry?.[l] === 'string' && entry[l].trim() && isNFC(entry[l]))
    && ['ha', 'ig', 'yo'].every((l) => entry[l] !== entry.en);
  const CONTROL_NFD = 'Kóòdù ìpè'.normalize('NFD');
  check('CONTROL the NFC check catches a decomposed string', isNFC(CONTROL_NFD), false);
  check('CONTROL an entry missing Yorùbá is incomplete', complete({ en: 'x', ha: 'y', ig: 'z' }), false);

  // Web: every data-i18n key the new markup uses, and the English matches it.
  const observe = read('app/observe.html');
  const invite = read('app/invite.html');
  const webUses = [
    // The one code field (invite or organisation): scripts/i18n/batches/auth_web.json.
    ['auth.code-label', observe], ['auth.code-hint', observe], ['auth.code-kind-invite', observe],
    ['auth.code-kind-org', observe], ['auth.code-invalid', observe], ['invite.open-in-app', invite],
  ];
  /* "Have an invite code?" went with the collapsed field (always shown now),
     and the invite-only label/error went with the ONE code field (auth.code-*):
     no markup or code asks for them, and they are out of every bundle. */
  const WEB_BUNDLES = ['app/i18n/en.json', 'app/i18n/ha.json', 'app/i18n/ig.json', 'app/i18n/yo.json', 'scripts/i18n/catalogue.json'];
  const NATIVE_BUNDLES = ['native/src/lib/i18n/en.json', 'native/src/lib/i18n/ha.json', 'native/src/lib/i18n/ig.json', 'native/src/lib/i18n/yo.json', 'scripts/i18n/native_catalogue.json'];
  const gone = [
    ['observe.have-an-invite-code', WEB_BUNDLES],
    ['observe.invite-code-optional', WEB_BUNDLES],
    ['observe.invite-code-invalid', WEB_BUNDLES],
    ['n.app.sign-in.have-an-invite-code', NATIVE_BUNDLES],
    ['n.app.sign-in.invite-code-optional', NATIVE_BUNDLES],
    ['n.app.sign-in.invite-code-invalid', NATIVE_BUNDLES],
  ];
  const usedAnywhere = (k) => ['app/observe.html', 'app/app.js', 'native/src/app/sign-in.tsx'].some((f) => read(f).includes(k.split('.').pop()));
  for (const [k, files] of gone) {
    check(`${k}: unused and removed`, [usedAnywhere(k), files.filter((f) => k in JSON.parse(read(f)))], [false, []]);
  }
  check('CONTROL the removal check finds a key that is still there', [usedAnywhere('auth.code-label'), 'auth.code-label' in JSON.parse(read('app/i18n/en.json'))], [true, true]);
  for (const [k, html] of webUses) {
    const m = new RegExp(`data-i18n="${k.replace(/\./g, '\\.')}"[^>]*>([^<]+)<`).exec(html);
    check(`web ${k}: in the markup, in the batch, complete`, !!m && complete(WEB[k]), true);
    check(`web ${k}: the markup's English is the batch's`, m?.[1], WEB[k]?.en);
  }
  // Native: every new key sign-in.tsx asks for.
  const signIn = read('native/src/app/sign-in.tsx');
  const nativeUses = [...new Set([...signIn.matchAll(/authT\('(n\.auth\.code-[a-z-]+)'\)/g)].map((m) => m[1]))];
  check('native: the five code-field keys used', nativeUses.sort(), ['n.auth.code-hint', 'n.auth.code-invalid', 'n.auth.code-kind-invite', 'n.auth.code-kind-org', 'n.auth.code-label']);
  for (const k of nativeUses) check(`native ${k}: in the batch, complete`, complete(NATIVE[k]), true);
  check('native and web say the same thing in every language',
    ['code-label', 'code-hint', 'code-kind-invite', 'code-kind-org', 'code-invalid'].every((s) =>
      JSON.stringify(NATIVE[`n.auth.${s}`]) === JSON.stringify(WEB[`auth.${s}`])), true);
  check('CONTROL that comparison can fail', JSON.stringify(NATIVE['n.auth.code-label']) === JSON.stringify(WEB['auth.code-hint']), false);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? `${fail} FAILED` : 'all passed'}`);
process.exit(fail ? 1 : 0);

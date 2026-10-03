/**
 * FLOW WALKTHROUGH — group `onboarding` (sign-up, organisation code, sign-in,
 * session end/return, first run, sign out) on web, Lite and native.
 *
 *   node onboarding.mjs [--surface web,lite,native] [--lang en,ha] [--flow signup,org,signin,session,firstrun,signout]
 *
 * Output: tests/e2e/out/flows/onboarding/
 *   <flow>/step-NN-<surface>-<lang>-<screen>.png   every step
 *   steps.json     per flow, per surface, per lang: ordered steps {screen, asked, taps, url, png, text}
 *   checks.json    every automated observation (value + the screenshot it came from) and the CONTROLS
 *   findings.json  findings whose condition still holds on this run (a fixed bug drops out on a re-run)
 *   safety.json    what the guard passed, answered and blocked
 *
 * SAFETY (production is live). Every context gets installGuard() from
 * tests/design-audit/lib.mjs: every non-GET is answered by a fixture here or
 * blocked. The ONE real write is POST /api/observers/register or /wa-start with
 * a number the server refuses BY FORMAT (refusedByFormat below — same regexes as
 * backend normalizePhone), so no account, no OTP, no lookup. Every other number
 * in this file (FX_PHONE) is answered only by a fixture and never leaves the
 * browser. Telegram / WhatsApp links are aborted, never followed.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  chromium, CHROME, SITE, VIEWPORTS, REPO, installGuard, contextOptions, webInit, nativeInit,
  startStatic, sleep, log, FAKE_TOKEN, SAFETY,
} from '../../design-audit/lib.mjs';
import { makeFixtures } from '../../design-audit/fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const SURFACES = arg('surface', 'web,lite,native').split(',');
const LANGS_ = arg('lang', 'en,ha').split(',');
const FLOWS = arg('flow', 'signup,org,signin,session,firstrun,signout').split(',');
const VPK = arg('vp', 's360');
const VP = VIEWPORTS[VPK];
const OUT = path.join(REPO, 'tests/e2e/out/flows/onboarding');
const NATIVE_DIR = process.env.NATIVE_DIR || '/home/elrio/hawkeye/tmp/design-audit-native-web';
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------ strings */
const J = (p) => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8'));
const NI = { en: J('native/src/lib/i18n/en.json'), ha: J('native/src/lib/i18n/ha.json') };
const WI = { en: J('app/i18n/en.json'), ha: J('app/i18n/ha.json') };
const nt = (lang, key, vars) => {
  let s = NI[lang][key] || NI.en[key] || key;
  for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(String(v));
  return s;
};
/* Untranslated-English detector: a visible line that is exactly an English
   source string (web or native) and NOT also a Hausa string. */
const EN_VALS = new Set([...Object.values(WI.en), ...Object.values(NI.en)].filter((v) => typeof v === 'string' && /[a-z]{3}/i.test(v) && v.length >= 6).map((v) => v.trim()));
const HA_VALS = new Set([...Object.values(WI.ha), ...Object.values(NI.ha)].filter((v) => typeof v === 'string').map((v) => v.trim()));
const EN_WORDS = /\b(the|your|you|here|and|for|with|have|this|that|will|can|not|first|time|new|sign|account|password|number|code|forgot|instead|enter|again|already|please|check|wrong|send|choose|only|don't|didn't)\b/gi;
const ALLOW = /^(HAWKEYE|EN|HA|Telegram|WhatsApp|SMS|OTP|FAQ|INEC|EC8A|HK-[A-Z0-9]+|[\d\s+·•—\-:/().,%]+)$/;
function untranslated(text, lang) {
  if (lang === 'en') return [];
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    if (!l || ALLOW.test(l) || HA_VALS.has(l)) continue;
    if (EN_VALS.has(l)) { out.push(l); continue; }
    const hits = new Set((l.match(EN_WORDS) || []).map((w) => w.toLowerCase()));
    if (hits.size >= 2) out.push(l);
  }
  return [...new Set(out)];
}

/* ------------------------------------------------------------ numbers */
const BAD_NUMBER = '0123 456 7890';   // not a Nigerian mobile: refused by format, nothing looked up or sent
const FX_PHONE = '0700 000 0000';     // valid format, answered ONLY by fixtures here
const refusedByFormat = (raw) => {
  const p = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^\+?888/.test(p)) return true;
  return !(/^0[789][01]\d{8}$/.test(p) || /^\+234[789][01]\d{8}$/.test(p));
};
const ORG_CODE = 'ORG-ABCD-EFGH-JKMN';  // well-formed, invented; answered by fixture
const PW = 'correct horse 8';

/* ------------------------------------------------------------ results */
const STEPS = {};
const CHECKS = {};
const CONTROLS = {};
const ERRORS = [];
let REAL_WRITES = [];
const rel = (f) => path.relative(OUT, f);
function chk(flow, surface, lang, name, value, png = null) {
  ((CHECKS[flow] ??= {})[surface] ??= {})[lang] ??= {};
  CHECKS[flow][surface][lang][name] = { value, png };
  return value;
}
const C = (flow, surface, lang, name) => CHECKS[flow]?.[surface]?.[lang]?.[name];
const CV = (flow, surface, lang, name) => C(flow, surface, lang, name)?.value;

function recorder(flow, surface, lang) {
  const dir = path.join(OUT, flow);
  fs.mkdirSync(dir, { recursive: true });
  const steps = [];
  ((STEPS[flow] ??= {})[surface] ??= {})[lang] = steps;
  let n = 0;
  let taps = 0;
  const R = {
    steps,
    last: null,
    tap(k = 1) { taps += k; },
    async step(page, screen, { asked = null, note = '' } = {}) {
      // A Chrome network-error page is THIS MACHINE's network (ERR_NETWORK_CHANGED under WSL), not the app: reload once.
      if (page.url().startsWith('chrome-error')) {
        note = `${note} [harness: chrome network-error page, reloaded]`.trim();
        await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await sleep(3500);
      }
      const f = path.join(dir, `step-${String(++n).padStart(2, '0')}-${surface}-${lang}-${slug(screen)}.png`);
      await page.screenshot({ path: f }).catch(() => {});
      const text = await vtext(page);
      const a = asked ?? await askedOn(page, surface);
      const s = { n, screen, asked: a, taps, note, url: page.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, 'native:'), png: rel(f), text: text.slice(0, 900) };
      taps = 0;
      steps.push(s);
      R.last = s;
      if (lang !== 'en') {
        const u = untranslated(text, lang);
        if (u.length) ((CHECKS[flow] ??= {})[surface] ??= {})[lang] ??= {}, (CHECKS[flow][surface][lang].untranslated ??= { value: [], png: [] }), CHECKS[flow][surface][lang].untranslated.value.push(...u.map((x) => `${screen}: ${x}`)), CHECKS[flow][surface][lang].untranslated.png.push(s.png);
      }
      return s;
    },
  };
  return R;
}
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 48);

/* ------------------------------------------------------------ page helpers */
async function vtext(page) {
  return page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
}
/** What the screen asks for: visible fields (and native's route chips). */
async function askedOn(page, surface) {
  return page.evaluate((surface) => {
    const vis = (el) => {
      if (!el || el.closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };
    const out = [];
    const radios = {};
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden' || !vis(el) && !(el.type === 'radio' && vis(el.closest('label')))) continue;
      if (el.closest('.hk-dlg')) continue;
      if (el.type === 'radio') {
        const lab = el.closest('label');
        (radios[el.name || 'radio'] ??= []).push(((lab && lab.innerText.trim()) || el.value).split('—')[0].trim());
        continue;
      }
      const lab = el.id && document.querySelector(`label[for="${el.id}"]`);
      const name = (lab && lab.innerText.trim()) || el.getAttribute('aria-label') || el.placeholder || el.id || el.name || '?';
      out.push(`${el.type === 'password' ? 'password' : el.type === 'tel' ? 'phone' : el.tagName.toLowerCase() === 'select' ? 'select' : 'text'}: ${name}`.slice(0, 60));
    }
    for (const [k, v] of Object.entries(radios)) out.push(`choice ${k}: ${v.join(' / ')}`);
    if (surface === 'native') {
      const chips = [...document.querySelectorAll('div')].filter((d) => vis(d) && d.children.length <= 1 && /^(Telegram|WhatsApp|SMS · .*)$/.test((d.innerText || '').trim()));
      const names = [...new Set(chips.map((d) => d.innerText.trim().split(' · ')[0]))];
      if (names.length) out.push(`choice route: ${names.join(' / ')}`);
    }
    return out;
  }, surface).catch(() => []);
}
/** Is the element on screen (in the layout viewport)? */
async function inView(page, loc) {
  const b = await loc.boundingBox().catch(() => null);
  if (!b) return false;
  const vh = page.viewportSize().height;
  return b.y >= -2 && b.y + b.height <= vh + 2 && b.height > 0;
}
/** Field-top to button-bottom: more than the room left above a keyboard means both can never be on screen at once. */
async function span(page, a, b) {
  const x = await a.boundingBox().catch(() => null);
  const y = await b.boundingBox().catch(() => null);
  return x && y ? Math.round(y.y + y.height - x.y) : null;
}
const LOADING = /(Loading…|Loading\.\.\.|Ana lodawa|Ana loda|Getting your code…|Sending a fresh code…)/;
/* #btn-auth carries aria-disabled until a route is picked but still takes the
   tap (it shows the "choose a route" line), so a user CAN press it. */
const FORCE = { force: true };

/* ------------------------------------------------------------ browser */
const browser = await chromium.launch({ executablePath: CHROME, args: ['--font-render-hinting=none'] });
let server = null;
let NBASE = null;

/**
 * A context with the guard, plus this flow's own answers:
 *   A['POST /api/observers/register'] = {status,json} | fn(body,url,req) | [queue…] | {abort:true} | {hang:true}
 * Anything not in A falls back to the guard (makeFixtures, public GET pass-through, write blocked).
 */
async function open(surface, { lang = 'en', signedIn = false, tourSeen = true, variant = 'empty', allowReal = false, deadAuth = null } = {}) {
  const ctx = await browser.newContext(contextOptions(VP, { theme: 'dark' }));
  const api = [];
  await installGuard(ctx, {
    signedIn: true, crossOrigin: surface === 'native', fixtures: makeFixtures(variant),
    onApi: (x) => api.push(x),
  });
  // Never follow a Telegram / WhatsApp hand-off.
  await ctx.route(/^(https?:\/\/)?(t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\b/, (r) => r.abort('blockedbyclient'));
  const A = {};
  const calls = [];
  const st = { dead: deadAuth };   // st.dead = {status, json} answers EVERY authed /api/ call (session-end flow)
  await ctx.route(/^https?:\/\/(hawkeye\.com\.ng|127\.0\.0\.1:\d+)\/api\//, async (route) => {
    const req = route.request();
    const m = req.method();
    if (m === 'OPTIONS') return route.fallback();
    const u = new URL(req.url());
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = req.postData(); }
    const hasAuth = !!req.headers().authorization;
    let a;
    if (st.dead && hasAuth && !/\/api\/observers\/(login|verify|register|resume|set-password|sign-out)$/.test(u.pathname)) a = st.dead;
    else {
      a = A[`${m} ${u.pathname}`] ?? A[u.pathname];
      if (Array.isArray(a)) a = a.length > 1 ? a.shift() : a[0];
      if (typeof a === 'function') a = a(body, u, req);
    }
    if (a === undefined) return route.fallback();
    calls.push({ m, p: u.pathname, body, status: a.status ?? (a.abort ? 'ABORT' : a.hang ? 'HANG' : 200), at: Date.now() });
    if (a.abort) return route.abort('internetdisconnected');
    if (a.hang) return;   // never answered
    await sleep(a.delay ?? 350);
    const origin = req.headers().origin || '*';
    return route.fulfill({
      status: a.status || 200,
      headers: { 'content-type': a.html ? 'text/html' : 'application/json', 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
      body: a.html ? a.html : JSON.stringify(a.json ?? {}),
    });
  });
  // THE ONE REAL WRITE: sign-up with a number refused by format. Registered last = runs first.
  await ctx.route(/^https:\/\/hawkeye\.com\.ng\/api\/observers\/(register|wa-start)$/, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    let phone = '';
    try { phone = JSON.parse(req.postData() || '{}').phone; } catch { /* not JSON */ }
    if (!allowReal || !refusedByFormat(phone)) return route.fallback();
    let r;
    let buf;
    try {
      r = await fetch(req.url(), { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'hawkeye-flow-walkthrough' }, body: req.postData(), signal: AbortSignal.timeout(20000) });
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      // This machine could not reach production: the page sees a network failure, as an offline phone would.
      ERRORS.push(`real write not delivered (harness network): ${e.message}`);
      return route.abort('failed');
    }
    REAL_WRITES.push({ path: new URL(req.url()).pathname, phone, status: r.status, body: buf.toString().slice(0, 300) });
    calls.push({ m: 'POST', p: new URL(req.url()).pathname, body: JSON.parse(req.postData() || '{}'), status: r.status, real: true, at: Date.now() });
    return route.fulfill({ status: r.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': req.headers().origin || '*' }, body: buf });
  });
  /* Storage is seeded ONCE per tab (lib.mjs webInit/nativeInit clear it on every
     navigation, which would sign a just-created account out on the next page);
     the Lite Capacitor stub and the native font are applied on every load. */
  await ctx.addInitScript(([surface, signedIn, lang, tourSeen, token]) => {
    if (window !== window.top) return;
    let first = true;
    try { first = !sessionStorage.getItem('__fw_seeded'); sessionStorage.setItem('__fw_seeded', '1'); } catch (e) { /* */ }
    if (first) {
      try {
        localStorage.clear();
        localStorage.setItem('hawkeye_lang', lang);
        if (surface === 'native') {
          localStorage.setItem('hawkeye.theme.pref', 'dark');
          if (tourSeen) localStorage.setItem('hawkeye_tour_seen', '1');
          if (signedIn) { localStorage.setItem('hawkeye.auth.token', token); localStorage.setItem('hawkeye.auth.observer', '7'); }
        } else {
          localStorage.setItem('hawkeye_theme', 'dark');
          if (tourSeen) localStorage.setItem('hawkeye_tour_seen', '1');
          if (signedIn) localStorage.setItem('hawkeye_token', token);
        }
      } catch (e) { /* storage blocked */ }
    }
    if (surface === 'lite') {
      try { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', platform: 'android', Plugins: {}, convertFileSrc: (p) => p, isPluginAvailable: () => false }; } catch (e) { /* */ }
      const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
      mark();
      document.addEventListener('readystatechange', mark);
      document.addEventListener('DOMContentLoaded', mark);
    }
    if (surface === 'native') {
      const addFont = () => {
        if (!document.head || document.getElementById('da-roboto')) return;
        const l = document.createElement('link');
        l.id = 'da-roboto'; l.rel = 'stylesheet';
        l.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=block';
        document.head.appendChild(l);
      };
      addFont();
      document.addEventListener('readystatechange', addFont);
      document.addEventListener('DOMContentLoaded', addFont);
    }
  }, [surface, signedIn, lang, tourSeen, FAKE_TOKEN]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push({ url: f.url(), at: Date.now() }); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 160)));
  return { ctx, page, A, calls, api, navs, st, errs };
}
const url = (surface, p) => (surface === 'native' ? `${NBASE}${p}` : `${SITE}/${p.replace(/^\//, '')}`);
async function go(page, u) {
  for (let i = 0; i < 2; i++) {
    const ok = await page.goto(u, { waitUntil: 'load', timeout: 60000 }).then(() => true).catch((e) => { if (i) ERRORS.push(`goto ${u}: ${e.message}`); return false; });
    if (ok && !page.url().startsWith('chrome-error')) break;
    await sleep(2000);
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
}
async function webAuthReady(page) {
  await page.waitForSelector('#screen-register:not([hidden])', { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => typeof document.getElementById('btn-auth')?.onclick === 'function', null, { timeout: 15000 }).catch(() => {});
  await sleep(900);
}
async function nativeReady(page) {
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 20, null, { timeout: 25000 }).catch(() => {});
  await sleep(1800);
}
/** Native: a visible element with exactly this text. */
const nbtn = (page, label) => page.getByText(label, { exact: true }).filter({ visible: true }).first();
async function nclick(page, label, R) {
  const l = nbtn(page, label);
  if (!(await l.isVisible().catch(() => false))) return false;
  await l.click({ timeout: 6000 }).catch(() => {});
  if (R) R.tap();
  await sleep(700);
  return true;
}
/** Native inputs in DOM order (react-native-web TextInput = <input>). */
const ninputs = (page) => page.locator('input:visible');
async function nfill(page, i, v, R) {
  const l = ninputs(page).nth(i);
  await l.click({ timeout: 5000 }).catch(() => {});
  await l.fill(v).catch(() => {});
  if (R) R.tap();
  await sleep(250);
}
const errLine = async (page) => page.evaluate(() => {
  const e = document.getElementById('auth-err');
  return e && !e.hidden ? e.textContent.trim() : '';
}).catch(() => '');
const tokenOf = async (page, surface) => page.evaluate((s) => {
  try { return localStorage.getItem(s === 'native' ? 'hawkeye.auth.token' : 'hawkeye_token'); } catch { return null; }
}, surface).catch(() => null);

/* ------------------------------------------------------------ fixtures */
const OK_REG = { status: 200, json: { ok: true, viaTelegram: true } };
const OK_VERIFY_NEW = { status: 200, json: { ok: true, observerId: 7, token: FAKE_TOKEN, isNew: true, needsUnit: true, hasPassword: false } };
const OK_VERIFY_OLD = { status: 200, json: { ok: true, observerId: 7, token: FAKE_TOKEN, isNew: false, needsUnit: false, hasPassword: true } };
const OK_LOGIN = { status: 200, json: { ok: true, observerId: 7, token: FAKE_TOKEN } };
const OK = { status: 200, json: { ok: true } };
const WA_START = { status: 200, json: { ok: true, code: 'HK-7Q2M4X', waLink: 'https://wa.me/2340000000000?text=HK-7Q2M4X', waNumber: '+234 000 000 0000', pollToken: 'pt-flow-walkthrough', expiresInS: 600, pollAfterMs: 2000 } };
const WA_PENDING = { status: 200, json: { ok: true, status: 'pending', mismatch: false, retryAfterMs: 3000 } };
const WA_VERIFIED = { status: 200, json: { ok: true, status: 'verified', observerId: 7, token: FAKE_TOKEN, isNew: true, needsUnit: true, hasPassword: false } };
const E = (status, error, extra = {}) => ({ status, json: { error, ...extra } });
const ORG_ROOM = {
  id: 41, name: 'Sample Party Lagos Agents', kind: 'party', contest: 'GOV', scope: 'Lagos', slug: 'sample-party-lagos', manages: null,
  assigned_pu: null, assign_state: '', joined_at: Date.now(), member_state: '',
  assigned_name: null, assigned_ward: null, assigned_lga: null, assigned_state: null,
  scope_label: 'Lagos', party: 'SPN', party_claim: null, party_state: 'verified', org: null, org_claim: null, org_state: null, org_listed: null,
};

/* ================================================================== FLOW 1: sign-up */
async function signupWeb(surface, lang) {
  const flow = 'signup';
  const full = lang === 'en';
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang, allowReal: true });
  const { page, A, calls } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  try {
    // 1. The first screen a stranger sees.
    await go(page, url(surface, 'index.html'));
    await sleep(2500);
    let s = await R.step(page, surface === 'lite' ? 'first launch' : 'landing (signed out)');
    const first = /intent=signin/.test(page.url()) ? 'sign-in form' : /observe\.html/.test(page.url()) ? 'sign-up form' : 'landing page';
    ck('firstScreen', first, s.png);
    // 2. To the sign-up form.
    if (first === 'landing page') {
      const cta = page.locator('a.btn-accent[href="observe.html?intent=observe"]:visible').first();
      await cta.click().catch(() => {});
      R.tap();
    } else if (first === 'sign-in form') {
      await page.locator('#signup-line a').click().catch(() => {});
      R.tap();
    }
    await webAuthReady(page);
    await page.waitForSelector('#otp-sms-opt:not([hidden])', { timeout: 6000 }).catch(() => {});
    s = await R.step(page, 'sign-up form');
    ck('signupAsked', s.asked, s.png);
    ck('pwOnFirstScreen', await page.locator('#pw-opt-input').isVisible().catch(() => false), s.png);
    ck('smsOffered', await page.locator('#otp-sms-opt').isVisible().catch(() => false), s.png);

    // 3. Send with nothing chosen: nothing may be sent.
    await page.fill('#auth-input', FX_PHONE); R.tap();
    const before = calls.filter((c) => /register|wa-start/.test(c.p)).length;
    await page.click('#btn-auth', FORCE); R.tap();
    await sleep(1200);
    const needShown = await page.locator('#channel-need').isVisible().catch(() => false);
    s = await R.step(page, 'send with no route chosen');
    ck('noRouteSendsNothing', calls.filter((c) => /register|wa-start/.test(c.p)).length === before, s.png);
    ck('noRoutePrompt', needShown ? (await page.locator('#channel-need').innerText()) : '', s.png);

    // 4. A number the server refuses by format — the one real write.
    await page.fill('#auth-input', BAD_NUMBER); R.tap();
    await page.check('input[name=otp-channel][value=telegram]', { force: true }); R.tap();
    await page.click('#btn-auth', FORCE); R.tap();
    await page.waitForFunction(() => !document.getElementById('auth-err').hidden, null, { timeout: 15000 }).catch(() => {});
    s = await R.step(page, 'bad number (real refusal)');
    ck('channelSends', calls.some((c) => c.real), s.png);   // CONTROL for noRouteSendsNothing
    ck('badNumberMsg', await errLine(page), s.png);
    ck('badNumberKept', await page.inputValue('#auth-input').catch(() => ''), s.png);

    // 5. Server-side failures on a well-formed number (fixtures).
    if (full) {
      for (const [name, ans] of [['err429', E(429, 'too_many_requests')], ['err500', E(500, 'internal_error')], ['err502html', { status: 502, html: '<html><body>Bad gateway</body></html>' }], ['errSmsFailed', E(502, 'sms_send_failed')], ['errOffline', { abort: true }]]) {
        A['POST /api/observers/register'] = ans;
        await page.fill('#auth-input', FX_PHONE); R.tap();
        await page.click('#btn-auth', FORCE); R.tap();
        await sleep(1500);
        s = await R.step(page, `send code: ${name}`);
        ck(`${name}Msg`, await errLine(page), s.png);
        ck(`${name}Kept`, await page.inputValue('#auth-input').catch(() => ''), s.png);
      }
    }
    // 6. Code sent.
    A['POST /api/observers/register'] = OK_REG;
    await page.fill('#auth-input', FX_PHONE); R.tap();
    await page.check('input[name=otp-channel][value=telegram]', { force: true });
    await page.click('#btn-auth', FORCE); R.tap();
    await page.waitForFunction(() => document.getElementById('btn-auth').textContent && document.getElementById('auth-reset') && !document.getElementById('auth-reset').hidden, null, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    s = await R.step(page, 'code screen');
    ck('codeAsked', s.asked, s.png);
    const regBody = calls.filter((c) => c.p === '/api/observers/register' && !c.real).pop()?.body;
    ck('registerBody', regBody, s.png);
    ck('pwOnCodeScreen', await page.locator('#pw-opt-input').isVisible().catch(() => false), s.png);
    // Resend: is there a timer / cooldown?
    const resend = page.locator('#otp-resend');
    ck('resendVisible', await resend.isVisible().catch(() => false), s.png);
    if (full) {
      const n0 = calls.filter((c) => c.p === '/api/observers/register').length;
      await resend.click().catch(() => {}); await sleep(900);
      await resend.click().catch(() => {}); await sleep(900);
      s = await R.step(page, 'resend tapped twice');
      ck('resendNoCooldown', calls.filter((c) => c.p === '/api/observers/register').length - n0, s.png);
    }
    // 7. Verify with a code but no password: is the password checked before the code?
    await page.fill('#auth-input', '123456'); R.tap();
    const v0 = calls.filter((c) => c.p === '/api/observers/verify').length;
    await page.click('#btn-auth', FORCE); R.tap();
    await sleep(1200);
    s = await R.step(page, 'verify without a password');
    ck('pwCheckedBeforeCode', { verifyCalled: calls.filter((c) => c.p === '/api/observers/verify').length > v0, msg: await errLine(page) }, s.png);
    // 8. Wrong / expired / too many.
    await page.fill('#pw-opt-input', PW); R.tap();
    for (const [name, ans] of (full ? [['wrongCode', E(400, 'otp_incorrect')], ['expired', E(400, 'otp_expired')], ['tooManyCodes', E(429, 'too_many_attempts')], ['verifyOffline', { abort: true }]] : [['wrongCode', E(400, 'otp_incorrect')]])) {
      A['POST /api/observers/verify'] = ans;
      await page.fill('#auth-input', '123456'); R.tap();
      await page.click('#btn-auth', FORCE); R.tap();
      await sleep(1400);
      s = await R.step(page, `verify: ${name}`);
      ck(`${name}Msg`, await errLine(page), s.png);
      ck(`${name}PwKept`, (await page.inputValue('#pw-opt-input').catch(() => '')).length > 0, s.png);
    }
    // 9. Keyboard up on the code screen.
    await page.focus('#auth-input').catch(() => {});
    await page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) });
    await sleep(900);
    s = await R.step(page, 'code screen, keyboard up');
    ck('kbdCode', { field: await inView(page, page.locator('#auth-input')), button: await inView(page, page.locator('#btn-auth')), span: await span(page, page.locator('#auth-input'), page.locator('#btn-auth')), room: page.viewportSize().height }, s.png);
    await page.setViewportSize({ width: VP.width, height: VP.height });
    await sleep(400);
    // 10. Reload mid-flow.
    if (full) {
      await page.reload({ waitUntil: 'load' }).catch(() => {});
      await webAuthReady(page);
      s = await R.step(page, 'reload on the code screen');
      ck('reloadAtCode', { mode: await page.locator('#auth-reset').isVisible().catch(() => false) ? 'code' : 'phone entry', number: await page.inputValue('#auth-input').catch(() => ''), pw: (await page.inputValue('#pw-opt-input').catch(() => '')).length }, s.png);
      // back to the code screen
      await page.fill('#auth-input', FX_PHONE);
      await page.check('input[name=otp-channel][value=telegram]', { force: true });
      await page.click('#btn-auth', FORCE);
      await sleep(1500);
      // 11. "Use a different number".
      await page.click('#auth-reset').catch(() => {});
      await sleep(700);
      s = await R.step(page, 'use a different number');
      ck('changeNumberKeeps', { number: await page.inputValue('#auth-input').catch(() => ''), route: await page.locator('input[name=otp-channel]:checked').count(), pw: (await page.inputValue('#pw-opt-input').catch(() => '')).length }, s.png);
      // 12. Browser Back from the code screen.
      await page.fill('#auth-input', FX_PHONE);
      await page.check('input[name=otp-channel][value=telegram]', { force: true });
      await page.click('#btn-auth', FORCE);
      await sleep(1500);
      await page.goBack({ waitUntil: 'load' }).catch(() => {});
      await sleep(1500);
      s = await R.step(page, 'browser Back on the code screen');
      ck('backAtCode', page.url(), s.png);
      await go(page, url(surface, 'observe.html?intent=observe'));
      await webAuthReady(page);
      await page.fill('#auth-input', FX_PHONE);
      await page.check('input[name=otp-channel][value=telegram]', { force: true });
      await page.click('#btn-auth', FORCE);
      await sleep(1500);
    }
    // 13. Correct code -> account.
    A['POST /api/observers/verify'] = OK_VERIFY_NEW;
    A['POST /api/observers/set-password'] = OK;
    await page.fill('#pw-opt-input', PW); R.tap();
    await page.fill('#auth-input', '123456'); R.tap();
    await page.click('#btn-auth', FORCE); R.tap();
    await page.waitForURL(/choose-unit|observe\.html.*|index\.html/, { timeout: 15000 }).catch(() => {});
    await sleep(2500);
    s = await R.step(page, 'after verify (arrival)');
    ck('arrival', page.url().replace(SITE, ''), s.png);
    ck('tokenStored', !!(await tokenOf(page, surface)), s.png);
    ck('setPasswordCalled', calls.some((c) => c.p === '/api/observers/set-password'), s.png);
  } catch (e) { ERRORS.push(`${flow}/${surface}/${lang}: ${e.message}`); }
  await X.ctx.close();

  // ---- the WhatsApp route (free: the observer sends US the code) ----
  const W = await open(surface, { lang, allowReal: true });
  const RW = recorder('signup-whatsapp', surface, lang);
  const ckw = (n, v, png) => chk('signup-whatsapp', surface, lang, n, v, png ?? RW.last?.png);
  try {
    await go(W.page, url(surface, 'observe.html?intent=observe'));
    await webAuthReady(W.page);
    await RW.step(W.page, 'sign-up form');
    await W.page.fill('#auth-input', BAD_NUMBER); RW.tap();
    await W.page.check('input[name=otp-channel][value=whatsapp]', { force: true }); RW.tap();
    await W.page.click('#btn-auth', FORCE); RW.tap();
    await sleep(1500);
    let s = await RW.step(W.page, 'WhatsApp, no password yet');
    ckw('waNeedsPwFirst', { msg: await errLine(W.page), started: W.calls.some((c) => c.p === '/api/observers/wa-start') }, s.png);
    await W.page.fill('#pw-opt-input', PW); RW.tap();
    await W.page.click('#btn-auth', FORCE); RW.tap();
    await sleep(2500);
    s = await RW.step(W.page, 'WhatsApp, bad number (real refusal)');
    ckw('waRealStatus', W.calls.filter((c) => c.real).map((c) => c.status), s.png);
    ckw('waBadMsg', await errLine(W.page), s.png);
    W.A['POST /api/observers/wa-start'] = WA_START;
    W.A['POST /api/observers/wa-status'] = [WA_PENDING, WA_VERIFIED];
    W.A['POST /api/observers/set-password'] = OK;
    W.A['POST /api/observers/wa-cancel'] = OK;
    await W.page.fill('#auth-input', FX_PHONE); RW.tap();
    await W.page.click('#btn-auth', FORCE); RW.tap();
    await W.page.waitForSelector('#wa-send:not([hidden])', { timeout: 10000 }).catch(() => {});
    await sleep(800);
    s = await RW.step(W.page, 'send us this code (waiting)');
    ckw('waAsked', s.asked, s.png);
    await W.page.waitForURL(/choose-unit/, { timeout: 25000 }).catch(() => {});
    await sleep(2000);
    s = await RW.step(W.page, 'after WhatsApp proof (arrival)');
    ckw('waArrival', W.page.url().replace(SITE, ''), s.png);
    ckw('waSetPwBody', W.calls.find((c) => c.p === '/api/observers/set-password')?.body ? 'sent' : 'not sent', s.png);
  } catch (e) { ERRORS.push(`signup-whatsapp/${surface}/${lang}: ${e.message}`); }
  await W.ctx.close();

  // ---- "Create account" with a number that already has an account + password ----
  if (full) {
    const Q = await open(surface, { lang });
    const RQ = recorder('signup-existing', surface, lang);
    try {
      Q.A['POST /api/observers/register'] = OK_REG;
      Q.A['POST /api/observers/verify'] = OK_VERIFY_OLD;
      Q.A['POST /api/observers/set-password'] = OK;
      await go(Q.page, url(surface, 'observe.html?intent=observe'));
      await webAuthReady(Q.page);
      await Q.page.fill('#auth-input', FX_PHONE); RQ.tap();
      await Q.page.check('input[name=otp-channel][value=telegram]', { force: true }); RQ.tap();
      await Q.page.fill('#pw-opt-input', PW); RQ.tap();
      await Q.page.click('#btn-auth', FORCE); RQ.tap();
      await sleep(1500);
      await RQ.step(Q.page, 'code screen (number already registered)');
      await Q.page.fill('#auth-input', '123456'); RQ.tap();
      await Q.page.click('#btn-auth', FORCE); RQ.tap();
      await sleep(5000);
      const s = await RQ.step(Q.page, 'after verify (existing account)');
      chk('signup', surface, lang, 'existingNumber', {
        registerIntent: Q.calls.find((c) => c.p === '/api/observers/register')?.body?.intent ?? null,
        codeSent: Q.calls.some((c) => c.p === '/api/observers/register'),
        passwordOverwritten: Q.calls.some((c) => c.p === '/api/observers/set-password'),
        toldExists: /already|tuni|riga/i.test(await vtext(Q.page)),
        arrival: Q.page.url().replace(SITE, ''),
      }, s.png);
    } catch (e) { ERRORS.push(`signup-existing/${surface}: ${e.message}`); }
    await Q.ctx.close();
  }

  // ---- keyboard up on the first form ----
  if (full) {
    const K = await open(surface, { lang });
    const RK = recorder('signup-keyboard', surface, lang);
    try {
      await go(K.page, url(surface, 'observe.html?intent=observe'));
      await webAuthReady(K.page);
      // CONTROL for inView, at full height: the title is on screen, the footer is not.
      CONTROLS.inView = { offscreenFooter: await inView(K.page, K.page.locator('footer.gov-footer')), onscreenTitle: await inView(K.page, K.page.locator('#register-title')) };
      await K.page.focus('#auth-input');
      await K.page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) });
      await sleep(1000);
      const s = await RK.step(K.page, 'sign-up form, keyboard up (phone field)');
      chk('signup', surface, lang, 'kbdForm', { field: await inView(K.page, K.page.locator('#auth-input')), button: await inView(K.page, K.page.locator('#btn-auth')), span: await span(K.page, K.page.locator('#auth-input'), K.page.locator('#btn-auth')), room: K.page.viewportSize().height }, s.png);
    } catch (e) { ERRORS.push(`signup-keyboard/${surface}: ${e.message}`); }
    await K.ctx.close();
  }
}

async function signupNative(lang) {
  const flow = 'signup';
  const surface = 'native';
  const full = lang === 'en';
  const L = (k, v) => nt(lang, k, v);
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang, allowReal: true });
  const { page, A, calls } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  const toForm = async (rec) => {
    await go(page, `${NBASE}/`);
    await nativeReady(page);
    if (rec) {
      const s = await R.step(page, 'welcome (first launch)');
      ck('firstScreen', /welcome/.test(page.url()) ? 'welcome' : page.url(), s.png);
    }
    await nclick(page, L('index.become-an-observer'), rec ? R : null);
    await sleep(1200);
  };
  try {
    await toForm(true);
    let s = await R.step(page, 'sign-up form');
    ck('signupAsked', s.asked, s.png);
    ck('pwOnFirstScreen', (await page.locator('input[type=password]:visible').count()) > 0, s.png);
    ck('smsOffered', await page.getByText(/^SMS · /).first().isVisible().catch(() => false), s.png);
    // Send with no route: nothing sent.
    await nfill(page, 0, FX_PHONE, R);
    const before = calls.filter((c) => /register|wa-start/.test(c.p)).length;
    await nclick(page, L('n.app.profile.send-code'), R);
    await sleep(800);
    s = await R.step(page, 'send with no route chosen');
    ck('noRouteSendsNothing', calls.filter((c) => /register|wa-start/.test(c.p)).length === before, s.png);
    ck('noRoutePrompt', (await vtext(page)).includes(L('auth.choose-route')) ? L('auth.choose-route') : '', s.png);
    // Bad number (real refusal).
    await nfill(page, 0, BAD_NUMBER, R);
    await nclick(page, 'Telegram', R);
    await nclick(page, L('n.app.profile.send-code'), R);
    for (let i = 0; i < 40 && !calls.some((c) => c.real); i++) await sleep(500);   // production can take seconds
    await sleep(1200);
    s = await R.step(page, 'bad number (real refusal)');
    ck('channelSends', calls.some((c) => c.real), s.png);
    ck('badNumberMsg', (await vtext(page)).includes(L('n.auth.wa-invalid-phone')) ? L('n.auth.wa-invalid-phone') : '(see text)', s.png);
    ck('badNumberKept', await ninputs(page).nth(0).inputValue().catch(() => ''), s.png);
    if (full) {
      for (const [name, ans] of [['err429', E(429, 'too_many_requests')], ['err500', E(500, 'internal_error')], ['err502html', { status: 502, html: '<html><body>Bad gateway</body></html>' }], ['errSmsFailed', E(502, 'sms_send_failed')], ['errOffline', { abort: true }], ['accountExists', E(409, 'account_exists', { hint: 'This number is already registered. Sign in with your password, or reset it.' })]]) {
        A['POST /api/observers/register'] = ans;
        await nfill(page, 0, FX_PHONE, R);
        await nclick(page, L('n.app.profile.send-code'), R);
        await sleep(2000);
        s = await R.step(page, `send code: ${name}`);
        const t = await vtext(page);
        ck(`${name}Msg`, t.split('\n').filter((x) => x.trim()).slice(-4).join(' | '), s.png);
        ck(`${name}Kept`, await ninputs(page).nth(0).inputValue().catch(() => ''), s.png);
        if (name === 'accountExists') {
          ck('accountExistsStep', t.includes(L('n.app.sign-in.this-account-already-exists')), s.png);
          await nclick(page, L('n.app.sign-in.use-a-different-number'));
          await sleep(800);
        }
      }
    }
    // Code sent.
    A['POST /api/observers/register'] = OK_REG;
    await nfill(page, 0, FX_PHONE, R);
    if (!(await nbtn(page, L('n.app.profile.send-code')).isVisible().catch(() => false))) { await toForm(false); await nfill(page, 0, FX_PHONE, R); await nclick(page, 'Telegram', R); }
    await nclick(page, L('n.app.profile.send-code'), R);
    await sleep(1500);
    s = await R.step(page, 'code screen');
    ck('codeAsked', s.asked, s.png);
    ck('registerBody', calls.filter((c) => c.p === '/api/observers/register' && !c.real).pop()?.body, s.png);
    ck('pwOnCodeScreen', (await page.locator('input[type=password]:visible').count()) > 0, s.png);
    const t0 = await vtext(page);
    ck('resendCooldown', /\d+\s*s/.test(t0) ? (t0.match(/[^\n]*\d+\s*s[^\n]*/) || [''])[0] : 'none', s.png);
    // Wrong / expired / too many.
    for (const [name, ans] of (full ? [['wrongCode', E(400, 'otp_incorrect')], ['expired', E(400, 'otp_expired')], ['tooManyCodes', E(429, 'too_many_attempts')], ['verifyOffline', { abort: true }]] : [['wrongCode', E(400, 'otp_incorrect')]])) {
      A['POST /api/observers/verify'] = ans;
      await nfill(page, 0, '123456', R);
      await nclick(page, L('n.app.profile.verify'), R);
      await sleep(1500);
      s = await R.step(page, `verify: ${name}`);
      const lines = (await vtext(page)).split('\n').map((x) => x.trim()).filter(Boolean);
      ck(`${name}Msg`, lines[lines.indexOf(L('n.app.sign-in.enter-the-code')) + 1] || '', s.png);
    }
    // Keyboard up on the code screen.
    await ninputs(page).nth(0).focus().catch(() => {});
    await page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) });
    await sleep(900);
    s = await R.step(page, 'code screen, keyboard up');
    ck('kbdCode', { field: await inView(page, ninputs(page).nth(0)), button: await inView(page, nbtn(page, L('n.app.profile.verify'))), span: await span(page, ninputs(page).nth(0), nbtn(page, L('n.app.profile.verify'))), room: page.viewportSize().height }, s.png);
    await page.setViewportSize({ width: VP.width, height: VP.height });
    await sleep(400);
    if (full) {
      // Reload mid-flow.
      await page.reload({ waitUntil: 'load' }).catch(() => {});
      await nativeReady(page);
      s = await R.step(page, 'reload on the code screen');
      ck('reloadAtCode', { url: page.url().replace(NBASE, 'native:'), number: await ninputs(page).nth(0).inputValue().catch(() => '') }, s.png);
      // back into the code screen
      if (!(await nbtn(page, 'Telegram').isVisible().catch(() => false))) await toForm(false);
      await nfill(page, 0, FX_PHONE);
      await nclick(page, 'Telegram');
      await nclick(page, L('n.app.profile.send-code'));
      await sleep(1500);
      // Use a different number.
      await nclick(page, L('n.app.sign-in.use-a-different-number'));
      s = await R.step(page, 'use a different number');
      ck('changeNumberKeeps', { number: await ninputs(page).nth(0).inputValue().catch(() => '') }, s.png);
      // Header close (x) on the code screen = router.back(). From a real stack
      // (welcome -> sign-in), not the reloaded page above, which has no history.
      await toForm(false);
      await nfill(page, 0, FX_PHONE);
      await nclick(page, 'Telegram');
      await nclick(page, L('n.app.profile.send-code'));
      await sleep(1500);
      await page.mouse.click(34, 26);   // the header's close (x), top left
      await sleep(1800);
      s = await R.step(page, 'header close on the code screen');
      ck('backAtCode', page.url().replace(NBASE, 'native:'), s.png);
      await toForm(false);
      await nfill(page, 0, FX_PHONE);
      await nclick(page, 'Telegram');
      await nclick(page, L('n.app.profile.send-code'));
      await sleep(1500);
    }
    // Correct code -> password step -> account.
    A['POST /api/observers/verify'] = OK_VERIFY_NEW;
    A['POST /api/observers/set-password'] = OK;
    await nfill(page, 0, '123456', R);
    await nclick(page, L('n.app.profile.verify'), R);
    await sleep(2500);
    s = await R.step(page, 'password step (after the code)');
    ck('pwStepAsked', s.asked, s.png);
    if (full) {
      // Password that does not match.
      await nfill(page, 0, PW, R);
      await nfill(page, 1, PW + 'x', R);
      await nclick(page, L('n.app.sign-in.save-password-and-continue'), R);
      await sleep(900);
      s = await R.step(page, 'passwords do not match');
      ck('pwMismatchMsg', (await vtext(page)).includes(L('n.app.sign-in.the-two-passwords-do-not-match')), s.png);
    }
    await nfill(page, 0, PW, R);
    await nfill(page, 1, PW, R);
    await nclick(page, L('n.app.sign-in.save-password-and-continue'), R);
    await sleep(3500);
    s = await R.step(page, 'after password (arrival)');
    ck('arrival', page.url().replace(NBASE, 'native:'), s.png);
    ck('tokenStored', !!(await tokenOf(page, surface)), s.png);
    ck('setPasswordCalled', calls.some((c) => c.p === '/api/observers/set-password'), s.png);
  } catch (e) { ERRORS.push(`${flow}/native/${lang}: ${e.message}`); }
  await X.ctx.close();

  // ---- WhatsApp (free) ----
  const W = await open(surface, { lang, allowReal: true });
  const RW = recorder('signup-whatsapp', surface, lang);
  const ckw = (n, v, png) => chk('signup-whatsapp', surface, lang, n, v, png ?? RW.last?.png);
  try {
    await go(W.page, `${NBASE}/sign-in?intent=signup`);
    await nativeReady(W.page);
    await RW.step(W.page, 'sign-up form');
    await nfill(W.page, 0, BAD_NUMBER, RW);
    await nclick(W.page, 'WhatsApp', RW);
    await nclick(W.page, L('n.app.profile.send-code'), RW);
    await sleep(3000);
    let s = await RW.step(W.page, 'WhatsApp, bad number (real refusal)');
    ckw('waNeedsPwFirst', { msg: '', started: true }, s.png);
    ckw('waRealStatus', W.calls.filter((c) => c.real).map((c) => c.status), s.png);
    ckw('waBadMsg', (await vtext(W.page)).split('\n').filter(Boolean).slice(-3).join(' | '), s.png);
    W.A['POST /api/observers/wa-start'] = WA_START;
    W.A['POST /api/observers/wa-status'] = [WA_PENDING, WA_VERIFIED];
    W.A['POST /api/observers/set-password'] = OK;
    W.A['POST /api/observers/wa-cancel'] = OK;
    await nfill(W.page, 0, FX_PHONE, RW);
    await nclick(W.page, L('n.app.profile.send-code'), RW);
    await sleep(1500);
    s = await RW.step(W.page, 'send us this code (waiting)');
    ckw('waAsked', s.asked, s.png);
    await W.page.waitForFunction((t) => document.body.innerText.includes(t), L('n.app.sign-in.create-your-password'), { timeout: 25000 }).catch(() => {});
    await sleep(800);
    s = await RW.step(W.page, 'password step (after WhatsApp proof)');
    await nfill(W.page, 0, PW, RW);
    await nfill(W.page, 1, PW, RW);
    await nclick(W.page, L('n.app.sign-in.save-password-and-continue'), RW);
    await sleep(3000);
    s = await RW.step(W.page, 'after password (arrival)');
    ckw('waArrival', W.page.url().replace(NBASE, 'native:'), s.png);
  } catch (e) { ERRORS.push(`signup-whatsapp/native/${lang}: ${e.message}`); }
  await W.ctx.close();

  if (full) {
    const K = await open(surface, { lang });
    const RK = recorder('signup-keyboard', surface, lang);
    try {
      await go(K.page, `${NBASE}/sign-in?intent=signup`);
      await nativeReady(K.page);
      await ninputs(K.page).nth(0).focus();
      await K.page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) });
      await sleep(1000);
      const s = await RK.step(K.page, 'sign-up form, keyboard up (phone field)');
      chk('signup', surface, lang, 'kbdForm', { field: await inView(K.page, ninputs(K.page).nth(0)), button: await inView(K.page, nbtn(K.page, L('n.app.profile.send-code'))), span: await span(K.page, ninputs(K.page).nth(0), nbtn(K.page, L('n.app.profile.send-code'))), room: K.page.viewportSize().height }, s.png);
    } catch (e) { ERRORS.push(`signup-keyboard/native: ${e.message}`); }
    await K.ctx.close();
  }
}

/* ================================================================== FLOW 2: organisation code */
async function orgWeb(surface, lang) {
  const flow = 'org';
  const full = lang === 'en';
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang });
  const { page, A, calls } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  try {
    await go(page, url(surface, 'observe.html?intent=observe'));
    await webAuthReady(page);
    let s = await R.step(page, 'sign-up form');
    await page.fill('#auth-input', FX_PHONE); R.tap();
    await page.fill('#ref-input', 'ORG-ABCD'); R.tap();
    await sleep(500);
    s = await R.step(page, 'half-typed ORG code');
    ck('orgModeAt', { routesHidden: !(await page.locator('#channel-pick').isVisible()), button: (await page.locator('#btn-auth').innerText()).trim() }, s.png);
    await page.click('#btn-auth', FORCE); R.tap();
    await sleep(700);
    s = await R.step(page, 'incomplete ORG code');
    ck('orgBadFormat', await page.locator('#ref-err').isVisible() ? (await page.locator('#ref-err').innerText()).trim() : '', s.png);
    await page.fill('#ref-input', ORG_CODE); R.tap();
    await sleep(400);
    s = await R.step(page, 'full ORG code typed');
    ck('orgAsked', s.asked, s.png);
    await page.click('#btn-auth', FORCE); R.tap();
    await sleep(900);
    s = await R.step(page, 'create account, no password yet');
    ck('orgPwFirst', { msg: await errLine(page), dialog: await page.locator('.hk-dlg').isVisible().catch(() => false) }, s.png);
    await page.fill('#pw-opt-input', PW); R.tap();
    const errs = full ? [['orgInvalid', E(400, 'org_code_invalid')], ['orgUsed', E(409, 'org_code_used')], ['orgTaken', E(409, 'org_code_number_taken')], ['orgRevoked', E(410, 'org_code_revoked')], ['org429', E(429, 'too_many_requests')], ['orgOffline', { abort: true }]] : [['orgInvalid', E(400, 'org_code_invalid')]];
    for (const [name, ans] of errs) {
      A['POST /api/observers/org-signup'] = ans;
      await page.click('#btn-auth', FORCE); R.tap();
      await page.waitForSelector('.hk-dlg .hk-dlg-ok', { timeout: 6000 }).catch(() => {});
      if (name === errs[0][0]) { s = await R.step(page, 'is this your number? (confirm)'); ck('orgConfirm', (await page.locator('.hk-dlg').innerText().catch(() => '')).replace(/\n+/g, ' | '), s.png); }
      await page.click('.hk-dlg .hk-dlg-ok').catch(() => {}); R.tap();
      await sleep(1500);
      s = await R.step(page, `org sign-up: ${name}`);
      ck(`${name}Msg`, await errLine(page), s.png);
      ck(`${name}Kept`, { code: await page.inputValue('#ref-input').catch(() => ''), pw: (await page.inputValue('#pw-opt-input').catch(() => '')).length }, s.png);
    }
    // Success: account, the room joined server-side (fixtures say so from here on).
    A['POST /api/observers/org-signup'] = { status: 200, json: { ok: true, observerId: 7, token: FAKE_TOKEN, isNew: true, needsUnit: true, hasPassword: false } };
    A['POST /api/observers/set-password'] = OK;
    A['GET /api/groups'] = { status: 200, json: { managing: [], member: [ORG_ROOM] } };
    A['GET /api/my/rooms'] = { status: 200, json: { rooms: [{ id: 41, name: ORG_ROOM.name, kind: 'party', contest: 'GOV', assigned: null, checkedIn: null }] } };
    A['GET /api/notifications'] = { status: 200, json: { items: [{ id: 901, kind: 'group_joined', title: `You joined ${ORG_ROOM.name}`, body: ORG_ROOM.name, url: 'https://hawkeye.com.ng/my-groups.html', read: 0, created_at: Date.now() }], unread: 1 } };
    await page.click('#btn-auth', FORCE); R.tap();
    await page.waitForSelector('.hk-dlg .hk-dlg-ok', { timeout: 6000 }).catch(() => {});
    await page.click('.hk-dlg .hk-dlg-ok').catch(() => {}); R.tap();
    await page.waitForURL(/choose-unit/, { timeout: 15000 }).catch(() => {});
    await sleep(2500);
    s = await R.step(page, 'after org sign-up (arrival)');
    ck('orgArrival', page.url().replace(SITE, ''), s.png);
    ck('orgSetPw', calls.some((c) => c.p === '/api/observers/set-password'), s.png);
    // Skip the unit -> Home: is the room anywhere?
    const skip = page.locator('#cu-skip');
    if (await skip.isVisible().catch(() => false)) { await skip.click(); R.tap(); }
    await page.waitForURL(/index\.html|\/$/, { timeout: 15000 }).catch(() => {});
    await sleep(4000);
    s = await R.step(page, 'home after skipping the unit');
    const home = await vtext(page);
    ck('orgRoomOnHome', home.includes(ORG_ROOM.name), s.png);
    await go(page, url(surface, 'my-groups.html'));
    await sleep(3000);
    s = await R.step(page, 'my groups');
    ck('orgRoomInMyGroups', (await vtext(page)).includes(ORG_ROOM.name), s.png);
  } catch (e) { ERRORS.push(`${flow}/${surface}/${lang}: ${e.message}`); }
  await X.ctx.close();
}

async function orgNative(lang) {
  const flow = 'org';
  const surface = 'native';
  const full = lang === 'en';
  const L = (k, v) => nt(lang, k, v);
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang });
  const { page, A, calls } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  try {
    await go(page, `${NBASE}/sign-in?intent=signup`);
    await nativeReady(page);
    let s = await R.step(page, 'sign-up form');
    await nfill(page, 0, FX_PHONE, R);
    await nfill(page, 1, 'ORG-ABCD', R);
    s = await R.step(page, 'half-typed ORG code');
    ck('orgModeAt', { routesHidden: !(await nbtn(page, 'Telegram').isVisible().catch(() => false)), button: (await nbtn(page, L('n.auth.org-create-account')).isVisible().catch(() => false)) ? L('n.auth.org-create-account') : '?' }, s.png);
    await nclick(page, L('n.auth.org-create-account'), R);
    s = await R.step(page, 'incomplete ORG code');
    ck('orgBadFormat', (await vtext(page)).split('\n').filter(Boolean).slice(-4).join(' | '), s.png);
    await nfill(page, 1, ORG_CODE, R);
    s = await R.step(page, 'full ORG code typed');
    ck('orgAsked', s.asked, s.png);
    const errs = full ? [['orgInvalid', E(400, 'org_code_invalid')], ['orgUsed', E(409, 'org_code_used')], ['orgTaken', E(409, 'org_code_number_taken')], ['orgRevoked', E(410, 'org_code_revoked')], ['org429', E(429, 'too_many_requests')], ['orgOffline', { abort: true }]] : [['orgInvalid', E(400, 'org_code_invalid')]];
    for (const [name, ans] of errs) {
      A['POST /api/observers/org-signup'] = ans;
      await nclick(page, L('n.auth.org-create-account'), R);
      await sleep(600);
      if (name === errs[0][0]) { s = await R.step(page, 'is this your number? (confirm)'); ck('orgConfirm', (await vtext(page)).split('\n').filter(Boolean).slice(-4).join(' | '), s.png); ck('orgPwFirst', { msg: '', dialog: true }, s.png); }
      await nclick(page, L('n.auth.org-confirm-yes'), R);
      await sleep(1500);
      s = await R.step(page, `org sign-up: ${name}`);
      ck(`${name}Msg`, (await vtext(page)).split('\n').filter(Boolean).slice(-4).join(' | '), s.png);
      ck(`${name}Kept`, { code: await ninputs(page).nth(1).inputValue().catch(() => '') }, s.png);
    }
    A['POST /api/observers/org-signup'] = { status: 200, json: { ok: true, observerId: 7, token: FAKE_TOKEN, isNew: true, needsUnit: true, hasPassword: false } };
    A['POST /api/observers/set-password'] = OK;
    A['GET /api/groups'] = { status: 200, json: { managing: [], member: [ORG_ROOM] } };
    A['GET /api/my/rooms'] = { status: 200, json: { rooms: [{ id: 41, name: ORG_ROOM.name, kind: 'party', contest: 'GOV', assigned: null, checkedIn: null }] } };
    await nclick(page, L('n.auth.org-create-account'), R);
    await nclick(page, L('n.auth.org-confirm-yes'), R);
    await sleep(2000);
    s = await R.step(page, 'password step (after org sign-up)');
    ck('orgPwAfter', s.asked, s.png);
    await nfill(page, 0, PW, R);
    await nfill(page, 1, PW, R);
    await nclick(page, L('n.app.sign-in.save-password-and-continue'), R);
    await sleep(3000);
    s = await R.step(page, 'after org sign-up (arrival)');
    ck('orgArrival', page.url().replace(NBASE, 'native:'), s.png);
    await nclick(page, nt(lang, 'map-unit.skip-for-now'), R);
    await sleep(4000);
    // the tour may be up: skip past it
    for (let i = 0; i < 6; i++) { if (!(await nclick(page, L('tour.next')))) break; }
    s = await R.step(page, 'home after skipping the unit');
    ck('orgRoomOnHome', (await vtext(page)).includes(ORG_ROOM.name), s.png);
    await go(page, `${NBASE}/my-groups`);
    await nativeReady(page);
    s = await R.step(page, 'my groups');
    ck('orgRoomInMyGroups', (await vtext(page)).includes(ORG_ROOM.name), s.png);
  } catch (e) { ERRORS.push(`${flow}/native/${lang}: ${e.message}`); }
  await X.ctx.close();
}

/* ================================================================== FLOW 3: returning sign-in */
async function signinWeb(surface, lang) {
  const flow = 'signin';
  const full = lang === 'en';
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang });
  const { page, A, calls } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  try {
    if (surface === 'web') {
      await go(page, url(surface, 'index.html'));
      await sleep(1500);
      await page.locator('a[href="observe.html?intent=signin"]:visible').first().click().catch(() => {}); R.tap();
    } else {
      await go(page, url(surface, 'index.html'));   // Lite: the gate opens on sign-in
    }
    await webAuthReady(page);
    await sleep(1500);   // passkey support is decided after /api/health
    let s = await R.step(page, 'sign-in form');
    ck('signinAsked', s.asked, s.png);
    ck('passkeyBtn', await page.locator('#pk-signin').isVisible().catch(() => false), s.png);
    // Wrong things.
    await page.fill('#auth-input', FX_PHONE); R.tap();
    await page.fill('#pw-signin-input', 'wrong-password'); R.tap();
    const errs = full ? [
      ['wrongPw', E(401, 'wrong_password', { hint: 'Wrong password. Forgot it? Sign in with an OTP to reset.' })],
      ['pwUnavailable', E(401, 'password_login_unavailable')],
      ['pw429', E(429, 'too_many_attempts', { hint: 'Too many wrong passwords. Wait an hour, or sign in with an OTP instead.' })],
      ['pw500', E(500, 'internal_error')],
      ['pw502html', { status: 502, html: '<html><body>Bad gateway</body></html>' }],
      ['pwOffline', { abort: true }],
    ] : [['wrongPw', E(401, 'wrong_password')], ['pwOffline', { abort: true }]];
    for (const [name, ans] of errs) {
      A['POST /api/observers/login'] = ans;
      await page.click('#btn-auth', FORCE); R.tap();
      await sleep(1500);
      s = await R.step(page, `sign in: ${name}`);
      ck(`${name}Msg`, await errLine(page), s.png);
      ck(`${name}Kept`, { phone: await page.inputValue('#auth-input').catch(() => ''), pw: (await page.inputValue('#pw-signin-input').catch(() => '')).length }, s.png);
    }
    // Keyboard up on the password field.
    if (full) {
      await page.focus('#pw-signin-input').catch(() => {});
      await page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) });
      await sleep(900);
      s = await R.step(page, 'sign-in form, keyboard up');
      ck('kbdSignin', { field: await inView(page, page.locator('#pw-signin-input')), button: await inView(page, page.locator('#btn-auth')), span: await span(page, page.locator('#pw-signin-input'), page.locator('#btn-auth')), room: page.viewportSize().height }, s.png);
      await page.setViewportSize({ width: VP.width, height: VP.height });
      await sleep(300);
    }
    // Success.
    A['POST /api/observers/login'] = OK_LOGIN;
    await page.fill('#pw-signin-input', PW); R.tap();
    await page.click('#btn-auth', FORCE); R.tap();
    await sleep(2500);
    if (await page.locator('#pk-offer').isVisible().catch(() => false)) {
      s = await R.step(page, 'passkey offer');
      ck('pkOffer', true, s.png);
      await page.click('#pk-offer-no').catch(() => {}); R.tap();
    }
    await page.waitForURL(/index\.html|hawkeye\.com\.ng\/?$/, { timeout: 12000 }).catch(() => {});
    await sleep(2500);
    s = await R.step(page, 'after sign-in (arrival)');
    ck('arrival', page.url().replace(SITE, ''), s.png);
  } catch (e) { ERRORS.push(`${flow}/${surface}/${lang}: ${e.message}`); }
  await X.ctx.close();

  // ---- Forgot password = the one-time-code sign-in ----
  const F = await open(surface, { lang, allowReal: true });
  const RF = recorder('signin-forgot', surface, lang);
  const ckf = (n, v, png) => chk('signin-forgot', surface, lang, n, v, png ?? RF.last?.png);
  try {
    await go(F.page, url(surface, 'observe.html?intent=signin'));
    await webAuthReady(F.page);
    await RF.step(F.page, 'sign-in form');
    await F.page.click('#pw-link'); RF.tap();
    await sleep(600);
    let s = await RF.step(F.page, 'forgot password: send a code');
    ckf('forgotAsked', s.asked, s.png);
    // The route picker: JS un-hides it; is it actually on screen?
    const picker = () => F.page.evaluate(() => {
      const p = document.getElementById('channel-pick');
      const w = document.getElementById('pw-signin-wrap');
      return {
        pickerHiddenAttr: p.hidden, pickerDisplay: getComputedStyle(p).display,
        pwSigninHiddenAttr: w.hidden, pwSigninDisplay: getComputedStyle(w).display,
        pwOptHiddenAttr: document.getElementById('pw-opt').hidden, pwOptDisplay: getComputedStyle(document.getElementById('pw-opt')).display,
        htmlIntentSignin: document.documentElement.classList.contains('intent-signin'),
        button: document.getElementById('btn-auth').textContent.trim(),
      };
    });
    ckf('forgotPicker', await picker(), s.png);
    F.A['POST /api/observers/register'] = OK_REG;
    F.A['POST /api/observers/verify'] = OK_VERIFY_OLD;
    F.A['POST /api/observers/set-password'] = OK;
    await F.page.fill('#auth-input', FX_PHONE); RF.tap();
    await F.page.click('#btn-auth', FORCE); RF.tap();
    await sleep(1200);
    s = await RF.step(F.page, 'forgot password: Send Code with no route on screen');
    ckf('forgotSendNoRoute', { prompt: await F.page.locator('#channel-need').isVisible().catch(() => false) ? (await F.page.locator('#channel-need').innerText()).trim() : '', sent: F.calls.some((c) => c.p === '/api/observers/register'), radiosVisible: await F.page.locator('input[name=otp-channel]').first().isVisible().catch(() => false) }, s.png);
    // A person cannot go further. The harness picks the route BY SCRIPT only to see the next step.
    await F.page.evaluate(() => { const r = document.querySelector('input[name=otp-channel][value=telegram]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    await F.page.click('#btn-auth', FORCE);
    await sleep(1600);
    s = await RF.step(F.page, 'forgot password: code screen (route picked by script)', { note: 'route chosen by script: no picker is visible to a person' });
    ckf('forgotCodeAsked', s.asked, s.png);
    ckf('forgotCodePicker', await picker(), s.png);
    ckf('forgotRegisterBody', F.calls.filter((c) => c.p === '/api/observers/register').pop()?.body, s.png);
    await F.page.fill('#auth-input', '123456'); RF.tap();
    await F.page.click('#btn-auth', FORCE); RF.tap();
    await sleep(1200);
    s = await RF.step(F.page, 'forgot password: verify (new password field not on screen)');
    ckf('forgotVerifyMsg', { msg: await errLine(F.page), verifyCalled: F.calls.some((c) => c.p === '/api/observers/verify') }, s.png);
    await F.page.evaluate((pw) => { document.getElementById('pw-opt-input').value = pw; }, PW);
    await F.page.click('#btn-auth', FORCE); RF.tap();
    await sleep(2500);
    if (await F.page.locator('#pk-offer').isVisible().catch(() => false)) { await F.page.click('#pk-offer-no').catch(() => {}); RF.tap(); }
    await F.page.waitForURL(/index\.html|hawkeye\.com\.ng\/?$/, { timeout: 12000 }).catch(() => {});
    await sleep(2000);
    s = await RF.step(F.page, 'after reset (arrival)');
    ckf('forgotArrival', F.page.url().replace(SITE, ''), s.png);
    ckf('forgotSetPw', F.calls.some((c) => c.p === '/api/observers/set-password'), s.png);
  } catch (e) { ERRORS.push(`signin-forgot/${surface}/${lang}: ${e.message}`); }
  await F.ctx.close();
}

async function signinNative(lang) {
  const flow = 'signin';
  const surface = 'native';
  const full = lang === 'en';
  const L = (k, v) => nt(lang, k, v);
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang });
  const { page, A } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  const signinBtn = () => page.getByText(L('index.sign-in'), { exact: true }).filter({ visible: true }).last();
  try {
    await go(page, `${NBASE}/`);
    await nativeReady(page);
    await nclick(page, L('index.sign-in'), R);
    await sleep(1200);
    let s = await R.step(page, 'sign-in form');
    ck('signinAsked', s.asked, s.png);
    ck('passkeyBtn', await page.getByText(L('passkey.signin-button'), { exact: true }).first().isVisible().catch(() => false), s.png);
    await nfill(page, 0, FX_PHONE, R);
    await nfill(page, 1, 'wrong-password', R);
    const errs = full ? [
      ['wrongPw', E(401, 'wrong_password', { hint: 'Wrong password. Forgot it? Sign in with an OTP to reset.' })],
      ['pwUnavailable', E(401, 'password_login_unavailable', { hint: 'Password sign-in is not available for this number.' })],
      ['pw429', E(429, 'too_many_attempts', { hint: 'Too many wrong passwords. Wait an hour, or sign in with an OTP instead.' })],
      ['pw500', E(500, 'internal_error')],
      ['pw502html', { status: 502, html: '<html><body>Bad gateway</body></html>' }],
      ['pwOffline', { abort: true }],
    ] : [['wrongPw', E(401, 'wrong_password')], ['pwOffline', { abort: true }]];
    for (const [name, ans] of errs) {
      A['POST /api/observers/login'] = ans;
      if (name === 'pwUnavailable') { /* lands on the code step: come back after */ }
      await signinBtn().click().catch(() => {}); R.tap();
      await sleep(1600);
      s = await R.step(page, `sign in: ${name}`);
      const t = await vtext(page);
      ck(`${name}Msg`, t.split('\n').filter(Boolean).slice(-3).join(' | '), s.png);
      ck(`${name}Kept`, { phone: await ninputs(page).nth(0).inputValue().catch(() => ''), pw: (await ninputs(page).nth(1).inputValue().catch(() => '')).length }, s.png);
      if (name === 'pwUnavailable') {
        ck('pwUnavailableRoutes', t.includes(L('n.app.sign-in.no-password-on-this-account')), s.png);
        await nclick(page, L('n.app.sign-in.back-to-password-sign-in'));
        await sleep(600);
        await nfill(page, 1, 'wrong-password');
      }
    }
    if (full) {
      await ninputs(page).nth(1).focus().catch(() => {});
      await page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) });
      await sleep(900);
      s = await R.step(page, 'sign-in form, keyboard up');
      ck('kbdSignin', { field: await inView(page, ninputs(page).nth(1)), button: await inView(page, signinBtn()), span: await span(page, ninputs(page).nth(1), signinBtn()), room: page.viewportSize().height }, s.png);
      await page.setViewportSize({ width: VP.width, height: VP.height });
      await sleep(300);
    }
    A['POST /api/observers/login'] = OK_LOGIN;
    await nfill(page, 1, PW, R);
    await signinBtn().click().catch(() => {}); R.tap();
    await sleep(3500);
    s = await R.step(page, 'after sign-in (arrival)');
    ck('arrival', page.url().replace(NBASE, 'native:'), s.png);
  } catch (e) { ERRORS.push(`${flow}/native/${lang}: ${e.message}`); }
  await X.ctx.close();

  const F = await open(surface, { lang });
  const RF = recorder('signin-forgot', surface, lang);
  const ckf = (n, v, png) => chk('signin-forgot', surface, lang, n, v, png ?? RF.last?.png);
  try {
    await go(F.page, `${NBASE}/sign-in`);
    await nativeReady(F.page);
    await RF.step(F.page, 'sign-in form');
    await nclick(F.page, L('n.app.sign-in.forgot-password'), RF);
    let s = await RF.step(F.page, 'forgot password: send a code');
    ckf('forgotAsked', s.asked, s.png);
    F.A['POST /api/observers/register'] = OK_REG;
    F.A['POST /api/observers/verify'] = OK_VERIFY_OLD;
    F.A['POST /api/observers/set-password'] = OK;
    F.A['GET /api/observers/me'] = { status: 200, json: { ok: true, observerId: 7, hasPassword: true, unit: null, subscriptions: [], reports: [], collation: [], incidents: [], mappings: [] } };
    await nfill(F.page, 0, FX_PHONE, RF);
    await nclick(F.page, 'Telegram', RF);
    await nclick(F.page, L('n.app.profile.send-code'), RF);
    await sleep(1500);
    s = await RF.step(F.page, 'forgot password: code');
    ckf('forgotCodeAsked', s.asked, s.png);
    ckf('forgotRegisterBody', F.calls.filter((c) => c.p === '/api/observers/register').pop()?.body, s.png);
    await nfill(F.page, 0, '123456', RF);
    await nclick(F.page, L('n.app.profile.verify'), RF);
    await sleep(2500);
    s = await RF.step(F.page, 'forgot password: new password');
    await nfill(F.page, 0, PW, RF);
    await nfill(F.page, 1, PW, RF);
    await nclick(F.page, L('n.app.sign-in.save-password-and-continue'), RF);
    await sleep(3000);
    s = await RF.step(F.page, 'after reset (arrival)');
    ckf('forgotArrival', F.page.url().replace(NBASE, 'native:'), s.png);
    ckf('forgotSetPw', F.calls.some((c) => c.p === '/api/observers/set-password'), s.png);
  } catch (e) { ERRORS.push(`signin-forgot/native/${lang}: ${e.message}`); }
  await F.ctx.close();
}

/* ================================================================== FLOW 4: session end / return */
const DEAD = { status: 401, json: { error: 'invalid_token' } };
async function sessionWeb(surface, lang) {
  const flow = 'session';
  const full = lang === 'en';
  const pages = [
    ['profile', 'profile.html'],
    ['my-groups', 'my-groups.html'],
    ['room', 'situation-room.html?room=lagos-citizens'],
  ];
  for (const [name, p] of pages) {
    const R = recorder(`session-401-${name}`, surface, lang);
    const X = await open(surface, { lang, signedIn: true, variant: 'populated', deadAuth: DEAD });
    const { page, A, navs } = X;
    const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
    try {
      await go(page, url(surface, p));
      await sleep(7000);
      const loopNavs = navs.filter((n) => /my-groups|observe\.html|situation-room|profile/.test(n.url)).length;
      let s = await R.step(page, `${name} with a refused token`);
      ck(`401_${name}`, { landed: page.url().replace(SITE, ''), navigations: loopNavs, tokenKept: !!(await tokenOf(page, surface)), text: (await vtext(page)).split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 200) }, s.png);
      // Sign in from wherever they are now, and see where they land.
      X.st.dead = null;
      A['POST /api/observers/login'] = OK_LOGIN;
      if (navs.length > 12) {
        // a redirect loop: stop it to finish the walk
        await page.evaluate(() => { try { localStorage.removeItem('hawkeye_token'); } catch (e) { /* */ } });
        await sleep(2500);
      }
      if (/profile/.test(page.url()) && await page.locator('#signed-out a').isVisible().catch(() => false)) {
        await page.locator('#signed-out a').click(); R.tap();
        await webAuthReady(page);
        s = await R.step(page, 'the "sign in" link on the profile');
        ck(`401_${name}_link`, page.url().replace(SITE, ''), s.png);
        if (await page.locator('#signin-line a').isVisible().catch(() => false)) { await page.locator('#signin-line a').click(); R.tap(); await webAuthReady(page); }
      }
      if (/observe\.html/.test(page.url())) {
        await webAuthReady(page);
        if (await page.locator('#pw-signin-input').isVisible().catch(() => false)) {
          await page.fill('#auth-input', FX_PHONE); R.tap();
          await page.fill('#pw-signin-input', PW); R.tap();
          await page.click('#btn-auth', FORCE); R.tap();
          await sleep(2500);
          if (await page.locator('#pk-offer').isVisible().catch(() => false)) { await page.click('#pk-offer-no').catch(() => {}); R.tap(); }
          await sleep(4000);
          s = await R.step(page, 'after signing in again');
          ck(`return_${name}`, page.url().replace(SITE, ''), s.png);
        }
      }
    } catch (e) { ERRORS.push(`${flow}-401-${name}/${surface}/${lang}: ${e.message}`); }
    await X.ctx.close();
    if (!full) break;   // ha: profile only
  }
  // Offline / 5xx must not sign out.
  const modes = full ? [['500', { status: 500, json: { error: 'internal_error' } }], ['offline', { abort: true }], ['502html', { status: 502, html: '<html>Bad gateway</html>' }], ['401-control', DEAD]] : [['offline', { abort: true }]];
  for (const [pname, p] of [['home', 'index.html'], ['profile', 'profile.html'], ['my-groups', 'my-groups.html']]) {
    for (const [mode, ans] of modes) {
      const R = recorder(`session-${mode}-${pname}`, surface, lang);
      const X = await open(surface, { lang, signedIn: true, variant: 'populated', deadAuth: ans });
      const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
      try {
        await go(X.page, url(surface, p));
        await sleep(6000);
        const s = await R.step(X.page, `${pname}: ${mode}`);
        const t = await vtext(X.page);
        ck(`keep_${pname}_${mode}`, { tokenKept: !!(await tokenOf(X.page, surface)), url: X.page.url().replace(SITE, ''), loading: LOADING.test(t), says: (t.match(/[^\n]*(reach|connection|Could not|offline|Try again|haɗ|intanet)[^\n]*/i) || [''])[0].slice(0, 120) }, s.png);
      } catch (e) { ERRORS.push(`${flow}-${mode}-${pname}/${surface}: ${e.message}`); }
      await X.ctx.close();
    }
    if (!full) break;
  }
}

async function sessionNative(lang) {
  const flow = 'session';
  const surface = 'native';
  const full = lang === 'en';
  const L = (k, v) => nt(lang, k, v);
  for (const [name, p] of [['profile', '/profile'], ['my-groups', '/my-groups']]) {
    const R = recorder(`session-401-${name}`, surface, lang);
    const X = await open(surface, { lang, signedIn: true, variant: 'populated', deadAuth: DEAD });
    const { page, A } = X;
    const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
    try {
      await go(page, `${NBASE}${p}`);
      await nativeReady(page);
      await sleep(4000);
      let s = await R.step(page, `${name} with a refused token`);
      ck(`401_${name}`, { landed: page.url().replace(NBASE, 'native:'), tokenKept: !!(await tokenOf(page, surface)), text: (await vtext(page)).split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 200) }, s.png);
      X.st.dead = null;
      A['POST /api/observers/login'] = OK_LOGIN;
      if (/welcome/.test(page.url())) {
        await nclick(page, L('index.sign-in'), R);
        await sleep(1000);
        await nfill(page, 0, FX_PHONE, R);
        await nfill(page, 1, PW, R);
        await page.getByText(L('index.sign-in'), { exact: true }).filter({ visible: true }).last().click().catch(() => {}); R.tap();
        await sleep(4000);
        s = await R.step(page, 'after signing in again');
        ck(`return_${name}`, page.url().replace(NBASE, 'native:'), s.png);
      }
    } catch (e) { ERRORS.push(`${flow}-401-${name}/native/${lang}: ${e.message}`); }
    await X.ctx.close();
    if (!full) break;
  }
  const modes = full ? [['500', { status: 500, json: { error: 'internal_error' } }], ['offline', { abort: true }], ['502html', { status: 502, html: '<html>Bad gateway</html>' }], ['401-control', DEAD]] : [['offline', { abort: true }]];
  for (const [pname, p] of [['home', '/'], ['profile', '/profile'], ['my-groups', '/my-groups']]) {
    for (const [mode, ans] of modes) {
      const R = recorder(`session-${mode}-${pname}`, surface, lang);
      const X = await open(surface, { lang, signedIn: true, variant: 'populated', deadAuth: ans });
      const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
      try {
        await go(X.page, `${NBASE}${p}`);
        await nativeReady(X.page);
        await sleep(4000);
        // after the failure, does the app still think it is signed in? open Home
        const s = await R.step(X.page, `${pname}: ${mode}`);
        const t = await vtext(X.page);
        ck(`keep_${pname}_${mode}`, { tokenKept: !!(await tokenOf(X.page, surface)), url: X.page.url().replace(NBASE, 'native:'), loading: LOADING.test(t), says: (t.match(/[^\n]*(reach|connection|Could not|offline|Try again|HTTP|haɗ|intanet)[^\n]*/i) || [''])[0].slice(0, 120) }, s.png);
      } catch (e) { ERRORS.push(`${flow}-${mode}-${pname}/native: ${e.message}`); }
      await X.ctx.close();
    }
    if (!full) break;
  }
}

/* ================================================================== FLOW 5: first run after sign-up */
async function firstrunWeb(surface, lang) {
  const flow = 'firstrun';
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang, tourSeen: false });
  const { page, A } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  const order = [];
  try {
    A['POST /api/observers/register'] = OK_REG;
    A['POST /api/observers/verify'] = OK_VERIFY_NEW;
    A['POST /api/observers/set-password'] = OK;
    A['GET /api/practice/nudge'] = { status: 200, json: { show: true, practised: false, practiceOpen: true, practiceDay: null } };
    await go(page, url(surface, 'observe.html?intent=observe'));
    await webAuthReady(page);
    await page.fill('#auth-input', FX_PHONE);
    await page.check('input[name=otp-channel][value=telegram]', { force: true });
    await page.fill('#pw-opt-input', PW);
    await page.click('#btn-auth', FORCE);
    await sleep(1500);
    await page.fill('#auth-input', '123456');
    await page.click('#btn-auth', FORCE);
    await page.waitForURL(/choose-unit/, { timeout: 15000 }).catch(() => {});
    await sleep(3000);
    let s = await R.step(page, 'choose your polling unit (onboarding)');
    order.push('choose-unit');
    ck('unitAsked', s.asked, s.png);
    // Escape: browser Back from the unit step.
    await page.goBack({ waitUntil: 'load' }).catch(() => {});
    await sleep(2500);
    s = await R.step(page, 'browser Back from the unit step');
    ck('backFromUnit', page.url().replace(SITE, ''), s.png);
    if (!/choose-unit/.test(page.url())) { await go(page, url(surface, 'choose-unit.html?onboard=1')); await sleep(2500); }
    await page.locator('#cu-skip').click().catch(() => {}); R.tap();
    await page.waitForURL(/index\.html/, { timeout: 12000 }).catch(() => {});
    await sleep(5000);
    s = await R.step(page, 'home (first visit)');
    order.push('home');
    // Tour (Lite: shell only)
    const tourUp = await page.locator('.tour:not([hidden]) .tour-card').isVisible().catch(() => false);
    ck('tourShown', tourUp, s.png);
    if (tourUp) {
      order.push('tour');
      let k = 0;
      while (k++ < 7 && await page.locator('.tour:not([hidden])').isVisible().catch(() => false)) {
        const nx = page.locator('.tour:not([hidden]) .tour-next');
        if (!(await nx.isVisible().catch(() => false))) break;
        await nx.click().catch(() => {}); R.tap();
        await sleep(700);
      }
      s = await R.step(page, 'home after the tour');
    }
    const t = await vtext(page);
    const nudge = await page.locator('#pnudge-card').isVisible().catch(() => false);
    ck('nudgeShown', nudge, s.png);
    if (nudge) order.push('practice nudge');
    const ready = await page.locator('a[href="ready.html"]:visible').count();
    ck('readyOffered', ready > 0, s.png);
    ck('unitPromptOnHome', /polling unit|rukunin zaɓe/i.test(t) ? (t.match(/[^\n]*(polling unit|rukunin zaɓe)[^\n]*/i) || [''])[0].slice(0, 100) : '', s.png);
    ck('order', order, s.png);
  } catch (e) { ERRORS.push(`${flow}/${surface}/${lang}: ${e.message}`); }
  await X.ctx.close();
}

async function firstrunNative(lang) {
  const flow = 'firstrun';
  const surface = 'native';
  const L = (k, v) => nt(lang, k, v);
  const R = recorder(flow, surface, lang);
  const X = await open(surface, { lang, tourSeen: false });
  const { page, A } = X;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  const order = [];
  try {
    A['POST /api/observers/register'] = OK_REG;
    A['POST /api/observers/verify'] = OK_VERIFY_NEW;
    A['POST /api/observers/set-password'] = OK;
    A['GET /api/practice/nudge'] = { status: 200, json: { show: true, practised: false, practiceOpen: true, practiceDay: null } };
    await go(page, `${NBASE}/sign-in?intent=signup`);
    await nativeReady(page);
    await nfill(page, 0, FX_PHONE);
    await nclick(page, 'Telegram');
    await nclick(page, L('n.app.profile.send-code'));
    await sleep(1500);
    await nfill(page, 0, '123456');
    await nclick(page, L('n.app.profile.verify'));
    await sleep(2500);
    order.push('password');
    await nfill(page, 0, PW);
    await nfill(page, 1, PW);
    await nclick(page, L('n.app.sign-in.save-password-and-continue'));
    await sleep(3500);
    let s = await R.step(page, 'choose your polling unit (onboarding)');
    order.push('choose-unit');
    ck('unitAsked', s.asked, s.png);
    await nclick(page, L('map-unit.skip-for-now'), R);
    await sleep(5000);
    s = await R.step(page, 'home (first visit)');
    order.push('home');
    const tourUp = (await vtext(page)).includes(L('tour.next'));
    ck('tourShown', tourUp, s.png);
    if (tourUp) {
      order.push('tour');
      for (let i = 0; i < 6; i++) { if (!(await nclick(page, L('tour.next'), R))) break; }
      // last card's button
      const t2 = await vtext(page);
      for (const k of ['tour.start', 'tour.done']) if (NI.en[k] && t2.includes(L(k))) await nclick(page, L(k), R);
      await sleep(800);
      s = await R.step(page, 'home after the tour');
    }
    const t = await vtext(page);
    const nudge = t.includes(L('n.app.tabs.index.practice-nudge-title'));
    ck('nudgeShown', nudge, s.png);
    if (nudge) order.push('practice nudge');
    ck('readyOffered', t.includes(nt(lang, 'ready.title')), s.png);
    ck('order', order, s.png);
  } catch (e) { ERRORS.push(`${flow}/native/${lang}: ${e.message}`); }
  await X.ctx.close();
}

/* ================================================================== FLOW 6: sign out */
async function signoutWeb(surface, lang) {
  const flow = 'signout';
  for (const where of ['menu', 'profile']) {
    const R = recorder(`signout-${where}`, surface, lang);
    const X = await open(surface, { lang, signedIn: true, variant: 'populated' });
    const { page, calls } = X;
    const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
    X.A['POST /api/observers/sign-out'] = OK;
    try {
      if (where === 'menu') {
        await go(page, url(surface, 'index.html'));
        await sleep(3500);
        await R.step(page, 'home (signed in)');
        if (surface === 'lite') await page.locator('.tabbar [data-more]').click().catch(() => {});
        else await page.locator('.menu-btn').first().click().catch(() => {});
        R.tap();
        await sleep(900);
        const so = page.locator('#menu-panel a.sign-out');
        await so.scrollIntoViewIfNeeded().catch(() => {});
        let s = await R.step(page, 'menu open');
        ck(`signoutIn_${where}`, await so.isVisible().catch(() => false), s.png);
        await so.click().catch(() => {}); R.tap();
      } else {
        await go(page, url(surface, 'profile.html'));
        await sleep(4000);
        const b = page.locator('#btn-signout');
        await b.scrollIntoViewIfNeeded().catch(() => {});
        let s = await R.step(page, 'profile (signed in)');
        ck(`signoutIn_${where}`, await b.isVisible().catch(() => false), s.png);
        await b.click().catch(() => {}); R.tap();
      }
      await sleep(900);
      const confirm = await page.locator('.hk-dlg').isVisible().catch(() => false);
      let s = await R.step(page, 'after tapping sign out');
      ck(`confirm_${where}`, confirm, s.png);
      if (confirm) { await page.click('.hk-dlg .hk-dlg-ok'); R.tap(); }
      await sleep(4500);
      s = await R.step(page, 'where sign out lands');
      ck(`landing_${where}`, { url: page.url().replace(SITE, ''), tokenGone: !(await tokenOf(page, surface)), serverTold: calls.some((c) => c.p === '/api/observers/sign-out') }, s.png);
    } catch (e) { ERRORS.push(`${flow}-${where}/${surface}/${lang}: ${e.message}`); }
    await X.ctx.close();
  }
}

async function signoutNative(lang) {
  const flow = 'signout';
  const surface = 'native';
  const L = (k, v) => nt(lang, k, v);
  const R = recorder('signout-profile', surface, lang);
  const X = await open(surface, { lang, signedIn: true, variant: 'populated' });
  const { page, calls } = X;
  X.A['POST /api/observers/sign-out'] = OK;
  const ck = (n, v, png) => chk(flow, surface, lang, n, v, png ?? R.last?.png);
  try {
    await go(page, `${NBASE}/more`);
    await nativeReady(page);
    let s = await R.step(page, 'More tab (signed in)');
    ck('signoutIn_more', (await vtext(page)).includes(L('n.app.profile.sign-out')), s.png);
    await go(page, `${NBASE}/profile`);
    await nativeReady(page);
    await sleep(1500);
    s = await R.step(page, 'profile (signed in)');
    ck('signoutIn_profile', await nbtn(page, L('n.app.profile.sign-out')).isVisible().catch(() => false), s.png);
    await nclick(page, L('n.app.profile.sign-out'), R);
    await sleep(800);
    s = await R.step(page, 'after tapping sign out');
    const confirm = (await vtext(page)).includes(L('n.app.profile.sign-out-2'));
    ck('confirm_profile', confirm, s.png);
    if (confirm) {
      const btns = page.getByText(L('n.app.profile.sign-out'), { exact: true }).filter({ visible: true });
      await btns.last().click().catch(() => {}); R.tap();
    }
    await sleep(3000);
    s = await R.step(page, 'where sign out lands');
    ck('landing_profile', { url: page.url().replace(NBASE, 'native:'), tokenGone: !(await tokenOf(page, surface)), serverTold: calls.some((c) => c.p === '/api/observers/sign-out') }, s.png);
  } catch (e) { ERRORS.push(`${flow}/native/${lang}: ${e.message}`); }
  await X.ctx.close();
}

/* ================================================================== controls */
async function controls() {
  // LOADING detector: a page whose data never arrives must read as loading; one that resolves must not.
  const X = await open('web', { signedIn: true, variant: 'populated' });
  X.A['GET /api/notifications'] = { hang: true };
  await go(X.page, `${SITE}/notifications.html`);
  await sleep(5000);
  const hung = LOADING.test(await vtext(X.page)) || await X.page.locator('[aria-busy="true"]:visible').count() > 0;
  await X.ctx.close();
  const Y = await open('web', { signedIn: true, variant: 'populated' });
  await go(Y.page, `${SITE}/notifications.html`);
  await sleep(5000);
  const resolved = !LOADING.test(await vtext(Y.page));
  await Y.ctx.close();
  CONTROLS.loadingDetector = { hangingPageReadsLoading: hung, resolvedPageReadsResolved: resolved };
  // Untranslated detector: English text must trip it; a Hausa source line must not.
  CONTROLS.untranslatedDetector = {
    englishTrips: untranslated('Create Your Account\nWe\'ll send a code to confirm your number.', 'ha').length === 2,
    hausaPasses: untranslated(`${NI.ha['n.app.sign-in.create-your-account']}\n${NI.ha['auth.choose-route']}`, 'ha').length === 0,
  };
}

/* ================================================================== run */
const RUN = {
  signup: { web: signupWeb, lite: signupWeb, native: (s, l) => signupNative(l) },
  org: { web: orgWeb, lite: orgWeb, native: (s, l) => orgNative(l) },
  signin: { web: signinWeb, lite: signinWeb, native: (s, l) => signinNative(l) },
  session: { web: sessionWeb, lite: sessionWeb, native: (s, l) => sessionNative(l) },
  firstrun: { web: firstrunWeb, lite: firstrunWeb, native: (s, l) => firstrunNative(l) },
  signout: { web: signoutWeb, lite: signoutWeb, native: (s, l) => signoutNative(l) },
};
if (SURFACES.includes('native')) { server = await startStatic(NATIVE_DIR); NBASE = `http://127.0.0.1:${server.address().port}`; }
const prev = fs.existsSync(path.join(OUT, 'checks.json')) && !argv.includes('--fresh') ? JSON.parse(fs.readFileSync(path.join(OUT, 'checks.json'), 'utf8')) : null;
const prevSteps = fs.existsSync(path.join(OUT, 'steps.json')) && !argv.includes('--fresh') ? JSON.parse(fs.readFileSync(path.join(OUT, 'steps.json'), 'utf8')) : null;
if (!argv.includes('--no-controls')) { log('controls'); await controls().catch((e) => ERRORS.push(`controls: ${e.message}`)); }
for (const flow of FLOWS) for (const surface of SURFACES) for (const lang of LANGS_) {
  log(flow, surface, lang);
  await RUN[flow][surface](surface, lang).catch((e) => ERRORS.push(`${flow}/${surface}/${lang}: ${e.message}`));
}
await browser.close();
if (server) server.close();

/* Merge with an earlier partial run (a --flow/--surface subset), newest wins. */
const merge = (a, b) => {
  if (!a) return b;
  for (const [k, v] of Object.entries(b)) a[k] = (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) && !('value' in v)) ? merge(a[k], v) : v;
  return a;
};
const ALL_CHECKS = merge(prev?.checks ?? null, CHECKS) || CHECKS;
const ALL_STEPS = merge(prevSteps, STEPS) || STEPS;
fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(ALL_STEPS, null, 1));
fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify({ checks: ALL_CHECKS, controls: { ...(prev?.controls || {}), ...CONTROLS }, errors: ERRORS }, null, 1));
/* Cumulative across partial runs: every real write ever let through is listed. */
const prevSafety = fs.existsSync(path.join(OUT, 'safety.json')) && !argv.includes('--fresh') ? JSON.parse(fs.readFileSync(path.join(OUT, 'safety.json'), 'utf8')) : {};
const runs = (prevSafety.runs || (prevSafety.realWrites ? [{ at: 'earlier (single-run format)', ...prevSafety }] : [])).concat([{
  at: new Date().toISOString(), args: argv.join(' '), realWrites: REAL_WRITES, passGet: SAFETY.passGet, fixtures: SAFETY.fixtures,
  blockedWrites: SAFETY.blockedWrites, sentry: SAFETY.sentry, beacons: SAFETY.beacons, apk: SAFETY.apk,
}]);
fs.writeFileSync(path.join(OUT, 'safety.json'), JSON.stringify({
  rule: 'Only POST /api/observers/register|wa-start with a number refused by format (refusedByFormat) reaches production; everything else is a fixture or blocked.',
  allRealWritesRefusedByFormat: runs.every((r) => (r.realWrites || []).every((w) => refusedByFormat(w.phone) && w.status === 400)),
  runs,
}, null, 1));
const { buildFindings } = await import('./onboarding-findings.mjs');
const findings = buildFindings(ALL_CHECKS, ALL_STEPS);
fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(findings, null, 1));
log('done', { findings: findings.length, errors: ERRORS.length, realWrites: REAL_WRITES.length, blocked: SAFETY.blockedWrites.length });
if (ERRORS.length) console.log(ERRORS.join('\n'));
process.exit(0);

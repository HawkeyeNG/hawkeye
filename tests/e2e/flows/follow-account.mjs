/**
 * FLOW WALKTHROUGH — group `follow-account` (tests/e2e/flows/follow-account.mjs).
 *
 *   node follow-account.mjs [--surface web,lite,native] [--lang en,ha]
 *                           [--flow home,x8,follow,notif,profile,public,ask] [--vp s360]
 *   node follow-account.mjs --probe <surface> <in|out> <route> [<route> ...]   (text-layer dump)
 *
 * Flows (web, Lite = Capacitor stub over the live site, native = react-native-web export):
 *   home     Home signed in, populated + empty fixtures: the section order per surface
 *   x8       KNOWN LEFTOVER X8 — can Home sit on "Loading…"? slow fixtures, /me 500,
 *            /me offline, /me 401, everything offline, every authed call 401; with a
 *            control that MUST resolve (baseline) and one that MUST hang (a request that
 *            never answers), so the detector is shown to be able to fail both ways
 *   follow   races list -> a race -> Follow -> reload (kept?) -> Alerts -> notification
 *            preferences; failures 500 / offline / 409 / 401; signed-out follow
 *   notif    the Alerts list: tap each kind (result, incident, group_joined, mapping,
 *            a url-less broadcast) — where does it land, is it marked read; mark all read
 *   profile  language (en, ha, ig, yo: whole app, no reload loop), theme, passkeys
 *            (list/remove), referral copy + share, delete account to the final confirm
 *            (the DELETE is a fixture: 500 first, then 200), where sign-out lives
 *   public   signed out: verify a certificate, the ledger, a case, results -> race,
 *            FAQ / How from the menu; deep links race / verify-cert / room
 *   ask      Ask Hawkeye (fixture answer — the real model is never called) and the
 *            support routes: can someone ask how to report and get a usable path?
 *
 * Output: ../out/flows/follow-account/{*.png, steps.json, observations.json, findings.json}
 *
 * SAFETY (shared brief): every context gets installGuard (every non-GET to production is
 * answered by a fixture here or blocked). Writes the flows make — subscriptions, notification
 * read/clear, language, passkey remove, account delete, sign-out, assistant, push subscribe —
 * are fixtures. Intercom (the support chat) is BLOCKED outright: booting the messenger posts
 * to Intercom and would create a visitor record there. Telegram/WhatsApp links are never
 * followed (blocked at the network too). Reads of public data pass through without a token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium, CHROME, SITE, VIEWPORTS, installGuard, contextOptions, webInit, nativeInit,
  startStatic, sleep, log, SAFETY,
} from '../../design-audit/lib.mjs';
import { makeFixtures } from '../../design-audit/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const OUT = path.resolve(HERE, '../out/flows/follow-account');
const NATIVE_DIR = process.env.NATIVE_DIR || path.join(REPO, 'tmp/design-audit-native-web');
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const SURFACES = arg('surface', 'web,lite,native').split(',');
const LANGS = arg('lang', 'en,ha').split(',');
const FLOWS = arg('flow', 'home,x8,follow,notif,profile,public,ask').split(',');
const VPK = arg('vp', 's360');
const VP = VIEWPORTS[VPK];

const ALL_LANGS = ['en', 'ha', 'ig', 'yo'];
const NI18N = Object.fromEntries(ALL_LANGS.map((l) => [l, JSON.parse(fs.readFileSync(path.join(REPO, `native/src/lib/i18n/${l}.json`), 'utf8'))]));
const WI18N = Object.fromEntries(ALL_LANGS.map((l) => [l, JSON.parse(fs.readFileSync(path.join(REPO, `app/i18n/${l}.json`), 'utf8'))]));
const nt = (lang, key, v = {}) => fill(NI18N[lang][key] || NI18N.en[key] || key, v);
const wt = (lang, key, v = {}) => fill(WI18N[lang][key] || WI18N.en[key] || key, v);
function fill(s, v) { return String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)); }
/** The part of a translated string before its first placeholder — a stable text marker. */
const head = (s) => String(s).split('{')[0].replace(/<[^>]+>/g, '').trim();
const LANG_NAME = { en: 'English', ha: 'Hausa', ig: 'Asụsụ Igbo', yo: 'Èdè Yorùbá' };
const HTML_LANG = { en: 'en', ha: 'ha', ig: 'ig', yo: 'yo' };

// ---------------------------------------------------------------- fixtures
const H = 3_600_000;
const NOW = Date.now();
const UNIT = { pu_code: '24-16-05-007', name: 'LGEA Primary School, Ojota I', ward: 'Ojota', lga: 'Kosofe', state: 'Lagos' };

/* The alerts feed with the URLS THE BACKEND ACTUALLY WRITES (backend/src/routes/
   subscriptions.js:167 result, admin.js:198 incident, groups.js:1828 group_joined,
   mapping.js:72 mapping) and the titles/bodies from backend/src/i18n/en.json
   (note.*). design-audit/fixtures.mjs invents two of these urls
   (incident-reports.html, null) — this flow is about where a tap lands, so it uses
   the real ones. Plus one url-less broadcast (services/push.js sends data.url only
   when the sender typed one). */
function notes() {
  return [
    { id: 401, kind: 'result', title: 'New Presidential (2027) report', body: 'A result was reported at LGEA Primary School, Ojota I, Kosofe, Lagos. Running total across 12 units: A 1,204 · B 988.', url: 'https://hawkeye.com.ng/results.html?contest=PRES&scope=Lagos', read: 0, created_at: NOW - 2 * H },
    { id: 402, kind: 'incident', title: 'Your incident report is live', body: 'late_materials · 24-16-05-007 — approved and published.', url: 'https://hawkeye.com.ng/incidents.html', read: 0, created_at: NOW - 5 * H },
    { id: 403, kind: 'group_joined', title: 'You have joined Lagos Citizens Observer Network', body: 'You signed up with a code from Lagos Citizens Observer Network, so you are on its roster. It sees the reports you file from now on. You can leave in My Groups.', url: 'https://hawkeye.com.ng/my-groups.html', read: 0, created_at: NOW - 30 * H },
    { id: 404, kind: 'mapping', title: 'Unit crowd-confirmed', body: 'LGEA Primary School, Ojota I (24-16-05-007) — 3 observer fixes agreed. Thank you for mapping it.', url: 'https://hawkeye.com.ng/map-unit.html', read: 0, created_at: NOW - 4 * 24 * H },
    { id: 405, kind: 'info', title: 'Practice Day: Saturday 12 December', body: 'Rehearse before polling day.', url: null, read: 0, created_at: NOW - 5 * 24 * H },
  ];
}
const KIND_TITLE = Object.fromEntries(notes().map((n) => [n.kind, n.title]));

function newState(o = {}) {
  const variant = o.variant || 'populated';
  return {
    variant,
    subs: o.subs !== undefined ? o.subs : (variant === 'empty' ? [] : [{ contest: 'PRES', state: null }, { contest: 'GOV', state: 'Lagos' }]),
    notes: o.notes || notes(),
    passkeys: o.passkeys || [
      { id: 'pk-1', label: 'Chrome on Android', createdAt: NOW - 20 * 24 * H, lastUsedAt: NOW - 2 * 24 * H },
      { id: 'pk-2', label: 'Safari on iPhone', createdAt: NOW - 9 * 24 * H, lastUsedAt: null },
    ],
    fail: { ...(o.fail || {}) },   // path -> status | 'abort' | 'hang'; '*' = every API call, '*auth' = every authed call
    slowAssets: o.slowAssets || [], // [[RegExp, ms]] static files served late
    mode: { ...(o.mode || {}) },   // write modes: subs, delete, assistant, read, lang
    writes: [],
    calls: [],
    deleted: false,
    langPut: [],
  };
}

function makeFx(S) {
  const base = makeFixtures(S.variant);
  return (m, u, hasAuth, req) => {
    const p = u.pathname;
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = null; }
    S.calls.push({ m, p: p + u.search, t: Date.now() });
    if (m !== 'GET') S.writes.push({ m, p, body, t: Date.now() });
    // ---- forced failures (abort/hang are done by the route in newCtx)
    const f = S.fail[p] ?? (hasAuth ? S.fail['*auth'] : undefined) ?? S.fail['*'];
    if (typeof f === 'number') {
      return { status: f, json: f === 401 ? { error: 'unknown_observer' } : { error: f === 429 ? 'rate_limited' : 'internal_error' } };
    }
    if (m === 'GET') {
      if (p === '/api/observers/me') {
        const me = base(m, u)?.json;
        if (!me) return undefined;
        return { status: 200, json: { ...me, subscriptions: S.subs } };
      }
      if (p === '/api/notifications') {
        return { status: 200, json: { items: S.variant === 'empty' ? [] : S.notes, unread: S.variant === 'empty' ? 0 : S.notes.filter((n) => !n.read).length } };
      }
      if (p === '/api/observers/passkeys') return { status: 200, json: { ok: true, available: true, passkeys: S.passkeys } };
      if (p === '/api/assistant/health') return { status: 200, json: { enabled: true } };
      if (p === '/api/cert/verify') {
        const code = String(u.searchParams.get('code') || '').toUpperCase().replace(/[^2-9A-HJKMNP-TV-Z]/g, '');
        if (code === 'K7PM3XQR') return { status: 200, json: { valid: true, code: 'K7PM-3XQR', issuedAt: NOW - 10 * 24 * H, issuedOn: '2026-09-23' } };
        return undefined; // anything else: the real public answer
      }
      return base(m, u);
    }
    // ---- writes
    if (p === '/api/subscriptions') {
      const mode = S.mode.subs || 'ok';
      if (mode === '500') return { status: 500, json: { error: 'internal_error' } };
      if (mode === '409') return { status: 409, json: { error: 'race_closed' } };
      if (mode === '401') return { status: 401, json: { error: 'unknown_observer' } };
      const contest = String(body?.contest || '');
      const state = String(body?.state || '');
      if (m === 'POST') {
        if (!S.subs.some((s) => s.contest === contest && (s.state || '') === state)) S.subs = [...S.subs, { contest, state: state || null }];
        return { status: 201, json: { ok: true } };
      }
      if (m === 'DELETE') {
        S.subs = S.subs.filter((s) => !(s.contest === contest && (s.state || '') === state));
        return { status: 200, json: { ok: true } };
      }
    }
    if (p === '/api/notifications/read') {
      if (S.mode.read === '500') return { status: 500, json: { error: 'internal_error' } };
      if (body?.all) S.notes = S.notes.map((n) => ({ ...n, read: 1 }));
      else S.notes = S.notes.map((n) => (n.id === Number(body?.id) ? { ...n, read: 1 } : n));
      return { status: 200, json: { ok: true, unread: S.notes.filter((n) => !n.read).length } };
    }
    if (p === '/api/notifications/clear') { S.notes = []; return { status: 200, json: { ok: true, unread: 0 } }; }
    if (p === '/api/observers/language') { S.langPut.push(body?.lang); return { status: 200, json: { ok: true } }; }
    if (p === '/api/observers/passkeys/remove') {
      const before = S.passkeys.length;
      S.passkeys = S.passkeys.filter((x) => x.id !== body?.id);
      if (S.passkeys.length === before) return { status: 404, json: { error: 'unknown_passkey' } };
      return { status: 200, json: { ok: true, passkeys: S.passkeys } };
    }
    if (p === '/api/observers/delete') {
      const mode = S.mode.delete || 'ok';
      if (mode === '500') return { status: 500, json: { error: 'internal_error' } };
      S.deleted = true;
      return { status: 200, json: { ok: true } };
    }
    if (p === '/api/observers/sign-out') return { status: 200, json: { ok: true } };
    if (p === '/api/assistant') {
      const mode = S.mode.assistant || 'ok';
      if (mode === 'no_answer') return { status: 200, json: { error: 'no_answer' } };
      /* A FIXTURE, never the model. Paraphrases the how-to guide the real system
         prompt carries (backend/src/services/assistant.js:57-75), which is what the
         model is told to answer "how do I report" from. */
      return { status: 200, json: { answer: 'To report a result: open the Hawkeye app or hawkeye.com.ng, tap Report, choose your polling unit, take the photos the app asks for of the result sheet posted at the unit, enter the counts and submit. Your report is signed on your phone and checked before it is published. You can practise first with Practice. Figures on Hawkeye are crowd-reported and unofficial.' } };
    }
    if (p === '/api/push/subscribe' || p === '/api/push/register') return { status: 200, json: { ok: true } };
    return base(m, u);
  };
}

// ---------------------------------------------------------------- browser + contexts
const browser = await chromium.launch({ executablePath: CHROME, args: ['--font-render-hinting=none'] });
let server = null;
let NBASE = null;
async function nativeBase() {
  if (!server) { server = await startStatic(NATIVE_DIR); NBASE = `http://127.0.0.1:${server.address().port}`; }
  return NBASE;
}

/* lib.mjs's webInit/nativeInit clear localStorage on EVERY document load. These flows
   change the language, delete the account and sign out — state that MUST survive the
   next navigation, or the harness (not the app) would undo it. So the lib script seeds
   storage on the FIRST document only; later documents keep what the page wrote. The
   Lite Capacitor stub (inside the lib script) still runs on every document. */
function initScript(surface, { lang, signedIn = true, theme = 'dark' }) {
  const i = surface === 'native' ? nativeInit({ signedIn, lang, theme }) : webInit({ lite: surface === 'lite', signedIn, lang, theme });
  return `(function(){
    if (window !== window.top) return;
    var snap = null;
    try { if (localStorage.getItem('__fa_seeded')) { snap = {}; for (var k = 0; k < localStorage.length; k++) { var key = localStorage.key(k); snap[key] = localStorage.getItem(key); } } } catch (e) {}
    (${i.script.toString()})(${JSON.stringify(i.arg)});
    try { if (snap) { localStorage.clear(); for (var s in snap) localStorage.setItem(s, snap[s]); } else localStorage.setItem('__fa_seeded', '1'); } catch (e) {}
    try {
      window.__fa_shared = [];
      navigator.share = function (d) { window.__fa_shared.push(d); return Promise.resolve(); };
      navigator.canShare = function () { return true; };
    } catch (e) {}
  })();`;
}

const BLOCKED3P = [];
async function newCtx(surface, { lang = 'en', S = newState(), signedIn = true, vp = VP } = {}) {
  const ctx = await browser.newContext({ ...contextOptions(vp), permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });
  await installGuard(ctx, { signedIn, crossOrigin: surface === 'native', fixtures: makeFx(S) });
  // Third parties: never a write, never Intercom, never a Telegram/WhatsApp hop.
  await ctx.route((url) => !/(^|\.)hawkeye\.com\.ng$|^127\.0\.0\.1$|^localhost$/.test(url.hostname), async (route) => {
    const req = route.request();
    const h = new URL(req.url()).hostname;
    if (/intercom/i.test(h) || /^(t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)$/i.test(h)) {
      BLOCKED3P.push(`${req.method()} ${h}`);
      return route.abort('blockedbyclient');
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD' && req.method() !== 'OPTIONS') {
      BLOCKED3P.push(`${req.method()} ${h}`);
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  // A slow static asset (a script on a 2G link): delayed, then served as normal.
  for (const [re, ms] of S.slowAssets || []) {
    await ctx.route(re, async (route) => { await sleep(ms); return route.fallback(); });
  }
  // Registered LAST, so it runs FIRST: forced network failures and never-answering calls.
  await ctx.route(/^https?:\/\/(hawkeye\.com\.ng|127\.0\.0\.1:\d+|localhost:\d+)\/api\//, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fallback();
    const u = new URL(req.url());
    const hasAuth = !!req.headers().authorization;
    const f = S.fail[u.pathname] ?? (hasAuth ? S.fail['*auth'] : undefined) ?? S.fail['*'];
    if (f === 'abort') { S.calls.push({ m: req.method(), p: u.pathname, aborted: true, t: Date.now() }); return route.abort('internetdisconnected'); }
    if (f === 'hang') { S.calls.push({ m: req.method(), p: u.pathname, hung: true, t: Date.now() }); await sleep(60000); return route.abort('timedout').catch(() => {}); }
    return route.fallback();
  });
  await ctx.addInitScript({ content: initScript(surface, { lang, signedIn }) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  const navs = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message().slice(0, 120)}`); d.dismiss().catch(() => {}); });
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) navs.push({ url: fr.url(), t: Date.now() }); });
  const base = surface === 'native' ? await nativeBase() : SITE;
  return { ctx, page, S, errors, navs, surface, lang, base, close: async () => { await ctx.close().catch(() => {}); } };
}

// ---------------------------------------------------------------- page helpers
const bodyText = (page) => page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
const rel = (P) => P.page.url().replace(P.base, '') || '/';
async function settle(P, ms = 3500) {
  await P.page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  await P.page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await sleep(ms);
}
async function go(P, route, ms) {
  await P.page.goto(P.base + route, { waitUntil: 'load', timeout: 60000 }).catch((e) => log('goto', route, e.message.slice(0, 80)));
  await settle(P, ms);
}
/** First VISIBLE element matching the locator (all matches tried). */
async function firstVisible(loc) {
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const l = loc.nth(i);
    if (await l.isVisible().catch(() => false)) {
      const box = await l.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) return l;
    }
  }
  return null;
}
/** Tap the first visible element with this exact text (or a regex). Returns true if tapped. */
async function tapText(P, text, { exact = true, last = false, timeout = 6000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const loc = P.page.getByText(text, { exact });
    let l = null;
    if (last) {
      const n = await loc.count().catch(() => 0);
      for (let i = n - 1; i >= 0 && !l; i--) if (await loc.nth(i).isVisible().catch(() => false)) l = loc.nth(i);
    } else l = await firstVisible(loc);
    if (l) { await l.scrollIntoViewIfNeeded().catch(() => {}); await l.click({ timeout: 5000 }).catch(() => {}); return true; }
    await sleep(300);
  }
  return false;
}
async function tapSel(P, sel, { timeout = 6000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const l = await firstVisible(P.page.locator(sel));
    if (l) { await l.scrollIntoViewIfNeeded().catch(() => {}); await l.click({ timeout: 5000 }).catch(() => {}); return true; }
    await sleep(300);
  }
  return false;
}
async function tapLabel(P, label, { timeout = 6000 } = {}) {
  return tapSel(P, `[aria-label="${label.replace(/"/g, '\\"')}"]`, { timeout });
}
const visibleText = async (P, text, exact = true) => !!(await firstVisible(P.page.getByText(text, { exact })));
/** Is a "still loading" state on screen? Text "Loading…" (any language), a skeleton, aria-busy, or a spinner. */
async function loadingState(P) {
  const words = ALL_LANGS.flatMap((l) => [WI18N[l]['index.loading'], NI18N[l]['n.app.tabs.results.loading'], 'Loading…', 'Loading...']).filter(Boolean);
  return P.page.evaluate((words) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.top < innerHeight * 4; };
    const out = { text: [], skeleton: 0, busy: 0, spinner: 0 };
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (t && words.includes(t) && vis(el) && !el.closest('.sr-only')) out.text.push(t);
    }
    out.skeleton = [...document.querySelectorAll('.hk-skel-page, .hk-skel')].filter(vis).length;
    out.busy = [...document.querySelectorAll('[aria-busy="true"]')].filter(vis).length;
    out.spinner = [...document.querySelectorAll('[role="progressbar"]')].filter(vis).length;
    return out;
  }, words).catch(() => ({ text: [], skeleton: 0, busy: 0, spinner: 0 }));
}
const isLoading = (s) => s.text.length > 0 || s.skeleton > 0 || s.busy > 0 || s.spinner > 0;
async function shrinkForKeyboard(P) { await P.page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) }); await sleep(500); }
async function restoreViewport(P) { await P.page.setViewportSize({ width: VP.width, height: VP.height }); await sleep(300); }
async function inViewport(P, loc) {
  const b = loc ? await loc.boundingBox().catch(() => null) : null;
  const vh = P.page.viewportSize().height;
  return !!b && b.y >= 0 && b.y + b.height <= vh;
}
/** Native: tap a tab in the bottom bar by its label (the LAST visible match is the tab, not a header).
 *  A pushed screen (race, profile…) covers the tab bar, so it is closed first with its header ×
 *  — what a person has to do too (each close counts as a tap in the caller's Rec). */
async function nativeTab(P, key, R = null) {
  const label = nt(P.lang, key);
  const tabBarUp = () => P.page.evaluate((lab) => [...document.querySelectorAll('[role="tab"], a[href]')].some((e) => e.getClientRects().length && (e.textContent || '').includes(lab)), label).catch(() => false);
  for (let i = 0; i < 2 && !(await tabBarUp()); i++) {
    const before = P.page.url();
    const closed = await tapLabel(P, nt(P.lang, 'common.close'), { timeout: 1500 });
    if (R && closed) R.tap();
    await sleep(900);
    // After a reload the web export has no history under a pushed screen (a phone
    // would have restarted on Home); the header's hawk is the way home then.
    if (!closed || P.page.url() === before) { if (await tapLabel(P, nt(P.lang, 'nav.home'), { timeout: 1500 })) { if (R) R.tap(); await sleep(1200); } }
  }
  return tapText(P, label, { last: true });
}
/** Web/Lite: open the ☰ menu (web) or the More tab (Lite) and tap a link by href. */
async function webMenu(P, href) {
  if (P.surface === 'lite') await tapSel(P, '.tabbar [data-more]');
  else await tapSel(P, '.menu-btn');
  await sleep(500);
  return tapSel(P, `#menu-panel a[href$="${href}"]`);
}

// ---------------------------------------------------------------- recording
const STEPS = {};
const OBS = {};
const obs = (k, v) => { OBS[k] = v; return v; };
class Rec {
  constructor(flow, surface, lang, tag = '') {
    this.flow = flow; this.surface = surface; this.lang = lang; this.tag = tag; this.steps = []; this.taps = 0;
    const key = tag ? `${flow}:${tag}` : flow;
    STEPS[key] = STEPS[key] || {};
    STEPS[key][surface] = STEPS[key][surface] || {};
    STEPS[key][surface][lang] = this.steps;
  }
  tap(n = 1) { this.taps += n; }
  async step(P, screen, { asked = '', note = '', ok = null, full = false } = {}) {
    const n = this.steps.length + 1;
    const f = `${this.flow}${this.tag ? '-' + this.tag : ''}-step-${String(n).padStart(2, '0')}-${this.surface}-${this.lang}.png`;
    await P.page.screenshot({ path: path.join(OUT, f), fullPage: full }).catch(() => {});
    const text = (await bodyText(P.page)).replace(/\s+/g, ' ').trim().slice(0, 300);
    this.steps.push({ n, screen, asked, taps: this.taps, url: rel(P), png: f, ok, note, text });
    this.taps = 0;
    return f;
  }
}
const png = (rec) => rec.steps.length ? rec.steps[rec.steps.length - 1].png : null;

// ================================================================ FLOW 1: HOME ORDER
/* Section markers, in the reader's language. Order = position in the text layer. */
function homeMarkers(surface, lang) {
  if (surface === 'native') {
    return [
      ['could-not-reach line', head(nt(lang, 'n.app.tabs.index.could-not-reach'))],
      ['election cards (2 soonest, countdown)', head(nt(lang, 'n.app.tabs.index.upcoming-election'))],
      ['election cards (reporting open)', head(nt(lang, 'n.app.tabs.index.reporting-open'))],
      ['show N more elections', head(nt(lang, 'n.app.tabs.index.show-more-elections'))],
      ['practice nudge card', head(nt(lang, 'n.app.tabs.index.practice-nudge-title'))],
      ['stats: accepted reports / units flagged', head(nt(lang, 'n.app.tabs.index.accepted-reports'))],
      ['chat card', head(nt(lang, 'n.app.tabs.index.chat-card-title'))],
      ['live activity feed (filters + rows)', head(nt(lang, 'n.app.tabs.index.live-activity'))],
    ];
  }
  return [
    ['greeting (Welcome back, Observer #N)', head(wt(lang, 'index.welcome-back-observer'))],
    ['generic greeting (Welcome Back)', head(wt(lang, 'index.welcome-back'))],
    ['unit chip (saved unit)', '📍'],
    ['unit chip (Save your polling unit)', head(wt(lang, 'index.save-your-polling-unit').replace(/<[^>]+>/g, ''))],
    ['could-not-reach line', head(wt(lang, 'common.cant-reach-hawkeye'))],
    ['quick actions: Report a Result / Incident / Collation / My Polling Unit', head(wt(lang, 'index.photograph-the-ec8a-sheet-at-your'))],
    ['practice nudge card', head(wt(lang, 'index.practice-nudge-title'))],
    ['latest alerts (unread, max 3)', head(wt(lang, 'index.latest-alerts'))],
    ['my activity (reports / incidents / races followed)', head(wt(lang, 'index.my-activity'))],
    ['chat card', head(wt(lang, 'index.chat-card-title'))],
    ['live on the ledger', head(wt(lang, 'index.live-on-the-ledger'))],
  ];
}
function orderFrom(text, markers) {
  const hits = [];
  // innerText applies text-transform (native's section labels are uppercase): compare folded.
  const low = text.toLowerCase();
  for (const [name, mk] of markers) {
    if (!mk) continue;
    const i = low.indexOf(mk.toLowerCase());
    if (i >= 0) hits.push({ name, i });
  }
  return hits.sort((a, b) => a.i - b.i).map((h) => h.name)
    .filter((n, i, a) => !(n === 'generic greeting (Welcome Back)' && a.includes('greeting (Welcome back, Observer #N)')));
}
/* Web/Lite, second route: the rendered blocks of .home-obs in DOM/paint order. */
async function webBlocks(P) {
  return P.page.evaluate(() => {
    const vis = (el) => el && el.getClientRects().length && getComputedStyle(el).display !== 'none' && !el.hidden;
    const root = document.querySelector('.home-obs');
    if (!root || !vis(root)) return ['(observer home not shown)'];
    const els = [...root.querySelectorAll('.home-hero, .qa-grid, .home-card')].filter(vis);
    return els.map((el) => {
      const h = el.querySelector('h1, h2, strong');
      return `${el.className.split(' ').filter((c) => /home|qa|pday|pnudge/.test(c)).join('.')}: ${(h ? h.textContent : el.textContent).trim().replace(/\s+/g, ' ').slice(0, 40)}`;
    });
  }).catch(() => []);
}

async function flowHome(surface, lang) {
  for (const variant of ['populated', 'empty']) {
    const P = await newCtx(surface, { lang, S: newState({ variant }) });
    const R = new Rec('home', surface, lang, variant);
    try {
      await go(P, '/', 4500);
      // Wait for the data-driven sections (election cards / alerts box) rather than a fixed time.
      if (surface === 'native') {
        await waitFor(async () => (await bodyText(P.page)).toLowerCase().includes(head(nt(lang, 'n.app.tabs.index.upcoming-election')).toLowerCase()), 20000);
      } else {
        await waitFor(() => P.page.evaluate(() => { const b = document.getElementById('home-alerts'); return !!b && !/…|\.\.\./.test(b.innerText.trim().slice(-1)); }).catch(() => false), 20000);
      }
      await sleep(800);
      const text = await bodyText(P.page);
      const order = orderFrom(text, homeMarkers(surface, lang));
      const blocks = surface === 'native' ? null : await webBlocks(P);
      await R.step(P, 'Home (top)', { asked: 'nothing — landing screen after sign-in', note: order.join(' > ') });
      // The rest of the page, a screen at a time.
      for (let k = 1; k <= 3; k++) {
        await P.page.mouse.move(VP.width / 2, VP.height / 2);
        await P.page.mouse.wheel(0, VP.height * 0.8);
        await sleep(700);
        await R.step(P, `Home (scrolled ${k})`);
      }
      // Is anything floating over the practice card's dismiss (×)? Hit-test its centre.
      await P.page.evaluate(() => scrollTo(0, 0)).catch(() => {});
      await P.page.mouse.wheel(0, -2000).catch(() => {});
      await sleep(600);
      const xLabel = surface === 'native' ? nt(lang, 'n.app.tabs.index.practice-nudge-dismiss') : wt(lang, 'index.practice-nudge-dismiss');
      obs(`home.nudgeDismissHit.${surface}.${variant}.${lang}`, await P.page.evaluate((lab) => {
        const x = [...document.querySelectorAll(`[aria-label="${lab}"]`)].find((e) => e.getClientRects().length);
        if (!x) return { found: false };
        const r = x.getBoundingClientRect();
        const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        const mine = !!hit && (hit === x || x.contains(hit));
        return { found: true, onScreen: cy > 0 && cy < innerHeight, hitsDismiss: mine, coveredBy: mine ? null : (hit ? (hit.getAttribute('aria-label') || hit.tagName + '.' + String(hit.className).slice(0, 40)) : null), at: [Math.round(cx), Math.round(cy)] };
      }, xLabel).catch(() => ({ found: false })));
      obs(`home.order.${surface}.${variant}.${lang}`, order);
      if (blocks) obs(`home.blocks.${surface}.${variant}.${lang}`, blocks);
      // Does Home name the next thing a first-time observer must do (save a unit)?
      const low = text.toLowerCase();
      // The "save/choose your unit" prompt only (not "My Polling Unit", whose Hausa also
      // occurs inside the practice card's sentence).
      const unitPhrases = [
        head(wt(lang, 'index.save-your-polling-unit').replace(/<[^>]+>/g, '')),
        'save your polling unit', 'choose your polling unit',
      ].filter(Boolean).map((s) => s.toLowerCase());
      const saveUnit = unitPhrases.some((s) => low.includes(s));
      obs(`home.saveUnitPrompt.${surface}.${variant}.${lang}`, saveUnit);
      obs(`home.png.${surface}.${variant}.${lang}`, R.steps.map((s) => s.png));
      // Untranslated leftovers on Home in Hausa: English sentences the bundle has a key for.
      if (lang !== 'en') {
        const english = ['Nothing yet — reports at your saved unit', 'Loading…', 'Welcome Back', 'Accepted Reports', 'Live activity'];
        obs(`home.english.${surface}.${variant}.${lang}`, english.filter((e) => text.includes(e)));
      }
    } catch (e) { obs(`home.error.${surface}.${variant}.${lang}`, String(e.message).slice(0, 200)); }
    await P.close();
  }
}

// ================================================================ FLOW X8: STUCK "LOADING…"
const X8_CASES = [
  { id: 'baseline', note: 'control: normal answers — MUST resolve' },
  { id: 'hang-control', note: 'control: the feed request never answers — MUST be reported stuck' },
  { id: 'slow-3000', note: 'every fixture answers after 3 s (DA_FIXTURE_MS=3000)', env: '3000' },
  { id: 'me-500', note: '/api/observers/me answers 500', fail: { '/api/observers/me': 500 } },
  { id: 'me-offline', note: '/api/observers/me fails at the network', fail: { '/api/observers/me': 'abort' } },
  { id: 'me-401', note: '/api/observers/me answers 401 unknown_observer', fail: { '/api/observers/me': 401 } },
  { id: 'all-offline', note: 'every /api/ call fails at the network (no signal)', fail: { '*': 'abort' } },
  { id: 'auth-401', note: 'every authenticated call answers 401 (dead token)', fail: { '*auth': 401 } },
  { id: 'notif-500', note: '/api/notifications answers 500', fail: { '/api/notifications': 500 } },
  /* Web/Lite only: index.html's alerts renderer calls window.timeAgo, which menu.js
     (the LAST script on the page) defines. A slow menu.js = the answer arrives first. */
  { id: 'menu-js-slow', note: 'menu.js served 4 s late (a slow script download); every API answers normally', web: true, slowAssets: [[/\/menu\.js(\?|$)/, 4000]] },
];
async function flowX8(surface) {
  const lang = 'en';
  const rows = [];
  const only = arg('x8cases', null);
  for (const c of X8_CASES.filter((x) => (!only || only.split(',').includes(x.id)) && !(x.web && surface === 'native'))) {
    const fail = { ...(c.fail || {}) };
    if (c.id === 'hang-control') {
      if (surface === 'native') for (const p of ['/api/contests', '/api/integrity/summary', '/api/ledger/entries', '/api/incidents', '/api/integrity/discrepancies', '/api/docket']) fail[p] = 'hang';
      else fail['/api/notifications'] = 'hang';
    }
    const prevMs = process.env.DA_FIXTURE_MS;
    if (c.env) process.env.DA_FIXTURE_MS = c.env;
    const P = await newCtx(surface, { lang, S: newState({ fail, slowAssets: c.slowAssets }) });
    const R = new Rec('x8', surface, lang, c.id);
    let row = { case: c.id, note: c.note };
    try {
      await P.page.goto(P.base + '/', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      const t0 = Date.now();
      // Sample the loading state for 20 s; a state that clears at ANY point resolved.
      let first = null; let last = null; let clearedAt = null;
      while (Date.now() - t0 < 20000) {
        const s = await loadingState(P);
        if (!first) first = s;
        last = s;
        if (!isLoading(s) && clearedAt === null && Date.now() - t0 > 1500) clearedAt = Date.now() - t0;
        if (isLoading(s)) clearedAt = null;
        await sleep(1000);
      }
      const text = await bodyText(P.page);
      const signedOut = surface === 'native'
        ? /\/(welcome|sign-in)/.test(P.page.url()) || text.includes(nt(lang, 'index.sign-in'))
        : await P.page.evaluate(() => !document.documentElement.classList.contains('obs-home')).catch(() => null);
      row = {
        ...row,
        stuckAfter20s: isLoading(last),
        loading: last,
        resolvedAtMs: clearedAt,
        signedOut,
        explains: text.includes(head(wt(lang, 'common.cant-reach-hawkeye'))) || text.includes(head(nt(lang, 'n.app.tabs.index.could-not-reach'))),
        explainLines: text.split('\n').map((s) => s.trim()).filter((s) => s.includes(head(wt(lang, 'common.cant-reach-hawkeye'))) || s.includes(head(nt(lang, 'n.app.tabs.index.could-not-reach')))).slice(0, 3),
        alertsBox: surface === 'native' ? null : await P.page.evaluate(() => (document.getElementById('home-alerts') || {}).innerText || null).catch(() => null),
        offlineLine: surface === 'native' ? null : await P.page.evaluate(() => { const o = document.getElementById('home-offline'); return o ? !o.hidden : null; }).catch(() => null),
        greeting: surface === 'native' ? null : await P.page.evaluate(() => (document.getElementById('home-greet') || {}).textContent || null).catch(() => null),
        url: rel(P),
        apiCalls: P.S.calls.filter((x) => x.p.startsWith('/api/')).map((x) => `${x.m} ${x.p}${x.aborted ? ' (aborted)' : x.hung ? ' (hung)' : ''}`).slice(0, 14),
      };
      row.png = await R.step(P, `Home after 20 s — ${c.id}`, { note: c.note, ok: !row.stuckAfter20s });
    } catch (e) { row.error = String(e.message).slice(0, 200); }
    if (c.env) { if (prevMs === undefined) delete process.env.DA_FIXTURE_MS; else process.env.DA_FIXTURE_MS = prevMs; }
    rows.push(row);
    await P.close();
  }
  obs(`x8.${surface}${only ? '.partial' : ''}`, rows);
  if (only) return;
  // The detector itself must be able to fail both ways.
  const b = rows.find((r) => r.case === 'baseline');
  const h = rows.find((r) => r.case === 'hang-control');
  obs(`x8.detectorValid.${surface}`, !!(b && h && b.stuckAfter20s === false && h.stuckAfter20s === true));
}

// ================================================================ shared: where am I?
/** The screen's name as the header shows it. */
async function screenName(P) {
  if (P.surface === 'native') {
    const t = await bodyText(P.page);
    return (t.split('\n').map((s) => s.trim()).find((s) => s.length > 1) || '').slice(0, 60);
  }
  return P.page.evaluate(() => {
    const bt = document.querySelector('.gov-header .brand-text strong');
    const h1 = [...document.querySelectorAll('main h1, h1')].find((h) => h.getClientRects().length);
    return ((bt && bt.textContent.trim() !== 'HAWKEYE' ? bt.textContent : (h1 ? h1.textContent : document.title)) || '').trim().slice(0, 60);
  }).catch(() => '');
}
const wrote = (S, p, pred = () => true) => S.writes.filter((w) => w.p === p && pred(w));
async function waitFor(fn, ms = 8000, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

// ================================================================ FLOW 2: FOLLOW A RACE
const RACE_ROUTE = { web: '/race.html?contest=GOV&state=Lagos', native: '/race?contest=GOV&state=Lagos' };
async function followLabel(P) {
  if (P.surface === 'native') {
    const t = await bodyText(P.page);
    const un = head(nt(P.lang, 'n.components.follow-race.unfollow'));
    const fo = head(nt(P.lang, 'n.components.follow-race.follow'));
    const line = t.split('\n').map((s) => s.trim()).find((s) => (un && s.startsWith(un)) || (fo && s.startsWith(fo)));
    return line || null;
  }
  return P.page.evaluate(() => { const b = document.getElementById('race-follow-btn'); return b && b.getClientRects().length ? b.textContent.trim() : null; }).catch(() => null);
}
async function tapFollow(P) {
  if (P.surface === 'native') {
    const un = head(nt(P.lang, 'n.components.follow-race.unfollow'));
    const fo = head(nt(P.lang, 'n.components.follow-race.follow'));
    const l = await firstVisible(P.page.getByText(new RegExp(`^(${escRe(un)}|${escRe(fo)})`)));
    if (!l) return false;
    await l.scrollIntoViewIfNeeded().catch(() => {});
    await l.click().catch(() => {});
    return true;
  }
  return tapSel(P, '#race-follow-btn');
}
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isUnfollow = (P, label) => !!label && (P.surface === 'native'
  ? label.startsWith(head(nt(P.lang, 'n.components.follow-race.unfollow')))
  : /unfollow|🔕/i.test(label));

async function openRaceFromList(P, R) {
  // races list
  if (P.surface === 'native') {
    await go(P, '/', 3000);
    await nativeTab(P, 'nav.more'); R.tap(); await sleep(1200);
    const ok = await tapText(P, nt(P.lang, 'races.races')); R.tap();
    if (!ok) await go(P, '/races', 1000);
    await waitFor(async () => (await bodyText(P.page)).includes(nt(P.lang, 'n.app.races.all').split('{')[0]) && !(await loadingState(P)).spinner, 25000);
    await R.step(P, 'Races (list)', { asked: 'pick a race' });
    // Governorship row expands into its states ("28 states" pill), then Lagos.
    const pill = await firstVisible(P.page.getByText(/^\d+ states$/));
    if (pill) { await pill.scrollIntoViewIfNeeded().catch(() => {}); await pill.click().catch(() => {}); R.tap(); await sleep(800); }
    await R.step(P, 'Races — Governorship expanded', { asked: 'pick a state' });
    const lagos = await tapText(P, 'Lagos'); R.tap();
    if (!lagos) await go(P, RACE_ROUTE.native, 1000);
  } else {
    await go(P, '/', 2500);
    const viaMenu = await webMenu(P, 'races.html'); R.tap(2);
    if (!viaMenu) await go(P, '/races.html', 0);
    await settle(P, 2500);
    await R.step(P, 'Races (list)', { asked: 'pick a race', note: viaMenu ? 'via menu' : 'menu had no Races link — opened by URL' });
    // Is the floating Ask bubble over the Governorship row's "N states" control? Hit-test it.
    obs(`follow.statesPillHit.${P.surface}.${P.lang}`, await P.page.evaluate(() => {
      const el = [...document.querySelectorAll('main *')].find((e) => !e.children.length && /^\d+ states$/i.test((e.textContent || '').trim()) && e.getClientRects().length);
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const pts = [[r.left + r.width * 0.5, r.top + r.height / 2], [r.right - 4, r.top + r.height / 2]];
      return { found: true, inView: r.top >= 0 && r.bottom <= innerHeight, hits: pts.map(([x, y]) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h) || h.contains(el) || !!h.closest('summary, button, a, [role=button]') && !h.closest('#hk-fab')); }), coveredBy: pts.map(([x, y]) => { const h = document.elementFromPoint(x, y); return h ? (h.closest('#hk-fab') ? 'hk-fab (Ask Hawkeye bubble)' : (h.id || h.tagName)) : null; }) };
    }).catch(() => ({ found: false })));
    let a = await firstVisible(P.page.locator('a[href*="contest=GOV&state=Lagos"]'));
    if (!a) {
      // The governorship row folds its states away.
      const opener = await firstVisible(P.page.locator('summary, button, [role=button]').filter({ hasText: /governorship|^\d+ states/i }));
      if (opener) { await opener.click().catch(() => {}); R.tap(); await sleep(700); }
      a = await firstVisible(P.page.locator('a[href*="contest=GOV&state=Lagos"]'));
    }
    await R.step(P, 'Races — Governorship states shown', { asked: 'pick a state' });
    if (a) { await a.scrollIntoViewIfNeeded().catch(() => {}); await a.click().catch(() => {}); R.tap(); } else await go(P, RACE_ROUTE.web, 0);
  }
  await settle(P, 3000);
  await waitFor(async () => !!(await followLabel(P)), 15000);
}

async function flowFollow(surface, lang) {
  const key = surface === 'native' ? 'native' : 'web';
  // ---- the happy path: an observer who follows nothing yet
  {
    const S = newState({ variant: 'empty' });
    const P = await newCtx(surface, { lang, S });
    const R = new Rec('follow', surface, lang);
    try {
      await openRaceFromList(P, R);
      const before = await followLabel(P);
      await R.step(P, 'Race page (Lagos governorship)', { asked: 'Follow?', note: `button: ${before}` });
      // keyboard not involved; the button must be on screen without hunting for it
      const t0 = Date.now();
      const tapped = await tapFollow(P); R.tap();
      await waitFor(async () => wrote(S, '/api/subscriptions').length > 0, 8000);
      await sleep(1500);
      const after = await followLabel(P);
      const posted = wrote(S, '/api/subscriptions')[0] || null;
      await R.step(P, 'Race page after Follow', { note: `button: ${after}; POST ${JSON.stringify(posted && posted.body)}`, ok: isUnfollow(P, after) });
      // interruption: reload — is the follow still shown?
      await P.page.reload({ waitUntil: 'load' }).catch(() => {});
      await settle(P, 3000);
      await waitFor(async () => !!(await followLabel(P)), 12000);
      const afterReload = await followLabel(P);
      await R.step(P, 'Race page after reload', { note: `button: ${afterReload}`, ok: isUnfollow(P, afterReload) });
      // where do alerts for it go? the Alerts tab/page
      if (surface === 'native') { await nativeTab(P, 'nav.alerts', R); R.tap(); await sleep(2500); }
      else if (surface === 'lite') { await tapSel(P, '.tabbar a[href="notifications.html"]'); R.tap(); await settle(P, 2500); }
      else { const ok = await tapSel(P, '.gov-header a[href$="notifications.html"]'); R.tap(); if (!ok) await go(P, '/notifications.html', 0); await settle(P, 2500); }
      const alertsText = await bodyText(P.page);
      const pushCard = surface === 'native' ? false : await P.page.evaluate(() => { const c = document.getElementById('push-card'); return !!(c && !c.hidden && c.getClientRects().length); }).catch(() => false);
      await R.step(P, 'Alerts', { asked: pushCard ? 'Enable notifications on this device?' : 'nothing — the list only', note: `push card: ${pushCard}` });
      let pushResult = null;
      if (pushCard) {
        await tapSel(P, '#push-enable'); R.tap();
        await sleep(3000);
        pushResult = await P.page.evaluate(() => (document.getElementById('push-status') || {}).textContent || '').catch(() => '');
        await R.step(P, 'Alerts — Enable notifications tapped', { note: `status: ${pushResult} (the OS permission sheet itself needs a device)` });
      }
      // notification preferences: is there anywhere to choose push / Telegram / channels?
      let prefs = {};
      if (surface === 'native') {
        await nativeTab(P, 'nav.more', R); R.tap(); await sleep(1500);
        const t = await bodyText(P.page);
        prefs = { telegramRow: /Telegram/.test(t), notificationsRow: t.includes(nt(lang, 'profile.notifications')) };
        await R.step(P, 'More (looking for notification settings)', { note: JSON.stringify(prefs) });
        await tapText(P, nt(lang, 'profile.my-profile')); R.tap(); await sleep(2500);
        const tp = await bodyText(P.page);
        prefs.profileNotificationsRow = tp.includes(nt(lang, 'profile.notifications'));
        prefs.profileRacesYouFollow = tp.toLowerCase().includes(nt(lang, 'n.app.profile.races-you-follow').toLowerCase());
        prefs.profileShowsLagos = /Lagos/.test(tp);
        await R.step(P, 'Profile (races you follow / notification settings?)', { note: JSON.stringify(prefs) });
      } else {
        await go(P, '/profile.html', 3000); R.tap(2);
        const tp = await bodyText(P.page);
        prefs = {
          profileNotificationsRow: await P.page.evaluate(() => { const b = document.getElementById('btn-push-state'); return !!(b && !b.hidden); }).catch(() => false),
          profileRacesYouFollow: tp.toLowerCase().includes(wt(lang, 'profile.races-you-follow').toLowerCase()),
          profileShowsLagos: /Lagos/.test(tp),
        };
        await R.step(P, 'Profile (races you follow / notification settings?)', { note: JSON.stringify(prefs) });
        await (surface === 'lite' ? tapSel(P, '.tabbar [data-more]') : tapSel(P, '.menu-btn'));
        await sleep(600);
        const menu = await P.page.evaluate(() => { const m = document.getElementById('menu-panel'); return m ? m.innerText : ''; }).catch(() => '');
        prefs.menuTelegram = /Telegram/.test(menu);
        prefs.menuAlertsSettings = /notification|alert/i.test(menu);
        await R.step(P, 'Menu (looking for notification settings)', { note: JSON.stringify({ menuTelegram: prefs.menuTelegram, menuAlertsSettings: prefs.menuAlertsSettings }) });
      }
      obs(`follow.happy.${surface}.${lang}`, {
        tapped, before, after, afterReload, posted: posted && posted.body, msToFollow: Date.now() - t0,
        pushCard, pushResult, prefs, alertsHasRows: alertsText.length > 50,
        followConfirmation: isUnfollow(P, after) ? 'button label flips only' : 'none',
        steps: R.steps.length, englishLabel: lang !== 'en' && /Follow this race|Unfollow this race/.test(`${before} ${after}`),
      });
    } catch (e) { obs(`follow.error.${surface}.${lang}`, String(e.message).slice(0, 200)); }
    await P.close();
  }
  if (lang !== 'en') return;
  // ---- failures on the Follow tap (en only)
  for (const c of [{ id: '500', mode: '500' }, { id: 'offline', fail: { '/api/subscriptions': 'abort' } }, { id: '409', mode: '409' }, { id: '401', mode: '401' }]) {
    const S = newState({ variant: 'empty', mode: c.mode ? { subs: c.mode } : {}, fail: c.fail || {} });
    const P = await newCtx(surface, { lang, S });
    const R = new Rec('follow', surface, lang, `err-${c.id}`);
    try {
      await go(P, RACE_ROUTE[key], 3000);
      await waitFor(async () => !!(await followLabel(P)), 15000);
      await tapFollow(P); R.tap();
      await sleep(3000);
      const text = await bodyText(P.page);
      const label = await followLabel(P);
      const msg = surface === 'native'
        ? text.split('\n').map((s) => s.trim()).filter((s) => /HTTP|could not|try again|network|failed|internet/i.test(s)).slice(0, 3).join(' / ')
        : await P.page.evaluate(() => { const m = document.getElementById('race-follow-msg'); return m && !m.hidden ? m.textContent.trim() : ''; }).catch(() => '');
      await R.step(P, `Follow tapped — ${c.id}`, { note: `message: ${msg || '(none)'}; button: ${label}` });
      obs(`follow.err.${c.id}.${surface}`, { message: msg, buttonAfter: label, png: png(R) });
    } catch (e) { obs(`follow.err.${c.id}.${surface}`, { error: String(e.message).slice(0, 200) }); }
    await P.close();
  }
  // ---- signed out
  {
    const S = newState({ variant: 'empty' });
    const P = await newCtx(surface, { lang, S, signedIn: false });
    const R = new Rec('follow', surface, lang, 'signed-out');
    try {
      await go(P, RACE_ROUTE[key], 3000);
      await waitFor(async () => !!(await followLabel(P)), 15000);
      const label = await followLabel(P);
      await R.step(P, 'Race page, signed out', { note: `button: ${label}` });
      await tapFollow(P); R.tap();
      await sleep(2500);
      const msg = surface === 'native' ? '' : await P.page.evaluate(() => { const m = document.getElementById('race-follow-msg'); return m && !m.hidden ? m.textContent.trim() : ''; }).catch(() => '');
      await R.step(P, 'Follow tapped, signed out', { note: `→ ${rel(P)} ${msg}` });
      obs(`follow.signedOut.${surface}`, { label, landed: rel(P), screen: await screenName(P), message: msg, png: png(R) });
    } catch (e) { obs(`follow.signedOut.${surface}`, { error: String(e.message).slice(0, 200) }); }
    await P.close();
  }
}

// ================================================================ FLOW 3: NOTIFICATIONS
const EXPECT_LAND = {
  result: { web: /\/results\.html\?contest=PRES&scope=Lagos/, native: /\/results\?contest=PRES&scope=Lagos/, what: 'the PRES board, Lagos' },
  incident: { web: /\/incident-reports\.html/, native: /\/incidents/, what: 'the published incident list (where "your report is live" can be seen)' },
  group_joined: { web: /\/my-groups\.html/, native: /\/my-groups/, what: 'My Groups' },
  mapping: { web: /\/map-unit\.html/, native: /\/map-unit/, what: 'Map a Polling Unit' },
  info: { web: /\/notifications\.html/, native: /\/alerts/, what: 'stays on Alerts (no url)' },
};
async function openAlerts(P) {
  if (P.surface === 'native') { await go(P, '/', 2500); await nativeTab(P, 'nav.alerts'); await sleep(2500); }
  else { await go(P, '/notifications.html', 3000); }
}
async function flowNotif(surface, lang) {
  const S = newState({});
  const P = await newCtx(surface, { lang, S });
  const rows = {};
  try {
    for (const n of notes()) {
      const R = new Rec('notif', surface, lang, n.kind);
      await openAlerts(P);
      R.tap();
      await R.step(P, 'Alerts list', { asked: `tap "${n.title}"` });
      const before = S.writes.length;
      const t = await firstVisible(P.page.getByText(n.title, { exact: true }));
      if (!t) { rows[n.kind] = { error: 'row not found' }; continue; }
      await t.click().catch(() => {}); R.tap();
      await sleep(1500);
      // a long alert opens in place first (body > 40 chars on both clients)
      let modal = false;
      const openLabel = surface === 'native' ? nt(lang, 'notifications.open') : wt(lang, 'notifications.open');
      if (surface === 'native') modal = await visibleText(P, openLabel);
      else modal = await P.page.evaluate(() => { const b = document.getElementById('nm-back'); return !!(b && !b.hidden); }).catch(() => false);
      const modalHasOpen = surface === 'native' ? modal : await P.page.evaluate(() => { const o = document.getElementById('nm-open'); return !!(o && !o.hidden && o.style.display !== 'none'); }).catch(() => false);
      if (modal || (surface !== 'native' && await P.page.evaluate(() => { const b = document.getElementById('nm-back'); return !!(b && !b.hidden); }).catch(() => false))) {
        modal = true;
        await R.step(P, 'Alert opened in place (full text)', { asked: modalHasOpen ? 'Open?' : 'Close' });
        if (modalHasOpen) {
          if (surface === 'native') await tapText(P, openLabel, { last: true }); else await tapSel(P, '#nm-open');
          R.tap();
        }
      }
      await settle(P, 4500);
      const landed = rel(P);
      const screen = await screenName(P);
      await R.step(P, `Landed: ${screen}`, { note: landed });
      const readPost = S.writes.slice(before).find((w) => w.p === '/api/notifications/read');
      const exp = EXPECT_LAND[n.kind];
      rows[n.kind] = {
        title: n.title, url: n.url, landed, screen, modal, taps: R.steps.reduce((a, s) => a + s.taps, 0),
        markedRead: !!readPost, readBody: readPost && readPost.body,
        rightPlace: exp[surface === 'native' ? 'native' : 'web'].test(landed), expected: exp.what,
        png: R.steps.map((s) => s.png),
      };
      // back to the list: is the row read now?
      await P.page.goBack({ waitUntil: 'load' }).catch(() => {});
      await settle(P, 2000);
      rows[n.kind].backTo = rel(P);
    }
    // ---- mark all read (fresh feed)
    S.notes = notes();
    const R = new Rec('notif', surface, lang, 'mark-all');
    await openAlerts(P);
    await R.step(P, 'Alerts list (5 unread)');
    const before = S.writes.length;
    if (surface === 'native') await tapLabel(P, nt(lang, 'notifications.mark-all-read')); else await tapSel(P, '#hdr-mark-all');
    R.tap();
    await sleep(2500);
    const all = S.writes.slice(before).find((w) => w.p === '/api/notifications/read' && w.body && w.body.all);
    const badge = surface === 'native'
      ? await P.page.evaluate(() => (document.body.innerText.match(/\n(\d+)\n[^\n]*$/m) || [])[1] || null).catch(() => null)
      : await P.page.evaluate(() => { const d = document.querySelector('.tab-dot, .bell-dot, .hdr-bell-n'); return d ? (d.hidden ? 'hidden' : d.textContent) : null; }).catch(() => null);
    await R.step(P, 'Alerts after Mark all read', { note: `POST all: ${!!all}` });
    rows.markAll = { posted: !!all, badge, png: png(R) };
    // ---- mark-read failure: does the row stay read on screen while the server says no?
    if (lang === 'en') {
      S.notes = notes(); S.mode.read = '500';
      const R2 = new Rec('notif', surface, lang, 'read-500');
      await openAlerts(P);
      const t = await firstVisible(P.page.getByText(KIND_TITLE.info, { exact: true }));
      if (t) { await t.click().catch(() => {}); R2.tap(); }
      await sleep(2500);
      const txt = await bodyText(P.page);
      await R2.step(P, 'Tapped an alert while /notifications/read answers 500', { note: rel(P) });
      rows.read500 = { said: /could not|try again|HTTP/i.test(txt), png: png(R2) };
      S.mode.read = undefined;
    }
  } catch (e) { rows.error = String(e.message).slice(0, 200); }
  obs(`notif.${surface}.${lang}`, rows);
  await P.close();
}

// ================================================================ FLOW 4: PROFILE / ACCOUNT
async function webLangSwitch(P, R, target) {
  await go(P, '/profile.html', 3000);
  await P.page.evaluate(() => { window.__fa_mark = 1; }).catch(() => {});
  const navBefore = P.navs.length;
  await tapSel(P, '#btn-lang'); R.tap();
  await sleep(700);
  await R.step(P, `Language picker (→ ${target})`, { asked: 'choose a language, then Save' });
  await tapSel(P, `#lang-modal label.lang-opt[data-lang="${target}"]`); R.tap();
  await tapSel(P, '#lang-save'); R.tap();
  const tSave = Date.now();
  // How long until THIS page is in the new language (html[lang] and the row)? 15 s cap.
  const switched = await waitFor(() => P.page.evaluate((t) => document.documentElement.lang === t, target).catch(() => false), 15000, 200);
  const msToSwitch = switched ? Date.now() - tSave : null;
  await sleep(800);
  const st = await P.page.evaluate(() => ({ html: document.documentElement.lang, row: (document.getElementById('p-lang') || {}).textContent, mark: window.__fa_mark === 1, tabs: [...document.querySelectorAll('.tabbar .tl')].map((x) => x.textContent), stored: localStorage.getItem('hawkeye_lang') })).catch(() => ({}));
  const text = await bodyText(P.page);
  await R.step(P, `Profile after choosing ${target}`, { note: JSON.stringify(st) });
  // the rest of the app: another page
  await go(P, '/notifications.html', 2500);
  const other = await P.page.evaluate(() => ({ html: document.documentElement.lang, h: (document.querySelector('main h1') || {}).textContent })).catch(() => ({}));
  await R.step(P, `Alerts page in ${target}`, { note: JSON.stringify(other) });
  return { ...st, msToSwitch, navsDuringSwitch: P.navs.length - navBefore, otherPage: other, profileTitleTranslated: text.includes(wt(target, 'profile.account').toUpperCase()) || text.includes(wt(target, 'profile.account')) };
}
async function nativeLangSwitch(P, R, target) {
  await go(P, '/', 2500);
  await nativeTab(P, 'nav.more'); R.tap();
  await sleep(1200);
  await P.page.evaluate(() => { window.__fa_mark = 1; }).catch(() => {});
  const navBefore = P.navs.length;
  await R.step(P, `More — Preferences (→ ${target})`, { asked: 'tap a language' });
  await tapText(P, LANG_NAME[target]); R.tap();
  const tSave = Date.now();
  const switched = await waitFor(async () => (await bodyText(P.page)).includes(nt(target, 'nav.alerts')), 15000, 200);
  const msToSwitch = switched ? Date.now() - tSave : null;
  P.lang = target; // the app's labels are in the new language from here on
  await sleep(1500);
  const t = await bodyText(P.page);
  const st = {
    msToSwitch,
    mark: await P.page.evaluate(() => window.__fa_mark === 1).catch(() => false),
    tabAlerts: t.includes(nt(target, 'nav.alerts')),
    moreTitle: t.includes(nt(target, 'nav.more')),
    stored: await P.page.evaluate(() => localStorage.getItem('hawkeye_lang')).catch(() => null),
  };
  await R.step(P, `More after choosing ${target}`, { note: JSON.stringify(st) });
  await nativeTab(P, 'nav.home'); R.tap();
  await sleep(2500);
  const th = await bodyText(P.page);
  st.homeTranslated = th.toLowerCase().includes(nt(target, 'n.app.tabs.index.live-activity').toLowerCase());
  await R.step(P, `Home in ${target}`, { note: `live-activity label in ${target}: ${st.homeTranslated}` });
  // a pushed screen: Profile
  await go(P, '/profile', 3000);
  const tp = await bodyText(P.page);
  st.profileTranslated = tp.includes(nt(target, 'profile.my-profile'));
  st.profileEnglishLeft = target === 'en' ? [] : [
    ['ACCOUNT (section label)', /(^|\n)ACCOUNT(\n|$)/], ['None Saved', /None Saved/], ['Not Available', /Not Available/],
    ['This phone has no fingerprint or face unlock set up.', /This phone has no fingerprint/], ['On / Off', /(^|\n)(On|Off)(\n|$)/],
  ].filter(([, re]) => re.test(tp)).map(([k]) => k);
  await R.step(P, `Profile in ${target}`, { note: JSON.stringify({ profileTranslated: st.profileTranslated, english: st.profileEnglishLeft }) });
  st.navsDuringSwitch = P.navs.length - navBefore;
  return st;
}

async function flowProfile(surface, lang) {
  // ---- language: en -> ha -> ig -> yo -> en (one context, the switch must stick)
  if (lang === 'en') {
    const S = newState({});
    const P = await newCtx(surface, { lang: 'en', S });
    const R = new Rec('profile', surface, 'en', 'language');
    const res = {};
    try {
      for (const target of ['ha', 'ig', 'yo', 'en']) {
        res[target] = surface === 'native' ? await nativeLangSwitch(P, R, target) : await webLangSwitch(P, R, target);
      }
      res.serverTold = S.langPut;
    } catch (e) { res.error = String(e.message).slice(0, 200); }
    obs(`profile.language.${surface}`, res);
    await P.close();
  }
  // ---- theme
  {
    const S = newState({});
    const P = await newCtx(surface, { lang, S });
    const R = new Rec('profile', surface, lang, 'theme');
    const res = {};
    try {
      const bg = () => P.page.evaluate(() => {
        const pick = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.parentElement; } return null; };
        const el = document.elementFromPoint(innerWidth / 2, innerHeight * 0.7);
        return { theme: document.documentElement.dataset.theme || null, bg: el ? pick(el) : null };
      }).catch(() => ({}));
      if (surface === 'native') {
        await go(P, '/', 2500);
        await nativeTab(P, 'nav.more'); R.tap(); await sleep(1000);
        res.before = await bg();
        await R.step(P, 'More — Theme', { asked: 'System / Light / Dark' });
        await tapText(P, nt(lang, 'n.app.tabs.more.light')); R.tap(); await sleep(1500);
        res.after = await bg();
        await R.step(P, 'More after Light');
        await P.page.reload({ waitUntil: 'load' }).catch(() => {}); await settle(P, 3000);
        res.afterReload = await bg();
        res.stored = await P.page.evaluate(() => localStorage.getItem('hawkeye.theme.pref')).catch(() => null);
        await R.step(P, 'After reload');
      } else {
        await go(P, '/', 2500);
        res.before = await bg();
        const ok = await tapSel(P, '.gov-header .theme-btn:not(.lang-btn):not(.close-btn)'); R.tap();
        await sleep(800);
        res.after = await bg();
        res.toggleOnHome = ok;
        await R.step(P, 'Home after theme toggle', { note: JSON.stringify(res.after) });
        await go(P, '/profile.html', 2500);
        res.profileHeaderToggle = await P.page.evaluate(() => !!document.querySelector('.gov-header .theme-btn:not(.lang-btn):not(.close-btn)')).catch(() => null);
        res.afterNav = await bg();
        await R.step(P, 'Profile (theme kept?)', { note: JSON.stringify(res.afterNav) });
      }
    } catch (e) { res.error = String(e.message).slice(0, 200); }
    obs(`profile.theme.${surface}.${lang}`, res);
    await P.close();
  }
  // ---- passkeys, referral, share, delete, sign-out location (en + ha)
  {
    const S = newState({ mode: { delete: '500' } });
    const P = await newCtx(surface, { lang, S });
    const R = new Rec('profile', surface, lang, 'account');
    const res = {};
    try {
      if (surface === 'native') {
        await go(P, '/', 2500);
        await nativeTab(P, 'nav.more'); R.tap(); await sleep(1000);
        await tapText(P, nt(lang, 'profile.my-profile')); R.tap();
        await sleep(3000);
      } else {
        await go(P, '/', 2500);
        const ok = surface === 'lite' ? await webMenu(P, 'profile.html') : await tapSel(P, 'footer a[href$="profile.html"], #menu-panel a[href$="profile.html"]');
        R.tap(2);
        if (!ok) await go(P, '/profile.html', 0);
        await settle(P, 3000);
        await waitFor(() => P.page.evaluate(() => { const p = document.getElementById('profile'); return !!p && !p.hidden; }).catch(() => false), 15000);
        await sleep(1500); // passkey.js lists after DOMContentLoaded
      }
      res.profileUrl = rel(P);
      await R.step(P, 'Profile', { full: false });
      const text = await bodyText(P.page);
      // passkeys
      if (surface === 'native') {
        res.passkeyRow = text.includes(nt(lang, 'passkey.profile-row'));
        if (res.passkeyRow) {
          await tapText(P, nt(lang, 'passkey.profile-row')); R.tap(); await sleep(1500);
          const rm = nt(lang, 'passkey.remove');
          res.passkeysListed = await P.page.getByText(rm, { exact: true }).count().catch(() => 0);
          res.canAddHere = await visibleText(P, nt(lang, 'passkey.add'));
          await R.step(P, 'Passkeys', { asked: 'Remove?', note: `${res.passkeysListed} listed; add here: ${res.canAddHere} (adding needs a device)` });
          await tapText(P, rm); R.tap();
          await sleep(2000);
          res.removePosted = wrote(S, '/api/observers/passkeys/remove').map((w) => w.body);
          res.passkeysAfter = await P.page.getByText(rm, { exact: true }).count().catch(() => 0);
          res.removeConfirmAsked = await visibleText(P, nt(lang, 'common.cancel'));
          await R.step(P, 'Passkeys after Remove', { note: `${res.passkeysAfter} left` });
        }
      } else {
        res.passkeyRow = await P.page.evaluate(() => { const b = document.getElementById('btn-pk-open'); return !!(b && !b.hidden); }).catch(() => false);
        if (res.passkeyRow) {
          await tapSel(P, '#btn-pk-open'); R.tap(); await sleep(800);
          res.passkeysListed = await P.page.locator('#pk-list li').count().catch(() => 0);
          res.canAddHere = await P.page.evaluate(() => !document.getElementById('pk-add').hidden).catch(() => null);
          await R.step(P, 'Passkeys', { asked: 'Remove?', note: `${res.passkeysListed} listed; add here: ${res.canAddHere}` });
          await tapSel(P, '#pk-list button[data-pk]'); R.tap();
          await sleep(1500);
          res.removePosted = wrote(S, '/api/observers/passkeys/remove').map((w) => w.body);
          res.passkeysAfter = await P.page.locator('#pk-list li').count().catch(() => 0);
          res.removeMsg = await P.page.evaluate(() => document.getElementById('pk-msg').textContent).catch(() => '');
          res.removeConfirmAsked = false; // removal is one tap, no confirm (read from passkeys modal behaviour)
          await R.step(P, 'Passkeys after Remove', { note: `${res.passkeysAfter} left — "${res.removeMsg}"` });
          await tapSel(P, '#pk-close'); R.tap();
        }
      }
      // referral: copy the invite link
      if (surface === 'native') {
        const ok = await tapText(P, nt(lang, 'profile.your-invite-link')); R.tap();
        await sleep(800);
        res.refFeedback = (await bodyText(P.page)).includes(nt(lang, 'n.app.profile.copied'));
        res.clipboard = await P.page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
        res.refTapped = ok;
        await R.step(P, 'Invite link tapped', { note: `copied feedback: ${res.refFeedback}; clipboard: ${res.clipboard}` });
        await tapText(P, nt(lang, 'profile.share-hawkeye')); R.tap();
        await sleep(1200);
        res.shared = await P.page.evaluate(() => window.__fa_shared || []).catch(() => []);
        await R.step(P, 'Share Hawkeye tapped', { note: JSON.stringify(res.shared) });
      } else {
        await tapSel(P, '#btn-ref-copy'); R.tap();
        await sleep(500);
        res.refFeedback = await P.page.evaluate(() => document.getElementById('p-ref-code').textContent).catch(() => '');
        res.clipboard = await P.page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
        await R.step(P, 'Invite link tapped', { note: `row says: ${res.refFeedback}; clipboard: ${res.clipboard}` });
        const urlBefore = rel(P);
        await tapSel(P, 'a[data-share]'); R.tap();
        await sleep(1500);
        res.shared = await P.page.evaluate(() => window.__fa_shared || []).catch(() => []);
        res.shareLanded = rel(P);
        await R.step(P, 'Share Hawkeye tapped', { note: `${JSON.stringify(res.shared)} → ${res.shareLanded}` });
        if (res.shareLanded !== urlBefore) { await P.page.goBack().catch(() => {}); await settle(P, 2000); }
      }
      // sign-out entry point: where is it?
      res.signOut = await P.page.evaluate((labels) => {
        const els = [...document.querySelectorAll('button, [role=button], a, div')].filter((e) => labels.includes((e.textContent || '').trim()) && e.getClientRects().length);
        const e = els[els.length - 1];
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const top = Math.round(r.top + scrollY);
        return { label: e.textContent.trim(), top, viewportH: innerHeight, pageH: document.documentElement.scrollHeight, aboveTheFold: top + r.height <= innerHeight, screensDown: +(top / innerHeight).toFixed(1) };
      }, [nt(lang, 'n.app.profile.sign-out'), wt(lang, 'profile.sign-out-on-this-device')]).catch(() => null);
      // delete account: walk to the final confirm; the DELETE answers 500 first, then 200
      const delLabel = surface === 'native' ? nt(lang, 'profile.delete-my-account') : wt(lang, 'profile.delete-my-account');
      if (surface === 'native') await tapText(P, delLabel); else await tapSel(P, '#btn-delete');
      R.tap();
      await sleep(1200);
      await R.step(P, 'Delete — final confirm', { asked: 'Delete your account? (Cancel / Delete My Account)' });
      res.confirmShown = surface === 'native'
        ? await visibleText(P, nt(lang, 'n.app.profile.delete-your-account'))
        : await P.page.evaluate(() => !!document.querySelector('.hk-dlg[data-hk-dialog="confirm"]')).catch(() => false);
      // the confirm itself — fixture answers 500
      if (surface === 'native') await tapText(P, delLabel, { last: true }); else await tapSel(P, '.hk-dlg .hk-dlg-ok');
      R.tap();
      await sleep(2500);
      const errText = await bodyText(P.page);
      res.delete500 = {
        posted: wrote(S, '/api/observers/delete').length,
        said: errText.split('\n').map((s) => s.trim()).filter((s) => /could not|try again|HTTP|500/i.test(s)).slice(0, 2).join(' / '),
        stillSignedIn: surface === 'native' ? !/\/welcome/.test(P.page.url()) : await P.page.evaluate(() => !!localStorage.getItem('hawkeye_token')).catch(() => null),
      };
      await R.step(P, 'Delete answered 500', { note: JSON.stringify(res.delete500) });
      // dismiss the error
      if (surface === 'native') await tapText(P, nt(lang, 'common.ok'), { last: true, timeout: 2000 }); else await tapSel(P, '.hk-dlg .hk-dlg-ok', { timeout: 2000 });
      R.tap();
      await sleep(800);
      // and again, now the fixture answers 200
      S.mode.delete = 'ok';
      if (surface === 'native') await tapText(P, delLabel); else await tapSel(P, '#btn-delete');
      R.tap(); await sleep(1000);
      if (surface === 'native') await tapText(P, delLabel, { last: true }); else await tapSel(P, '.hk-dlg .hk-dlg-ok');
      R.tap(); await sleep(2500);
      await R.step(P, 'Deleted (fixture 200)');
      if (surface !== 'native') { await tapSel(P, '.hk-dlg .hk-dlg-ok', { timeout: 2500 }); R.tap(); }
      await settle(P, 2500);
      res.delete200 = {
        posted: wrote(S, '/api/observers/delete').length,
        landed: rel(P), screen: await screenName(P),
        tokenGone: surface === 'native'
          ? await P.page.evaluate(() => !localStorage.getItem('hawkeye.auth.token')).catch(() => null)
          : await P.page.evaluate(() => !localStorage.getItem('hawkeye_token')).catch(() => null),
      };
      await R.step(P, 'After delete', { note: JSON.stringify(res.delete200) });
    } catch (e) { res.error = String(e.message).slice(0, 200); }
    obs(`profile.account.${surface}.${lang}`, res);
    await P.close();
  }
}

// ================================================================ FLOW 5: PUBLIC, SIGNED OUT
async function flowPublic(surface, lang) {
  const res = {};
  const nat = surface === 'native';
  /* THE APPS ARE SIGNED-IN ONLY (native _layout.tsx:209-253, Lite authgate.js): a
     signed-out reader is bounced to the welcome screen from every public page. That
     gate is recorded first; the lookups themselves are then walked SIGNED IN on the
     apps (the only way an app user can reach them), signed out on the website. */
  if (surface !== 'web') {
    const G = await newCtx(surface, { lang, S: newState({}), signedIn: false });
    const R = new Rec('public', surface, lang, 'signed-out-gate');
    res.gate = {};
    for (const [k, r] of nat
      ? [['verify-cert', '/verify-cert?code=K7PM-3XQR'], ['ledger', '/ledger'], ['race', '/race?contest=GOV&state=Lagos'], ['results', '/results']]
      : [['verify-cert', '/verify-cert.html?code=K7PM-3XQR'], ['ledger', '/ledger.html'], ['race', '/race.html?contest=GOV&state=Lagos'], ['results', '/results.html']]) {
      await go(G, r, 3500);
      res.gate[k] = { asked: r, landed: rel(G), screen: await screenName(G) };
      await R.step(G, `Signed out: ${r}`, { note: `→ ${rel(G)}` });
    }
    await G.close();
  }
  const S = newState({});
  const P = await newCtx(surface, { lang, S, signedIn: surface !== 'web' });
  try {
    // ---- certificate check
    {
      const R = new Rec('public', surface, lang, 'cert');
      const route = nat ? '/verify-cert' : '/verify-cert.html';
      await go(P, route, 2500);
      await R.step(P, 'Check a certificate', { asked: 'certificate code' });
      const run = async (code) => {
        const inp = await firstVisible(P.page.locator('input'));
        if (!inp) return { error: 'no input' };
        await inp.fill(''); await inp.fill(code); R.tap();
        // keyboard up: is the Check button still on screen?
        await shrinkForKeyboard(P);
        const btn = nat ? await firstVisible(P.page.getByText(nt(lang, 'cert.verify-button'), { exact: true })) : await firstVisible(P.page.locator('#vc-go'));
        const kb = await inViewport(P, btn);
        await restoreViewport(P);
        if (nat) await tapText(P, nt(lang, 'cert.verify-button')); else await tapSel(P, '#vc-go');
        R.tap();
        const t0 = Date.now();
        await sleep(600);
        await waitFor(async () => {
          const tt = await bodyText(P.page);
          return nat
            ? [nt(lang, 'cert.verify-valid-h'), nt(lang, 'cert.verify-invalid-h'), head(nt(lang, 'cert.verify-error'))].some((s) => tt.includes(s))
            : P.page.evaluate(() => document.getElementById('vc-checking').hidden).catch(() => false);
        }, 15000);
        const ms = Date.now() - t0;
        const t = await bodyText(P.page);
        const said = nat
          ? (t.includes(nt(lang, 'cert.verify-valid-h')) ? 'valid' : t.includes(nt(lang, 'cert.verify-invalid-h')) ? 'not valid' : t.includes(head(nt(lang, 'cert.verify-error'))) ? 'error' : 'unknown')
          : await P.page.evaluate(() => ['vc-valid', 'vc-invalid', 'vc-error', 'vc-checking'].find((id) => !document.getElementById(id).hidden) || 'none').catch(() => 'none');
        await R.step(P, `Checked ${code}`, { note: `${said} after ${ms} ms; Check visible with keyboard: ${kb}` });
        return { said, ms, keyboardOk: kb, url: rel(P) };
      };
      res.certValid = await run('K7PM-3XQR');
      res.certUnknown = await run('ZZZZ-2222');
      res.certBad = await run('hello');
      S.fail['/api/cert/verify'] = 'abort';
      res.certOffline = await run('K7PM-3XQR');
      delete S.fail['/api/cert/verify'];
      // deep link with the code
      await go(P, nat ? '/verify-cert?code=K7PM-3XQR' : '/verify-cert.html?code=K7PM-3XQR', 3000);
      const t = await bodyText(P.page);
      res.certDeepLink = nat ? t.includes(nt(lang, 'cert.verify-valid-h')) : await P.page.evaluate(() => !document.getElementById('vc-valid').hidden).catch(() => false);
      await R.step(P, 'Deep link /verify-cert?code=…', { note: `valid shown: ${res.certDeepLink}` });
    }
    // ---- ledger
    {
      const R = new Rec('public', surface, lang, 'ledger');
      await go(P, nat ? '/ledger' : '/ledger.html', 3500);
      await R.step(P, 'Verify the ledger', { full: false });
      const btn = nat
        ? await firstVisible(P.page.getByText(new RegExp(escRe(head(nt(lang, 'n.app.ledger.re-verify-on-this-phone') || 'Re-verify')) + '|Re-verify', 'i')))
        : await firstVisible(P.page.locator('button, [role=button]').filter({ hasText: /verify|check|tabbat|duba/i }));
      if (btn) { await btn.click().catch(() => {}); R.tap(); await sleep(3500); }
      const t = await bodyText(P.page);
      res.ledger = { button: !!btn, text: t.replace(/\s+/g, ' ').slice(0, 300), loading: isLoading(await loadingState(P)) };
      await R.step(P, 'Ledger after Verify', { note: res.ledger.button ? 'tapped verify' : 'no verify button' });
    }
    // ---- a case (none exists yet in production: a missing id, and no id)
    {
      const R = new Rec('public', surface, lang, 'case');
      await go(P, nat ? '/case?id=999999' : '/case.html?id=999999', 3500);
      const t1 = await bodyText(P.page);
      res.caseMissing = { text: t1.replace(/\s+/g, ' ').slice(0, 240), loading: isLoading(await loadingState(P)) };
      await R.step(P, 'Case 999999 (does not exist)', { note: res.caseMissing.text.slice(0, 120) });
      await go(P, nat ? '/case' : '/case.html', 3000);
      const t2 = await bodyText(P.page);
      res.caseNoId = { text: t2.replace(/\s+/g, ' ').slice(0, 240), landed: rel(P), loading: isLoading(await loadingState(P)) };
      await R.step(P, 'Case with no id', { note: res.caseNoId.text.slice(0, 120) });
    }
    // ---- results -> a race page
    {
      const R = new Rec('public', surface, lang, 'results-race');
      if (nat) { await go(P, '/', 2500); await nativeTab(P, 'nav.results'); R.tap(); await sleep(4000); }
      else await go(P, '/results.html', 4000);
      await R.step(P, 'Results', { asked: 'pick a race' });
      let reached = null;
      let via = null;
      const findLink = async () => (nat
        ? firstVisible(P.page.getByText(/^View the .* race →$|race →$/))
        : firstVisible(P.page.locator('main a[href*="race.html"], main a[href*="candidates.html"], .leaflet-popup a[href*="race"]')));
      let l = await findLink();
      // The leaderboard opens on its race picker; a by-election row (one seat) goes
      // straight to that race's page on both clients (results.html:921, results.tsx:413).
      if (!l) {
        l = await firstVisible(P.page.getByText(/Representatives By-?\s*Election/));
        if (l) via = 'race picker: by-election row';
      }
      if (!l) {
        // The way in is the map: tap a region, then its "View the … race" link.
        const map = await firstVisible(P.page.locator(nat ? 'svg' : '.leaflet-container, svg'));
        const box = map ? await map.boundingBox() : null;
        if (box && box.width > 150) {
          await map.scrollIntoViewIfNeeded().catch(() => {});
          const b2 = await map.boundingBox();
          await P.page.mouse.click(b2.x + b2.width * 0.5, b2.y + b2.height * 0.55); R.tap();
          await sleep(1500);
          via = 'map tap';
          await R.step(P, 'Results — tapped a region on the map');
          l = await findLink();
        }
      } else if (!via) via = 'link on the page';
      if (l) { await l.scrollIntoViewIfNeeded().catch(() => {}); await l.click().catch(() => {}); R.tap(); await settle(P, 3000); reached = rel(P); }
      res.resultsToRace = { reached, via, screen: await screenName(P) };
      await R.step(P, 'After tapping a race from Results', { note: JSON.stringify(res.resultsToRace) });
    }
    // ---- FAQ and How from the menu
    {
      const R = new Rec('public', surface, lang, 'menu-pages');
      for (const [k, webHref, slug, nkey] of [['faq', 'faq.html', 'faq', 'nav.faq'], ['how', 'how.html', 'how', 'common.how-hawkeye-works']]) {
        await go(P, '/', 2500);
        let ok;
        if (nat) { await nativeTab(P, 'nav.more'); R.tap(); await sleep(1000); ok = await tapText(P, nt(lang, nkey)); R.tap(); await sleep(2500); }
        else { ok = await webMenu(P, webHref); R.tap(2); await settle(P, 2500); }
        res[`menu_${k}`] = { ok, landed: rel(P), screen: await screenName(P) };
        await R.step(P, `${k.toUpperCase()} from the menu`, { note: JSON.stringify(res[`menu_${k}`]) });
      }
    }
    // ---- deep links
    {
      const R = new Rec('public', surface, lang, 'deeplinks');
      const links = nat
        ? [['race-gov-lagos', '/race?contest=GOV&state=Lagos'], ['race-pres', '/race?contest=PRES'], ['race-declared-byelection', '/race?contest=REP_BYE_GOMBE_2026'], ['room (maps to /my-groups)', '/my-groups']]
        : [['race-gov-lagos', '/race.html?contest=GOV&state=Lagos'], ['race-pres', '/race.html?contest=PRES'], ['race-declared-byelection', '/race.html?contest=REP_BYE_GOMBE_2026'], ['room', '/room/lagos-citizens']];
      res.deep = {};
      for (const [k, r] of links) {
        await go(P, r, 4000);
        const t = await bodyText(P.page);
        res.deep[k] = { route: r, landed: rel(P), screen: await screenName(P), text: t.replace(/\s+/g, ' ').slice(0, 200), loading: isLoading(await loadingState(P)) };
        await R.step(P, `Deep link ${r}`, { note: res.deep[k].text.slice(0, 120) });
      }
    }
  } catch (e) { res.error = String(e.message).slice(0, 200); }
  obs(`public.${surface}.${lang}`, res);
  await P.close();
}

// ================================================================ FLOW 6: ASK HAWKEYE + SUPPORT
const QUESTION = { en: 'How do I report a result?', ha: 'Ta yaya zan aika da sakamako?' };
async function askOnce(P, R, q) {
  const nat = P.surface === 'native';
  const inp = nat ? await firstVisible(P.page.locator('textarea, input')) : await firstVisible(P.page.locator('#hk-in'));
  if (!inp) return { error: 'no input' };
  await inp.click().catch(() => {});
  await inp.fill(q); R.tap();
  await shrinkForKeyboard(P);
  const send = nat ? await firstVisible(P.page.getByText(nt(P.lang, 'n.app.assistant.ask'), { exact: true })) : await firstVisible(P.page.locator('#hk-form button'));
  const kbInput = await inViewport(P, inp);
  const kbSend = await inViewport(P, send);
  await R.step(P, 'Typing (keyboard up)', { note: `input visible: ${kbInput}; send visible: ${kbSend}` });
  await restoreViewport(P);
  if (send) { await send.click().catch(() => {}); R.tap(); }
  await sleep(3000);
  const t = await bodyText(P.page);
  return { kbInput, kbSend, text: t };
}
async function flowAsk(surface, lang) {
  const nat = surface === 'native';
  const res = {};
  // ---- Ask Hawkeye: the answer is a fixture
  {
    const S = newState({});
    const P = await newCtx(surface, { lang, S });
    const R = new Rec('ask', surface, lang);
    try {
      await go(P, '/', 3000);
      if (nat) { await nativeTab(P, 'nav.more'); R.tap(); await sleep(1000); await tapText(P, nt(lang, 'nav.ask-hawkeye')); R.tap(); await sleep(2500); }
      else { const ok = await tapSel(P, '#hk-fab', { timeout: 10000 }); R.tap(); res.fab = ok; await sleep(1000); }
      res.entry = rel(P);
      res.greeting = nat ? nt(lang, 'n.app.assistant.ask-me-about-the-crowd-reported') : await P.page.evaluate(() => { const a = document.querySelector('#hk-msgs .hk-a'); return a ? a.textContent : null; }).catch(() => null);
      res.suggestions = nat ? ['n.app.assistant.what-is-the-presidential-tally-so', 'n.app.assistant.how-much-of-nigeria-is-mapped', 'n.app.assistant.which-states-still-have-no-reports'].map((k) => nt(lang, k)) : [];
      res.greetingInvitesHowTo = /how (do|to)|using hawkeye|report a result/i.test(res.greeting || '');
      await R.step(P, 'Ask Hawkeye opened', { asked: 'a question' });
      const a = await askOnce(P, R, QUESTION[lang] || QUESTION.en);
      res.posted = wrote(S, '/api/assistant').map((w) => w.body);
      res.answered = a.text && a.text.includes('tap Report');
      res.keyboard = { input: a.kbInput, send: a.kbSend };
      res.answerHasLink = await P.page.evaluate(() => [...document.querySelectorAll('#hk-msgs a, [dir] a')].length).catch(() => 0);
      await R.step(P, 'Answer shown', { note: `answered: ${res.answered}; a link/button to Report in the answer: ${res.answerHasLink > 0}` });
      // a refusal from the server: what does the reader see, and can they retry without retyping?
      S.mode.assistant = 'no_answer';
      const b = await askOnce(P, R, 'And where do I see my report?');
      const lastBubble = () => P.page.evaluate(() => { const a = [...document.querySelectorAll('#hk-msgs .hk-a')].pop(); return a ? a.textContent : null; }).catch(() => null);
      const lines = b.text.split('\n').map((s) => s.trim());
      res.noAnswer = {
        said: nat ? lines.filter((s) => /HTTP|no_answer|could not|try again/i.test(s)).slice(0, 2).join(' / ') : await lastBubble(),
        retry: nat ? await visibleText(P, nt(lang, 'n.app.assistant.retry')) : false,
        inputKept: nat ? null : await P.page.evaluate(() => document.getElementById('hk-in').value).catch(() => null),
      };
      await R.step(P, 'Server could not answer', { note: JSON.stringify(res.noAnswer) });
      S.mode.assistant = 'ok';
      // offline
      S.fail['/api/assistant'] = 'abort';
      const c = await askOnce(P, R, 'Is my unit covered?');
      res.offline = {
        said: nat ? c.text.split('\n').map((s) => s.trim()).filter((s) => /connection|could not|reach|internet|try again/i.test(s)).slice(0, 2).join(' / ') : await lastBubble(),
        inputKept: nat ? null : await P.page.evaluate(() => document.getElementById('hk-in').value).catch(() => null),
      };
      await R.step(P, 'Asked while offline', { note: JSON.stringify(res.offline) });
      delete S.fail['/api/assistant'];
      // close: where does it leave you?
      if (nat) await tapLabel(P, nt(lang, 'common.close')); else await tapSel(P, '#hk-x');
      R.tap(); await sleep(1500);
      res.closedTo = rel(P);
      await R.step(P, 'Closed', { note: res.closedTo });
    } catch (e) { res.error = String(e.message).slice(0, 200); }
    await P.close();
  }
  // ---- Support routes: the chat card and "Support Hawkeye"
  {
    const S = newState({});
    const P = await newCtx(surface, { lang, S });
    const R = new Rec('ask', surface, lang, 'support');
    try {
      await go(P, '/', 3000);
      const card = nat ? nt(lang, 'n.app.tabs.index.chat-card-title') : wt(lang, 'index.chat-card-title');
      await R.step(P, 'Home — chat card', { asked: card });
      if (nat) await tapText(P, card); else await tapSel(P, '.home-chat');
      R.tap();
      await sleep(8000);
      const t = await bodyText(P.page);
      res.chat = {
        landed: rel(P),
        status: nat ? '' : await P.page.evaluate(() => [...document.querySelectorAll('[data-chat-status]')].map((x) => x.textContent).join(' ')).catch(() => ''),
        loading: isLoading(await loadingState(P)),
        closeVisible: nat ? !!(await firstVisible(P.page.locator(`[aria-label="${nt(lang, 'common.close')}"]`))) : null,
        text: t.replace(/\s+/g, ' ').slice(0, 200),
        intercomBlocked: BLOCKED3P.filter((x) => /intercom/i.test(x)).length,
      };
      await R.step(P, 'After tapping the chat card (Intercom blocked by the harness)', { note: JSON.stringify(res.chat).slice(0, 200) });
      // "Support Hawkeye" — what is it?
      if (nat) { await go(P, '/', 2000); await nativeTab(P, 'nav.more'); await sleep(800); await tapText(P, nt(lang, 'support.support-hawkeye')); await sleep(2500); }
      else await go(P, '/support.html', 2500);
      const ts = await bodyText(P.page);
      res.supportPage = { landed: rel(P), isDonation: /wallet|donat|crypto|independent/i.test(ts), howToReport: /report a result|how to report/i.test(ts) };
      await R.step(P, 'Support Hawkeye', { note: JSON.stringify(res.supportPage) });
      // FAQ: does it answer "how do I report"?
      await go(P, nat ? '/page?slug=faq' : '/faq.html', 3000);
      const tf = await bodyText(P.page);
      res.faqHowToReport = /report a result|how do i report|how to report/i.test(tf);
      await R.step(P, 'FAQ', { note: `answers how to report: ${res.faqHowToReport}` });
      await go(P, nat ? '/page?slug=guide' : '/guide.html', 3000);
      const tg = await bodyText(P.page);
      res.guideHowToReport = /report a result|photograph|EC8A/i.test(tg);
      await R.step(P, 'Observer Guide', { note: `explains reporting: ${res.guideHowToReport}` });
    } catch (e) { res.supportError = String(e.message).slice(0, 200); }
    await P.close();
  }
  obs(`ask.${surface}.${lang}`, res);
}

// ================================================================ findings (from observations.json)
/* Each finding fires ONLY when the observation that proves it is present and says so;
   a flow that did not run (or whose harness failed) yields no finding, not a guess. */
function buildFindings(O) {
  const F = [];
  const g = (k) => O[k];
  const add = (f) => F.push({ needsDevice: false, ...f });
  const pngs = (...xs) => xs.flat().filter(Boolean);
  // ---- HOME
  // The order of SECTIONS — a "could not reach" line is a state, not a section (see FA-X8-2).
  const ord = (s, v) => (g(`home.order.${s}.${v}.en`) || null) && g(`home.order.${s}.${v}.en`).filter((x) => x !== 'could-not-reach line');
  if (ord('web', 'populated') && ord('native', 'populated')) {
    const w = ord('web', 'populated').join(' > ');
    const n = ord('native', 'populated').join(' > ');
    const l = (ord('lite', 'populated') || []).join(' > ');
    if (w !== n) add({
      id: 'FA-HOME-1', flow: 'home', surfaces: ['web', 'lite', 'native'], severity: 'P2',
      title: 'Home is two different screens: a personal dashboard on web/Lite, a public feed on native',
      actual: `web: ${w}. Lite: ${l || '(not run)'}. native: ${n}. Native has no greeting, no unit, no Latest Alerts, no My Activity and no report actions on Home; web/Lite have no election cards, no stats and no live feed.`,
      expected: 'One order on every surface, led by what a first-time observer must do next.',
      evidence: pngs(g('home.png.web.populated.en')?.[0], g('home.png.lite.populated.en')?.[0], g('home.png.native.populated.en')?.[0], g('home.png.native.populated.en')?.[1]),
      source: 'app/index.html:292-347 (hero 293-299, qa-grid 302-315, pday/pnudge 321-324, alerts 325-328, activity 329-336, chat 337-341, ledger 343-346); native/src/app/(tabs)/index.tsx:494-636 (error 502, election cards 508-551, show-more 556-574, practice 579, stats 581-596, chat 599-612, live activity 614-635, feed 649-701)',
      fix: 'Adopt one order: 1 next-step card (no unit → Choose your polling unit; else practice nudge / Practice Day; polls open → Report now), 2 greeting + unit, 3 two soonest elections, 4 Latest alerts (unread), 5 report actions, 6 My activity, 7 live feed/ledger, 8 Chat.',
    });
  }
  if (g('home.saveUnitPrompt.native.empty.en') === false && g('home.saveUnitPrompt.web.empty.en') === true) add({
    id: 'FA-HOME-2', flow: 'home', surfaces: ['native'], severity: 'P2',
    title: 'Native Home never tells a new observer to choose their polling unit',
    actual: 'Empty fixture (no unit saved): web/Lite hero shows "Save Your Polling Unit" and a My Polling Unit card; native Home shows election cards, practice, stats, chat and the feed — nothing about the unit.',
    expected: 'A first-time observer with no unit sees "Choose your polling unit" first on every surface.',
    evidence: pngs(g('home.png.native.empty.en')?.[0], g('home.png.web.empty.en')?.[0]),
    source: 'native/src/app/(tabs)/index.tsx:494-636 (no unit state read at all); app/index.html:297 (unit chip)',
    fix: 'Read /api/observers/my-unit on native Home and show a "Choose your polling unit" card at the top when it is null.',
  });
  {
    const hits = ['web', 'lite', 'native'].flatMap((s) => ['populated', 'empty'].flatMap((v) => ['en', 'ha'].map((l) => [s, v, l, g(`home.nudgeDismissHit.${s}.${v}.${l}`)])))
      .filter(([, , , h]) => h && h.found && h.onScreen && h.hitsDismiss === false);
    const surf = [...new Set(hits.map(([s]) => s))];
    if (surf.length) add({
      id: 'FA-HOME-3', flow: 'home', surfaces: surf, severity: 'P3',
      title: 'On first paint the floating Ask bubble sits on the practice card\'s dismiss ×',
      actual: `Hit-testing the centre of the × of "Try a practice run" at 360x740 lands on the Ask bubble in ${hits.length} of 12 Home loads (${hits.map(([s, v, l, h]) => `${s}/${v}/${l} @${h.at[1]}px`).join(', ')}); a tap there opens the assistant instead of dismissing the card. Native's bubble can be dragged away (a new user will not know); web/Lite's is fixed — scrolling moves the card out from under it.`,
      expected: 'The dismiss control is tappable at first paint; floating buttons never rest on a control.',
      evidence: pngs(g('home.png.native.populated.en')?.[0], g('home.png.lite.populated.en')?.[0], g('home.png.web.populated.en')?.[0]),
      source: 'native/src/components/ask-fab.tsx:178 (default { side: right, y: restY }); app/menu.js:2117 (#hk-fab fixed bottom-right); the × at native (tabs)/index.tsx:298-306 and app/index.html:766',
      fix: 'Keep the bubble\'s corner clear on Home (right padding on cards at its height) or start it above the tab bar edge.',
    });
  }
  const eng = (s, v, l) => g(`home.english.${s}.${v}.${l}`) || [];
  {
    const surf = ['web', 'lite'].filter((s) => [...eng(s, 'empty', 'ha'), ...eng(s, 'populated', 'ha')].includes('Nothing yet — reports at your saved unit'));
    const s = surf[0];
    if (surf.length) add({
      id: 'FA-HOME-4', flow: 'home', surfaces: surf, severity: 'P3',
      title: 'Home\'s empty alerts line stays English in Hausa',
      actual: '"Nothing yet — reports at your saved unit and status updates land here." on a Hausa Home (empty fixture).',
      expected: 'Translated like the rest of the card.',
      evidence: pngs(surf.map((x) => g(`home.png.${x}.empty.ha`)?.[1] || g(`home.png.${x}.empty.ha`)?.[0])),
      source: `app/index.html:818 (string written without a data-i18n key)${s ? '' : ''}`,
      fix: 'Give the line a key (index.nothing-yet-alerts) and apply() the box after writing it.',
    });
  }
  // ---- X8
  const x8n = g('x8.native');
  if (x8n && g('x8.detectorValid.native')) {
    const off = x8n.find((r) => r.case === 'all-offline');
    if (off && off.stuckAfter20s) add({
      id: 'FA-X8-1', flow: 'home', surfaces: ['native'], severity: 'P2',
      title: 'X8 reproduced on native: with no network Home shows the error AND a spinner forever; the only retry is pull-to-refresh',
      actual: `Every /api/ call failing (no signal): "${(off.explainLines || [])[0] || 'Could not reach hawkeye.com.ng'}" appears, but the feed's ActivityIndicator keeps spinning under it for good (still spinning at 20 s; items stays null). The only way to retry is pull-to-refresh. Slow (3 s) answers, /me 500, /me offline, /me 401 and /notifications 500 all resolved (native Home does not read /me); a dead token (every authed call 401) correctly drops to /welcome. Detector controls: baseline resolved, a never-answering feed reported stuck.`,
      expected: 'Failure replaces the spinner: one line, a Try again button, and the empty feed state.',
      evidence: pngs(off.png, x8n.find((r) => r.case === 'baseline')?.png, x8n.find((r) => r.case === 'hang-control')?.png),
      source: 'native/src/app/(tabs)/index.tsx:417-420 (sets error and returns without setItems) + :667-669 (items === null renders ActivityIndicator)',
      fix: 'On the all-failed branch call setItems([]) (or render the error as the ListEmptyComponent with a Try again that calls load()).',
    });
  }
  const x8w = g('x8.web');
  const x8l = g('x8.lite');
  {
    const cant = head(wt('en', 'common.cant-reach-hawkeye'));
    // A re-run of single cases (--x8cases) lands in x8.<surface>.partial; a row only counts if the page loaded (greeting).
    const pick = (s, c) => [...(g(`x8.${s}.partial`) || []), ...(g(`x8.${s}`) || [])].find((r) => r.case === c && r.greeting);
    const rows = ['web', 'lite'].map((s) => [s, pick(s, 'menu-js-slow'), pick(s, 'baseline')]);
    const hit = rows.filter(([, r, b]) => r && b && (r.alertsBox || '').includes(cant) && !(b.alertsBox || '').includes(cant) && r.offlineLine === false);
    const natural = ['web', 'lite'].flatMap((s) => ['populated'].flatMap((v) => (g(`home.order.${s}.${v}.en`) || []).includes('could-not-reach line') ? [`${s}/${v}/en`] : []));
    if (hit.length) add({
      id: 'FA-X8-2', flow: 'home', surfaces: hit.map(([s]) => s), severity: 'P2',
      title: 'X8 root cause on web: Latest Alerts says "Could not reach Hawkeye" when the network is fine',
      actual: `With every API answering normally and only menu.js arriving late (4 s), Latest Alerts shows "${cant}…" while the greeting, unit and My Activity all loaded (no offline line in the hero) — ${hit.map(([s, r]) => `${s}: "${(r.alertsBox || '').trim().slice(0, 60)}"`).join('; ')}. Control: the same load without the delay lists the alerts. It also happened unprovoked in this run's own Home walk (${natural.join(', ') || 'none'}). index.html renders each alert with window.timeAgo, which menu.js — the last script on the page — defines; when /api/notifications answers first the renderer throws, and .catch(alertsFailed) reports the ReferenceError as a connection failure. Before alertsFailed existed this same throw left "Loading…" up — the original X8 (2 of 10 loads). (Lite here loads its pages from the live site; if a phone's Lite serves menu.js from its own bundle the window is smaller — confirm on a slow device.)`,
      expected: 'Alerts render whenever the feed arrives; "could not reach" only for a failed request.',
      evidence: pngs(hit.map(([, r]) => r.png), rows.map(([, , b]) => b && b.png), g('home.png.web.populated.en')?.[1]),
      source: 'app/index.html:826-828 (timeAgo in the alert row) and :860 (.catch(alertsFailed)); app/menu.js:1783 (window.timeAgo), loaded last at app/index.html:991',
      fix: 'Define timeAgo inside index.html (or call it only after menu.js — e.g. render on DOMContentLoaded), and keep render exceptions out of the network-failure branch.',
      needsDevice: false,
    });
  }
  if (x8w && x8l && g('x8.detectorValid.web') && g('x8.detectorValid.lite')
      && x8w.every((r) => r.case === 'hang-control' || !r.stuckAfter20s) && x8l.every((r) => r.case === 'hang-control' || !r.stuckAfter20s)) {
    O['x8.webLiteResolved'] = true; // reported in the summary, not a finding
  }
  // ---- FOLLOW
  const fe = (c, s) => g(`follow.err.${c}.${s}`);
  if (fe('500', 'web') && /verified/i.test(fe('500', 'web').message || '')) add({
    id: 'FA-FOLLOW-1', flow: 'follow', surfaces: ['web', 'lite'].filter((s) => fe('500', s)), severity: 'P2',
    title: 'A failed Follow always blames phone verification',
    actual: `Server error (500), no network and an expired session (401) all show "${fe('500', 'web').message}" — the observer is signed in and verified; nothing tells them to retry or sign in again.`,
    expected: '500/offline: "Could not follow — check your connection and try again." 401: "Your session ended — sign in again" with a link.',
    evidence: pngs(fe('500', 'web').png, fe('offline', 'web')?.png, fe('401', 'web')?.png, fe('500', 'lite')?.png),
    source: 'app/follow.js:234-236 (any non-2xx or network failure → the verify-your-phone sentence)',
    fix: 'Branch on status: 0/5xx → connection line, 401 → sign-in line; key both for i18n.',
  });
  if (fe('offline', 'native') && /Failed to fetch|HTTP/i.test(`${fe('offline', 'native').message} ${fe('500', 'native')?.message}`)) add({
    id: 'FA-FOLLOW-2', flow: 'follow', surfaces: ['native'], severity: 'P3',
    title: 'Native Follow errors are raw technical text',
    actual: `500 → "${fe('500', 'native')?.message}"; offline → "${fe('offline', 'native').message}"; 401 → "${fe('401', 'native')?.message}" (no way to sign in again from it).`,
    expected: 'Plain words and the next step (connection / sign in again).',
    evidence: pngs(fe('500', 'native')?.png, fe('offline', 'native').png, fe('401', 'native')?.png),
    source: 'native/src/components/follow-race.tsx:204-216',
    fix: 'Use humanError() for the catch path and a sign-in action on 401.',
  });
  {
    const cov = ['web', 'lite'].filter((s) => (g(`follow.statesPillHit.${s}.en`)?.coveredBy || []).some((c) => /hk-fab/.test(c || '')));
    if (cov.length) add({
      id: 'FA-FOLLOW-6', flow: 'follow', surfaces: cov, severity: 'P3',
      title: 'The Ask bubble covers the Governorship row\'s "28 states" control on Races',
      actual: `At 360x740 the fixed chat bubble sits on the right half of "28 states" (hit-test: ${cov.map((s) => `${s} ${JSON.stringify(g(`follow.statesPillHit.${s}.en`).coveredBy)}`).join('; ')}) — the control that opens the 36 governorship pages.`,
      expected: 'Nothing floats over a control; the page leaves room for the bubble.',
      evidence: pngs(STEPS_PNG('follow', cov[0], 'en', [1])),
      source: 'app/menu.js:2117 (#hk-fab fixed bottom-right) over app/races.html governorship row',
      fix: 'Give body.has-fab pages a right gutter at the bubble\'s height, or hide the bubble while a list scrolls.',
    });
  }
  if (fe('409', 'web') && fe('409', 'native') && !fe('409', 'web').message && fe('409', 'web').buttonAfter === null) add({
    id: 'FA-FOLLOW-3', flow: 'follow', surfaces: ['web', 'lite', 'native'], severity: 'P3',
    title: 'Following a race that has just been declared makes the button vanish without a word',
    actual: 'POST /api/subscriptions → 409 race_closed: the Follow button disappears; no message on any surface.',
    expected: 'A line: "This race has been declared — there is nothing more to follow."',
    evidence: pngs(fe('409', 'web').png, fe('409', 'native').png),
    source: 'app/follow.js:229-233; native/src/components/follow-race.tsx:200-203',
    fix: 'Say why before hiding the control.',
  });
  {
    const hw = g('follow.happy.web.en'); const hn = g('follow.happy.native.en'); const hl = g('follow.happy.lite.en');
    if (hw && hn) {
      const noPrefs = [hw, hn, hl].filter(Boolean).every((h) => !h.prefs.menuAlertsSettings && !h.prefs.notificationsRow);
      if (noPrefs) add({
        id: 'FA-FOLLOW-4', flow: 'follow', surfaces: ['web', 'lite', 'native'], severity: 'P2',
        title: 'Nowhere to see or choose how race alerts reach you (push / Telegram / channel)',
        actual: `After Follow: web shows only "${hw.after}" (no confirmation of where alerts go); the browser-push card exists only on the Alerts page (${hw.pushCard ? 'shown' : 'not shown'}; the harness's Lite shows it too, a phone WebView has no Push API — needs a device); Lite's Profile row "Notifications" is a push diagnostic (stage/token length), not a setting; native has no notification setting at all (push is registered at sign-in, the Telegram row on More only opens the bot). The FAQ promises race alerts in a Telegram channel, which no follow screen mentions.`,
        expected: 'One "How you get alerts" place (Profile): this device push on/off, Telegram linked or not, the results channel — linked from the Follow confirmation.',
        evidence: pngs(hw && STEPS_PNG('follow', 'web', 'en', [4, 6, 8]), hn && STEPS_PNG('follow', 'native', 'en', [4, 6, 7, 8]), hl && STEPS_PNG('follow', 'lite', 'en', [8])),
        source: 'app/follow.js:159-163 + :238-246 (label flip is the only confirmation); app/notifications.html (#push-card); app/profile.html:230-241 + :758-795 (diagnostic row, app shell only); native/src/app/(tabs)/more.tsx (SocialRow only); native/src/app/profile.tsx (no notification row)',
        fix: 'Add a Notifications section to Profile on all surfaces and show "Alerts on — by push and Telegram · change" after Follow.',
      });
    }
    for (const l of ['ha']) {
      const h = g(`follow.happy.web.${l}`);
      if (h && h.before && /Follow this race|Unfollow this race/.test(`${h.before} ${h.after}`)) add({
        id: 'FA-FOLLOW-5', flow: 'follow', surfaces: ['web', 'lite'], severity: 'P2',
        title: 'The Follow button is English on a Hausa race page',
        actual: `In ha the race page's button reads "${h.before}" / "${h.after}"; follow.js repaints the translated markup label with hardcoded English, and its messages ("To follow a race, first verify your phone…", "Could not update following…") are English too.`,
        expected: `Hausa label and messages, like native ("${nt('ha', 'n.components.follow-race.follow', { v0: nt('ha', 'n.components.follow-race.this-race') })}").`,
        evidence: pngs(STEPS_PNG('follow', 'web', l, [3, 4]), STEPS_PNG('follow', 'lite', l, [3, 4])),
        source: 'app/follow.js:27-38 (CONTEST_PLURAL / followSubject in English), :159-163 (paint() writes English over the translated markup label from race.js:847), :208 and :235 (messages)',
        fix: 'Use HawkeyeI18n.t with the race.follow-this-race / native follow-race keys and repaint on hawkeye-lang.',
      });
    }
  }
  // ---- NOTIFICATIONS
  {
    const nw = g('notif.web.en'); const nn = g('notif.native.en'); const nl = g('notif.lite.en');
    if (nw && nn && nw.incident && nn.incident && !nw.incident.rightPlace && nn.incident.rightPlace) add({
      id: 'FA-NOTIF-1', flow: 'notif', surfaces: ['web', 'lite'], severity: 'P2',
      title: '"Your incident report is live" opens the Report-an-Incident form on web/Lite, the published list on native',
      actual: `Web/Lite land on ${nw.incident.landed} ("${nw.incident.screen}"): a new-incident form, with Published Incidents below it. Native maps the same url to /incidents ("${nn.incident.screen}").`,
      expected: 'All surfaces open the published incident list (incident-reports.html), where the observer can see their report.',
      evidence: pngs([nw.incident.png, nl?.incident?.png, nn.incident.png].map((a) => (a || [])[a ? a.length - 1 : 0]), (nw.incident.png || [])[1]),
      source: 'backend/src/routes/admin.js:201 and :209 (url incidents.html for the "mine" and unit-saver alerts); native/src/lib/push.ts:190 (incidents.html → /incidents)',
      fix: 'Send https://hawkeye.com.ng/incident-reports.html in both pushNote calls and map it to /incidents in push.ts ROUTES.',
    });
    const taps = (x) => x && Object.entries(x).filter(([k, v]) => v && v.modal).map(([k, v]) => `${k} ${v.taps}`);
    if (nw && nn && (taps(nw) || []).length >= 3) add({
      id: 'FA-NOTIF-2', flow: 'notif', surfaces: ['web', 'lite', 'native'], severity: 'P3',
      title: 'Every real alert takes three taps to reach what it is about',
      actual: `The backend\'s bodies are all longer than the 40-character one-line limit, so tapping an alert opens a full-text modal first and the target needs "Open": web ${taps(nw).join(', ')}; native ${taps(nn).join(', ')} (list tap → modal → Open).`,
      expected: 'One tap opens the target; the full text is shown on the target or behind a "More" affordance only.',
      evidence: pngs(nw.result?.png, nn.result?.png),
      source: 'app/notifications.html (ONE_LINE = 40, data-modal); native/src/app/(tabs)/alerts.tsx:42 and :222-225',
      fix: 'Navigate on tap when the alert has a url; keep the modal for url-less long alerts.',
    });
    if (nw && nn && nw.read500 && nn.read500 && nw.read500.said === false && nn.read500.said === true) add({
      id: 'FA-NOTIF-3', flow: 'notif', surfaces: ['web', 'lite'], severity: 'P3',
      title: 'Web marks an alert read on screen even when the server refused',
      actual: '/api/notifications/read answering 500: web/Lite show the row as read and say nothing (keepalive fire-and-forget), so it returns as unread on the next load; native puts the row back and says "Could not mark that read".',
      expected: 'Same as native.',
      evidence: pngs(nw.read500.png, nn.read500.png),
      source: 'app/notifications.html:451-465 markOneRead() (keepalive fetch, .catch(() => {}), row painted read first)',
      fix: 'On a non-OK answer, restore the unread class and the badge.',
    });
  }
  // ---- PROFILE
  {
    const lw = g('profile.language.web'); const ln = g('profile.language.native'); const ll = g('profile.language.lite');
    for (const [s, L] of [['web', lw], ['lite', ll]]) {
      if (!L) continue;
      const slow = Object.entries(L).filter(([k, v]) => v && typeof v === 'object' && 'msToSwitch' in v && (v.msToSwitch === null || v.msToSwitch > 5000));
      if (slow.length) add({
        id: `FA-PROF-LANG-${s}`, flow: 'profile', surfaces: [s], severity: 'P2',
        title: 'Choosing a language in Profile does not switch the open page (or takes seconds)',
        actual: `After Save: ${slow.map(([k, v]) => `${k}: ${v.msToSwitch === null ? 'not switched within 15 s' : v.msToSwitch + ' ms'} (html lang ${v.html}, row "${v.row}")`).join('; ')}. The next page opens in the chosen language.`,
        expected: 'The page switches as soon as Save is tapped (as it does for the others).',
        evidence: pngs(STEPS_PNG('profile:language', s, 'en', [8, 9])),
        source: 'app/lang.js (#lang-save → I18N.set(code)) / app/i18n.js set()',
        fix: 'Show a busy state until the bundle lands and apply it to the open page; preload bundles on picker open.',
      });
    }
    if (ln) {
      const left = [...new Set(['ha', 'ig', 'yo'].flatMap((k) => (ln[k] && ln[k].profileEnglishLeft) || []))];
      if (left.length) add({
        id: 'FA-PROF-2', flow: 'profile', surfaces: ['native'], severity: 'P3',
        title: 'Native Profile keeps English words in every other language',
        actual: `In ha/ig/yo: ${left.join(', ')}.`,
        expected: 'Translated (the keys exist on web: profile.account, profile.none-saved).',
        evidence: pngs(STEPS_PNG('profile:language', 'native', 'en', [4])),
        source: 'native/src/app/profile.tsx:667 ("Account"), :761 (\'On\'/\'Off\'/\'Not Available\'), :767, :774, :787 (\'None Saved\'), :950-951, :963',
        fix: 'Replace the literals with i18nT keys.',
      });
      const broken = ['ha', 'ig', 'yo', 'en'].filter((k) => ln[k] && (ln[k].mark === false || ln[k].msToSwitch === null));
      if (broken.length) O['profile.language.native.broken'] = broken;
    }
    const aw = g('profile.account.web.en'); const an = g('profile.account.native.en');
    if (aw && aw.removePosted && aw.removePosted.length && aw.removeConfirmAsked === false) add({
      id: 'FA-PROF-3', flow: 'profile', surfaces: ['web', 'lite'].concat(an && an.removePosted && an.removePosted.length && !an.removeConfirmAsked ? ['native'] : []), severity: 'P3',
      title: 'Removing a passkey is one tap with no confirmation',
      actual: `Tapping Remove deletes the sign-in passkey at once (${aw.passkeysListed} → ${aw.passkeysAfter}). Lite cannot add one back ("${'You can add a passkey in the Hawkeye app…'}").`,
      expected: 'A confirm ("Remove the passkey on Chrome on Android? You will sign in with a code on that device.")',
      evidence: pngs(STEPS_PNG('profile:account', 'web', 'en', [2, 3]), an && STEPS_PNG('profile:account', 'native', 'en', [2, 3])),
      source: 'app/profile.html:896-911; native/src/app/profile.tsx:316 (onRemovePasskey) via :708-711',
      fix: 'hkConfirm / ConfirmSheet before POST /api/observers/passkeys/remove.',
    });
  }
  // ---- PUBLIC
  {
    const pw = g('public.web.en');
    if (pw && pw.caseMissing && /sign in/i.test(pw.caseMissing.text)) add({
      id: 'FA-PUB-1', flow: 'public', surfaces: ['web'], severity: 'P2',
      title: 'A public case page asks a signed-out visitor to sign in',
      actual: `case.html?id=… (linked from the public docket) bounces to ${pw.caseNoId ? pw.caseNoId.landed : 'observe.html?intent=signin'}; docket.html, ledger.html and integrity.html are public ("anyone can audit").`,
      expected: 'A case is readable signed out; only casting a verdict asks for sign-in.',
      evidence: pngs(STEPS_PNG('public:case', 'web', 'en', [1, 2])),
      source: 'app/authgate.js:69-76 (WEB_PUBLIC has docket.html but not case.html)',
      fix: "Add 'case.html': 1 to WEB_PUBLIC; case.html already gates the verdict form on its own token check.",
    });
    const pn = g('public.native.en');
    if (pw && pn && pw.deep && pn.deep && /unavailable/i.test(pw.deep['race-pres']?.text || '')) add({
      id: 'FA-PUB-2', flow: 'public', surfaces: ['web', 'lite', 'native'], severity: 'P3',
      title: 'A race link for the presidency is a dead end with a wrong explanation',
      actual: `race.html?contest=PRES → "Race data unavailable. Try again" (a reload cannot help); native /race?contest=PRES → "${(pn.deep['race-pres']?.text || '').replace(/^.*Details\s*/, '').slice(0, 110)}" — the presidential page exists (candidates).`,
      expected: 'Both send PRES to the presidential page (candidates.html / /candidates).',
      evidence: pngs(STEPS_PNG('public:deeplinks', 'web', 'en', [2]), STEPS_PNG('public:deeplinks', 'native', 'en', [2])),
      source: 'app/race.js:488-494 (no race → unavailable + reload); native/src/app/race.tsx:273 (n.app.race.hawkeye-has-no-page-for-this)',
      fix: 'Redirect contest=PRES to the candidates page on both clients.',
    });
    if (pn && pn.caseMissing && /no_such_case/.test(pn.caseMissing.text)) add({
      id: 'FA-PUB-3', flow: 'public', surfaces: ['native'], severity: 'P3',
      title: 'Native missing-case screen: raw error code, and the sentence is English-only',
      actual: `"${pn.caseMissing.text.trim().slice(0, 110)}"${g('public.native.ha')?.caseMissing ? ` — in Hausa: "${g('public.native.ha').caseMissing.text.trim().slice(0, 90)}"` : ''}`,
      expected: 'A translated sentence without "(no_such_case)".',
      evidence: pngs(STEPS_PNG('public:case', 'native', 'en', [1]), STEPS_PNG('public:case', 'native', 'ha', [1])),
      source: 'native/src/app/case.tsx:200 (hardcoded English + ({c?.error ?? err}))',
      fix: 'Key the sentence and drop the code from the reader-facing line.',
    });
    const gate = pn && pn.gate;
    if (gate && Object.values(gate).every((x) => /welcome/.test(x.landed))) add({
      id: 'FA-PUB-4', flow: 'public', surfaces: ['lite', 'native'], severity: 'P3',
      title: 'Signed out, the apps bounce every public lookup (native even the certificate check)',
      actual: `Native: ${Object.entries(gate).map(([k, v]) => `${k} → ${v.landed}`).join(', ')}. Lite: ${g('public.lite.en')?.gate ? Object.entries(g('public.lite.en').gate).map(([k, v]) => `${k} → ${v.landed}`).join(', ') : '(not run)'}. The website shows all four signed out. So a certificate holder's verifier who has the app gets a sign-up wall on native but the check on Lite.`,
      expected: 'Owner decision: at least verify-cert and the ledger ("anyone can audit") open signed out in both apps, the same way.',
      evidence: pngs(STEPS_PNG('public:signed-out-gate', 'native', 'en', [1, 2])),
      source: 'native/src/app/_layout.tsx:209-253 (allowed = welcome/sign-in/practice/open/join); app/authgate.js:63,83 (app shell: ALWAYS only)',
      fix: 'Add verify-cert and ledger to the signed-out allow-list on both apps (read-only, no account data).',
    });
  }
  // ---- ASK / SUPPORT
  {
    const aw = g('ask.web.en'); const an = g('ask.native.en');
    if (aw && an && aw.noAnswer && an.noAnswer) add({
      id: 'FA-ASK-1', flow: 'ask', surfaces: ['web', 'lite'], severity: 'P2',
      title: 'Ask Hawkeye on web/Lite: a failed answer loses the question and says nothing useful',
      actual: `Server cannot answer → "${aw.noAnswer.said}"; offline → "${aw.offline?.said}". The input is cleared ("${aw.noAnswer.inputKept}"), there is no Retry — the question must be retyped. Native keeps the question and offers "${nt('en', 'n.app.assistant.retry')}" (but shows the raw "${an.noAnswer.said}").`,
      expected: 'Keep the question, offer Retry, say whether it was the connection or the service.',
      evidence: pngs(STEPS_PNG('ask', 'web', 'en', [5, 7]), STEPS_PNG('ask', 'native', 'en', [5])),
      source: 'app/menu.js:2214-2227 (input cleared before the fetch, single generic error); native/src/app/assistant.tsx:132-137 (raw code in the message)',
      fix: 'Clear the input only on success; add a Retry chip; native: drop "(no_answer / HTTP 200)" from the sentence.',
    });
    if (aw && an && aw.answered && an.answered && !aw.answerHasLink && !an.answerHasLink) add({
      id: 'FA-ASK-2', flow: 'ask', surfaces: ['web', 'lite', 'native'], severity: 'P3',
      title: 'Ask Hawkeye can explain how to report but gives no way to start',
      actual: `The greeting ("${(an.greeting || '').slice(0, 80)}…") and the three suggestions are about results only; asked "How do I report a result?", the (fixture) answer says "tap Report" in plain text — no button; native's assistant is a modal over the tab bar, so Report is not even visible until it is closed.`,
      expected: 'How-to answers carry a "Report a result" / "Practice first" button; one suggestion is "How do I report a result?".',
      evidence: pngs(STEPS_PNG('ask', 'web', 'en', [3]), STEPS_PNG('ask', 'native', 'en', [3])),
      source: 'native/src/app/assistant.tsx:30-43 (greeting, SUGGESTIONS); app/menu.js:2196; backend/src/services/assistant.js:62-68 (the how-to guide it answers from)',
      fix: 'Add a how-to suggestion and render action chips (Report / Practice) under how-to answers.',
    });
    if (aw && an && aw.supportPage && an.supportPage && aw.supportPage.isDonation && aw.faqHowToReport === false) add({
      id: 'FA-ASK-3', flow: 'ask', surfaces: ['web', 'lite', 'native'], severity: 'P3',
      title: '"Support" is a donation page and the FAQ never says how to report',
      actual: `Footer "Support" (web) and More → "Support Hawkeye" (native) open crypto wallets, not help. The FAQ (${aw.faqHowToReport ? 'has' : 'has no'} reporting question) covers alerts, codes and photos; reporting is only explained in the Observer Guide (${aw.guideHowToReport ? 'yes' : 'no'}). The chat card is the only human route: web falls back to "The chat could not load. Email info@hawkeye.com.ng" when Intercom cannot load; native\'s chat is a WebView (needs a device to judge).`,
      expected: 'A "How do I report a result?" FAQ entry linking to the guide and to Practice; the donation page named "Donate".',
      evidence: pngs(STEPS_PNG('ask:support', 'web', 'en', [2, 3, 4]), STEPS_PNG('ask:support', 'native', 'en', [2, 3])),
      source: 'app/faq.html:55-110; app/support.html:83-92; native/src/app/support.tsx:73-91',
      fix: 'Add the FAQ entry; rename the footer link "Donate".',
    });
    if (an && an.chat && /WebView does not support/i.test(an.chat.text || '')) add({
      id: 'FA-ASK-4', flow: 'ask', surfaces: ['native'], severity: 'P3',
      title: 'Native "Chat with us" could not be judged off-device',
      actual: 'The chat screen is a react-native-webview of about.html?chat=1&embed=1 (Intercom); the web export renders "React Native WebView does not support this platform." Its close (×) is present while loading.',
      expected: 'Check on a phone: the messenger opens, closing it returns to Home.',
      evidence: pngs(STEPS_PNG('ask:support', 'native', 'en', [2])),
      source: 'native/src/app/chat.tsx', fix: 'Device check only.', needsDevice: true,
    });
  }
  return F;
}
/** png names of given step numbers for flow/surface/lang (filled from steps.json at build time). */
let STEPS_ALL = {};
function STEPS_PNG(flow, surface, lang, ns) {
  const steps = (((STEPS_ALL[flow] || {})[surface] || {})[lang]) || [];
  return ns.map((n) => steps.find((s) => s.n === n)).filter(Boolean).map((s) => s.png);
}

// ================================================================ main
const RUN = {
  home: async () => { for (const s of SURFACES) for (const l of LANGS) { log('home', s, l); await flowHome(s, l); } },
  x8: async () => { for (const s of SURFACES) { log('x8', s); await flowX8(s); } },
  follow: async () => { for (const s of SURFACES) for (const l of LANGS) { log('follow', s, l); await flowFollow(s, l); } },
  notif: async () => { for (const s of SURFACES) for (const l of LANGS) { log('notif', s, l); await flowNotif(s, l); } },
  profile: async () => { for (const s of SURFACES) for (const l of LANGS) { log('profile', s, l); await flowProfile(s, l); } },
  public: async () => { for (const s of SURFACES) for (const l of LANGS) { log('public', s, l); await flowPublic(s, l); } },
  ask: async () => { for (const s of SURFACES) for (const l of LANGS) { log('ask', s, l); await flowAsk(s, l); } },
};

async function probe() {
  const i = argv.indexOf('--probe');
  const [surface, inout, ...routes] = argv.slice(i + 1);
  const P = await newCtx(surface, { lang: arg('lang', 'en').split(',')[0], signedIn: inout === 'in', S: newState({ variant: arg('variant', 'populated') }) });
  for (const r of routes) {
    await go(P, r, 4000);
    const t = await bodyText(P.page);
    const links = await P.page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => a.getClientRects().length).map((a) => `${a.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)} -> ${a.getAttribute('href')}`).slice(0, 60)).catch(() => []);
    const f = `probe-${surface}-${inout}-${r.replace(/[^a-z0-9]+/gi, '_')}.png`;
    await P.page.screenshot({ path: path.join(OUT, f) }).catch(() => {});
    console.log(`===== ${surface} ${inout} ${r} -> ${rel(P)}\n${t.slice(0, 2500)}\n-- links\n${links.join('\n')}\n-- api\n${P.S.calls.map((c) => `${c.m} ${c.p}`).join('\n')}\n-- errors ${P.errors.join(' | ')}`);
  }
  await P.close();
}

const t0 = Date.now();
if (argv.includes('--probe')) await probe();
else {
  if (!argv.includes('--findings')) for (const f of FLOWS) if (RUN[f]) { log('FLOW', f); await RUN[f](); }
  // Merge with earlier runs (a partial re-run must not drop other flows' results).
  // A lock file, because two runs (different --flow sets) may finish together.
  const lock = path.join(OUT, '.merge.lock');
  for (let i = 0; i < 100; i++) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch { await sleep(200); }
  }
  const merge = (file, obj) => {
    const p = path.join(OUT, file);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { prev = {}; }
    const next = { ...prev };
    for (const [k, v] of Object.entries(obj)) next[k] = (v && typeof v === 'object' && !Array.isArray(v) && prev[k] && typeof prev[k] === 'object' && file === 'steps.json')
      ? { ...prev[k], ...Object.fromEntries(Object.entries(v).map(([s, l]) => [s, { ...(prev[k][s] || {}), ...l }])) }
      : v;
    fs.writeFileSync(p, JSON.stringify(next, null, 1));
  };
  try {
    if (!argv.includes('--findings')) {
      merge('steps.json', STEPS);
      merge('observations.json', OBS);
    }
    writeFindings();
  } finally { try { fs.unlinkSync(lock); } catch { /* */ } }
}
function writeFindings() {
  let O = {};
  try { O = JSON.parse(fs.readFileSync(path.join(OUT, 'observations.json'), 'utf8')); } catch { O = {}; }
  try { STEPS_ALL = JSON.parse(fs.readFileSync(path.join(OUT, 'steps.json'), 'utf8')); } catch { STEPS_ALL = {}; }
  // Evidence must exist: a screenshot that failed mid-navigation is dropped, not cited.
  const F = buildFindings(O).map((f) => ({ ...f, evidence: [...new Set(f.evidence)].filter((e) => fs.existsSync(path.join(OUT, e))) }));
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(F, null, 1));
  log('findings', F.length, JSON.stringify(F.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {})));
}
await browser.close();
if (server) server.close();
log('done', Math.round((Date.now() - t0) / 1000) + 's', 'safety', JSON.stringify({ passGet: SAFETY.passGet, fixtures: SAFETY.fixtures, blockedWrites: SAFETY.blockedWrites.length, blocked3p: BLOCKED3P.length, sentry: SAFETY.sentry }));
if (SAFETY.blockedWrites.length) log('blocked writes (unanswered by a fixture):', [...new Set(SAFETY.blockedWrites)].join(', '));
process.exit(0);

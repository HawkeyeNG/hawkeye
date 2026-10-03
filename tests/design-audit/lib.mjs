/**
 * Shared plumbing for the design audit (tests/design-audit/).
 *
 * READ-ONLY AGAINST PRODUCTION — the same rule as tests/e2e/first_time_observer.mjs:
 *   - every /api/ request goes through a Playwright route handler;
 *   - GET/HEAD to a public endpoint is passed to production WITHOUT the
 *     Authorization header (production never sees the audit's fake token);
 *   - an endpoint that needs a session is answered from fixtures.mjs (a fake
 *     "Design Audit" observer, #0), so signed-in screens render with no account;
 *   - every write (POST/PUT/PATCH/DELETE) is answered locally: a fixture when one
 *     exists (practice submit, resume), otherwise a blocked 403 — nothing is sent;
 *   - Sentry, Cloudflare beacons and .apk downloads are blocked and counted.
 * Service workers are BLOCKED in every context: a SW-handled fetch would bypass
 * the route handler (and with it the guard).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
const require_ = createRequire(HERE + '/');
export const { chromium } = require_('playwright-core');
export const CHROME = process.env.CHROME_PATH || '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
export const SITE = 'https://hawkeye.com.ng';
/* AUDIT_PAGES=http://127.0.0.1:<port> measures UNSHIPPED pages (a local mirror of
   app/); the API still passes through to SITE. AUDIT_OUT keeps such a run apart
   from the published audit's out/. */
export const PAGES = process.env.AUDIT_PAGES || SITE;
export const OUT = process.env.AUDIT_OUT || path.join(HERE, 'out');
export const NATIVE_DIR = process.env.NATIVE_DIR || path.join(REPO, 'tmp/e2e-native-web');

export const LANGS = ['en', 'ha', 'ig', 'yo'];
export const THEMES = ['light', 'dark'];
export const VIEWPORTS = {
  s360: { width: 360, height: 740, dsf: 2, label: '360x740 (low-end Android)' },
  s390: { width: 390, height: 844, dsf: 2, label: '390x844 (iPhone-size)' },
  d1366: { width: 1366, height: 900, dsf: 1, label: '1366x900 (laptop)' },
};
export const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 11; TECNO KG5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
export const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* A JWT-SHAPED token, unsigned. The web client only decodes `exp` (authgate.js,
   app.js tokenFresh); the server would reject it, which is why it never reaches
   the server — the Authorization header is stripped on every pass-through. */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
export const FAKE_TOKEN = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '7', via: 'pw', exp: 4102444800 })}.design-audit`;

export const SAFETY = { passGet: 0, fixtures: 0, blockedWrites: [], sentry: 0, beacons: 0, apk: 0, cacheHits: 0, unknownAuth: new Map() };

/* A process-wide cache for pass-through GETs. Hundreds of page loads ask
   production for the same public data files; one fetch each is plenty for a
   design review, and it keeps the audit's load on the origin small. */
const PASS_CACHE = new Map();
export async function cachedGet(url, headers = {}) {
  const hit = PASS_CACHE.get(url);
  if (hit) { SAFETY.cacheHits++; return hit; }
  const r = await fetch(url, { headers: { 'user-agent': 'hawkeye-design-audit', ...headers } });
  const v = { status: r.status, type: r.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await r.arrayBuffer()) };
  if (r.status === 200) PASS_CACHE.set(url, v);
  SAFETY.passGet++;
  return v;
}

/**
 * Install the API guard on a context.
 *   fixtures(method, url, hasAuth) -> undefined | { status, json }
 * `signedIn` decides whether an auth-carrying GET that production refuses is
 * replaced by an empty 200 (signed-in screens must not bounce to sign-in because
 * one secondary widget had no fixture) — logged so the gap is visible.
 */
export async function installGuard(ctx, { fixtures = () => undefined, signedIn = false, onApi = null, crossOrigin = false } = {}) {
  if (crossOrigin) {
    // The native web export runs on 127.0.0.1 and reads data files (not only /api/)
    // from https://hawkeye.com.ng; production sends no CORS header, so GETs are
    // fetched here and answered with one. Registered FIRST so the /api/ route
    // below (registered later) wins for API paths.
    await ctx.route(/^https:\/\/hawkeye\.com\.ng\//, async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' } });
      if (req.method() !== 'GET' && req.method() !== 'HEAD') { SAFETY.blockedWrites.push(`${req.method()} ${req.url()}`); return route.abort('blockedbyclient'); }
      try {
        const r = await cachedGet(req.url());
        return route.fulfill({ status: r.status, headers: { 'content-type': r.type, 'access-control-allow-origin': '*' }, body: r.body });
      } catch (e) { return route.abort('failed'); }
    });
  }
  const cors = (req) => [
    { name: 'access-control-allow-origin', value: req.headers().origin || '*' },
    { name: 'access-control-allow-credentials', value: 'true' },
    { name: 'access-control-allow-headers', value: '*' },
    { name: 'access-control-allow-methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
  ];
  const fulfilJson = (route, req, status, json) => route.fulfill({
    status, headers: Object.fromEntries([...cors(req), { name: 'content-type', value: 'application/json' }].map((h) => [h.name, h.value])),
    body: JSON.stringify(json),
  });
  if (PAGES !== SITE) {
    // Lite rewrites root-relative fetches (i18n bundles, data files) to SITE:
    // answer those from the local mirror too, so the run measures ONE build.
    await ctx.route(/^https:\/\/hawkeye\.com\.ng\/(?!api\/)/, async (route) => {
      const u = new URL(route.request().url());
      try {
        const r = await fetch(PAGES + u.pathname + u.search);
        return route.fulfill({ status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*' }, body: Buffer.from(await r.arrayBuffer()) });
      } catch (e) { return route.abort('failed'); }
    });
  }
  await ctx.route(/sentry\.io|ingest\.(de\.)?sentry/, (route) => { SAFETY.sentry++; return route.abort('blockedbyclient'); });
  await ctx.route(/cloudflareinsights\.com|\/cdn-cgi\/rum/, (route) => { SAFETY.beacons++; return route.abort('blockedbyclient'); });
  await ctx.route(/\.apk(\?|$)/, (route) => { SAFETY.apk++; return route.abort('blockedbyclient'); });
  await ctx.route(/^https?:\/\/(hawkeye\.com\.ng|127\.0\.0\.1:\d+|localhost:\d+)\/api\//, async (route) => {
    const req = route.request();
    const m = req.method();
    const u = new URL(req.url());
    const hasAuth = !!(req.headers().authorization);
    if (m === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: Object.fromEntries(cors(req).map((h) => [h.name, h.value])) });
    }
    const fx = fixtures(m, u, hasAuth, req);
    if (fx !== undefined) {
      SAFETY.fixtures++;
      // A real answer takes a round trip; an instant one exposes ordering races a
      // phone would not hit on first load (DA_FIXTURE_MS=0 to see them).
      await sleep(Number(process.env.DA_FIXTURE_MS ?? 450));
      onApi && onApi({ method: m, path: u.pathname + u.search, status: fx.status || 200, source: 'fixture' });
      return fulfilJson(route, req, fx.status || 200, fx.json);
    }
    if (m !== 'GET' && m !== 'HEAD') {
      SAFETY.blockedWrites.push(`${m} ${u.pathname}`);
      onApi && onApi({ method: m, path: u.pathname, status: 403, source: 'blocked' });
      return fulfilJson(route, req, 403, { ok: false, error: 'design_audit_blocked' });
    }
    // Pass-through: always to production, never with the fake token.
    const target = SITE + u.pathname + u.search;
    try {
      const r = await cachedGet(target, { accept: req.headers().accept || '*/*' });
      const buf = r.body;
      onApi && onApi({ method: m, path: u.pathname + u.search, status: r.status, source: 'prod', hasAuth });
      if ((r.status === 401 || r.status === 403) && signedIn) {
        const k = u.pathname;
        SAFETY.unknownAuth.set(k, (SAFETY.unknownAuth.get(k) || 0) + 1);
        return fulfilJson(route, req, 200, {});
      }
      return route.fulfill({
        status: r.status,
        headers: Object.fromEntries([...cors(req), { name: 'content-type', value: r.type }].map((h) => [h.name, h.value])),
        body: buf,
      });
    } catch (e) {
      return fulfilJson(route, req, 502, { ok: false, error: 'design_audit_proxy_failed' });
    }
  });
}

/** Context setup shared by every surface. */
export function contextOptions(vp, { theme = 'dark', mobile = true, ua } = {}) {
  return {
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dsf,
    isMobile: mobile,
    hasTouch: mobile,
    userAgent: ua || (mobile ? UA_ANDROID : UA_DESKTOP),
    locale: 'en-NG',
    timezoneId: 'Africa/Lagos',
    colorScheme: theme,
    reducedMotion: 'reduce', // cross-document view transitions stall headless Chromium (see e2e REPORT #7)
    serviceWorkers: 'block',
    acceptDownloads: false,
    permissions: ['geolocation'],
    geolocation: { latitude: 9.0579, longitude: 7.4951 }, // Abuja
  };
}

/** Web/Lite storage + Lite shell. Runs before any page script. */
export function webInit({ lite = false, signedIn = false, lang = 'en', theme = 'dark', tourSeen = true } = {}) {
  return { script: ([lite, signedIn, lang, theme, tourSeen, token]) => {
    if (window !== window.top) return; // init scripts also run in iframes (Cloudflare's same-origin challenge frame)
    try {
      localStorage.clear(); // a shared profile: every visit starts from a first-visit state
      localStorage.setItem('hawkeye_lang', lang);
      localStorage.setItem('hawkeye_theme', theme);
      if (tourSeen) localStorage.setItem('hawkeye_tour_seen', '1');
      else localStorage.removeItem('hawkeye_tour_seen');
      if (signedIn) localStorage.setItem('hawkeye_token', token);
      else localStorage.removeItem('hawkeye_token');
    } catch (e) { /* storage blocked */ }
    if (lite) {
      // A Capacitor stub with no plugins, so native.js takes its REAL app-shell
      // path (html.native-app, tab bar, report sheet, authGet cache, API base =
      // https://hawkeye.com.ng — the origin these pages are served from anyway,
      // so the guard still sees every call). Every plugin is absent, which
      // native.js already tolerates (old Lite builds lack most of them).
      // (tests/ui/capture_lite_shots.mjs froze HAWKEYE instead, because it pointed
      // at a LOCAL server; that skips authGet and is less faithful.)
      try {
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', platform: 'android', Plugins: {}, convertFileSrc: (p) => p, isPluginAvailable: () => false };
      } catch (e) { /* ignore */ }
      const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
      mark();
      document.addEventListener('readystatechange', mark);
      document.addEventListener('DOMContentLoaded', mark);
    }
  }, arg: [lite, signedIn, lang, theme, tourSeen, FAKE_TOKEN] };
}

/** Native (react-native-web export) storage. bootstrapAuth() trusts a stored token+observer. */
export function nativeInit({ signedIn = false, lang = 'en', theme = 'dark' } = {}) {
  return { script: ([signedIn, lang, theme, token]) => {
    if (window !== window.top) return;
    try {
      localStorage.clear();
      localStorage.setItem('hawkeye_lang', lang);
      localStorage.setItem('hawkeye.theme.pref', theme); // lib/theme-pref.tsx THEME_PREF_KEY (AsyncStorage = localStorage on web)
      localStorage.setItem('hawkeye_tour_seen', '1');    // lib/tour.ts SEEN_KEY
      if (signedIn) {
        localStorage.setItem('hawkeye.auth.token', token);  // lib/auth.ts K_TOKEN (secure-store web shim = localStorage)
        localStorage.setItem('hawkeye.auth.observer', '7'); // K_OBSERVER; bootstrapAuth trusts token+observer without a call
      } else {
        localStorage.removeItem('hawkeye.auth.token'); localStorage.removeItem('hawkeye.auth.observer');
      }
    } catch (e) { /* storage blocked */ }
    // THE PHONE'S SYSTEM FONT. The app sets no fontFamily, so a phone draws it in
    // Roboto (Android) / SF (iOS). react-native-web's "System" stack falls through
    // to DejaVu Sans on this Linux box — ~12% wider, which would invent wrapping
    // and clipping a phone never shows. Roboto is in RNW's stack, so loading it is enough.
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
  }, arg: [signedIn, lang, theme, FAKE_TOKEN] };
}

/** Static server for the react-native-web export. */
export function startStatic(dir) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let f = path.join(dir, url === '/' ? 'index.html' : url);
    if (!f.startsWith(dir)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      if (fs.existsSync(`${f}.html`)) f = `${f}.html`;
      else if (fs.existsSync(path.join(f, 'index.html'))) f = path.join(f, 'index.html');
      else f = path.join(dir, '+not-found.html');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

export function slug(s) { return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(); }

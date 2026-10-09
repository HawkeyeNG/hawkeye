/**
 * FLOW WALKTHROUGH — group `reporting` (tests/e2e/flows/reporting.mjs).
 *
 *   node reporting.mjs [--surface web,lite,native] [--lang en,ha] [--flow unit,result,practice,incident,collation,offline,checkin]
 *                      [--vp s360] [--variants 0|1]
 *
 * Walks, on web / Lite (Capacitor stub) / native (react-native-web export), signed in
 * with fixtures:
 *   unit       choose / change my polling unit (search by name + code, near me, save, change)
 *   result     report a result: photos, unit, race, counts, review, submit, receipt
 *              (+ en-only variants: double tap, 500, network failure, 401, a 4xx refusal,
 *              reload mid-flow, Back mid-flow, keyboard up)
 *   practice   step order of the practice run against the real result flow
 *   incident   report an incident: kind, details, photo, unit, submit, confirmation, where it shows
 *   collation  report a collation
 *   offline    start offline, submit a result and an incident, reload while queued, go online, flush
 *   checkin    "I'm at my unit" inside the report flow (roster member) + the ordinary-observer control
 *
 * Output: ../out/flows/reporting/{<flow>/*.png, steps.json, findings.json, observations.json}
 *
 * SAFETY (shared brief): every context gets installGuard; every write the flows make
 * (submission, incident, collation, my-unit, check-in, presign, resume) is answered by
 * the fixture below and never reaches production. Reads of public data (register,
 * parties, incident kinds) pass through the guard to production, without the token.
 * "Offline" is emulated in-browser (ctx.setOffline + a route that aborts the API), so
 * nothing about it touches the server either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium, CHROME, SITE, VIEWPORTS, installGuard, contextOptions, webInit, nativeInit,
  startStatic, sleep, log, SAFETY, cachedGet,
} from '../../design-audit/lib.mjs';
import { makeFixtures } from '../../design-audit/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const OUT = path.resolve(HERE, '../out/flows/reporting');
const NATIVE_DIR = process.env.NATIVE_DIR || path.join(REPO, 'tmp/design-audit-native-web');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const SURFACES = arg('surface', 'web,lite,native').split(',');
const LANGS = arg('lang', 'en,ha').split(',');
const FLOWS = arg('flow', 'unit,result,practice,incident,collation,offline,checkin').split(',');
const VPK = arg('vp', 's360');
const VP = VIEWPORTS[VPK];
const VARIANTS = arg('variants', '1') !== '0';
fs.mkdirSync(OUT, { recursive: true });

const NI18N = Object.fromEntries(['en', 'ha'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(REPO, `native/src/lib/i18n/${l}.json`), 'utf8'))]));
const WI18N = Object.fromEntries(['en', 'ha'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(REPO, `app/i18n/${l}.json`), 'utf8'))]));
/** Native label in the run's language (the app falls back to English per key). */
const nt = (lang, key) => NI18N[lang][key] || NI18N.en[key] || key;
const wt = (lang, key) => WI18N[lang][key] || WI18N.en[key] || key;
const strip = (s) => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- data (GET only)
const AT = { latitude: 6.5422, longitude: 3.3608 }; // ~16 m from 24-16-05-007 (17, Oziegbe St., Ilupeju, Mushin, Lagos)
const getJson = async (p) => JSON.parse((await cachedGet(SITE + p)).body.toString());
const UNIT = (await getJson('/api/register/unit?pu_code=24-16-05-007')).unit;
const UNIT2 = (await getJson('/api/register/unit?pu_code=24-16-05-008')).unit;
const WARD_UNITS = (await getJson('/api/register/units?state=Lagos&lga=Mushin&ward=Ilupeju')).units || [];
const hav = (a, b, c, d) => { const r = (x) => (x * Math.PI) / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(h)); };
const NEAR_ROWS = WARD_UNITS.filter((u) => u.lat != null)
  .map((u) => ({ ...u, distanceM: Math.round(hav(AT.latitude, AT.longitude, u.lat, u.lng)) }))
  .sort((a, b) => a.distanceM - b.distanceM).slice(0, 6);
/* ELECTION DAY, 16 Jan 2027: the three federal races open at once (GOV/SHA stay
   scheduled). /api/contests is the ONLY gate the clients read: web
   selectedContestClosed() (app.js:483) and native isRaceOpen() (races.ts:1897) both
   take `open` from it; the server refuses early reports with reporting_not_open
   (submissions.js:291), which never runs here because the submit is a fixture. */
const OPEN_CODES = ['PRES', 'SEN', 'REP'];
const CONTESTS = (await getJson('/api/contests')).map((c) => (OPEN_CODES.includes(c.code) ? { ...c, open: true, opensAt: null } : c));
const CONTESTS_CLOSED = await getJson('/api/contests');
const H = 3_600_000;
const NOW = Date.now();
const ROOM = { id: 12, name: 'Lagos Citizens Observer Network', kind: 'cso', contest: 'PRES' };

// ---------------------------------------------------------------- fixtures
function newState(o = {}) {
  return {
    myUnit: o.myUnit === undefined ? UNIT : o.myUnit,
    rooms: o.rooms || 'member',          // 'member' (on a roster, assigned UNIT) | 'none' (ordinary observer)
    checkedIn: null,
    near: o.near || 'ok',                // 'ok' | 'empty' | 'fail'
    submit: o.submit || 'ok',            // 'ok' | '500' | '401' | 'err:<code>:<status>'
    incident: o.incident || 'ok',
    collation: o.collation || 'ok',
    myUnitPost: o.myUnitPost || 'ok',
    contests: o.contests || CONTESTS,
    apiDown: false,                      // emulated offline: every API call aborts
    netFail: new Set(o.netFail || []),   // POST paths that fail at the network layer
    hang: new Set(o.hang || []),         // GET paths that never answer (control for the stuck-loading detector)
    posts: [],                           // every write the app made, in order
    calls: [],
    reports: [], incidents: [], collations: [],
  };
}
const multipartField = (body, name) => {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body || '');
  return m ? m[1] : null;
};
function makeFx(S) {
  const base = makeFixtures('populated');
  return (m, u, hasAuth, req) => {
    const p = u.pathname;
    S.calls.push(`${m} ${p}`);
    if (m === 'GET') {
      if (p === '/api/contests') return { status: 200, json: S.contests };
      if (p === '/api/observers/me') {
        return { status: 200, json: { ok: true, observerId: 7, identityHash: 'da'.repeat(32), createdAt: NOW - 40 * 24 * H, hasPassword: true,
          unit: S.myUnit, subscriptions: [{ contest: 'PRES', state: null }], reports: S.reports, collation: S.collations, incidents: S.incidents, mappings: [] } };
      }
      if (p === '/api/observers/my-unit') return { status: 200, json: { ok: true, unit: S.myUnit } };
      if (p === '/api/my/rooms') {
        return { status: 200, json: { rooms: S.rooms === 'member' ? [{ ...ROOM, assigned: { pu_code: UNIT.pu_code, name: UNIT.name, ward: UNIT.ward, lga: UNIT.lga, state: UNIT.state }, checkedIn: S.checkedIn }] : [] } };
      }
      if (p === '/api/polling-units') {
        if (S.near === 'fail') return { status: 500, json: { error: 'internal_error' } };
        return { status: 200, json: { radiusM: 500, maxRows: 40, capped: false, units: S.near === 'empty' ? [] : NEAR_ROWS } };
      }
      if (p === '/api/mapping/nearby') {
        if (S.near === 'fail') return { status: 500, json: { error: 'internal_error' } };
        // the envelope lookup's own shape (routes/mapping.js /nearby): camelCase, positioned
        return { status: 200, json: { units: S.near === 'empty' ? [] : NEAR_ROWS.map((r) => ({ puCode: r.pu_code, name: r.name, ward: r.ward, lat: r.lat, lng: r.lng, distanceM: r.distanceM, status: 'verified', fixes: 0 })) } };
      }
      return base(m, u);
    }
    // ---- writes: every one is answered here
    const body = (() => { try { return req.postData() || ''; } catch { return ''; } })();
    S.posts.push({ m, p, at: Date.now() });
    if (p === '/api/uploads/presign') return { status: 409, json: { error: 'direct_upload_disabled', mode: 'proxy' } };
    if (p === '/api/observers/resume') return { status: 200, json: { ok: false, recognized: false } };
    if (p === '/api/submissions') {
      const mode = S.submit;
      if (mode === '500') return { status: 500, json: { error: 'internal_error' } };
      if (mode === '401') return { status: 401, json: { error: 'invalid_token' } };
      if (mode.startsWith('err:')) { const [, code, st] = mode.split(':'); return { status: Number(st || 400), json: { error: code } }; }
      let votes = [];
      try { votes = JSON.parse(multipartField(body, 'votes') || (JSON.parse(body).votes) || '[]'); } catch { /* */ }
      const puCode = multipartField(body, 'puCode') || UNIT.pu_code;
      const contest = multipartField(body, 'contest') || 'PRES';
      S.reports.unshift({ pu_code: puCode, contest, created_at: Date.now(), entry_hash: 'e2e1'.repeat(16), name: UNIT.name, lga: UNIT.lga, state: UNIT.state });
      return { status: 201, json: { ok: true, entryHash: 'e2e1'.repeat(16), locationVerified: true, late: false, ocr: null, photosOnDevice: false, counted: true,
        result: { puCode, contest, votes, status: 'provisional', confidence: 100, matchingReports: 1, totalReports: 1, locationStatus: 'verified', locationConfidence: 100, venueMatches: 0, scope: 'Presidential — national contest' } } };
    }
    if (p === '/api/incidents') {
      if (S.incident === '500') return { status: 500, json: { error: 'internal_error' } };
      if (S.incident === '401') return { status: 401, json: { error: 'invalid_token' } };
      const id = 9001 + S.incidents.length;
      S.incidents.unshift({ id, kind: multipartField(body, 'kind') || 'late_materials', status: 'pending', pu_code: multipartField(body, 'puCode'), state: 'Lagos', created_at: Date.now() });
      return { status: 201, json: { ok: true, id, status: 'pending' } };
    }
    if (p === '/api/collations') {
      if (S.collation === '500') return { status: 500, json: { error: 'internal_error' } };
      S.collations.unshift({ level: multipartField(body, 'level') || 'ward', contest: multipartField(body, 'contest') || 'PRES', created_at: Date.now(), entry_hash: 'c011'.repeat(16) });
      return { status: 201, json: { ok: true, entryHash: 'c011'.repeat(16), form: 'EC8B', late: false } };
    }
    if (p === '/api/observers/my-unit') {
      if (S.myUnitPost === '500') return { status: 500, json: { error: 'internal_error' } };
      let code = null;
      try { code = JSON.parse(body).puCode; } catch { /* */ }
      const unit = [UNIT, UNIT2, ...WARD_UNITS].find((x) => x.pu_code === code);
      if (!unit) return { status: 404, json: { error: 'unknown_unit' } };
      S.myUnit = unit;
      return { status: 200, json: { ok: true, unit } };
    }
    if (p === '/api/observers/my-unit/clear') { S.myUnit = null; return { status: 200, json: { ok: true } }; }
    if (p === '/api/my/check-in') {
      S.checkedIn = { at: Date.now(), standing: 'verified', pu_code: UNIT.pu_code };
      return { status: 200, json: { ok: true, standing: 'verified', rooms: [{ id: ROOM.id, standing: 'verified' }] } };
    }
    return base(m, u);
  };
}

// ---------------------------------------------------------------- browser + contexts
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--font-render-hinting=none'],
});
let server = null;
let NBASE = null;
async function nativeBase() {
  if (!server) { server = await startStatic(NATIVE_DIR); NBASE = `http://127.0.0.1:${server.address().port}`; }
  return NBASE;
}

/* lib.mjs's webInit/nativeInit clear localStorage on EVERY document load (each
   visit is meant to start fresh). These flows reload mid-flow on purpose, and a
   reload that wiped storage would make the harness — not the app — lose the
   outbox (native keeps it in AsyncStorage = localStorage on web) and the device
   keys. So the lib script runs as-is on the FIRST load only; later loads restore
   what the page had. navigator.onLine is also pinned to an emulated-offline flag,
   because Chromium reports onLine=true again after a navigation under setOffline. */
function initScript(surface, { lang, signedIn = true, theme = 'dark' }) {
  const i = surface === 'native' ? nativeInit({ signedIn, lang, theme }) : webInit({ lite: surface === 'lite', signedIn, lang, theme });
  return `(function(){
    if (window !== window.top) return;
    var snap = null;
    try { if (localStorage.getItem('__hk_seeded')) { snap = {}; for (var k = 0; k < localStorage.length; k++) { var key = localStorage.key(k); snap[key] = localStorage.getItem(key); } } } catch (e) {}
    (${i.script.toString()})(${JSON.stringify(i.arg)});
    try { if (snap) { localStorage.clear(); for (var s in snap) localStorage.setItem(s, snap[s]); } else localStorage.setItem('__hk_seeded', '1'); } catch (e) {}
    try {
      var d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: function () {
        try { if (localStorage.getItem('__hk_offline') === '1') return false; } catch (e) {}
        return d.get.call(this);
      } });
    } catch (e) {}
  })();`;
}

const OPEN_CTX = new Set();
async function newCtx(surface, { lang = 'en', S, vp = VP, geo = AT, signedIn = true } = {}) {
  while (OPEN_CTX.size >= 2) await sleep(200); // brief: at most 2 contexts at once
  const ctx = await browser.newContext({ ...contextOptions(vp), permissions: ['geolocation', 'camera', 'microphone'], geolocation: geo });
  OPEN_CTX.add(ctx);
  await installGuard(ctx, { signedIn, crossOrigin: surface === 'native', fixtures: makeFx(S) });
  // Registered LAST, so it runs first: emulated offline + forced network failures.
  await ctx.route(/^https?:\/\/(hawkeye\.com\.ng|127\.0\.0\.1:\d+)\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const isApi = u.pathname.startsWith('/api/');
    if (isApi && req.method() === 'GET' && S.hang.has(u.pathname)) { await sleep(45000); return route.abort('timedout').catch(() => {}); }
    if (isApi && req.method() === 'POST' && S.netFail.has(u.pathname)) { S.posts.push({ m: 'POST', p: u.pathname, aborted: true, at: Date.now() }); return route.abort('connectionreset'); }
    if (!S.apiDown) return route.fallback();
    const remote = u.hostname === 'hawkeye.com.ng';
    // A STATE pack the device never fetched is not in IndexedDB, and sw.js only
    // caches /reg/ files it has fetched once — so offline it cannot arrive.
    // (The index pack and manifest are fetched on every page and stay served.)
    if (remote && /^\/reg\/\d\d\./.test(u.pathname)) { S.packMisses = (S.packMisses || 0) + 1; return route.abort('internetdisconnected'); }
    if (isApi || (surface === 'native' && remote) || req.method() !== 'GET') {
      if (isApi && req.method() !== 'OPTIONS' && req.method() !== 'GET') S.posts.push({ m: req.method(), p: u.pathname, offline: true, at: Date.now() });
      return route.abort('internetdisconnected');
    }
    // The page shell while "offline": on a phone the service worker (web) or the
    // APK/bundle (Lite/native) serves it; the harness blocks SWs, so serve it here.
    try {
      const r = remote ? await cachedGet(req.url()) : await fetch(req.url()).then(async (x) => ({ status: x.status, type: x.headers.get('content-type') || 'application/octet-stream', body: Buffer.from(await x.arrayBuffer()) }));
      return route.fulfill({ status: r.status, headers: { 'content-type': r.type, 'access-control-allow-origin': '*' }, body: r.body });
    } catch { return route.abort('failed'); }
  });
  await ctx.addInitScript({ content: initScript(surface, { lang, signedIn }) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(90000);
  // Production page loads occasionally time out from this box (ERR_TIMED_OUT); a
  // navigation the HARNESS could not make is retried, never reported as an app bug.
  const goto0 = page.goto.bind(page);
  page.goto = async (url, opts) => {
    for (let i = 0; ; i++) {
      try { return await goto0(url, opts); } catch (e) {
        if (i >= 2 || !/ERR_TIMED_OUT|Timeout|ERR_CONNECTION|ERR_NETWORK_CHANGED/.test(String(e.message))) throw e;
        await sleep(3000);
      }
    }
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  page.on('dialog', (d) => { errors.push(`dialog: ${d.message().slice(0, 120)}`); d.accept().catch(() => {}); });
  return { ctx, page, errors, close: async () => { OPEN_CTX.delete(ctx); await ctx.close().catch(() => {}); } };
}
async function goOffline(ctx, page, S) {
  S.apiDown = true;
  await ctx.setOffline(true);
  await page.evaluate(() => { try { localStorage.setItem('__hk_offline', '1'); } catch (e) {} window.dispatchEvent(new Event('offline')); }).catch(() => {});
}
async function goOnline(ctx, page, S) {
  S.apiDown = false;
  await ctx.setOffline(false);
  await page.evaluate(() => { try { localStorage.removeItem('__hk_offline'); } catch (e) {} window.dispatchEvent(new Event('online')); }).catch(() => {});
}

// ---------------------------------------------------------------- recording
const RUNS = [];
const OBS = {}; // observations the findings are computed from
const ob = (k, v) => { OBS[k] = v; return v; };
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
function recorder(flow, surface, lang, variant = '') {
  const dir = path.join(OUT, flow);
  fs.mkdirSync(dir, { recursive: true });
  const run = { flow, surface, lang, variant, steps: [], done: false, notes: [], errors: [] };
  RUNS.push(run);
  let n = 0;
  return {
    run,
    async step(page, screen, asked, taps = 0, extra = {}) {
      n++;
      const f = `${String(n).padStart(2, '0')}-${surface}-${lang}${variant ? '-' + variant : ''}-${slug(screen)}.png`;
      await page.screenshot({ path: path.join(dir, f) }).catch(() => {});
      const text = await vis(page);
      const leaks = lang === 'en' ? [] : englishLeaks(text, surface);
      const s = { n, screen, asked, taps, shot: `${flow}/${f}`, ...extra };
      if (leaks.length) s.englishLeaks = leaks.slice(0, 8);
      run.steps.push(s);
      return s;
    },
    note(t) { run.notes.push(t); },
    shot(n) { return run.steps[n - 1] && run.steps[n - 1].shot; },
    last() { return run.steps[run.steps.length - 1]; },
  };
}
async function vis(page) { return page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => ''); }
/* ENGLISH LEFT IN A HAUSA SCREEN. A line counts when it is an English UI string
   whose Hausa differs (exact match against en.json values), or reads as English
   prose (two or more English function words). Control: run on the en text of the
   same screen it flags heavily; see selfTest(). */
const EN_VALUES = new Set();
for (const [dict, other] of [[WI18N.en, WI18N.ha], [NI18N.en, NI18N.ha]]) {
  for (const [k, v] of Object.entries(dict)) { const s = strip(v); if (s.length >= 4 && other[k] && strip(other[k]) !== s) EN_VALUES.add(s); }
}
const FUNC = /\b(the|your|you|and|to|of|is|this|for|not|with|are|from|can|will|was|has|have|every|must|here)\b/gi;
/* The harness's own fixture data (fixtures.mjs notification titles) is English by construction. */
const FIXTURE_TEXT = /^(New result at your unit|Your incident report was published|You joined a room|Your unit location was confirmed)$/;
/* Strings the source writes in English with no key at all (found by reading the
   render paths; each is checked on screen, never assumed). */
const HARDCODED = [
  /\bpart(y|ies) entered\b/,                 // app.js:3430 setStepDone(3, …)
  /^Status: .*Confidence:/,                    // app.js result-summary
  /reports match\)/,
  /^You are reporting: /,                      // app.js updateScopeNotice
  /Result reporting opens when polls open/,
  /^This build has no document scanner/,       // capture-camera.tsx scanNote
  /^None Saved$/,                              // profile.tsx Row value
  /^(Form|Venue|Scope|Race|Votes|Send)$/,      // collation.tsx STEPS labels rendered raw
  /^Choose which election you are reporting/,  // app.js:499 updateScopeNotice
  /^📖 Reading the numbers off your sheet/,     // app.js ocrHint
  /^— select (state|LGA|ward) —$/,             // app.js fillSelect placeholders, collation.html
  /^Fit the (EC8A|whole form)/,                // result.tsx:1710 / collation.tsx:407
  /\btop (right )?of the (EC8A|collation form)\b/, // serial-field.tsx:43 `where` default spliced into a keyed sentence
  /^(Result sheet|Venue)$/,                    // result.tsx:2373 review labels
  /approved incident (here|at this unit)/,     // map-unit.tsx:1307-1310
];
function englishLeaks(text, surface) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line.length < 4 || /^[\d\s·.,:/%()+-]+$/.test(line)) continue;
    if (/@|https?:|\b\d{2}-\d{2}-\d{2}-\d{3}\b/.test(line) && line.length < 30) continue;
    const words = (line.match(FUNC) || []).length;
    if (FIXTURE_TEXT.test(line)) continue;
    if (EN_VALUES.has(line) || HARDCODED.some((re) => re.test(line)) || (words >= 2 && line.split(/\s+/).length >= 4)) out.push(line.slice(0, 120));
  }
  return [...new Set(out)];
}
/* CONTROL for the language detector: it must flag English UI text and must NOT flag
   Hausa (the first version flagged Hausa sentences on the word "a"). Checked at
   start; a failing control disables the language findings rather than lying. */
function langControl() {
  const en = ['Choose an incident type…', 'Your report is on the public tamper-evident ledger now — it cannot be edited or withdrawn.', '✔ 4 parties entered'];
  const ha = ["Rahotonka yana kan littafin jama'a mai nuna sauyi yanzu — ba za a iya gyara shi ko janye shi ba.", 'Wannan zai yi maka rajistar isowa a 17, Oziegbe St., rumfar da aka sanya ka.', 'An ajiye a wayarka tare da hotunan rahotonka.', 'Zaɓi nau\'in lamari…'];
  const r = { enFlagged: en.filter((l) => englishLeaks(l).length).length, enTotal: en.length, haFlagged: ha.filter((l) => englishLeaks(l).length), haTotal: ha.length };
  r.ok = r.enFlagged === r.enTotal && r.haFlagged.length === 0;
  return r;
}
const STUCK = /Loading|Searching|Looking up|Getting your location|Uploading|Submitting|Signing|Saving|Lodawa|Ana |Nemo|Ana loda/;
/** Lines that look like a pending state at t0 and are STILL there `ms` later. */
async function stuckLines(page, ms = 8000) {
  const a = (await vis(page)).split('\n').map((x) => x.trim()).filter((x) => STUCK.test(x));
  if (!a.length) return [];
  await sleep(ms);
  const b = new Set((await vis(page)).split('\n').map((x) => x.trim()));
  return a.filter((x) => b.has(x));
}

// ---------------------------------------------------------------- generic helpers
const tick = () => sleep(350);
async function waitFor(fn, ms = 15000, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* */ } await sleep(step); }
  return false;
}
/** Native: tap the first VISIBLE element whose text is exactly `label` (or matches a RegExp). */
async function nTap(page, label, { exact = true, last = false } = {}) {
  const loc = typeof label === 'string' ? page.getByText(label, { exact }) : page.getByText(label);
  const n = await loc.count().catch(() => 0);
  const idx = [...Array(n).keys()];
  if (last) idx.reverse();
  for (const i of idx) {
    const l = loc.nth(i);
    if (await l.isVisible().catch(() => false)) { await l.scrollIntoViewIfNeeded().catch(() => {}); await l.click({ timeout: 6000 }).catch(() => {}); return true; }
  }
  return false;
}
async function nCount(page, label) {
  const loc = page.getByText(label, { exact: true });
  const n = await loc.count().catch(() => 0);
  let c = 0;
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) c++;
  return c;
}
async function nHas(page, label, exact = true) {
  const loc = typeof label === 'string' ? page.getByText(label, { exact }) : page.getByText(label);
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
  return false;
}
/** The shutter: the round 72x72 control at the bottom of CaptureCamera (no label of its own). */
async function nShutter(page) {
  const box = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) => { const r = d.getBoundingClientRect(); return Math.abs(r.width - 72) < 3 && Math.abs(r.height - 72) < 3 && r.top > innerHeight * 0.6; });
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }).catch(() => null);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
}
/** Native: shoot one photo in CaptureCamera and accept it. */
async function nShoot(page, lang) {
  if (!(await waitFor(() => page.evaluate(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }), 15000))) return 'no-camera';
  await sleep(600);
  if (!(await nShutter(page))) return 'no-shutter';
  const use = nt(lang, 'n.components.capture-camera.use-photo');
  if (!(await waitFor(() => nHas(page, use), 20000))) return 'no-confirm';
  await nTap(page, use);
  await sleep(1500);
  return 'ok';
}
/** Web: one photo through capture.js (fake camera), accepting a scanner warning. */
async function wShoot(page, target) {
  await page.click(`#btn-cam-${target}`);
  const cam = await waitFor(() => page.evaluate(() => { const o = document.getElementById('camera-overlay'); const v = document.getElementById('video'); return o && !o.hidden && v && v.readyState >= 2; }), 15000);
  if (!cam) return 'no-camera';
  await sleep(700);
  await page.click('#btn-capture').catch(() => {});
  for (let i = 0; i < 40; i++) {
    if (await page.locator('.hk-dlg-ok').first().isVisible().catch(() => false)) await page.locator('.hk-dlg-ok').first().click().catch(() => {});
    const done = await page.evaluate((t) => { const s = document.getElementById(`status-${t}`); return !!(s && s.classList.contains('done')); }, target).catch(() => false);
    if (done) return 'ok';
    await sleep(500);
  }
  return 'no-preview';
}
/* The three modal implementations a page can raise: dialog.js (.hk-dlg), menu.js
   HAWKEYE_ALERT (.hk-alert) and HAWKEYE_MODAL (.gov-disc-modal). */
async function wDialog(page) {
  for (const sel of ['.hk-dlg', '.hk-alert .hk-alert-card', '.gov-disc-modal']) {
    const d = page.locator(sel).last();
    if (await d.isVisible().catch(() => false)) return (await d.innerText().catch(() => '')).trim();
  }
  return null;
}
async function wDialogOk(page) {
  for (const sel of ['.hk-dlg-ok', '#hk-alert-ok', '.gov-disc-close']) {
    const b = page.locator(sel).last();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); return true; }
  }
  return false;
}
async function wVisible(page, sel) { return page.locator(sel).first().isVisible().catch(() => false); }
async function outboxCount(page, surface) {
  if (surface === 'native') {
    return page.evaluate(() => { try { const v = JSON.parse(localStorage.getItem('hawkeye.outbox.jobs.v1') || '[]'); return Array.isArray(v) ? v.length : -1; } catch { return -2; } }).catch(() => -3);
  }
  return page.evaluate(async () => (window.HawkeyeOutbox ? window.HawkeyeOutbox.count() : -1)).catch(() => -3);
}
/** Keyboard emulation: a phone keyboard takes ~42% of a 740px screen. */
/* Chrome on Android scrolls the focused field into view when the keyboard opens;
   a viewport resize alone does not, so that half is done here. What is then
   measured is whether the field AND the step's primary action can be seen. */
async function keyboardUp(page, vp = VP) {
  await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.58) });
  await sleep(300);
  await page.evaluate(() => { const e = document.activeElement; if (e && e !== document.body && e.scrollIntoView) e.scrollIntoView({ block: 'nearest' }); }).catch(() => {});
  await sleep(300);
}
async function keyboardDown(page, vp = VP) { await page.setViewportSize({ width: vp.width, height: vp.height }); await sleep(300); }
async function inViewport(page, locatorOrSel) {
  const loc = typeof locatorOrSel === 'string' ? page.locator(locatorOrSel).first() : locatorOrSel;
  const b = await loc.boundingBox().catch(() => null);
  const h = page.viewportSize().height;
  return !!(b && b.y >= 0 && b.y + Math.min(b.height, 40) <= h);
}
async function focusedInView(page) {
  return page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const r = e.getBoundingClientRect(); return r.top >= 0 && r.top + Math.min(r.height, 30) <= innerHeight; }).catch(() => null);
}
const pngExists = (p) => fs.existsSync(path.join(OUT, p));

// ================================================================ entry points
/* The fake session skips sign-in, and sign-in is where app.js ensureKeys() makes
   the device's signing key (IndexedDB hawkeye/kv "keypair"). observe.html makes it
   on demand; collation.html only READS it — so without this a harness-only
   "Could not submit" appears. Same key shape as app.js:95-106. */
async function seedKeys(page) {
  await page.evaluate(async () => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('hawkeye', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const db = await open();
    const have = await new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('keypair'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    if (have) return;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(pair, 'keypair'); tx.oncomplete = res; tx.onerror = res; });
  }).catch(() => {});
}
/** Web/Lite: open a report flow the way a person does. Returns taps spent. */
async function wEnter(page, surface, which /* 'observe' | 'incidents' | 'collation' */) {
  await page.goto(`${SITE}/index.html`, { waitUntil: 'load', timeout: 60000 });
  await seedKeys(page);
  await sleep(2500);
  if (surface === 'lite') {
    await page.locator('.tabbar [data-report]').click();
    await sleep(500);
    await page.locator(`.report-sheet .rs-opt[href^="${which}.html"]`).click();
    await page.waitForLoadState('load', { timeout: 90000 });
    return 2;
  }
  // The website: the header CTA for a result; the menu for the other two.
  const direct = page.locator(`a[href^="${which}.html"]:visible`).first();
  if (which === 'observe' && await direct.isVisible().catch(() => false)) { await direct.click(); await page.waitForLoadState('load', { timeout: 90000 }); return 1; }
  await page.locator('.menu-btn').first().click().catch(() => {});
  await sleep(400);
  const inMenu = page.locator(`#menu-panel a[href^="${which}.html"]`).first();
  if (!(await inMenu.isVisible().catch(() => false))) {
    // the "Report" accordion holds result / collation / incident
    const acc = page.locator('#menu-panel .menu-acc').filter({ hasText: /Report|Rahoto|Bayar/ }).first();
    await acc.click().catch(() => {});
    await sleep(300);
  }
  let taps = 3;
  await inMenu.click({ timeout: 5000 }).catch(async () => { taps = -1; await page.goto(`${SITE}/${which}.html`); });
  await page.waitForLoadState('load', { timeout: 90000 });
  return taps;
}
/** Native: Report tab → sheet option. */
async function nEnter(page, lang, which /* result | incident | collation */) {
  const base = await nativeBase();
  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
  await waitFor(() => nHas(page, nt(lang, 'nav.report')), 20000);
  await sleep(1500);
  await nTap(page, nt(lang, 'nav.report'), { last: true });
  await sleep(900);
  const key = { result: 'common.report-a-result', incident: 'common.report-an-incident', collation: 'nav.report-a-collation' }[which];
  const ok = await nTap(page, nt(lang, key));
  if (!ok) { await page.goto(`${base}/report/${which}`, { waitUntil: 'load' }); await sleep(2500); return -1; }
  await sleep(2500);
  return 2;
}

// ================================================================ RESULT — web / Lite
/**
 * The real result form, observe.html (+ app.js). `until`: photos | unit | race | counts | submit,
 * so a variant can stop anywhere and interfere.
 */
async function webResultWalk(page, R, S, { surface, lang, until = 'submit', unitBy = 'near', enter = true }) {
  const res = { taps: 0 };
  if (enter) {
    res.taps += await wEnter(page, surface, 'observe');
    await page.waitForSelector('#screen-submit:not([hidden])', { timeout: 20000 }).catch(() => {});
    await sleep(2500);
    await R.step(page, 'report screen (step 1 open)', 'entry: Report → result form', res.taps, {
      checkInCard: await wVisible(page, '#checkin-card'),
      stepHeads: await page.$$eval('#screen-submit details.step-card > summary h2', (a) => a.map((h) => h.innerText.trim())).catch(() => []),
    });
  }
  // ---- step 1: both photos
  const s1 = await wShoot(page, 'sheet');
  await R.step(page, 'photo 1 — EC8A sheet', 'photo of the result sheet (live camera)', 2, { result: s1 });
  const s2 = await wShoot(page, 'venue');
  await sleep(800);
  await R.step(page, 'photo 2 — venue', 'photo of the polling venue (live camera)', 2, { result: s2 });
  res.photos = s1 === 'ok' && s2 === 'ok';
  if (until === 'photos') return res;
  // ---- step 2: which unit
  const unitOpen = await page.evaluate(() => document.getElementById('unit-fold').open).catch(() => false);
  if (!unitOpen) { await page.click('#unit-fold > summary').catch(() => {}); res.taps++; }
  let picked = false;
  if (unitBy === 'near') {
    // near me runs by itself when the report screen opens (app.js show()); tap only if it did not
    const auto = await waitFor(() => page.locator('#pu-list .pu-option').count().then((n) => n > 0), 8000);
    if (!auto) { await page.click('#btn-locate'); await waitFor(() => page.locator('#pu-list .pu-option').count().then((n) => n > 0), 20000); }
    await sleep(400);
    await R.step(page, 'unit — near me list', 'which polling unit (near me, ran by itself)', auto ? 0 : 1, { auto, status: (await page.locator('#locate-status').innerText().catch(() => '')).trim() });
    const row = page.locator('#pu-list .pu-option', { hasText: UNIT.pu_code }).first();
    if (await row.count()) { await row.click(); picked = true; }
  } else if (unitBy === 'browse') {
    // first what an offline observer is told to do — search — then the register
    await page.fill('#pus-q', 'Oziegbe St').catch(() => {});
    await sleep(3500);
    res.searchLine = (await page.locator('#pus-status').innerText().catch(() => '')).trim();
    await R.step(page, 'unit — search (offline)', 'which polling unit (search)', 0, { line: res.searchLine, rows: await page.locator('#pu-search-host .pu-option').count() });
    const rowS = page.locator('#pu-search-host .pu-option', { hasText: UNIT.pu_code }).first();
    if (await rowS.count()) { await rowS.click(); picked = true; } else {
      await page.evaluate(() => { const d = document.getElementById('browse-block'); if (d) d.open = true; }).catch(() => {});
      await waitFor(() => page.locator('#sel-state option').count().then((n) => n > 5), 15000);
      await page.selectOption('#sel-state', 'Lagos').catch(() => {});
      await waitFor(() => page.locator('#sel-lga option').count().then((n) => n > 2), 15000);
      await page.selectOption('#sel-lga', 'Mushin').catch(() => {});
      await waitFor(() => page.locator('#sel-ward option').count().then((n) => n > 2), 15000);
      await page.selectOption('#sel-ward', 'Ilupeju').catch(() => {});
      await waitFor(() => page.locator('#register-units .pu-option').count().then((n) => n > 0), 15000);
      res.browseRows = await page.locator('#register-units .pu-option').count();
      res.browseLine = (await page.locator('#browse-block').innerText().catch(() => '')).split('\n').filter((l) => /Could not|offline|connection|No units|not on this device/i.test(l)).slice(0, 3);
      await R.step(page, 'unit — browse the register (offline)', 'state, LGA, ward selects', 6, { rows: res.browseRows, line: res.browseLine, packMisses: S.packMisses || 0 });
      if (!res.browseRows) {
        // pick the ward again: does a second try ever list the units?
        await sleep(3000);
        await page.evaluate(() => document.getElementById('sel-ward').dispatchEvent(new Event('change'))).catch(() => {});
        await sleep(3000);
        res.browseRowsRetry = await page.locator('#register-units .pu-option').count();
        await R.step(page, 'unit — ward picked again (offline)', 'ward select again', 1, { rows: res.browseRowsRetry });
      }
      const rowB = page.locator('#register-units .pu-option', { hasText: UNIT.pu_code }).first();
      if (await rowB.count()) { await rowB.click(); picked = true; }
    }
  } else {
    await page.fill('#pus-q', unitBy === 'code' ? UNIT.pu_code : 'Oziegbe St');
    await waitFor(() => page.locator('#pu-search-host .pu-option').count().then((n) => n > 0), 15000);
    await R.step(page, `unit — search by ${unitBy}`, 'which polling unit (search)', 1, { typed: unitBy === 'code' ? UNIT.pu_code : 'Oziegbe' });
    const row = page.locator('#pu-search-host .pu-option', { hasText: UNIT.pu_code }).first();
    if (await row.count()) { await row.click(); picked = true; }
  }
  await sleep(1800);
  res.unit = picked;
  await R.step(page, 'unit chosen → step 3', 'tap the unit', 1, { checkInCard: await wVisible(page, '#checkin-card'), unitState: (await page.locator('#unit-fold-state').innerText().catch(() => '')).trim() });
  if (!picked) { R.note('no unit could be chosen — the report stops at step 2'); return res; }
  if (until === 'unit') return res;
  // ---- step 3: which election
  const opts = await page.$$eval('#sel-contest option', (a) => a.map((o) => ({ v: o.value, t: o.textContent.trim(), d: o.disabled })));
  await page.selectOption('#sel-contest', 'PRES').catch(() => {});
  await sleep(900);
  await R.step(page, 'election chosen → step 4', 'which election (select)', 2, { options: opts, scope: (await page.locator('#contest-scope').textContent().catch(() => '')).trim() });
  if (until === 'race') return res;
  // ---- step 4: counts + verify
  const inputs = page.locator('#vote-inputs input');
  await waitFor(() => inputs.count().then((n) => n > 3), 15000);
  const counts = { APC: 212, PDP: 188, LP: 41, NNPP: 9 };
  for (const [party, v] of Object.entries(counts)) await page.fill(`#vote-inputs input[data-party="${party}"]`, String(v)).catch(() => {});
  res.counts = counts;
  // keyboard up while typing the third party's figure
  const third = page.locator('#vote-inputs input[data-party="LP"]');
  await third.focus().catch(() => {});
  await keyboardUp(page);
  await third.scrollIntoViewIfNeeded().catch(() => {});
  res.keyboard = { focusedVisible: await focusedInView(page), verifyVisible: await inViewport(page, '#btn-verify-counts') };
  await R.step(page, 'counts — keyboard up', 'party counts (typing)', 0, { keyboard: res.keyboard });
  await keyboardDown(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
  // REP-RES-04 probe: a wrong sheet total must warn, and "Check again" must
  // leave the step open; then the right total goes through with no dialog.
  res.totalsCheck = { fields: await wVisible(page, '#tot-valid') };
  if (res.totalsCheck.fields) {
    await page.fill('#tot-valid', '999');
    await page.click('#btn-verify-counts');
    await sleep(700);
    res.totalsCheck.warned = !!(await wDialog(page));
    await page.locator('.hk-dlg-cancel').last().click().catch(() => {});
    await sleep(300);
    res.totalsCheck.stayedOpen = !(await page.locator('#counts-fold-state').innerText().catch(() => '')).trim();
    await page.fill('#tot-valid', String(Object.values(counts).reduce((a, b) => a + b, 0)));
  }
  await page.click('#btn-verify-counts');
  await sleep(900);
  const dlg = await wDialog(page);
  if (dlg) await wDialogOk(page);
  await R.step(page, 'counts verified → step 5', 'party counts + Verify counts', 4 + 1, {
    serialAsked: await wVisible(page, '#sheet-serial'),
    countsState: (await page.locator('#counts-fold-state').innerText().catch(() => '')).trim(),
    dialog: dlg,
    submitEnabled: await page.locator('#btn-submit').isEnabled().catch(() => false),
  });
  if (until === 'counts') return res;
  // ---- step 5: sign & submit
  await page.locator('#btn-submit').scrollIntoViewIfNeeded().catch(() => {});
  await R.step(page, 'review — sign & submit card', 'review facts, then Sign & submit', 0, { facts: (await page.locator('#submit-facts').innerText().catch(() => '')).trim() });
  await page.click('#btn-submit');
  res.after = await webAfterSubmit(page);
  Object.assign(res, res.after);
  await R.step(page, res.arrived ? 'receipt — Report Recorded' : 'submit — still on form', 'Sign & submit', 1, { status: res.status, summary: (res.summary || '').slice(0, 300) });
  if (res.arrived) {
    await page.locator('#receipt-wrap').scrollIntoViewIfNeeded().catch(() => {});
    await R.step(page, 'receipt card + next actions', '—', 0, {
      receiptShown: await wVisible(page, '#receipt-img'),
      next: await page.$$eval('#screen-result button, #screen-result a', (a) => a.filter((x) => x.offsetParent).map((x) => x.innerText.trim()).filter(Boolean)).catch(() => []),
    });
  }
  return res;
}
async function webResultTop(page, R, label) {
  await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
  await sleep(400);
  const top = {
    headline: (await page.locator('#screen-result .confirm-panel').innerText().catch(() => '')).trim(),
    summary: (await page.locator('#result-summary').innerText().catch(() => '')).trim().slice(0, 300),
    entryHash: (await page.locator('#entry-hash').innerText().catch(() => '')).trim(),
  };
  await R.step(page, label, '—', 0, top);
  return top;
}
async function webAfterSubmit(page) {
  await waitFor(async () => (await wVisible(page, '#screen-result'))
    || ((await page.locator('#submit-status').innerText().catch(() => '')).trim().length > 0 && await page.locator('#btn-submit').isEnabled().catch(() => false))
    || !!(await wDialog(page)), 30000);
  await page.waitForSelector('#receipt-img[src^="data:"], #receipt-img[src^="blob:"]', { timeout: 6000 }).catch(() => {});
  await sleep(700);
  return {
    arrived: await wVisible(page, '#screen-result'),
    status: (await page.locator('#submit-status').innerText().catch(() => '')).trim(),
    summary: (await page.locator('#result-summary').innerText().catch(() => '')).trim(),
    dialog: await wDialog(page),
  };
}

// ================================================================ RESULT — native
async function nativeResultWalk(page, R, S, { lang, until = 'submit', unitBy = 'near', enter = true }) {
  const res = { taps: 0 };
  if (enter) {
    res.taps += await nEnter(page, lang, 'result');
    await R.step(page, 'camera — sheet (opens straight in)', 'entry: Report tab → Report a Result', res.taps);
  }
  const s1 = await nShoot(page, lang);
  await R.step(page, 'photo 1 accepted → venue camera', 'photo of the result sheet + Use photo', 2, { result: s1 });
  const s2 = await nShoot(page, lang);
  await sleep(2500);
  res.photos = s1 === 'ok' && s2 === 'ok';
  await R.step(page, 'unit step (near me auto-runs)', 'photo of the venue + Use photo', 2, { result: s2 });
  if (until === 'photos') return res;
  // ---- unit
  if (unitBy === 'near') {
    await waitFor(() => nHas(page, UNIT.name), 20000);
    await nTap(page, UNIT.name);
  } else if (unitBy === 'browse') {
    await sleep(4000);
    res.nearLine = (await vis(page)).split('\n').filter((l) => /Could not|No unit|search|browse/i.test(l)).slice(0, 3);
    const q = page.locator(`input[placeholder="${nt(lang, 'n.components.unit-search.name-ward-or-unit-number')}"]`).first();
    await q.scrollIntoViewIfNeeded().catch(() => {});
    await q.fill('Oziegbe St').catch(() => {});
    await sleep(3500);
    res.searchLine = (await vis(page)).split('\n').filter((l) => /Could not search|match|connection/i.test(l)).slice(0, 2);
    await R.step(page, 'unit — near me + search (offline)', 'which polling unit', 0, { near: res.nearLine, search: res.searchLine });
    if (await nHas(page, UNIT.name)) await nTap(page, UNIT.name, { last: true });
    else {
      await q.fill('').catch(() => {});
      await sleep(800);
      await nTap(page, nt(lang, 'n.components.choose-unit.browse-register'));
      await sleep(2500);
      for (const chip of ['Lagos', 'Mushin', 'Ilupeju']) { await nTap(page, chip); await sleep(2500); }
      res.browseShowsUnit = await nHas(page, UNIT.name);
      await R.step(page, 'unit — browse the register (offline)', 'Browse register → state → LGA → ward', 4, { showsUnit: res.browseShowsUnit, lines: (await vis(page)).split('\n').filter((l) => /Could not|Loading|couldn/i.test(l)).slice(0, 3) });
      if (res.browseShowsUnit) await nTap(page, UNIT.name, { last: true });
    }
  } else {
    const q = page.locator(`input[placeholder="${nt(lang, 'n.components.unit-search.name-ward-or-unit-number')}"]`).first();
    await q.scrollIntoViewIfNeeded().catch(() => {});
    await q.fill(unitBy === 'code' ? UNIT.pu_code : 'Oziegbe St').catch(() => {});
    await sleep(2500);
    await R.step(page, `unit — search by ${unitBy}`, 'which polling unit (search)', 1);
    await nTap(page, UNIT.name);
  }
  await sleep(2500);
  const checkIn = await nHas(page, nt(lang, 'n.app.report.result.check-in'));
  res.unit = await nHas(page, nt(lang, 'n.app.report.result.selected').replace('{v0}', UNIT.name));
  await R.step(page, 'unit selected (pinned Continue)', 'tap the unit', 1, { checkInCard: checkIn, selected: res.unit });
  if (until === 'unit') return res;
  if (!res.unit) { R.note('no unit could be chosen — the report stops at the unit step'); return res; }
  const cont = nt(lang, 'n.app.report.collation.continue-choose-the-race');
  if (!(await nTap(page, cont))) await nTap(page, nt(lang, 'common.continue'));
  await sleep(2000);
  await R.step(page, 'race picker', 'which election', 1);
  // ---- race: the election row, then the race row ("Presidency (2027)"), then Continue
  const rt = await nPickRace(page, lang, R);
  res.taps += rt;
  await R.step(page, 'votes per party', 'party counts', 1);
  if (until === 'race') return res;
  // ---- counts
  const counts = { APC: 212, PDP: 188, LP: 41, NNPP: 9 };
  const filled = await nFillCounts(page, counts);
  res.counts = counts;
  res.filled = filled;
  const numeric = page.locator('input[inputmode="numeric"]').nth(2);
  await numeric.focus().catch(() => {});
  await keyboardUp(page);
  res.keyboard = { focusedVisible: await focusedInView(page), reviewVisible: await nHas(page, nt(lang, 'n.app.report.collation.review-report')) };
  await R.step(page, 'votes — keyboard up', 'party counts (typing)', 0, { keyboard: res.keyboard, filled });
  await keyboardDown(page);
  await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
  await sleep(500);
  await R.step(page, 'votes entered', 'party counts', 4, { filled });
  // REP-RES-04 probe: a wrong sheet total must warn before Review.
  const tot = page.getByLabel(nt(lang, 'observe.total-valid-votes'), { exact: true }).first();
  res.totalsCheck = { fields: await tot.isVisible().catch(() => false) };
  if (res.totalsCheck.fields) {
    await tot.fill('999').catch(() => {});
    await nTap(page, nt(lang, 'n.app.report.collation.review-report'));
    await sleep(800);
    res.totalsCheck.warned = await nHas(page, nt(lang, 'observe.totals-dont-add-up'));
    await nTap(page, nt(lang, 'observe.check-again')).catch(() => {});
    await sleep(400);
    await tot.fill(String(Object.values(counts).reduce((a, b) => a + b, 0))).catch(() => {});
  }
  await nTap(page, nt(lang, 'n.app.report.collation.review-report'));
  await sleep(1500);
  await R.step(page, 'review — Confirm and send', 'review', 1);
  if (until === 'counts') return res;
  await nTap(page, nt(lang, 'n.app.report.result.sign-submit'));
  Object.assign(res, await nativeAfterSubmit(page, lang));
  await R.step(page, res.arrived ? 'receipt — Report filed' : res.queued ? 'queued — Saved on this phone' : 'submit — error', 'Sign & submit', 1, { text: res.text.slice(0, 400) });
  return res;
}
/** Native ContestPicker: election → race → "Continue to the figures". Records what each level offered. */
async function nPickRace(page, lang, R, { election = /^(Presidential|Shugaban [Kk]asa.*|Zaɓen Shugaban.*)$/, race = /\(2027\)\s*$/ } = {}) {
  const votes = nt(lang, 'n.app.report.result.votes-per-party');
  const toFig = nt(lang, 'n.app.practice.continue-to-the-figures');
  let taps = 0; let tappedElection = false; let tappedRace = false;
  for (let i = 0; i < 5; i++) {
    if (await nHas(page, votes)) break;
    if (!tappedRace && await nHas(page, race, false)) {
      await R.step(page, 'race picker — choose the race (seat)', 'which race (seat) inside the election', 0, { seats: (await vis(page)).split('\n').filter((l) => /\(2027\)/.test(l)).slice(0, 30) });
      await nTap(page, race); tappedRace = true; taps++;
    } else if (!tappedElection) {
      if (!(await nTap(page, election))) {
        // the first election card under "Choose an election", whatever its label in this language
        const box = await page.evaluate(() => { const r = [...document.querySelectorAll('[tabindex="0"]')].map((e) => e.getBoundingClientRect()).find((r) => r.height > 70 && r.top > 200); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; });
        if (box) await page.mouse.click(box.x, box.y);
      }
      tappedElection = true; taps++;
    } else if (await nTap(page, toFig)) { taps++; }
    await sleep(1300);
  }
  return taps;
}
async function nFillCounts(page, counts) {
  return page.evaluate((counts) => {
    let n = 0;
    const numeric = [...document.querySelectorAll('input')].filter((i) => i.getClientRects().length && i.inputMode === 'numeric');
    for (const inp of numeric) {
      // the party row = the largest ancestor that holds this one numeric input only
      let row = inp.parentElement;
      while (row.parentElement && [...row.parentElement.querySelectorAll('input')].filter((i) => i.inputMode === 'numeric').length === 1) row = row.parentElement;
      const code = ((row.innerText || '').trim().split(/\s+/)[0] || '').toUpperCase();
      const m = /^(APC|PDP|LP|NNPP)$/.exec(code);
      if (!m || !(m[1] in counts) || inp.value) continue;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(inp, String(counts[m[1]])); inp.dispatchEvent(new Event('input', { bubbles: true })); n++;
      delete counts[m[1]];
    }
    return n;
  }, { ...counts }).catch(() => 0);
}
async function nativeAfterSubmit(page, lang) {
  const keys = ['n.app.report.result.report-filed', 'n.app.report.result.saved-on-this-phone', 'n.app.report.collation.collation-filed',
    'n.app.report.collation.saved-on-this-phone', 'n.app.report.incident.incident-reported', 'n.app.report.incident.saved-to-send-later'];
  await waitFor(async () => {
    for (const k of keys) if (await nHas(page, nt(lang, k))) return true;
    return /went wrong|could not|nothing was sent|failed|Sign in/i.test(await vis(page));
  }, 25000);
  await sleep(1500);
  const text = await vis(page);
  return {
    arrived: (await nHas(page, nt(lang, keys[0]))) || (await nHas(page, nt(lang, keys[2]))) || (await nHas(page, nt(lang, keys[4]))),
    queued: (await nHas(page, nt(lang, keys[1]))) || (await nHas(page, nt(lang, keys[3]))) || (await nHas(page, nt(lang, keys[5]))),
    text,
  };
}
// ================================================================ FLOW: choose / change my polling unit
async function flowUnit(surface, lang) {
  const S = newState({ myUnit: null });
  const { ctx, page, errors, close } = await newCtx(surface, { lang, S });
  const R = recorder('unit', surface, lang);
  const o = {};
  try {
    if (surface === 'native') await nativeUnitWalk(page, R, S, lang, o);
    else await webUnitWalk(page, R, S, surface, lang, o);
    R.run.done = !!(o.firstSaved && o.changed);
    R.run.result = o;
  } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
  R.run.errors.push(...errors);
  R.run.posts = S.posts.map((p) => `${p.m} ${p.p}`);
  ob(`unit.${surface}.${lang}`, { ...o, posts: R.run.posts });
  await close();
  if (lang === 'en' && VARIANTS) {
    await unitEdges(surface, lang);
    await mapUnitSave(surface, lang);
  } else if (lang !== 'en') await mapUnitSave(surface, lang);
}
async function webUnitWalk(page, R, S, surface, lang, o) {
  await page.goto(`${SITE}/profile.html`, { waitUntil: 'load', timeout: 60000 });
  await waitFor(() => wVisible(page, '#btn-pick-unit'), 20000);
  await sleep(1500);
  await R.step(page, 'profile — My polling unit row', 'entry: Profile', 1, { row: (await page.locator('#btn-pick-unit').innerText().catch(() => '')).replace(/\s+/g, ' ').trim() });
  await page.click('#btn-pick-unit');
  await page.waitForLoadState('load', { timeout: 90000 });
  await waitFor(() => page.locator('#unit-near-results .pu-option').count().then((n) => n > 0), 15000);
  await sleep(600);
  o.nearAuto = await page.locator('#unit-near-results .pu-option').count();
  await R.step(page, 'choose-unit — near me (opens itself)', 'tap My polling unit', 1, { nearRows: o.nearAuto, nearLine: (await page.locator('#unit-near-status').innerText().catch(() => '')).trim() });
  // search by NAME
  // the street name alone first: does the unit on that street come up?
  await page.fill('#pus-q', 'Oziegbe');
  await waitFor(() => page.locator('#pus-status').innerText().then((t) => /match/i.test(t)).catch(() => false), 15000);
  await sleep(500);
  o.streetOnly = { status: (await page.locator('#pus-status').innerText().catch(() => '')).trim(), rows: await page.locator('#unit-search-host .pu-option').allInnerTexts().catch(() => []) };
  o.streetOnly.findsUnit = o.streetOnly.rows.some((t) => t.includes(UNIT.pu_code));
  await R.step(page, 'search by street name — "Oziegbe"', 'type a name', 0, o.streetOnly);
  await page.fill('#pus-q', 'Oziegbe St');
  await waitFor(() => page.locator('#unit-search-host .pu-option', { hasText: UNIT.pu_code }).count().then((n) => n > 0), 15000);
  o.byName = (await page.locator('#pus-status').innerText().catch(() => '')).trim();
  await R.step(page, 'search by name — "Oziegbe St"', 'type a name', 0, { typed: 'Oziegbe St', status: o.byName, rows: await page.locator('#unit-search-host .pu-option').count() });
  await page.locator('#unit-search-host .pu-option', { hasText: UNIT.pu_code }).first().click();
  await sleep(500);
  const saveVisible = await inViewport(page, '#btn-unit-save');
  await R.step(page, 'unit picked — Save enabled', 'tap the unit', 1, { picked: (await page.locator('#unit-picked').innerText().catch(() => '')).trim(), saveInView: saveVisible });
  await page.click('#btn-unit-save');
  await waitFor(async () => (await wVisible(page, '#cu-after')) || /profile\.html/.test(page.url()), 15000);
  await sleep(800);
  o.inviteOffered = await wVisible(page, '#cu-after');
  await R.step(page, o.inviteOffered ? 'saved — invite a second observer offered' : 'saved — left the page', 'Save This Unit', 1, { url: page.url().replace(SITE, '') });
  if (o.inviteOffered) { await page.click('#cu-after-on'); await waitFor(() => /profile\.html/.test(page.url()), 10000); }
  await waitFor(() => page.locator('#p-unit').innerText().then((t) => t.includes(UNIT.name)).catch(() => false), 10000);
  o.firstSaved = (await page.locator('#p-unit').innerText().catch(() => '')).trim();
  await R.step(page, 'back on Profile — row shows the unit', o.inviteOffered ? 'Not now' : '—', o.inviteOffered ? 1 : 0, { row: o.firstSaved });
  o.firstSaved = o.firstSaved.includes(UNIT.name) ? o.firstSaved : null;
  // CHANGE IT LATER — by PU code this time
  await page.click('#btn-pick-unit');
  await page.waitForLoadState('load', { timeout: 90000 });
  await sleep(2500);
  o.savedChip = await page.locator('.cu-saved').count();
  await R.step(page, 'choose-unit again — saved unit marked', 'tap My polling unit', 1, { savedChip: o.savedChip, url: page.url().replace(SITE, '') });
  await page.fill('#pus-q', UNIT2.pu_code);
  await waitFor(() => page.locator('#unit-search-host .pu-option').count().then((n) => n > 0), 15000);
  o.byCode = (await page.locator('#pus-status').innerText().catch(() => '')).trim();
  await R.step(page, 'search by PU code', 'type the unit code', 0, { typed: UNIT2.pu_code, status: o.byCode });
  await page.locator('#unit-search-host .pu-option', { hasText: UNIT2.pu_code }).first().click();
  await sleep(400);
  await page.click('#btn-unit-save');
  await waitFor(async () => (await wVisible(page, '#cu-after')) || /profile\.html/.test(page.url()), 15000);
  if (await wVisible(page, '#cu-after')) { o.inviteOfferedTwice = true; await page.click('#cu-after-on'); }
  await waitFor(() => page.locator('#p-unit').innerText().then((t) => t.includes(UNIT2.name)).catch(() => false), 10000);
  const row = (await page.locator('#p-unit').innerText().catch(() => '')).trim();
  o.changed = row.includes(UNIT2.name) ? row : null;
  await R.step(page, 'changed — Profile shows the new unit', 'tap result + Save', 2, { row });
}
async function nativeUnitWalk(page, R, S, lang, o) {
  const base = await nativeBase();
  await page.goto(`${base}/profile`, { waitUntil: 'load', timeout: 60000 });
  await waitFor(() => nHas(page, nt(lang, 'index.my-polling-unit')), 20000);
  await sleep(1500);
  await R.step(page, 'profile — My Polling Unit row', 'entry: Profile', 1, { noneSavedEnglish: await nHas(page, 'None Saved') });
  await nTap(page, nt(lang, 'index.my-polling-unit'));
  await sleep(3000);
  const nearRow = await waitFor(() => nHas(page, UNIT.name), 12000);
  o.nearAuto = nearRow;
  await R.step(page, 'choose-unit — near me', 'tap My Polling Unit', 1, { nearShowsUnit: nearRow });
  const q = page.locator(`input[placeholder="${nt(lang, 'n.components.unit-search.name-ward-or-unit-number')}"]`).first();
  await q.scrollIntoViewIfNeeded().catch(() => {});
  const before = await nCount(page, UNIT.name);
  await q.fill('Oziegbe').catch(() => {});
  await sleep(3000);
  o.streetOnly = { findsUnit: (await nCount(page, UNIT.name)) > before, before, status: (await vis(page)).split('\n').find((l) => /match/i.test(l)) || '', rows: (await vis(page)).split('\n').filter((l) => /Oziegbe/.test(l)) };
  await R.step(page, 'search by street name — "Oziegbe"', 'type a name', 0, o.streetOnly);
  await q.fill('Oziegbe St').catch(() => {});
  await sleep(3000);
  o.byName = (await vis(page)).split('\n').find((l) => /match/i.test(l)) || '';
  await R.step(page, 'search by name — "Oziegbe St"', 'type a name', 0, { typed: 'Oziegbe St', found: await nHas(page, UNIT.name) });
  await nTap(page, UNIT.name, { last: true });
  await sleep(800);
  await R.step(page, 'unit picked', 'tap the unit', 1, { saveVisible: await nHas(page, nt(lang, 'profile.save-this-unit')) });
  await nTap(page, nt(lang, 'profile.save-this-unit'));
  await sleep(2500);
  o.inviteOffered = await nHas(page, nt(lang, 'n.invite2.title'));
  await R.step(page, o.inviteOffered ? 'saved — invite a second observer offered' : 'saved — left', 'Save This Unit', 1);
  if (o.inviteOffered) await nTap(page, nt(lang, 'lang.later'));
  await sleep(2500);
  o.firstSaved = (await nHas(page, UNIT.name)) && (await nHas(page, nt(lang, 'index.my-polling-unit')));
  await R.step(page, 'back on Profile — row shows the unit', o.inviteOffered ? 'Not now' : '—', o.inviteOffered ? 1 : 0, { rowShowsUnit: o.firstSaved });
  // change later, by code
  await nTap(page, nt(lang, 'index.my-polling-unit'));
  await sleep(3000);
  o.savedChip = await nHas(page, nt(lang, 'n.components.choose-unit.saved'));
  await R.step(page, 'choose-unit again', 'tap My Polling Unit', 1, { savedChip: o.savedChip });
  const q2 = page.locator(`input[placeholder="${nt(lang, 'n.components.unit-search.name-ward-or-unit-number')}"]`).first();
  await q2.scrollIntoViewIfNeeded().catch(() => {});
  await q2.fill(UNIT2.pu_code).catch(() => {});
  await sleep(2500);
  await R.step(page, 'search by PU code', 'type the unit code', 0, { typed: UNIT2.pu_code, found: await nHas(page, UNIT2.name) });
  await nTap(page, UNIT2.name, { last: true });
  await sleep(600);
  await nTap(page, nt(lang, 'profile.save-this-unit'));
  await sleep(2500);
  if (await nHas(page, nt(lang, 'n.invite2.title'))) { o.inviteOfferedTwice = true; await nTap(page, nt(lang, 'lang.later')); await sleep(1500); }
  o.changed = await nHas(page, UNIT2.name);
  await R.step(page, 'changed — Profile shows the new unit', 'tap result + Save', 2, { rowShowsNewUnit: o.changed });
}
/** Edge cases on the chooser (en): no results, bad code, near-me empty / failing, offline, keyboard, reload, Back. */
async function unitEdges(surface, lang) {
  const R = recorder('unit', surface, lang, 'edges');
  const out = {};
  const native = surface === 'native';
  const open = async (S) => {
    const c = await newCtx(surface, { lang, S });
    if (native) await c.page.goto(`${await nativeBase()}/choose-unit?current=${UNIT.pu_code}`, { waitUntil: 'load', timeout: 60000 });
    else await c.page.goto(`${SITE}/choose-unit.html?current=${UNIT.pu_code}`, { waitUntil: 'load', timeout: 60000 });
    await sleep(4000);
    return c;
  };
  const search = async (page, term) => {
    if (native) {
      const q = page.locator(`input[placeholder="${nt(lang, 'n.components.unit-search.name-ward-or-unit-number')}"]`).first();
      await q.scrollIntoViewIfNeeded().catch(() => {});
      await q.fill(term).catch(() => {});
    } else await page.fill('#pus-q', term);
    await sleep(3500);
    const t = await vis(page);
    return (t.split('\n').find((l) => /No unit matches|Could not search|not on this device|Keep typing|match/i.test(l)) || '').trim();
  };
  // 1. no results + bad code + near-me empty (one context)
  {
    const S = newState({ near: 'empty' });
    const { page, close, errors } = await open(S);
    out.nearEmpty = (await vis(page)).split('\n').find((l) => /No unit found|could not|Could not/i.test(l)) || '(no line)';
    await R.step(page, 'near me — nothing within reach', 'near me (fixture: no units)', 0, { line: out.nearEmpty });
    out.noResults = await search(page, 'zzqxw');
    await R.step(page, 'search — no results', 'type "zzqxw"', 0, { line: out.noResults });
    out.badCode = await search(page, '99-99-99-999');
    await R.step(page, 'search — a code not in the register', 'type "99-99-99-999"', 0, { line: out.badCode });
    out.shortCode = await search(page, '24-16-05-0');
    await R.step(page, 'search — partial code', 'type "24-16-05-0"', 0, { line: out.shortCode });
    R.run.errors.push(...errors);
    await close();
  }
  // 2. near me failing
  {
    const S = newState({ near: 'fail' });
    const { page, close } = await open(S);
    out.nearFail = (await vis(page)).split('\n').find((l) => /Could not check|could not/i.test(l)) || '(no line)';
    out.nearFailStuck = await stuckLines(page, 6000);
    await R.step(page, 'near me — lookup fails (500)', 'near me (fixture: 500)', 0, { line: out.nearFail, stuck: out.nearFailStuck });
    await close();
  }
  // 3. control for the stuck-loading detector: a lookup that never answers MUST be reported stuck
  {
    const S = newState({ hang: ['/api/polling-units', '/api/mapping/nearby'] });
    const { page, close } = await open(S);
    out.controlHang = await stuckLines(page, 5000);
    await R.step(page, 'CONTROL — near-me lookup hangs (detector must fire)', 'control', 0, { stuck: out.controlHang });
    await close();
  }
  // 4. offline: search and save
  {
    const S = newState();
    const { ctx, page, close } = await open(S);
    await goOffline(ctx, page, S);
    out.offlineSearch = await search(page, 'Ilupeju');
    const rows = native ? (await nHas(page, /Ilupeju/)) : await page.locator('#unit-search-host .pu-option').count();
    await R.step(page, 'offline — search', 'type "Ilupeju" offline', 0, { line: out.offlineSearch, rows });
    // pick one (search result, else the near list from before going offline)
    let picked = false;
    if (native) picked = await nTap(page, UNIT2.name, { last: true }) || await nTap(page, /Ilupeju/, { last: true });
    else {
      const r = page.locator('#unit-search-host .pu-option, #unit-near-results .pu-option').first();
      if (await r.count()) { await r.click(); picked = true; }
    }
    await sleep(500);
    if (native) await nTap(page, nt(lang, 'profile.save-this-unit')); else await page.click('#btn-unit-save').catch(() => {});
    await sleep(3500);
    const t = native ? await vis(page) : await page.locator('#unit-msg').innerText().catch(() => '');
    out.offlineSave = (t.split('\n').filter((l) => /Could not save|check your connection|try again/i.test(l) && !/search/i.test(l)).join(' ') || '(no line)').trim();
    out.offlineSaveStuck = await stuckLines(page, 4000);
    await R.step(page, 'offline — Save', 'Save This Unit offline', 1, { picked, line: out.offlineSave, stuck: out.offlineSaveStuck });
    await goOnline(ctx, page, S);
    if (native) { await nTap(page, nt(lang, 'common.ok')) || await nTap(page, 'OK'); await sleep(800); await nTap(page, nt(lang, 'profile.save-this-unit')); } else await page.click('#btn-unit-save').catch(() => {});
    await sleep(3500);
    out.retrySaved = !!(S.myUnit && S.myUnit.pu_code !== UNIT.pu_code) || S.posts.filter((p) => p.p === '/api/observers/my-unit' && !p.offline).length > 0;
    await R.step(page, 'back online — Save again (no re-pick)', 'Save This Unit', 1, { saved: out.retrySaved, url: page.url() });
    await close();
  }
  // 5. keyboard up on the search field
  {
    const S = newState();
    const { page, close } = await open(S);
    if (native) {
      const q = page.locator(`input[placeholder="${nt(lang, 'n.components.unit-search.name-ward-or-unit-number')}"]`).first();
      await q.scrollIntoViewIfNeeded().catch(() => {});
      await q.click().catch(() => {});
      await q.fill('Oziegbe St').catch(() => {});
    } else { await page.click('#pus-q'); await page.fill('#pus-q', 'Oziegbe St'); }
    await keyboardUp(page);
    await sleep(2500);
    out.keyboard = { fieldVisible: await focusedInView(page) };
    await R.step(page, 'keyboard up — typing in search', 'type a name', 0, out.keyboard);
    await keyboardDown(page);
    await close();
  }
  // 6. Back and reload after picking but before saving
  {
    const S = newState();
    const { page, close } = await open(S);
    await search(page, 'Oziegbe St');
    if (native) await nTap(page, UNIT.name, { last: true }); else await page.locator('#unit-search-host .pu-option').first().click().catch(() => {});
    await sleep(500);
    await page.reload({ waitUntil: 'load' });
    await sleep(4000);
    out.reloadKeepsPick = native ? await nHas(page, nt(lang, 'n.components.choose-unit.selected')) : await wVisible(page, '#unit-picked');
    out.reloadKeepsQuery = native ? await page.locator('input').first().inputValue().catch(() => '') : await page.locator('#pus-q').inputValue().catch(() => '');
    await R.step(page, 'reload after picking (unsaved)', 'reload', 0, { keepsPick: out.reloadKeepsPick, query: out.reloadKeepsQuery });
    await close();
  }
  R.run.done = true;
  R.run.result = out;
  ob(`unitEdges.${surface}`, out);
}
/** The other way in: Map a Polling Unit → pick → "Save as my polling unit" (+ offline save). */
async function mapUnitSave(surface, lang) {
  const R = recorder('unit', surface, lang, 'map');
  const S = newState({ myUnit: null });
  const { ctx, page, close, errors } = await newCtx(surface, { lang, S });
  const o = {};
  try {
    if (surface === 'native') {
      await page.goto(`${await nativeBase()}/map-unit`, { waitUntil: 'load', timeout: 60000 });
      await sleep(5000);
      await R.step(page, 'map-unit', 'entry: Map a Polling Unit', 2);
      const q = page.locator(`input[placeholder="${nt(lang, 'n.components.unit-search.name-ward-or-unit-number')}"]`).first();
      await q.scrollIntoViewIfNeeded().catch(() => {});
      await q.fill('Oziegbe St').catch(() => {});
      await sleep(3000);
      await nTap(page, UNIT.name, { last: true });
      await sleep(2500);
      await R.step(page, 'map-unit — unit picked', 'search + tap', 1, { saveOffered: await nHas(page, nt(lang, 'n.app.map-unit.save-as-my-polling-unit')) });
      if (lang === 'en') { await goOffline(ctx, page, S); }
      await nTap(page, nt(lang, 'n.app.map-unit.save-as-my-polling-unit'));
      await sleep(4000);
      o.offlineLine = lang === 'en' ? (await vis(page)).split('\n').filter((l) => /could not|connection|try again|Saving/i.test(l)).slice(0, 3) : null;
      if (lang === 'en') {
        await R.step(page, 'map-unit — Save offline', 'Save as my polling unit (offline)', 1, { lines: o.offlineLine, stuck: await stuckLines(page, 4000) });
        await goOnline(ctx, page, S);
        await nTap(page, nt(lang, 'common.ok')) || await nTap(page, 'OK'); await sleep(800);
        await nTap(page, nt(lang, 'n.app.map-unit.save-as-my-polling-unit'));
        await sleep(3500);
      }
      o.saved = !!S.myUnit;
      await R.step(page, 'map-unit — saved', 'Save as my polling unit', 1, { saved: o.saved, savedLine: await nHas(page, nt(lang, 'n.app.map-unit.saved-as-your-polling-unit-tap')) });
    } else {
      await page.goto(`${SITE}/map-unit.html`, { waitUntil: 'load', timeout: 60000 });
      await sleep(4000);
      await R.step(page, 'map-unit', 'entry: Map a Polling Unit', 2);
      await page.locator('#pus-q').scrollIntoViewIfNeeded().catch(() => {});
      await page.fill('#pus-q', 'Oziegbe St').catch(() => {});
      await waitFor(() => page.locator('#pu-search-host .pu-option', { hasText: UNIT.pu_code }).count().then((n) => n > 0), 15000);
      await page.locator('#pu-search-host .pu-option', { hasText: UNIT.pu_code }).first().click().catch(() => {});
      await sleep(1500);
      await page.locator('#btn-save-unit').scrollIntoViewIfNeeded().catch(() => {});
      await R.step(page, 'map-unit — unit picked (capture card)', 'search + tap', 1, { saveOffered: await wVisible(page, '#btn-save-unit'), gpsButton: await wVisible(page, '#btn-gps') });
      if (lang === 'en') {
        await goOffline(ctx, page, S);
        await page.click('#btn-save-unit').catch(() => {});
        await sleep(4000);
        o.offlineLine = (await page.locator('#cap-status').innerText().catch(() => '')).trim();
        o.offlineStuck = await stuckLines(page, 5000);
        await R.step(page, 'map-unit — Save offline', 'Save as my polling unit (offline)', 1, { line: o.offlineLine, stuck: o.offlineStuck });
        await goOnline(ctx, page, S);
      }
      await page.click('#btn-save-unit').catch(() => {});
      await sleep(3000);
      o.saved = !!S.myUnit;
      await R.step(page, 'map-unit — saved', 'Save as my polling unit', 1, { saved: o.saved, line: (await page.locator('#cap-status').innerText().catch(() => '')).trim() });
    }
  } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
  R.run.errors.push(...errors);
  R.run.done = !!o.saved;
  R.run.result = o;
  ob(`mapUnit.${surface}.${lang}`, o);
  await close();
}

// ================================================================ FLOW: incident
let PHOTO = null;
async function fixturePhoto() {
  if (PHOTO) return PHOTO;
  const dir = path.join(OUT, '_fixture');
  fs.mkdirSync(dir, { recursive: true });
  PHOTO = path.join(dir, 'incident.jpg');
  const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
  const p = await ctx.newPage();
  await p.setContent('<body style="margin:0;background:#556b2f;color:#fff;font:bold 40px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">TEST PHOTO — FLOW AUDIT</body>');
  await p.screenshot({ path: PHOTO, type: 'jpeg', quality: 70 });
  await ctx.close();
  return PHOTO;
}
async function webIncidentWalk(page, R, S, { surface, lang, enter = true, submit = true, media = true }) {
  const res = {};
  if (enter) {
    const taps = await wEnter(page, surface, 'incidents');
    await waitFor(() => wVisible(page, '#form-card'), 20000);
    await sleep(2500);
    await R.step(page, 'incident form', 'entry: Report → Report an Incident', taps, { formOrder: await page.$$eval('#form-card label, #form-card select, #form-card textarea, #form-card button', (a) => a.filter((x) => x.offsetParent).map((x) => (x.innerText || x.id || '').trim().split('\n')[0]).filter(Boolean).slice(0, 14)).catch(() => []) });
  }
  if (media) {
    await page.setInputFiles('#media', await fixturePhoto()).catch((e) => R.note('media input: ' + e.message.slice(0, 80)));
    await sleep(2500);
    await R.step(page, 'photo attached (optional)', 'Upload → choose a photo', 2, { previews: await page.locator('#preview img, #preview .thumb, #preview > *').count().catch(() => 0) });
  }
  const opts = await page.$$eval('#kind option', (a) => a.map((o) => ({ v: o.value, t: o.textContent.trim() })));
  await page.selectOption('#kind', 'late_materials').catch(() => {});
  await page.fill('#desc', 'Materials arrived 2 hours late; voting started 10:40.');
  await R.step(page, 'kind + description', 'what happened (select) + describe', 3, { kinds: opts.length, placeholderFirst: opts[0] && opts[0].v === '' });
  // attach the unit
  await page.check('#attach-pu').catch(() => {});
  await sleep(2500);
  const savedRow = await wVisible(page, '#saved-unit-row');
  if (savedRow) await page.check('#use-saved').catch(() => {});
  else await page.locator('#pu-near-list input[type=radio]').first().check().catch(() => {});
  await sleep(500);
  await R.step(page, 'attach the polling unit', 'tick "attach a polling unit" + choose it', 2, { savedUnitOffered: savedRow, nearRows: await page.locator('#pu-near-list input[type=radio]').count() });
  if (!submit) return res;
  await page.click('#btn-submit');
  res.after = await webIncidentAfter(page);
  Object.assign(res, res.after);
  await R.step(page, res.modal ? `done — ${res.title}` : 'submit — still on form', 'Submit report', 1, res.after);
  return res;
}
async function webIncidentAfter(page) {
  await waitFor(async () => (await wVisible(page, '#done-modal')) || /Could not|failed|❌|offline/i.test(await page.locator('#status').innerText().catch(() => '')) || !!(await wDialog(page)), 30000);
  await page.waitForSelector('#receipt-img[src^="data:"], #receipt-img[src^="blob:"]', { timeout: 6000 }).catch(() => {});
  await sleep(600);
  return {
    modal: await wVisible(page, '#done-modal'),
    title: (await page.locator('#done-title').innerText().catch(() => '')).trim(),
    msg: (await page.locator('#done-msg').innerText().catch(() => '')).trim(),
    status: (await page.locator('#status').innerText().catch(() => '')).trim(),
    receipt: await wVisible(page, '#receipt-img'),
    dialog: await wDialog(page),
    descKept: (await page.locator('#desc').inputValue().catch(() => '')).length > 0,
  };
}
async function nativeIncidentWalk(page, R, S, { lang, enter = true, submit = true, media = false }) {
  const res = {};
  if (enter) {
    const taps = await nEnter(page, lang, 'incident');
    await R.step(page, 'incident — what happened', 'entry: Report tab → Report an Incident', taps);
  }
  if (media) {
    await nTap(page, nt(lang, 'n.app.report.incident.camera'));
    await sleep(1500);
    const shot = await nShoot(page, lang);
    await R.step(page, 'photo taken (optional)', 'Camera → shutter → Use photo', 3, { shot });
  }
  await nTap(page, nt(lang, 'n.kind.late-materials'));
  const desc = page.locator(`textarea, input[placeholder^="${nt(lang, 'n.app.report.incident.what-did-you-witness-where-when').slice(0, 12)}"]`).first();
  await desc.fill('Materials arrived 2 hours late; voting started 10:40.').catch(() => {});
  await sleep(600);
  await R.step(page, 'kind + description', 'what happened (chip) + describe', 2);
  await nTap(page, nt(lang, 'n.app.report.incident.continue-where-did-this-happen'));
  await sleep(2500);
  await R.step(page, 'incident — which polling unit', 'Continue — where did this happen', 1, { savedOptIn: await nHas(page, nt(lang, 'n.app.report.incident.i-am-at-my-own-polling')) });
  if (!(await nTap(page, nt(lang, 'n.app.report.incident.i-am-at-my-own-polling')))) await nTap(page, UNIT.name);
  await sleep(1200);
  await R.step(page, 'unit decided', 'tick "I am at my own polling unit"', 1, { submitReady: await nHas(page, nt(lang, 'n.app.report.incident.submit-incident-report')) });
  if (!submit) return res;
  await nTap(page, nt(lang, 'n.app.report.incident.submit-incident-report'));
  Object.assign(res, await nativeAfterSubmit(page, lang));
  await R.step(page, res.arrived ? 'done — Incident reported' : res.queued ? 'done — Saved to send later' : 'submit — error', 'Submit incident report', 1, { text: res.text.slice(0, 400) });
  return res;
}
async function flowIncident(surface, lang) {
  const S = newState();
  const { ctx, page, errors, close } = await newCtx(surface, { lang, S });
  const R = recorder('incident', surface, lang);
  try {
    const r = surface === 'native' ? await nativeIncidentWalk(page, R, S, { lang }) : await webIncidentWalk(page, R, S, { surface, lang });
    R.run.done = !!(r.modal || r.arrived);
    // where it shows afterwards: Profile → Incident Reports (from /api/observers/me)
    if (R.run.done) {
      if (surface === 'native') {
        await page.goto(`${await nativeBase()}/reports-log`, { waitUntil: 'load' }).catch(() => {});
        await sleep(4000);
        await R.step(page, 'afterwards — reports log', 'where it shows', 1, { listsPending: /pending|review/i.test(await vis(page)) });
        await page.goto(`${await nativeBase()}/profile`, { waitUntil: 'load' }).catch(() => {});
        await sleep(4000);
        await R.step(page, 'afterwards — Profile', 'where it shows', 1, { mentionsIncident: /incident|Late materials/i.test(await vis(page)) });
      } else {
        if (await wVisible(page, '#btn-exit')) await page.click('#btn-exit').catch(() => {});
        await sleep(1500);
        await R.step(page, 'after Exit', 'Exit', 1, { url: page.url().replace(SITE, '') });
        await page.goto(`${SITE}/profile.html`, { waitUntil: 'load' });
        await sleep(3000);
        await page.locator('#cnt-incidents').scrollIntoViewIfNeeded().catch(() => {});
        await page.locator('#p-incidents').evaluate((e) => { const d = e.closest('details'); if (d) d.open = true; }).catch(() => {});
        await sleep(500);
        await R.step(page, 'afterwards — Profile › Incident Reports', 'where it shows', 2, { count: (await page.locator('#cnt-incidents').innerText().catch(() => '')).trim(), list: (await page.locator('#p-incidents').innerText().catch(() => '')).trim().slice(0, 200) });
      }
    }
    R.run.result = r;
    R.run.posts = S.posts.map((p) => `${p.m} ${p.p}`);
    ob(`incident.${surface}.${lang}`, { done: R.run.done, ...r, text: undefined, posts: R.run.posts });
  } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
  R.run.errors.push(...errors);
  await close();
  if (lang === 'en' && VARIANTS) await incidentVariants(surface, lang);
}
/** Incident: 500, network failure, 401, kind missing, reload, keyboard. */
async function incidentVariants(surface, lang) {
  const native = surface === 'native';
  const walk = (page, R, S, o) => (native ? nativeIncidentWalk(page, R, S, { lang, ...o }) : webIncidentWalk(page, R, S, { surface, lang, ...o }));
  for (const v of ['500', 'net', '401']) {
    const S = newState({ incident: v === 'net' ? 'ok' : v, netFail: v === 'net' ? ['/api/incidents'] : [] });
    const { page, close, errors } = await newCtx(surface, { lang, S });
    const R = recorder('incident', surface, lang, `fail-${v}`);
    try {
      const r = await walk(page, R, S, {});
      const ob_ = { ...r, text: (r.text || '').slice(-400), outbox: await outboxCount(page, surface), posts: S.posts.map((p) => `${p.m} ${p.p}${p.aborted ? ' (net)' : ''}`) };
      if (v !== '401') {
        // retry without retyping?
        S.incident = 'ok'; S.netFail.clear();
        if (!native && !r.modal && await page.locator('#btn-submit').isEnabled().catch(() => false)) {
          await page.click('#btn-submit');
          ob_.retry = await webIncidentAfter(page);
          await R.step(page, 'retry — tap Submit again', 'Submit report', 1, ob_.retry);
        } else if (native && !r.arrived && !r.queued) {
          await nTap(page, nt(lang, 'n.app.report.incident.submit-incident-report'));
          ob_.retry = { ...(await nativeAfterSubmit(page, lang)) }; ob_.retry.text = ob_.retry.text.slice(0, 300);
          await R.step(page, 'retry — tap Submit again', 'Submit incident report', 1, { arrived: ob_.retry.arrived });
        }
      }
      R.run.done = true; R.run.result = ob_;
      ob(`incidentFail.${surface}.${v}`, ob_);
    } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
    R.run.errors.push(...errors);
    await close();
  }
  // reload mid-flow (kind + description typed) and keyboard up on the description
  {
    const S = newState();
    const { page, close } = await newCtx(surface, { lang, S });
    const R = recorder('incident', surface, lang, 'reload');
    try {
      await walk(page, R, S, { submit: false, media: !native });
      const descSel = native ? 'textarea' : '#desc';
      await page.locator(descSel).first().focus().catch(() => {});
      await keyboardUp(page);
      const kb = { focusedVisible: await focusedInView(page), submitVisible: native ? await nHas(page, nt(lang, 'n.app.report.incident.submit-incident-report')) : await inViewport(page, '#btn-submit') };
      await R.step(page, 'keyboard up — typing the description', 'describe', 0, kb);
      await keyboardDown(page);
      await page.reload({ waitUntil: 'load' });
      await sleep(5000);
      const kept = native ? /2 hours late/.test(await page.locator('textarea').first().inputValue().catch(() => '')) : /2 hours late/.test(await page.locator('#desc').inputValue().catch(() => ''));
      await R.step(page, 'after reload', 'reload', 0, { descriptionKept: kept });
      R.run.done = true;
      ob(`incidentReload.${surface}`, { keyboard: kb, descriptionKept: kept });
    } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
    await close();
  }
}

// ================================================================ FLOW: collation
async function webCollationWalk(page, R, S, { surface, lang }) {
  const res = {};
  const taps = await wEnter(page, surface, 'collation');
  await waitFor(() => wVisible(page, '#form'), 20000);
  await sleep(2500);
  await R.step(page, 'collation form (step 1 open)', 'entry: Report → Report a Collation', taps, { stepHeads: await page.$$eval('#form details.step-card > summary h2', (a) => a.map((h) => h.innerText.trim())).catch(() => []) });
  const s1 = await wShoot(page, 'sheet');
  const s2 = await wShoot(page, 'venue');
  await sleep(800);
  await R.step(page, 'photos — form + centre', 'photo of the collation form + the centre', 4, { sheet: s1, venue: s2 });
  // step 2: level + state + lga + ward
  await page.selectOption('#sel-level', 'ward').catch(() => {});
  await waitFor(() => page.locator('#sel-state option').count().then((n) => n > 5), 15000);
  await page.selectOption('#sel-state', 'Lagos').catch(() => {});
  await waitFor(() => page.locator('#sel-lga option').count().then((n) => n > 2), 15000);
  await page.selectOption('#sel-lga', 'Mushin').catch(() => {});
  await waitFor(() => page.locator('#sel-ward option').count().then((n) => n > 2), 15000);
  await page.selectOption('#sel-ward', { label: 'Ilupeju' }).catch(async () => { await page.selectOption('#sel-ward', { index: 1 }).catch(() => {}); });
  await sleep(1200);
  await R.step(page, 'scope — level, state, LGA, ward', 'what does this form cover (4 selects)', 8, { scopeState: (await page.locator('#scope-fold-state').innerText().catch(() => '')).trim() });
  const opts = await page.$$eval('#sel-contest option', (a) => a.map((o) => ({ v: o.value, t: o.textContent.trim(), d: o.disabled })));
  await page.selectOption('#sel-contest', 'PRES').catch(() => {});
  await sleep(900);
  await R.step(page, 'election chosen', 'which election (select)', 2, { options: opts.map((o) => `${o.v}${o.d ? '(disabled)' : ''}`) });
  await waitFor(() => page.locator('#vote-inputs input').count().then((n) => n > 3), 15000);
  for (const [party, v] of Object.entries({ APC: 4120, PDP: 3877, LP: 901, NNPP: 212 })) await page.fill(`#vote-inputs input[data-party="${party}"]`, String(v)).catch(() => {});
  await page.click('#btn-verify-counts').catch(() => {});
  await sleep(900);
  const dlg = await wDialog(page); if (dlg) await wDialogOk(page);
  res.verifyState = (await page.locator('#counts-fold-state').innerText().catch(() => '')).trim();
  res.submitEnabledAfterVerify = await page.locator('#btn-submit').isEnabled().catch(() => false);
  await R.step(page, 'totals + Verify totals', 'party totals + Verify totals', 5, { countsState: res.verifyState, dialog: dlg, submitEnabled: res.submitEnabledAfterVerify });
  if (!res.submitEnabledAfterVerify) {
    // Re-check by a different route: wait, then poke an unrelated control that runs
    // updateSubmit() (the ward <select>). If THAT lights the button, the verify
    // handler is what fails to.
    await sleep(3000);
    res.submitEnabledAfterWait = await page.locator('#btn-submit').isEnabled().catch(() => false);
    await page.evaluate(() => document.getElementById('sel-ward').dispatchEvent(new Event('change'))).catch(() => {});
    await sleep(500);
    res.submitEnabledAfterOtherChange = await page.locator('#btn-submit').isEnabled().catch(() => false);
    await page.locator('#btn-submit').scrollIntoViewIfNeeded().catch(() => {});
    await R.step(page, 'Sign & submit still disabled after Verify totals', '—', 0, { afterWait: res.submitEnabledAfterWait, afterWardChange: res.submitEnabledAfterOtherChange });
  }
  await page.locator('#btn-submit').scrollIntoViewIfNeeded().catch(() => {});
  await R.step(page, 'sign & submit card', 'review facts', 0, { facts: (await page.locator('#submit-facts').innerText().catch(() => '')).trim() });
  await page.click('#btn-submit').catch(() => {});
  await waitFor(async () => (await wVisible(page, '#receipt-wrap')) || /submitted|recorded|Could not|failed|offline|❌|✅/i.test(await page.locator('#status').innerText().catch(() => '')) || !!(await wDialog(page)), 30000);
  await sleep(1500);
  res.status = (await page.locator('#status').innerText().catch(() => '')).trim();
  res.receipt = await wVisible(page, '#receipt-img');
  res.dialog = await wDialog(page);
  res.arrived = res.receipt || /recorded|submitted|✅/i.test(res.status);
  await R.step(page, res.arrived ? 'done — receipt' : 'submit — still on form', 'Sign & submit collation report', 1, { status: res.status, receipt: res.receipt, dialog: res.dialog });
  return res;
}
async function nativeCollationWalk(page, R, S, { lang }) {
  const res = {};
  const taps = await nEnter(page, lang, 'collation');
  await R.step(page, 'collation — first screen', 'entry: Report tab → Report a Collation', taps, { steps: (await vis(page)).split('\n').slice(0, 12) });
  const s1 = await nShoot(page, lang);
  const s2 = await nShoot(page, lang);
  await sleep(2000);
  await R.step(page, 'photos done → scope', 'photo of the form + the centre (shutter + Use photo, ×2)', 4, { sheet: s1, venue: s2 });
  // scope: level → state → LGA → ward
  await nTap(page, nt(lang, 'n.level.ward'));
  await sleep(1500);
  await nTap(page, 'Lagos'); await sleep(1800);
  await nTap(page, 'Mushin'); await sleep(1800);
  await nTap(page, 'Ilupeju'); await sleep(1800);
  await R.step(page, 'scope chosen', 'level, state, LGA, ward (4 taps)', 4);
  if (!(await nTap(page, nt(lang, 'n.app.report.collation.continue-choose-the-race')))) await nTap(page, nt(lang, 'common.continue'));
  await sleep(1800);
  const rt = await nPickRace(page, lang, R);
  await R.step(page, 'collated totals', 'race', rt);
  const filled = await nFillCounts(page, { APC: 4120, PDP: 3877, LP: 901, NNPP: 212 });
  await R.step(page, 'totals entered', 'party totals', 4, { filled });
  await nTap(page, nt(lang, 'n.app.report.collation.review-report'));
  await sleep(1500);
  await R.step(page, 'review', 'Review report', 1);
  await nTap(page, nt(lang, 'n.app.report.collation.sign-submit'));
  Object.assign(res, await nativeAfterSubmit(page, lang));
  await R.step(page, res.arrived ? 'done — Collation Filed' : res.queued ? 'queued' : 'submit — error', 'Sign & submit', 1, { text: res.text.slice(0, 300) });
  return res;
}
async function flowCollation(surface, lang) {
  const S = newState();
  const { page, errors, close } = await newCtx(surface, { lang, S });
  const R = recorder('collation', surface, lang);
  try {
    const r = surface === 'native' ? await nativeCollationWalk(page, R, S, { lang }) : await webCollationWalk(page, R, S, { surface, lang });
    R.run.done = !!r.arrived;
    R.run.result = { ...r, text: (r.text || '').slice(0, 300) };
    R.run.posts = S.posts.map((p) => `${p.m} ${p.p}`);
    ob(`collation.${surface}.${lang}`, { ...R.run.result, posts: R.run.posts });
  } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
  R.run.errors.push(...errors);
  await close();
}

// ================================================================ FLOW: result
async function flowResult(surface, lang) {
  const S = newState();
  const { ctx, page, errors, close } = await newCtx(surface, { lang, S });
  const R = recorder('result', surface, lang);
  try {
    const r = surface === 'native' ? await nativeResultWalk(page, R, S, { lang }) : await webResultWalk(page, R, S, { surface, lang });
    R.run.done = !!r.arrived;
    R.run.result = { ...r, text: undefined };
    R.run.posts = S.posts.map((p) => `${p.m} ${p.p}${p.aborted ? ' (net fail)' : ''}`);
    ob(`result.${surface}.${lang}`, { done: !!r.arrived, queued: !!r.queued, photos: r.photos, unit: r.unit, keyboard: r.keyboard, posts: R.run.posts, status: r.status || null, text: (r.text || '').slice(0, 300), totalsCheck: r.totalsCheck || null });
  } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
  R.run.errors.push(...errors);
  await close();
  if (lang === 'en' && VARIANTS) await resultVariants(surface, lang);
}

/** Wait for the web outbox to drain, nudging it the way its own triggers do (online / visible / 60 s tick). */
async function drainWeb(page, ms = 50000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = await outboxCount(page, 'web');
    if (n === 0) return { drained: true, afterMs: Date.now() - t0 };
    await page.evaluate(() => window.HawkeyeOutbox && window.HawkeyeOutbox.flush()).catch(() => {});
    await sleep(3000);
  }
  return { drained: false, left: await outboxCount(page, 'web') };
}

async function resultVariants(surface, lang) {
  const native = surface === 'native';
  const one = async (variant, opts, body) => {
    const S = newState(opts);
    const c = await newCtx(surface, { lang, S });
    const R = recorder('result', surface, lang, variant);
    const o = {};
    try { await body(c, R, S, o); } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
    R.run.errors.push(...c.errors);
    R.run.posts = S.posts.map((p) => `${p.m} ${p.p}${p.aborted ? ' (net fail)' : ''}${p.offline ? ' (offline)' : ''}`);
    R.run.result = o; R.run.done = true;
    ob(`resultVariant.${surface}.${variant}`, { ...o, posts: R.run.posts });
    await c.close();
  };
  const walk = (page, R, S, o) => (native ? nativeResultWalk(page, R, S, { lang, ...o }) : webResultWalk(page, R, S, { surface, lang, ...o }));

  // THE GATE as it is today (contests closed): what the observer meets before election day.
  await one('gate-closed', { contests: CONTESTS_CLOSED }, async ({ page }, R, S, o) => {
    await walk(page, R, S, { until: 'unit' });
    if (native) {
      const cont = nt(lang, 'n.app.report.collation.continue-choose-the-race');
      await nTap(page, cont); await sleep(2000);
      await nPickRace(page, lang, R);
      o.blockedLine = (await vis(page)).split('\n').filter((l) => /open|Opens/i.test(l)).slice(0, 6);
      o.canReachVotes = await nHas(page, nt(lang, 'n.app.report.result.votes-per-party'));
      await R.step(page, 'closed race — where the flow stops', 'which election', 0, o);
    } else {
      o.options = await page.$$eval('#sel-contest option', (a) => a.map((x) => `${x.value}${x.disabled ? '(disabled)' : ''}: ${x.textContent.trim()}`));
      await page.selectOption('#sel-contest', 'PRES').catch(() => {});
      await sleep(800);
      o.scope = (await page.locator('#contest-scope').textContent().catch(() => '')).trim();
      await R.step(page, 'closed race selected — scope notice', 'which election', 2, { scope: o.scope, options: o.options });
      for (const [party, v] of Object.entries({ APC: 1, PDP: 2 })) await page.fill(`#vote-inputs input[data-party="${party}"]`, String(v)).catch(() => {});
      await page.click('#btn-verify-counts').catch(() => {});
      await sleep(800);
      await page.click('#btn-submit').catch(() => {});
      await sleep(2000);
      o.dialog = await wDialog(page);
      await R.step(page, 'submit on a closed race — refused', 'Sign & submit', 1, { dialog: o.dialog });
    }
  });

  if (native) {
    // THE SEAT QUESTION: the unit decides its senatorial district / federal
    // constituency (web derives it, scope.js); what does the native picker ask?
    await one('race-seat', {}, async ({ page }, R, S, o) => {
      await walk(page, R, S, { until: 'unit' });
      await nTap(page, nt(lang, 'n.app.report.collation.continue-choose-the-race'));
      await sleep(2000);
      await nTap(page, /^(Senate|Majalisar Dattawa)$/);
      await sleep(1500);
      const lines = (await vis(page)).split('\n').map((x) => x.trim());
      o.seatsOffered = lines.filter((l) => /\(2027\)\s*$/.test(l));
      o.unitSeat = UNIT.senatorial;
      o.unitSeatListed = lines.some((l) => l.includes(UNIT.senatorial)); // listed, not marked: every row looks the same
      await R.step(page, 'Senate — which seats are offered', 'tap Senate', 1, o);
    });
  }
  if (!native) {
    // DOUBLE TAP on Sign & submit
    await one('double-tap', {}, async ({ page }, R, S, o) => {
      await walk(page, R, S, { until: 'counts' });
      await page.locator('#btn-submit').scrollIntoViewIfNeeded().catch(() => {});
      const b = await page.locator('#btn-submit').boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      await sleep(60);
      await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
      Object.assign(o, await webAfterSubmit(page));
      await sleep(2500);
      o.submissionPosts = S.posts.filter((p) => p.p === '/api/submissions').length;
      await R.step(page, 'double tap — outcome', 'Sign & submit ×2 (60 ms apart)', 2, { posts: o.submissionPosts, arrived: o.arrived });
    });
    // SERVER 500 → kept and retried?
    await one('fail-500', { submit: '500' }, async ({ page }, R, S, o) => {
      await walk(page, R, S, {});
      o.first = { arrived: (await wVisible(page, '#screen-result')), summary: (await page.locator('#result-summary').innerText().catch(() => '')).trim().slice(0, 300), status: (await page.locator('#submit-status').innerText().catch(() => '')).trim() };
      o.outboxAfter = await outboxCount(page, surface);
      await R.step(page, 'after a 500 — what the observer is told', '—', 0, o.first);
      o.top = await webResultTop(page, R, 'after a 500 — top of the screen');
      S.submit = 'ok';
      Object.assign(o, { drain: await drainWeb(page) });
      o.sentLater = S.posts.filter((p) => p.p === '/api/submissions').length;
      await R.step(page, 'server back — queue drained?', '— (no tap)', 0, { drain: o.drain, posts: o.sentLater, anyNotice: (await vis(page)).split('\n').filter((l) => /sent|delivered|on the ledger|recorded/i.test(l)).slice(0, 3) });
    });
    // NETWORK FAILURE at submit
    await one('fail-net', { netFail: ['/api/submissions'] }, async ({ ctx, page }, R, S, o) => {
      await walk(page, R, S, {});
      o.first = { arrived: await wVisible(page, '#screen-result'), summary: (await page.locator('#result-summary').innerText().catch(() => '')).trim().slice(0, 300) };
      o.outboxAfter = await outboxCount(page, surface);
      await R.step(page, 'after a network failure — what the observer is told', '—', 0, o.first);
      o.top = await webResultTop(page, R, 'after a network failure — top of the screen');
      // reload while queued: the queue must survive
      await page.reload({ waitUntil: 'load' }); await sleep(3000);
      o.afterReload = { outbox: await outboxCount(page, surface), screen: (await vis(page)).split('\n').slice(0, 6) };
      S.netFail.clear();
      await goOnline(ctx, page, S);
      o.drain = await drainWeb(page);
      o.sentLater = S.posts.filter((p) => p.p === '/api/submissions' && !p.aborted).length;
      await R.step(page, 'network back — queue drained?', '— (no tap)', 0, { afterReload: o.afterReload, drain: o.drain, posts: o.sentLater });
    });
    // SESSION EXPIRED (401)
    await one('fail-401', { submit: '401' }, async ({ page }, R, S, o) => {
      await walk(page, R, S, {});
      o.lines = (await vis(page)).split('\n').filter(Boolean).slice(0, 14);
      o.outboxAfter = await outboxCount(page, surface);
      o.onResult = await wVisible(page, '#screen-result');
      o.onSignIn = await wVisible(page, '#screen-register');
      await R.step(page, 'after a 401 — what the observer is told', '—', 0, o);
      if (o.onResult) o.top = await webResultTop(page, R, 'after a 401 — top of the screen');
    });
    // A REFUSAL the observer can do nothing about by retrying (400 photo_location_mismatch), then a retry that works
    await one('fail-400', { submit: 'err:photo_location_mismatch:400' }, async ({ page }, R, S, o) => {
      await walk(page, R, S, {});
      o.status = (await page.locator('#submit-status').innerText().catch(() => '')).trim();
      o.enabled = await page.locator('#btn-submit').isEnabled().catch(() => false);
      o.countsKept = await page.locator('#vote-inputs input[data-party="APC"]').inputValue().catch(() => '');
      await R.step(page, 'after a 400 — message + is the work kept?', '—', 0, o);
      S.submit = 'ok';
      await page.click('#btn-submit').catch(() => {});
      o.retry = await webAfterSubmit(page);
      await R.step(page, 'retry without retyping', 'Sign & submit', 1, { arrived: o.retry.arrived });
    });
  }
  // RELOAD mid-flow (photos + unit + race + counts done, not sent)
  await one('reload', {}, async ({ page }, R, S, o) => {
    await walk(page, R, S, { until: 'counts' });
    await page.reload({ waitUntil: 'load' });
    await sleep(5000);
    // The apps OFFER the saved draft after a reload; an observer taps Continue.
    if (native) {
      o.offered = await nHas(page, nt(lang, 'n.app.practice.continue'));
      if (o.offered) { await nTap(page, nt(lang, 'n.app.practice.continue')).catch(() => {}); await sleep(2500); }
    } else {
      const go = page.getByRole('button', { name: wt(lang, 'observe.draft-continue') });
      o.offered = await go.isVisible().catch(() => false);
      if (o.offered) { await go.click().catch(() => {}); await sleep(2500); }
    }
    if (native) {
      o.after = (await vis(page)).split('\n').filter(Boolean).slice(0, 8);
      o.photosKept = !(await nHas(page, nt(lang, 'n.app.report.result.photo-1-of-2-the-result')));
    } else {
      o.photosKept = await page.evaluate(() => ['sheet', 'venue'].map((t) => document.getElementById(`status-${t}`)?.classList.contains('done')));
      o.unitKept = (await page.locator('#unit-fold-state').innerText().catch(() => '')).trim();
      o.countsKept = await page.locator('#vote-inputs input[data-party="APC"]').inputValue().catch(() => '');
    }
    await R.step(page, 'after reload — what is left', 'reload', 0, o);
  });
  // BACK mid-flow
  await one('back', {}, async ({ page }, R, S, o) => {
    await walk(page, R, S, { until: 'race' });
    if (native) {
      // the header ×
      const box = await page.evaluate(() => { const el = [...document.querySelectorAll('div')].find((d) => { const r = d.getBoundingClientRect(); return Math.abs(r.width - 36) < 2 && Math.abs(r.height - 36) < 2 && r.top < 60 && r.left < 120; }); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + 18, y: r.top + 18 }; });
      if (box) await page.mouse.click(box.x, box.y);
      await sleep(2000);
      o.confirmAsked = /discard|lose|leave|sure/i.test(await vis(page));
      o.after = (await vis(page)).split('\n').filter(Boolean).slice(0, 6);
      await R.step(page, 'header × mid-flow', 'tap ×', 1, o);
    } else {
      await page.goBack({ waitUntil: 'load' }).catch(() => {});
      await sleep(2500);
      o.urlAfterBack = page.url().replace(SITE, '');
      o.confirmAsked = errorsHaveDialog(R);
      await R.step(page, 'browser Back mid-flow', 'Back', 1, o);
      await page.goForward({ waitUntil: 'load' }).catch(() => {});
      await sleep(3000);
      // Coming back offers the saved draft (REP-RES-02's fix); take it, as an observer would.
      const go = page.getByRole('button', { name: wt(lang, 'observe.draft-continue') });
      o.draftOffered = await go.isVisible().catch(() => false);
      if (o.draftOffered) { await go.click().catch(() => {}); await sleep(2500); }
      o.forwardKeeps = await page.evaluate(() => ['sheet', 'venue'].map((t) => document.getElementById(`status-${t}`)?.classList.contains('done'))).catch(() => null);
      await R.step(page, 'Forward again — is the report still there?', 'Forward', 1, { photos: o.forwardKeeps });
    }
  });
}
const errorsHaveDialog = (R) => R.run.errors.some((e) => /^dialog:/.test(e));

// ================================================================ FLOW: check-in (roster member) + control
async function flowCheckin(surface, lang) {
  const native = surface === 'native';
  for (const rooms of ['member', 'none']) {
    const S = newState({ rooms });
    const c = await newCtx(surface, { lang, S });
    const { page } = c;
    const R = recorder('checkin', surface, lang, rooms);
    const o = { rooms };
    try {
      if (native) {
        // Arrival on native is the Report sheet (components/report-sheet.tsx), not the camera.
        await page.goto(NBASE + '/', { waitUntil: 'load' }).catch(() => {});
        await sleep(2000);
        await page.getByText(nt(lang, 'nav.report'), { exact: true }).last().click().catch(() => {});
        await sleep(1500);
        o.cardOnArrival = await nHas(page, nt(lang, 'observe.check-in-title'));
        await page.goto(NBASE + '/', { waitUntil: 'load' }).catch(() => {}); // sheet closed; the walk opens it again
        await sleep(1500);
        await nativeResultWalk(page, R, S, { lang, until: 'photos' });
        o.cardBeforeUnit = await nHas(page, nt(lang, 'n.app.report.result.check-in'));
        await waitFor(() => nHas(page, UNIT.name), 15000);
        await nTap(page, UNIT.name);
        await sleep(2500);
        o.cardAfterUnit = await nHas(page, nt(lang, 'n.app.report.result.check-in'));
        await R.step(page, 'unit chosen — check-in offered?', 'tap the unit', 1, { card: o.cardAfterUnit });
        if (o.cardAfterUnit) {
          await nTap(page, nt(lang, 'n.app.report.result.check-in'));
          await waitFor(() => nHas(page, nt(lang, 'n.app.report.result.checked-in-ok')), 12000);
          o.receipt = await nHas(page, nt(lang, 'n.app.report.result.checked-in-ok'));
          o.continueStillThere = await nHas(page, nt(lang, 'n.app.report.collation.continue-choose-the-race'));
          await R.step(page, 'checked in', "I'm at my unit", 1, { receipt: o.receipt, continueStillThere: o.continueStillThere });
        }
      } else {
        const taps = await wEnter(page, surface, 'observe');
        await page.waitForSelector('#screen-submit:not([hidden])', { timeout: 20000 }).catch(() => {});
        await sleep(3000);
        o.cardOnArrival = await wVisible(page, '#checkin-card');
        o.cardText = o.cardOnArrival ? (await page.locator('#checkin-card').innerText()).trim() : null;
        await R.step(page, 'report opened — check-in card?', 'entry', taps, { card: o.cardOnArrival });
        if (o.cardOnArrival) {
          await page.click('#btn-checkin');
          o.checkInMs = Date.now();
          await waitFor(() => page.locator('#checkin-host').innerText().then((t) => /Checked in|Recorded|could not|refused|went wrong/i.test(t)), 30000);
          o.checkInMs = Date.now() - o.checkInMs;
          o.receipt = (await page.locator('#checkin-host').innerText().catch(() => '')).trim();
          o.submitGated = false;
          await R.step(page, 'checked in on arrival', "I'm at my unit", 1, { receipt: o.receipt });
        }
        // the rest of the report does not depend on it: photos → unit
        await webResultWalk(page, R, S, { surface, lang, enter: false, until: 'unit' });
        o.cardAfterUnit = await wVisible(page, '#checkin-card');
        o.hostAfterUnit = (await page.locator('#checkin-host').innerText().catch(() => '')).trim();
      }
    } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
    R.run.errors.push(...c.errors);
    R.run.posts = S.posts.map((p) => `${p.m} ${p.p}`);
    R.run.result = o; R.run.done = true;
    ob(`checkin.${surface}.${lang}.${rooms}`, { ...o, posts: R.run.posts });
    await c.close();
  }
}

// ================================================================ FLOW: practice (order vs the real flow)
async function flowPractice(surface, lang) {
  const S = newState();
  const c = await newCtx(surface, { lang, S });
  const { page } = c;
  const R = recorder('practice', surface, lang);
  const o = {};
  try {
    if (surface === 'native') {
      await page.goto(`${await nativeBase()}/practice`, { waitUntil: 'load', timeout: 60000 });
      await sleep(4000);
      o.stepper = (await vis(page)).split('\n').map((x) => x.trim()).filter((x) => Object.values(NI18N[lang]).includes(x) && ['n.step.sheet', 'n.step.venue', 'n.step.unit', 'n.step.race', 'n.step.votes', 'n.step.send'].some((k) => nt(lang, k) === x));
      await R.step(page, 'practice — first screen', 'entry: /practice', 1, { stepper: o.stepper });
      // walk it the way tests/design-audit/flows.mjs does, recording each screen's heading
      const order = ['n.app.practice.use-a-sample', 'n.app.practice.yes-use-this-unit', 'n.app.practice.continue-without-a-unit',
        'n.app.practice.continue-to-the-figures', 'n.app.practice.review', 'n.app.practice.sign-submit-practice', 'n.app.practice.continue'].map((k) => nt(lang, k));
      const tried = [];
      o.screens = [];
      for (let i = 0; i < 16; i++) {
        const t = await vis(page);
        if (t.includes(nt(lang, 'n.app.practice.practice-complete'))) { o.done = true; await R.step(page, 'practice complete', '—', 0); break; }
        await page.evaluate(() => { // practice parties are "Party A/B/…": fill every empty count box
          let n = 0;
          for (const inp of document.querySelectorAll('input')) {
            if (!inp.getClientRects().length || inp.value || inp.inputMode !== 'numeric') continue;
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            set.call(inp, String(10 + n * 7)); inp.dispatchEvent(new Event('input', { bubbles: true })); n++;
          }
        }).catch(() => {});
        await sleep(300);
        let clicked = null;
        for (const label of order) {
          if (label !== order[0] && tried.includes(label)) continue;
          if (await nTap(page, label)) { clicked = label; tried.push(label); break; }
        }
        if (!clicked || clicked === order[3]) {
          if (!tried.includes('race') && await nHas(page, /\(2027\)\s*$/, false)) { await nTap(page, /\(2027\)\s*$/); tried.push('race'); clicked = 'race'; await sleep(800); await nTap(page, order[3]); }
          else if (!tried.includes('election')) { await nPickRace(page, lang, R); tried.push('election'); clicked = 'election'; }
        }
        o.screens.push(clicked);
        await R.step(page, `practice — after ${clicked || 'nothing'}`, clicked || '—', clicked ? 1 : 0);
        if (!clicked) break;
        await sleep(1300);
      }
    } else {
      await page.goto(`${SITE}/practice.html`, { waitUntil: 'load', timeout: 60000 });
      await sleep(3000);
      o.cards = await page.$$eval('#flow .card', (a) => a.filter((x) => x.offsetParent).map((x) => (x.querySelector('h2, strong') || x).innerText.trim().split('\n')[0]));
      o.unitPickerCount = await page.locator('#flow #btn-locate, #flow #pus-q, #flow #sel-state, #flow .pu-option').count();
      o.electionPickerCount = await page.locator('#flow #sel-contest, #flow select').count();
      o.verifyCount = await page.locator('#flow #btn-verify-counts').count();
      await R.step(page, 'practice — the whole form', 'entry: practice.html', 1, { cards: o.cards, unitPicker: o.unitPickerCount, electionPicker: o.electionPickerCount, verifyButton: o.verifyCount });
      await page.click('#btn-skip-sheet').catch(() => {});
      await page.click('#btn-skip-venue').catch(() => {});
      await sleep(800);
      const inputs = page.locator('#vote-inputs input');
      const n = await inputs.count();
      for (let i = 0; i < Math.min(n, 4); i++) await inputs.nth(i).fill(String(10 + i * 7)).catch(() => {});
      await R.step(page, 'practice — samples + counts', 'Use a sample ×2 + counts', 6);
      await page.click('#btn-submit').catch(() => {});
      o.done = await page.waitForSelector('#done:not([hidden])', { timeout: 20000 }).then(() => true).catch(() => false);
      await R.step(page, 'practice — done', 'Sign & submit (practice)', 1, { done: o.done });
    }
  } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
  R.run.errors.push(...c.errors);
  R.run.result = o; R.run.done = !!o.done;
  ob(`practice.${surface}.${lang}`, o);
  await c.close();
}

// ================================================================ FLOW: offline queue end to end
async function flowOffline(surface, lang) {
  // cold: used the app online before (near me / search), never browsed a ward → no state pack on the phone
  // warm: browsed their own ward online once → the state pack is in IndexedDB (web/Lite only; the
  //       native web export cannot hold packs — expo-file-system is not available on web)
  for (const variant of surface === 'native' ? ['cold'] : ['cold', 'warm']) await offlineRun(surface, lang, variant);
}
async function offlineRun(surface, lang, variant) {
  const native = surface === 'native';
  const S = newState();
  const c = await newCtx(surface, { lang, S });
  const { ctx, page } = c;
  const R = recorder('offline', surface, lang, variant === 'cold' ? '' : variant);
  const o = { variant };
  try {
    // An observer who opened the app online earlier (caches warm), now with no signal.
    if (native) {
      await page.goto(`${await nativeBase()}/`, { waitUntil: 'load', timeout: 60000 });
      await sleep(5000);
    } else {
      await page.goto(`${SITE}/observe.html?intent=observe`, { waitUntil: 'load', timeout: 60000 });
      await seedKeys(page);
      await sleep(5000);
      if (variant === 'warm') {
        // the only user path that puts a state pack on the phone: an earlier report
        // whose unit was found through Browse the register (step 2 unlocks after the photos)
        await webResultWalk(page, R, S, { surface, lang, enter: false, until: 'photos' });
        await page.evaluate(() => { const d = document.getElementById('browse-block'); if (d) d.open = true; }).catch(() => {});
        await waitFor(() => page.locator('#sel-state option').count().then((n) => n > 5), 15000);
        await page.selectOption('#sel-state', 'Lagos').catch(() => {});
        await waitFor(() => page.locator('#sel-lga option').count().then((n) => n > 2), 15000);
        await page.selectOption('#sel-lga', 'Mushin').catch(() => {});
        await waitFor(() => page.locator('#sel-ward option').count().then((n) => n > 2), 15000);
        await page.selectOption('#sel-ward', 'Ilupeju').catch(() => {});
        await waitFor(() => page.locator('#register-units .pu-option').count().then((n) => n > 0), 15000);
        await sleep(4000); // the background pack load lands in IndexedDB
        await R.step(page, 'online beforehand — browsed own ward once', 'state, LGA, ward (online)', 6, { rows: await page.locator('#register-units .pu-option').count() });
      }
    }
    await goOffline(ctx, page, S);
    // ---- a RESULT, offline
    if (native) {
      const r = await nativeResultWalk(page, R, S, { lang, unitBy: 'browse' });
      o.result = { arrived: r.arrived, queued: r.queued, text: (r.text || '').slice(0, 300), unit: r.unit, nearLine: r.nearLine, searchLine: r.searchLine, browseShowsUnit: r.browseShowsUnit };
    } else {
      await page.reload({ waitUntil: 'load' }); // "start offline": the page itself opened with no signal
      await sleep(4000);
      await R.step(page, 'opened offline', 'open the report flow offline', 0, { onLine: await page.evaluate(() => navigator.onLine) });
      const r = await webResultWalk(page, R, S, { surface, lang, enter: false, unitBy: 'browse' }).catch((e) => ({ err: e.message }));
      o.result = { arrived: r.arrived, summary: (r.summary || '').slice(0, 300), status: r.status, unit: r.unit, err: r.err, searchLine: r.searchLine, browseRows: r.browseRows, browseRowsRetry: r.browseRowsRetry, browseLine: r.browseLine };
      if (r.arrived) o.resultTop = await webResultTop(page, R, 'queued offline — top of the screen');
      if (!r.unit) {
        // near me cannot work offline: say what the unit step offered
        o.unitStep = (await vis(page)).split('\n').filter((l) => /Could not|search|browse|offline|connection/i.test(l)).slice(0, 6);
      }
    }
    o.outboxAfterResult = await outboxCount(page, surface);
    // ---- an INCIDENT, offline
    if (native) {
      const r = await nativeIncidentWalk(page, R, S, { lang, enter: true });
      o.incident = { arrived: r.arrived, queued: r.queued, text: (r.text || '').slice(0, 300) };
    } else {
      await page.goto(`${SITE}/incidents.html`, { waitUntil: 'load' });
      await sleep(4000);
      const r = await webIncidentWalk(page, R, S, { surface, lang, enter: false });
      o.incident = { modal: r.modal, title: r.title, msg: r.msg, status: r.status };
    }
    o.outboxAfterIncident = await outboxCount(page, surface);
    // ---- where can the observer SEE what is waiting?
    if (native) {
      await page.goto(`${await nativeBase()}/profile`, { waitUntil: 'load' }); await sleep(4000);
    } else {
      await page.goto(`${SITE}/profile.html`, { waitUntil: 'load' }); await sleep(4000);
    }
    o.profileMentionsQueue = (await vis(page)).split('\n').filter((l) => /queue|waiting|saved on|not sent|pending|offline/i.test(l)).slice(0, 4);
    await R.step(page, 'Profile while 2 reports wait', 'where is the queue shown?', 1, { lines: o.profileMentionsQueue, outbox: await outboxCount(page, surface) });
    // ---- reload while queued
    await page.reload({ waitUntil: 'load' }); await sleep(4000);
    o.outboxAfterReload = await outboxCount(page, surface);
    await R.step(page, 'reload while queued', 'reload', 0, { outbox: o.outboxAfterReload });
    // ---- back online
    const before = S.posts.filter((p) => !p.offline && !p.aborted).length;
    await goOnline(ctx, page, S);
    if (native) {
      await waitFor(async () => (await outboxCount(page, surface)) === 0, 30000, 1000);
    } else {
      o.drain = await drainWeb(page, 40000);
    }
    await sleep(2000);
    o.outboxAfterOnline = await outboxCount(page, surface);
    o.sentAfterOnline = S.posts.filter((p) => !p.offline && !p.aborted).slice(before).map((p) => p.p);
    o.noticeOnSend = (await vis(page)).split('\n').filter((l) => /sent|delivered|on the ledger|recorded|filed/i.test(l)).slice(0, 4);
    await R.step(page, 'back online — queue sent?', '— (no tap)', 0, { outbox: o.outboxAfterOnline, sent: o.sentAfterOnline, notice: o.noticeOnSend });
    // receipts afterwards: Profile lists what the server now has
    await page.reload({ waitUntil: 'load' }); await sleep(4000);
    o.profileAfter = (await vis(page)).split('\n').filter((l) => /Result Reports|Incident Reports|Rahoto/i.test(l)).slice(0, 4);
    await R.step(page, 'Profile after sending', 'where the sent reports show', 0, { lines: o.profileAfter });
  } catch (e) { R.run.errors.push(String(e.message || e).slice(0, 300)); }
  R.run.errors.push(...c.errors);
  R.run.posts = S.posts.map((p) => `${p.m} ${p.p}${p.offline ? ' (offline)' : ''}${p.aborted ? ' (net fail)' : ''}`);
  R.run.result = o; R.run.done = o.outboxAfterOnline === 0 && (o.sentAfterOnline || []).length > 0;
  ob(variant === 'cold' ? `offline.${surface}.${lang}` : `offlineWarm.${surface}.${lang}`, { ...o, posts: R.run.posts });
  await c.close();
}

// ================================================================ findings
/**
 * Every finding is a PREDICATE over what the run recorded, so a re-run after a fix
 * drops it (and a run that never reached the screen cannot report it). Evidence =
 * the screenshots of the steps that showed it; `source` = where the behaviour comes
 * from, read in the code before the finding was written.
 */
function computeFindings(runs, obs) {
  const OUTREL = 'tests/e2e/out/flows/reporting/';
  const run = (flow, surface, lang, variant = '') => runs.find((r) => r.flow === flow && r.surface === surface && r.lang === lang && (r.variant || '') === variant);
  const shot = (flow, surface, lang, variant, re) => {
    const r = run(flow, surface, lang, variant);
    const s = r && r.steps.find((x) => re.test(x.screen));
    return s ? OUTREL + s.shot : null;
  };
  const O = (k) => obs[k];
  const out = [];
  const add = (f) => {
    const ev = (f.evidence || []).filter(Boolean);
    if (!f.surfaces.length) return;
    out.push({ id: f.id, flow: f.flow, surfaces: f.surfaces, severity: f.severity, title: f.title, actual: f.actual, expected: f.expected, evidence: ev, source: f.source, fix: f.fix, needsDevice: !!f.needsDevice });
  };
  const S3 = ['web', 'lite', 'native'];
  const WL = ['web', 'lite'];
  const which = (list, pred) => list.filter((s) => { try { return !!pred(s); } catch { return false; } });
  const langOk = !obs._controls || !obs._controls.language || obs._controls.language.ok;
  if (!langOk) log('LANGUAGE CONTROL FAILED — language findings withheld', JSON.stringify(obs._controls.language));
  for (const f of FINDINGS) {
    if (/^REP-LANG-/.test(f.id) && !langOk) continue;
    const surfaces = which(f.surfacesFrom || S3, (s) => f.when(s, O, run, runs));
    if (!surfaces.length) continue;
    add({ ...f, surfaces, actual: typeof f.actual === 'function' ? f.actual(surfaces, O, runs) : f.actual, evidence: [...new Set(surfaces.flatMap((s) => f.evidence(s, shot, runs)))] });
  }
  return out;
}
const FINDINGS = [];
const L = (s) => (s === 'native' ? 'native' : s);
// ---- flow 1: choose / change my polling unit
FINDINGS.push({
  id: 'REP-UNIT-01', flow: 'unit', severity: 'P2',
  title: 'Searching the street name does not find "17, Oziegbe St." — prefix matches hide every "NN, Street" unit',
  when: (s, O) => O(`unit.${s}.en`) && O(`unit.${s}.en`).streetOnly && O(`unit.${s}.en`).streetOnly.findsUnit === false,
  actual: 'Typing "Oziegbe" answers "1 match." (Oziegbe/Akinbola Junction). The unit the observer is standing at, "17, Oziegbe St." (24-16-05-007), is not listed; "Oziegbe St" finds it. The count line reads as complete, so the observer concludes their unit is missing.',
  expected: 'A street-name search lists every unit on that street; house-number-first names ("17, …", the usual Lagos form) are found by their street.',
  evidence: (s, shot) => [shot('unit', s, 'en', '', /street name/), shot('unit', s, 'en', '', /Oziegbe St"/)],
  source: 'backend/src/routes/pollingUnits.js:269-274 (prefix tier only; contains-match runs only when the prefix finds nothing) — mirrored by the offline packs (app/register-store.js search, native/src/lib/register.ts packSearch)',
  fix: 'When the prefix tier returns fewer than `limit` rows, append the contains (word-start) matches after them instead of dropping them.',
});
FINDINGS.push({
  id: 'REP-UNIT-02', flow: 'unit', severity: 'P2',
  title: 'Offline, unit search always fails — yet every near-me failure line says "search by name"',
  when: (s, O) => O(`unitEdges.${s}`) && /Could not search/.test(O(`unitEdges.${s}`).offlineSearch || ''),
  actual: (ss, O) => `With no signal, typing a name answers "${(O(`unitEdges.${ss[0]}`) || {}).offlineSearch}". The search only consults an offline state pack when it is told the state, and no caller ever tells it, so every search goes to the server. Near me cannot work offline either, and its failure line sends the observer to that same search ("Could not check nearby units — search by name above.").`,
  expected: 'Search answers from the state pack offline (the stated design of the 2027 packs, docs/PU-SEARCH-2027.md), or the offline line points to Browse the register.',
  evidence: (s, shot) => [shot('unit', s, 'en', 'edges', /offline — search/), shot('unit', s, 'en', 'edges', /lookup fails/)],
  source: 'app/pu-search.js:65-71 (rememberState() is defined but never called, so stateName is always "") + app/app.js:1926, app/choose-unit.html:664 (mount without `state`); native/src/components/unit-search.tsx:104 (localSearch needs opts.state) + native/src/components/choose-unit.tsx:948, report/result.tsx:1995 (no `state` passed)',
  fix: 'Remember the state of the saved / last chosen unit (call rememberState; pass state to UnitSearch) so the pack answers offline; until then make the offline line say "Browse the register below".',
});
FINDINGS.push({
  id: 'REP-UNIT-03', flow: 'unit', severity: 'P2', surfacesFrom: ['web', 'lite'],
  title: 'Map a Polling Unit: "Save as my polling unit" with no signal sticks on "Saving…" forever',
  when: (s, O) => O(`mapUnit.${s}.en`) && /Saving/.test(O(`mapUnit.${s}.en`).offlineLine || ''),
  actual: 'The status line says "Saving…" and never changes; the fetch rejection is unhandled ("Failed to fetch" in the console). No error, no retry hint. (choose-unit.html and native say "Please check your connection and try again".)',
  expected: 'A failed save says it failed and how to retry, like the chooser does.',
  evidence: (s, shot) => [shot('unit', s, 'en', 'map', /Save offline/)],
  source: 'app/map-unit.html:200 (api() has no catch) and :539-546 (btn-save-unit awaits it with no try/catch)',
  fix: 'Wrap the save in try/catch and print map-unit.could-not-save-try-again on a network failure.',
});
// ---- language (every flow walked in ha)
const haLeaks = (runs, s, re) => runs.filter((r) => r.surface === s && r.lang === 'ha').flatMap((r) => r.steps.flatMap((x) => (x.englishLeaks || []).filter((l) => englishLeaks(l, s).length && (!re || re.test(l))).map((l) => ({ l, shot: x.shot, flow: r.flow }))));
const leakShots = (runs, s, re) => [...new Set(haLeaks(runs, s, re).map((x) => 'tests/e2e/out/flows/reporting/' + x.shot))].slice(0, 4);
const LANG01 = /part(y|ies) entered|^Status: |reports match|^Choose which election|^📖 Reading the numbers|^— select (state|LGA|ward) —$/;
FINDINGS.push({
  id: 'REP-LANG-01', flow: 'result', severity: 'P3', surfacesFrom: ['web', 'lite'],
  title: 'Hausa result/collation flow: step receipts, the result summary and the register placeholders are hardcoded English',
  when: (s, O, run, runs) => haLeaks(runs, s, LANG01).length > 0,
  actual: (ss, O, runs) => `In ha (seen on screen): ${[...new Set(haLeaks(runs, ss[0], LANG01).map((x) => `"${x.l}"`))].slice(0, 6).join(', ')}.`,
  expected: 'Keyed strings (T()) like the rest of observe.html / collation.html.',
  evidence: (s, shot, runs) => leakShots(runs, s, LANG01),
  source: 'app/app.js:3445 (`✔ ${n} part${n === 1 ? "y" : "ies"} entered`), :3316-3322 (Status/Confidence summary), :499 (updateScopeNotice), :2723 (ocrHint), :2030/:2037 (fillSelect placeholders); app/collation.html sel-state placeholder',
  fix: 'Route each through T() with {n}/{v0} placeholders (T() takes params since the check-in work).',
});
const LANG02 = /^(Form|Venue|Scope|Race|Votes|Send|None Saved|Result sheet)$|^Fit the (EC8A|whole form)|top (right )?of the (EC8A|collation form)|approved incident (here|at this unit)/;
FINDINGS.push({
  id: 'REP-LANG-02', flow: 'collation', severity: 'P3', surfacesFrom: ['native'],
  title: 'Native Hausa: English literals in the report screens — collation stepper, camera hint, serial-number hint, review labels, "None Saved"',
  when: (s, O, run, runs) => haLeaks(runs, s, LANG02).length > 0,
  actual: (ss, O, runs) => `In ha (seen on screen): ${[...new Set(haLeaks(runs, 'native', LANG02).map((x) => `"${x.l}"`))].slice(0, 16).join(', ')}. The result stepper beside the collation one is translated; the serial hint is a Hausa sentence with an English location spliced in.`,
  expected: 'Keyed strings (n.step.*, profile.none-saved, a keyed location for SerialField).',
  evidence: (s, shot, runs) => leakShots(runs, 'native', LANG02),
  source: 'native/src/app/report/collation.tsx:52-59 + :503 ({s.label} raw) ; result.tsx:1710 & collation.tsx:407 (frame hints) ; components/serial-field.tsx:43 + collation.tsx:666 (`where` English default) ; result.tsx:2373 (\'Result sheet\' : \'Venue\') ; profile.tsx:787 (\'None Saved\') ; map-unit.tsx:1307-1310',
  fix: 'Replace each literal with i18nT keys (most already exist on the web side).',
});
FINDINGS.push({
  id: 'REP-LANG-03', flow: 'incident', severity: 'P2', surfacesFrom: ['web', 'lite'],
  title: 'Hausa incident form: "what happened" options can come up in English and never switch',
  when: (s, O, run, runs) => haLeaks(runs, s, /^(Choose an incident type…|Violence|Ballot snatching|Vote-buying|Voter intimidation|BVAS failure|Late materials|Obstruction of observers)$/).length > 0,
  actual: 'With Hausa chosen (page heading "Kai Rahoton Lamari"), the Type of Incident list read "Choose an incident type… / Violence / Ballot snatching / Vote-buying / …" — the one question the report cannot be filed without. A second run of the page showed it Hausa on web and English on Lite: the options are written once, when /api/incidents/kinds answers, in whatever language has loaded by then, and nothing repaints them on hawkeye-lang.',
  expected: 'Options repainted on hawkeye-lang (or built after i18nReady), as the rest of the page is.',
  evidence: (s, shot, runs) => leakShots(runs, s, /^(Choose an incident type…|Violence|Ballot snatching)$/),
  source: 'app/incidents.html:1121-1129 (kinds fetched → innerHTML built once from kindLabels()) — the "frozen at import" class (memory: hawkeye-i18n-frozen-at-import); no hawkeye-lang listener for #kind',
  fix: 'Build the options in a paintKinds() run on load, after i18nReady and on every hawkeye-lang, keeping the selected value.',
});
FINDINGS.push({
  id: 'REP-LANG-04', flow: 'result', severity: 'P3',
  title: 'Hausa: the election/race names in the race step are English on every surface',
  when: (s, O, run, runs) => haLeaks(runs, s, /^(Presidential|Senate|House of Representatives|Governorship|State House of Assembly)$/).length > 0,
  actual: 'Step 3 / the race picker lists "Presidential, Senate, House of Representatives, Governorship, State House of Assembly" in English inside a Hausa screen (web: the <select> options come from /api/contests names; native: ELECTION_TYPES labels).',
  expected: 'Race names keyed like the rest of the UI (the web already has race.* keys for the unconfigured fallbacks).',
  evidence: (s, shot, runs) => leakShots(runs, s, /^(Presidential|Senate|House of Representatives)$/),
  source: 'app/menu.js:2302-2312 (configured contests use c.name from the server; only the disabled fallbacks use race.* keys) ; native/src/lib/races.ts:128-134 (ELECTION_TYPES label/seatLabel English)',
  fix: 'Label options by code through race.* keys on web and i18n keys for ELECTION_TYPES on native; keep the server name as the fallback.',
});
// ---- flow 4: incident
FINDINGS.push({
  id: 'REP-INC-01', flow: 'incident', severity: 'P2',
  title: 'An expired session loses the incident report (results in the same situation are kept and sent after sign-in)',
  when: (s, O) => { const v = O(`incidentFail.${s}.401`); if (!v) return false; return s === 'native' ? /invalid_token|Submission failed/.test(v.text || '') && !v.queued : (!v.modal && /Session expired/.test(v.status || '')); },
  actual: (ss) => `${ss.some((s) => s !== 'native') ? 'Web/Lite: the form is hidden and the line says "Session expired — register your device again →", a link to observe.html — following it leaves the page, so the description and the attached photo are gone; nothing is queued. ' : ''}${ss.includes('native') ? 'Native: "Submission failed — try again. (invalid_token)" — tapping again can never work, nothing points to sign-in, and nothing is queued.' : ''} A result report hit by the same 401 is parked in the outbox and sent after sign-in.`,
  expected: 'Same as results: keep the incident (outbox holds 401s until sign-in) and say "Sign in again — your report is saved and will send".',
  evidence: (s, shot) => [shot('incident', s, 'en', 'fail-401', /submit/)],
  source: 'app/incidents.html:1047-1053 (401 → hide form, link away; no HawkeyeOutbox.queue) ; native/src/app/report/incident.tsx:1162-1173 (non-2xx → line only; queueJob only when fetch threw)',
  fix: 'On 401 queue the incident like a network failure (outbox.js already defers 401s) and show the sign-in prompt with "your report is saved".',
});
FINDINGS.push({
  id: 'REP-INC-02', flow: 'incident', severity: 'P3',
  title: 'A server error (500) on an incident is not queued — unlike a result — and the message shows a raw code',
  when: (s, O) => { const v = O(`incidentFail.${s}.500`); return !!(v && !v.modal && !v.arrived && !v.queued && v.retry && (v.retry.modal || v.retry.arrived)); },
  actual: '500 → "❌ Could not submit (internal_error) — try again." (web/Lite) / "Submission failed — try again. (internal_error)" (native). The form is kept and a second tap works, so nothing is lost — but the observer must stay and retry, where a result in the same state is saved and sent automatically ("Hawkeye is busy right now — your signed report is saved on this phone").',
  expected: 'One rule for retryable server answers across report types: queue it (outbox.js / outbox.ts already accept incidents) and say it will send by itself.',
  evidence: (s, shot) => [shot('incident', s, 'en', 'fail-500', /submit/), shot('incident', s, 'en', 'fail-500', /retry/)],
  source: 'app/incidents.html:1054-1058 (non-201 → status line) vs app/app.js:3270-3273 (result: 5xx/408/425/429 → park); native incident.tsx:1162-1173 vs lib/submit.ts retryableStatus → park',
  fix: 'Treat 5xx/408/429 on /api/incidents like a network failure: queue it and show the "Saved on your phone" ending.',
});
FINDINGS.push({
  id: 'REP-INC-03', flow: 'incident', severity: 'P3',
  title: 'Incident draft (kind, description, photo) is lost on reload',
  when: (s, O) => { const v = O(`incidentReload.${s}`); return !!(v && v.descriptionKept === false); },
  actual: 'Kind, description and an attached photo, then a reload: the form is empty.',
  expected: 'A typed description survives a reload (sessionStorage is enough for text).',
  evidence: (s, shot) => [shot('incident', s, 'en', 'reload', /after reload/)],
  source: 'app/incidents.html (no draft persistence); native/src/app/report/incident.tsx:423-436 (useState only)',
  fix: 'Persist kind + description as a draft; restore on open.',
});
// ---- flow 6: offline queue
FINDINGS.push({
  id: 'REP-OFF-01', flow: 'offline', severity: 'P2', surfacesFrom: ['web', 'lite'],
  title: 'Once the receipt screen is left, queued reports are invisible — and nothing says when they finally send',
  when: (s, O) => { const o = O(`offlineWarm.${s}.en`) || O(`offline.${s}.en`); return !!(o && o.outboxAfterIncident > 0 && (!o.profileMentionsQueue || !o.profileMentionsQueue.length) && o.outboxAfterOnline === 0 && (!o.noticeOnSend || !o.noticeOnSend.length)); },
  actual: (ss, O) => { const o = O(`offlineWarm.${ss[0]}.en`) || O(`offline.${ss[0]}.en`) || {}; return `With ${o.outboxAfterIncident} report(s) waiting in the outbox, Profile (and every other screen) shows nothing pending — Result/Incident Reports list only what the server has. A reload keeps the queue (${o.outboxAfterReload}). Back online the outbox drains by itself (${(o.sentAfterOnline || []).join(', ')}) with no toast, badge or line on screen; the only later signal is the server's own notification once a report lands.`; },
  expected: 'A visible "Waiting to send (N)" row (Profile / report tab) while the outbox is non-empty, and a short "Your saved report was sent" when it drains.',
  evidence: (s, shot) => [shot('offline', s, 'en', 'warm', /Profile while/) || shot('offline', s, 'en', '', /Profile while/), shot('offline', s, 'en', 'warm', /back online/) || shot('offline', s, 'en', '', /back online/)],
  source: 'app/outbox.js:266-269 dispatches hawkeye-outbox-sent / -dropped and nothing listens (app.js:889 only counts it for the signed-out pane); native/src/lib/outbox.ts useOutbox() is read only by components/signed-out-elsewhere.tsx',
  fix: 'Render the outbox count on Profile (and the report tab) from HawkeyeOutbox.count()/useOutbox(), and toast on hawkeye-outbox-sent.',
});
FINDINGS.push({
  id: 'REP-OFF-02', flow: 'offline', severity: 'P1', surfacesFrom: ['web', 'lite'],
  title: 'Offline, a result report cannot get past "Which polling unit?" — near me, search and browse all come up empty',
  when: (s, O) => { const o = O(`offline.${s}.en`); return !!(o && o.result && !o.result.unit && /Could not search/i.test(o.result.searchLine || '') && o.result.browseRows === 0 && !o.result.browseRowsRetry); },
  actual: (ss, O) => { const o = O(`offline.${ss[0]}.en`) || {}; return `An observer who used the app online earlier (near me / search) and has no signal at the unit: both photos are taken, then step 2 — near me: "Could not check nearby units. Search by name below."; search: "${o.result && o.result.searchLine}"; Browse the register: State, LGA and ward fill from the offline index, but the ward lists ${o.result ? o.result.browseRows : 0} units, with no message, and again ${o.result && o.result.browseRowsRetry != null ? o.result.browseRowsRetry : 0} on a second pick. The state's unit pack is only ever fetched in the background by an online browse, so it is not on the phone. Steps 3-5 stay locked; the signed report can never reach the outbox that exists for exactly this. The saved "My polling unit" is not offered either.${(() => { const w = O(`offlineWarm.${ss[0]}.en`); return w && w.result ? ` Even with the pack on the phone (ward browsed online beforehand) the first offline ward pick listed ${w.result.browseRows} units and only a second pick listed ${w.result.browseRowsRetry ?? w.result.browseRows}.` : ''; })()}`; },
  expected: 'The observer can always name their unit offline: the saved unit offered in step 2, the state pack of the saved / last-used unit fetched ahead of time (it is ~32 KB), and an empty offline ward says why.',
  evidence: (s, shot) => [shot('offline', s, 'en', '', /search \(offline\)/), shot('offline', s, 'en', '', /browse the register/), shot('offline', s, 'en', '', /ward picked again/)],
  source: 'app/app.js:1990-2008 registerFromPacks(): /units with no pack in memory → loadState() fire-and-forget, return null → apiTry fails offline → empty list (2039-2051 sel-ward handler, no error branch); app/register-store.js:688-710 (packs come only from IndexedDB or the network); app/app.js:1878-1882 + pu-search.js:182-193 (the two failure lines)',
  fix: 'Prefetch the state pack of the saved unit (and of each unit chosen) while online; offer the saved unit in step 2; show "Unit list not on this phone yet" in an empty offline ward.',
});
// native seat question
FINDINGS.push({
  id: 'REP-RES-06', flow: 'result', severity: 'P2', surfacesFrom: ['native'],
  title: 'Native race step asks the observer to pick their senatorial district / constituency, which the unit already decides',
  when: (s, O) => { const v = O('resultVariant.native.race-seat'); return !!(v && v.seatsOffered && v.seatsOffered.length > 1); },
  actual: (ss, O) => { const v = O('resultVariant.native.race-seat') || {}; return `At 24-16-05-007 (Lagos West senatorial district) tapping Senate lists ${v.seatsOffered.length} seats (${(v.seatsOffered || []).slice(0, 4).join(', ')}…) to choose from. Only the contest code is sent — the server derives the seat from the unit (scope.js) — so the answer is ignored, yet a wrong tap reads as a wrong report to the observer. Web/Lite ask only "Senate".`; },
  expected: 'Senate / House pre-resolved to the unit\'s own seat (or not asked), as web does.',
  evidence: (s, shot) => [shot('result', 'native', 'en', 'race-seat', /Senate/)],
  source: 'native/src/components/contest-picker.tsx:139 (listRaces(t.code, lockedState) — every seat in the unit\'s STATE, none marked); native/src/app/report/result.tsx:1621 (only contest.code is submitted); backend/src/services/scope.js derives the seat from the unit',
  fix: 'Filter the seat list by the chosen unit (senatorial / federal_constituency are on the register row) and auto-confirm the single match.',
});
// ---- flow 5: collation
FINDINGS.push({
  id: 'REP-COL-01', flow: 'collation', severity: 'P1', surfacesFrom: ['web', 'lite'],
  title: 'Collation: "Sign & submit collation report" stays disabled after "Verify totals" — the report cannot be sent',
  when: (s, O) => { const c = O(`collation.${s}.en`); return !!(c && c.submitEnabledAfterVerify === false && c.submitEnabledAfterOtherChange === true); },
  actual: 'Both photos, ward/LGA/state, Presidential and four party totals done; "Verify totals" folds step 4 ("✔ 4 parties entered") and the submit card names the scope — but the button stays grey, also after waiting. It lights up only when some unrelated control re-runs the page\'s updateSubmit() (the harness re-fired the ward <select>\'s change event), which an observer has no reason to do.',
  expected: 'Verify totals enables Sign & submit, as "Verify counts" does on observe.html (app.js calls updateSubmitState() there).',
  evidence: (s, shot) => [shot('collation', s, 'en', '', /Verify totals$/), shot('collation', s, 'en', '', /still disabled/)],
  source: 'app/collation.html:399-406 (btn-verify-counts → setStepDone(3) only) vs :497-517 updateSubmit() (the only writer of btn-submit.disabled, needs stepDone[3]); app/app.js:3429-3449 calls updateSubmitState() after the same step',
  fix: 'Call updateSubmit() at the end of the Verify totals handler (and after setStepDone generally).',
});
FINDINGS.push({
  id: 'REP-COL-02', flow: 'collation', severity: 'P3', surfacesFrom: ['native'],
  title: 'Native collation review shows a raw translation key: "n.level.ward collation · EC8B"',
  when: (s, O, run, runs) => runs.some((r) => r.flow === 'collation' && r.surface === s && r.steps.some((x) => /n\.level\.(ward|lga|state)/.test(x.text || ''))),
  actual: 'The Confirm and Send screen (and the done screen) prints the level as its i18n key followed by English: "n.level.ward collation · EC8B", in every language.',
  expected: '"Ward collation · EC8B", translated (n.level.ward + a keyed "collation").',
  evidence: (s, shot) => [shot('collation', s, 'en', '', /submit/), shot('collation', s, 'en', '', /review/)],
  source: 'native/src/app/report/collation.tsx:732 and :922 (`{levelDef?.label} collation` — label is a key, never passed through i18nT)',
  fix: 'Render i18nT(levelDef.label) inside a keyed "{level} collation" string.',
});
// ---- flow 3: practice ≠ the real flow
FINDINGS.push({
  id: 'REP-PRAC-01', flow: 'practice', severity: 'P2', surfacesFrom: ['web', 'lite'],
  title: 'The web/Lite practice run rehearses a different flow: no unit step, no election step, no "Verify counts"',
  when: (s, O) => { const p = O(`practice.${s}.en`); return p && p.cards && p.unitPickerCount === 0 && p.electionPickerCount === 0; },
  actual: (ss, O) => `practice.html is: a fixed "Practice Polling Unit" card → 1 Capture the Evidence → 2 Enter the Announced Counts → 3 Sign & Submit. The real result form (observe.html) is 1 Capture → 2 Which polling unit? (near me / search / browse) → 3 Which election? → 4 Counts + Verify counts → 5 Sign and Submit (+ the check-in card for roster members). The two steps observers stumble on — finding the unit and choosing the race — are never rehearsed. Native practice uses the same six steps as native result (sheet, venue, unit, race, votes, send).`,
  expected: 'Practice walks the same five step cards in the same order as observe.html (as native practice mirrors native result), with only the race list opened and the submit answered locally.',
  evidence: (s, shot) => [shot('practice', s, 'en', '', /whole form/), shot('result', s, 'en', '', /report screen/)],
  source: 'app/practice.html:106-142 (three cards) vs app/observe.html:467-596 (check-in host + five step cards); native/src/app/practice.tsx:213-220 STEPS = report/result.tsx:287-294 STEPS',
  fix: 'Rebuild practice.html on the observe.html step cards (unit picker + race picker + Verify counts), keeping "Use a sample" and the local submit.',
});
// ---- flow 7: check-in
FINDINGS.push({
  id: 'REP-CHK-01', flow: 'checkin', severity: 'P2',
  title: 'Check-in is offered at a different point on each surface: before the photos on web/Lite, only after choosing the unit on native',
  when: (s, O) => { const w = O('checkin.web.en.member'); const n = O('checkin.native.en.member'); return !!(w && n && w.cardOnArrival && !n.cardOnArrival && !n.cardBeforeUnit && n.cardAfterUnit) && (s === 'native' || !!(O(`checkin.${s}.en.member`) || {}).cardOnArrival); },
  actual: 'Web/Lite: a roster member opening Report sees "Tell your coordinator you are here / I\'m at my unit" at the top, above step 1, checking them in at their ASSIGNED unit before any photo. Native: no card on the camera steps; it appears only on the unit step, after a unit is tapped, beside "Continue — choose the race", and checks in at the CHOSEN unit. Neither gates the report.',
  expected: 'One order on every surface (the brief\'s lockstep rule): either both offer it on arrival or both at unit selection.',
  evidence: (s, shot) => (s === 'native' ? [shot('checkin', 'native', 'en', 'member', /check-in offered/), shot('checkin', 'native', 'en', 'member', /checked in/)] : [shot('checkin', s, 'en', 'member', /check-in card/), shot('checkin', s, 'en', 'member', /checked in on arrival/)]),
  source: 'app/app.js:2304-2331 enterReportFlow() → renderCheckIn() "CHECK IN ON ARRIVAL, before the photos" vs native/src/app/report/result.tsx:2111-2180 (card inside the unit step, "offered at the moment the unit is chosen")',
  fix: 'Pick one moment and port it to the other client (native already explains why unit-selection time knows the real unit).',
});
FINDINGS.push({
  id: 'REP-CHK-02', flow: 'checkin', severity: 'P1',
  title: 'Check-in card shown to an ordinary observer (no roster)',
  when: (s, O) => { const c = O(`checkin.${s}.en.none`); return !!(c && (c.cardOnArrival || c.cardAfterUnit)); },
  actual: 'The "let your coordinator know" card rendered for an observer whose /api/my/rooms is empty.',
  expected: 'Nothing for an observer on no roster (memory: hawkeye-checkin-gate — the control).',
  evidence: (s, shot) => [shot('checkin', s, 'en', 'none', /check-in/)],
  source: 'app/app.js:2381-2385 renderCheckIn / native result.tsx:2119',
  fix: 'Render only when rooms.length > 0.',
});
// ---- flow 2: report a result
FINDINGS.push({
  id: 'REP-RES-05', flow: 'result', severity: 'P1', surfacesFrom: ['web', 'lite'],
  title: 'A report that is only QUEUED on the phone is announced as "Report Recorded — on the public tamper-evident ledger now"',
  when: (s, O) => ['fail-500', 'fail-net', 'fail-401'].some((v) => { const r = O(`resultVariant.${s}.${v}`); return r && r.top && /ledger now|Report Recorded/i.test(r.top.headline) && r.outboxAfter > 0; })
    || !!(O(`offlineWarm.${s}.en`) && O(`offlineWarm.${s}.en`).resultTop && /ledger now|Report Recorded/i.test(O(`offlineWarm.${s}.en`).resultTop.headline)),
  actual: 'After a 500, a network failure, a 401 or an offline submit, the report is parked in the outbox — and the screen opens with the success headline "Report Recorded" and "Your report is on the public tamper-evident ledger now — it cannot be edited or withdrawn." Only further down does the summary say it is saved on the phone, and the card say "Not yet on the public ledger". "Ledger entry:" is printed empty.',
  expected: 'The queued ending has its own headline, as native does ("Saved on this phone", clock icon): not on the ledger yet, sends by itself, keep the app.',
  evidence: (s, shot) => [shot('result', s, 'en', 'fail-500', /500 — top/), shot('result', s, 'en', 'fail-net', /network failure — top/), shot('offline', s, 'en', 'warm', /queued offline — top/)],
  source: 'app/observe.html:602-605 (static "Report Recorded" confirm-panel) + app/app.js:3169-3195 park() (fills #result-summary and the card, never the headline) → show("screen-result")',
  fix: 'In park(), swap the confirm-panel to a "Saved on this phone — not on the ledger yet" headline (keys exist: receipt.title-pending) and hide the empty ledger-entry line.',
});
FINDINGS.push({
  id: 'REP-RES-01', flow: 'result', severity: 'P2',
  title: 'Back / × in the middle of a result report throws away both photos, the unit and the race — no "discard?" question',
  when: (s, O) => { const v = O(`resultVariant.${s}.back`); return v && v.confirmAsked === false && (s === 'native' || !(v.forwardKeeps || []).some(Boolean)); },
  actual: (ss) => `${ss.filter((s) => s !== 'native').length ? 'Web/Lite: one browser/Android Back leaves observe.html for the page before it, and Forward reopens an empty report (photos gone). ' : ''}${ss.includes('native') ? 'Native: the header × (and the crest) leave the report at once; reopening starts at the camera again.' : ''} Nothing asks first.`,
  expected: 'Once a photo is taken, leaving asks "Discard this report?" (or keeps a draft to resume).',
  evidence: (s, shot) => [shot('result', s, 'en', 'back', /Back mid-flow|× mid-flow/), shot('result', s, 'en', 'back', /Forward again/)],
  source: 'native/src/app/report/result.tsx:1791-1797 (× → router.back(), crest → navigate("/(tabs)"), no usePreventRemove/BackHandler); app/app.js (one page of screens, no beforeunload/popstate guard)',
  fix: 'Confirm before leaving once evidence exists (beforeunload + popstate on web/Lite, usePreventRemove + BackHandler on native).',
});
FINDINGS.push({
  id: 'REP-RES-02', flow: 'result', severity: 'P2',
  title: 'A reload / app restart mid-report loses the photos, the unit and every typed count',
  // Native is NOT judged here: its draft (lib/report-draft.ts) keeps the photo FILES,
  // which a react-native-web export cannot keep across a reload — needs a device.
  when: (s, O) => { const v = O(`resultVariant.${s}.reload`); if (!v || s === 'native') return false; return !(v.photosKept || []).some(Boolean) && !v.countsKept; },
  actual: 'After photos + unit + race + four party counts, a reload opens a brand-new report (web/Lite: step 1, both slots "Required", counts empty; native: back at the camera).',
  expected: 'The signed-later draft survives a reload or an OS kill (low-memory Android kills backgrounded WebViews/apps), or the user is warned it will not.',
  evidence: (s, shot) => [shot('result', s, 'en', 'reload', /after reload/)],
  source: 'app/app.js:2083-2116 resetReportState() + 2304 enterReportFlow() on every load (state only in memory); native/src/app/report/result.tsx:569-1594 (useState only)',
  fix: 'Persist the in-progress report (blobs in IndexedDB / document dir + fields) and offer "Continue your report" on open.',
  needsDevice: false,
});
FINDINGS.push({
  id: 'REP-RES-03', flow: 'result', severity: 'P2', surfacesFrom: ['web', 'lite'],
  title: 'Web/Lite race picker offers races that are not open (Governorship, State Assembly) as normal options; the refusal comes only after the whole report',
  when: (s, O) => { const r = O(`resultVariant.${s}.gate-closed`); return r && /not open/i.test(r.dialog || ''); },
  actual: 'On election day (PRES/SEN/REP open) step 3 lists Governorship and State House of Assembly — which open on 6 Feb — exactly like the open races. Choosing one folds step 3 at once, so the "Result reporting opens when polls open" note written under the picker is never seen; the observer types every count and is refused by a "Reporting is not open yet" modal at Sign & submit. Native marks them "Opens 6 Feb" in the picker and never lets them through.',
  expected: 'Closed races are marked (and disabled) in the picker, as native does, so the refusal comes before the work.',
  evidence: (s, shot) => [shot('result', s, 'en', 'gate-closed', /scope notice/), shot('result', s, 'en', 'gate-closed', /refused/), shot('result', 'native', 'en', '', /race picker$/)],
  source: 'app/menu.js:2286-2316 HAWKEYE_RACES.fill (any configured contest becomes an enabled option, open or not) + app/app.js:3422-3427 (change → updateScopeNotice, then setStepDone folds the card) + app/app.js:3027-3036 (refusal only at Sign & submit)',
  fix: 'In fill(), disable/suffix options whose contest has open === false (with "opens <date>"), like the native ContestPicker.',
});
FINDINGS.push({
  id: 'REP-RES-04', flow: 'result', severity: 'P3',
  title: 'No totals or consistency check on the counts — Verify passes with any one number',
  // Measured: the flow types a wrong sheet total and looks for the warning.
  when: (s, O) => { const r = O(`result.${s}.en`); return !!r && !(r.totalsCheck && r.totalsCheck.warned); },
  actual: '"Verify counts" (web) / "Review report" (native) only require one party count. There is no total-valid-votes / rejected / accredited field to add up against, so a slipped digit (2120 for 212) goes through unchallenged; the counts step lists all 22 parties in register order.',
  expected: 'The EC8A totals (valid votes, rejected, total cast) are asked and checked against the party sum before sign, or an obviously-off figure is flagged.',
  evidence: (s, shot) => [shot('result', s, 'en', '', /counts verified|votes entered/)],
  source: 'app/app.js:3429-3446 (verify = at least one count); native/src/app/report/result.tsx votes step (~2240-2330, Review enabled when votes.length > 0)',
  fix: 'Add the sheet totals fields and a sum check (warn, do not block) before Sign & submit.',
});

// ================================================================ main
const FLOW_FNS = { unit: flowUnit, result: flowResult, practice: flowPractice, incident: flowIncident, collation: flowCollation, offline: flowOffline, checkin: flowCheckin };
for (const flow of FLOWS) {
  const fn = FLOW_FNS[flow];
  if (!fn) { log('no such flow', flow); continue; }
  for (const surface of SURFACES) for (const lang of LANGS) {
    log(flow, surface, lang);
    await fn(surface, lang);
  }
}
await browser.close();
if (server) server.close();
// A partial run (--flow/--surface/--lang) replaces only its own slice of the record.
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { return d; } };
const keptRuns = readJson('steps.json', []).filter((r) => !(FLOWS.includes(r.flow) && SURFACES.includes(r.surface) && LANGS.includes(r.lang)));
const ALL_RUNS = [...keptRuns, ...RUNS].sort((a, b) => `${a.flow}|${a.surface}|${a.lang}|${a.variant}`.localeCompare(`${b.flow}|${b.surface}|${b.lang}|${b.variant}`));
const ALL_OBS = { ...readJson('observations.json', {}), ...OBS, _controls: { language: langControl(), stuckDetector: { web: (OBS['unitEdges.web'] || readJson('observations.json', {})['unitEdges.web'] || {}).controlHang } } };
fs.writeFileSync(path.join(OUT, 'steps.json'), JSON.stringify(ALL_RUNS, null, 1));
fs.writeFileSync(path.join(OUT, 'observations.json'), JSON.stringify(ALL_OBS, null, 1));
const FOUND = computeFindings(ALL_RUNS, ALL_OBS);
fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify(FOUND, null, 1));
log('findings', FOUND.map((f) => `${f.severity} ${f.id} ${f.surfaces.join('/')} — ${f.title}`).join('\n'));
log('safety', JSON.stringify({ passGet: SAFETY.passGet, fixtures: SAFETY.fixtures, blockedWrites: SAFETY.blockedWrites, sentry: SAFETY.sentry }));
for (const r of RUNS) log(`${r.flow}/${r.surface}/${r.lang}${r.variant ? '/' + r.variant : ''}: ${r.steps.length} steps, done=${r.done}${r.errors.length ? ' ERR ' + r.errors.join(' | ').slice(0, 300) : ''}`);
process.exit(0);


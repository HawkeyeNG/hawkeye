/**
 * FIRST-TIME OBSERVER WALKTHROUGH — the LIVE site, as someone who has never
 * seen Hawkeye, on a low-end Android and on an iPhone-size screen.
 *
 *   node tests/e2e/first_time_observer.mjs                  # both profiles, web + native
 *   node tests/e2e/first_time_observer.mjs --profile low    # one profile (low | iphone)
 *   node tests/e2e/first_time_observer.mjs --no-native      # skip the react-native-web pass
 *   node tests/e2e/first_time_observer.mjs --no-web         # native pass only
 *   node tests/e2e/first_time_observer.mjs --native-dir DIR # an `expo export --platform web` output
 *
 * Output: tests/e2e/out/first-time/<profile>/*.png, results.json and REPORT.md
 * (findings ranked by severity, every finding linked to its screenshot).
 *
 * READ-ONLY AGAINST PRODUCTION. This is the part that matters most, so it is
 * enforced twice, and both layers are logged in the report:
 *
 *  1. A CDP Fetch interceptor on every page (Fetch.enable with URL patterns, so
 *     the HTTP cache stays on — Playwright's own route() would disable it and
 *     distort every repeat-load timing). GET/HEAD pass. A write passes ONLY if
 *     it is a sign-in request (/api/observers/register or /wa-start) carrying a
 *     number the server refuses BY FORMAT before it looks anything up, writes
 *     anything or sends anything: a +888 Telegram number, or a string that is
 *     not a Nigerian mobile at all (same regexes as backend normalizePhone).
 *     POST /api/practice/submit is answered with a STUB (the practice chain is
 *     anchored to Rekor daily — a test row could never be purged), so the done
 *     screen and the receipt card are exercised without a row being written.
 *     Every other write is failed with BlockedByClient. Sentry ingest is blocked
 *     (test errors must not land in the owner's monitoring) and counted. APKs are
 *     never downloaded (HEAD only, from Node).
 *  2. An init script wraps fetch / XMLHttpRequest / sendBeacon in the page with
 *     the same rule, so a write the interceptor somehow missed still never leaves.
 *
 * No account is created, no code is sent to any real number, nothing is posted.
 *
 * The native pass serves a react-native-web export (`npx expo export --platform
 * web --output-dir tmp/e2e-native-web`) from 127.0.0.1 and runs Chromium with
 * --disable-web-security so its calls to https://hawkeye.com.ng are not killed
 * by CORS (see memory hawkeye-native-headless-capture). Signed-out screens only:
 * welcome, sign-up, practice. The same two guards apply.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const CHROME = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const SITE = 'https://hawkeye.com.ng';
const OUT = '/home/elrio/hawkeye/tests/e2e/out/first-time';
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const NATIVE_DIR = arg('native-dir', '/home/elrio/hawkeye/tmp/e2e-native-web');
const LANGS = ['en', 'ha', 'ig', 'yo'];
const STUB_HASH = 'e2e0'.repeat(16);
/* The native app's own strings, to find buttons by their label in each language. */
const NATIVE_I18N = Object.fromEntries(LANGS.map((l) => {
  try { return [l, JSON.parse(fs.readFileSync(`/home/elrio/hawkeye/native/src/lib/i18n/${l}.json`, 'utf8'))]; } catch { return [l, {}]; }
}));

/* Chrome DevTools "Slow 4G" (formerly "Fast 3G"): 150 ms x 3.75 RTT, 1.6 Mbps x 0.9
   down, 750 kbps x 0.9 up. The throughput control below measures it. */
const SLOW_4G = { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375, connectionType: 'cellular4g' };
const PROFILES = {
  low: {
    key: 'low', label: 'Low-end Android (360x740, 4x CPU, Slow 4G)',
    viewport: { width: 360, height: 740 }, dsf: 2, cpu: 4, net: SLOW_4G, keyboardFrac: 0.42,
    ua: 'Mozilla/5.0 (Linux; Android 11; TECNO KG5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  },
  iphone: {
    key: 'iphone', label: 'iPhone-size (390x844, iOS Safari UA, no throttle)',
    viewport: { width: 390, height: 844 }, dsf: 3, cpu: 1, net: null, keyboardFrac: 0.40,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  },
};
const which = arg('profile', 'all');
const RUN = which === 'all' ? ['low', 'iphone'] : [which];

// ---------------------------------------------------------------- safety rule
// Mirrors backend/src/routes/observers.js isAnonymousNumber + normalizePhone.
const isAnonymous = (raw) => /^\+?888/.test(String(raw || '').replace(/[\s\-()]/g, ''));
const normalizePhone = (raw) => {
  const p = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^0[789][01]\d{8}$/.test(p)) return '+234' + p.slice(1);
  if (/^\+234[789][01]\d{8}$/.test(p)) return p;
  return null;
};
const refusedByFormat = (phone) => isAnonymous(phone) || normalizePhone(phone) === null;
const SIGNIN_PATHS = ['/api/observers/register', '/api/observers/wa-start'];

const SAFETY = { allowedWrites: [], blocked: [], stubbed: [], sentry: 0, apkSkipped: [], popupsClosed: [], pageGuard: [] };

/** The in-page backstop: same rule, applied before anything leaves the page. */
const PAGE_GUARD = `(() => {
  const isAnon = (r) => /^\\+?888/.test(String(r || '').replace(/[\\s\\-()]/g, ''));
  const norm = (r) => { const p = String(r || '').replace(/[\\s\\-()]/g, '');
    return /^0[789][01]\\d{8}$/.test(p) || /^\\+234[789][01]\\d{8}$/.test(p); };
  const SIGNIN = ${JSON.stringify(SIGNIN_PATHS)};
  const verdict = (url, method, body) => {
    let u; try { u = new URL(url, location.href); } catch (e) { return 'ok'; }
    if (/sentry\\.io$/.test(u.hostname)) return 'block';
    const m = String(method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD') return 'ok';
    if (u.pathname === '/api/practice/submit') return 'ok';   // the CDP layer stubs it
    if (u.pathname === '/api/observers/resume') return 'ok';  // read-only for a device the server has never seen
    if (SIGNIN.includes(u.pathname)) {
      let phone = ''; try { phone = JSON.parse(body || '{}').phone; } catch (e) {}
      return (isAnon(phone) || !norm(phone)) ? 'ok' : 'block';
    }
    return 'block';
  };
  const hit = (s) => { try { window.__e2eGuardHit && window.__e2eGuardHit(s); } catch (e) {} };
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const body = init && typeof init.body === 'string' ? init.body : '';
    if (verdict(url, method, body) === 'block') {
      hit(method + ' ' + url);
      return Promise.reject(new TypeError('e2e guard: write blocked'));
    }
    return of.apply(this, arguments);
  };
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__e2e = [m, u]; return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const [m, u] = this.__e2e || ['GET', ''];
    if (verdict(u, m, typeof b === 'string' ? b : '') === 'block') { hit(m + ' ' + u); throw new Error('e2e guard: write blocked'); }
    return xs.apply(this, arguments);
  };
  if (navigator.sendBeacon) navigator.sendBeacon = function (u) { hit('BEACON ' + u); return false; };
})();`;

/** Timing probes, installed before any page script. */
const PERF_PROBE = `(() => {
  const s = window.__e2e = { lcp: 0, fcp: 0, cls: 0, longTasks: 0, longTaskMs: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') s.fcp = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) s.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { s.longTasks++; s.longTaskMs += e.duration; } }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
})();`;

// ------------------------------------------------------------- data we keep
const R = { startedAt: new Date().toISOString(), site: SITE, profiles: {}, findings: [], safety: SAFETY };
const finding = (sev, area, title, detail, shots = [], profile = '') => {
  R.findings.push({ sev, area, title, detail, shots, profile });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** page.evaluate has no timeout of its own; a wedged page must not wedge the run. */
const race = (p, ms, fallback, label) => { let t; return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), new Promise((r) => { t = setTimeout(() => { log(`    (timeout ${ms} ms: ${label})`); r(fallback); }, ms); })]); };
const perf = (page) => race(_perf(page), 20000, null, "perf");
const texts = (page) => race(_texts(page), 30000, [], "texts");
const layout = (page) => race(_layout(page), 30000, { error: "timeout" }, "layout");
const overlays = (page) => race(_overlays(page), 20000, [], "overlays");
setInterval(() => { for (const p of Object.values(R.profiles)) { const P = p.native || p.web; if (P) log(`  ... still at ${P.key}:${P.step}`); } }, 60000).unref();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// -------------------------------------------------------- page instrumentation
async function instrument(page, prof, P) {
  const cdp = await page.context().newCDPSession(page);
  const net = { bytes: 0, requests: 0, fromSW: 0, fromCache: 0 };
  P.net = net;
  await cdp.send('Network.enable');
  if (prof.net) await cdp.send('Network.emulateNetworkConditions', prof.net);
  if (prof.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
  cdp.on('Network.responseReceived', (e) => {
    net.requests++;
    if (e.response.fromServiceWorker) net.fromSW++;
    if (e.response.fromDiskCache) net.fromCache++;
  });
  cdp.on('Network.loadingFinished', (e) => { net.bytes += e.encodedDataLength || 0; });

  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*hawkeye.com.ng/api/*', requestStage: 'Request' },
      { urlPattern: '*sentry.io*', requestStage: 'Request' },
      { urlPattern: '*.apk*', requestStage: 'Request' },
    ],
  });
  cdp.on('Fetch.requestPaused', async (e) => {
    const { requestId, request } = e;
    const u = new URL(request.url);
    const m = request.method;
    try {
      if (/sentry\.io$/.test(u.hostname)) {
        SAFETY.sentry++;
        return await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
      if (/\.apk$/i.test(u.pathname)) {
        SAFETY.apkSkipped.push(request.url);
        return await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return await cdp.send('Fetch.continueRequest', { requestId });
      if (u.pathname === '/api/practice/submit') {
        SAFETY.stubbed.push({ at: P.step, url: request.url, body: request.postData || '' });
        const body = Buffer.from(JSON.stringify({ ok: true, entryHash: STUB_HASH, e2eStub: true })).toString('base64');
        return await cdp.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }],
          body,
        });
      }
      if (u.pathname === '/api/observers/resume') {
        // Every context here is brand new, so its device id is random and
        // unknown: services/sessions.js resumeSession() finds no row and returns
        // before any write. This is the call every first visit makes.
        SAFETY.resumes = (SAFETY.resumes || 0) + 1;
        return await cdp.send('Fetch.continueRequest', { requestId });
      }
      if (SIGNIN_PATHS.includes(u.pathname)) {
        let phone = '';
        try { phone = JSON.parse(request.postData || '{}').phone; } catch { /* not JSON */ }
        if (refusedByFormat(phone)) {
          SAFETY.allowedWrites.push({ at: P.step, path: u.pathname, phone, why: isAnonymous(phone) ? '+888 (refused by format)' : 'not a Nigerian mobile (refused by format)' });
          return await cdp.send('Fetch.continueRequest', { requestId });
        }
        SAFETY.blocked.push({ at: P.step, method: m, url: request.url, why: 'valid-format number: a real code could be sent' });
        return await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      }
      SAFETY.blocked.push({ at: P.step, method: m, url: request.url, why: 'write to production' });
      return await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch (err) {
      // Target closed mid-request; nothing to do.
    }
  });

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const harness = /ERR_BLOCKED_BY_CLIENT|e2e guard|React error #(418|419|423|425)/.test(text) || (P.expect4xx && /status of 4[0-9][0-9]/.test(text));
    P.console.push({ step: P.step, text: text.slice(0, 400), harness });
  });
  page.on('pageerror', (err) => P.pageErrors.push({ step: P.step, text: String(err && err.stack || err).slice(0, 600) }));
  page.on('response', (res) => {
    const s = res.status();
    if (s >= 400) P.httpErrors.push({ step: P.step, status: s, url: res.url().slice(0, 200), expected: P.expect4xx });
  });
  page.on('requestfailed', (req) => {
    const t = req.failure() && req.failure().errorText;
    if (/BLOCKED_BY_CLIENT|ERR_ABORTED/.test(t || '')) return;
    P.failedRequests.push({ step: P.step, url: req.url().slice(0, 200), error: t });
  });
  page.on('dialog', async (d) => { P.nativeDialogs.push({ step: P.step, type: d.type(), message: d.message() }); await d.dismiss().catch(() => {}); });
  return cdp;
}

// ------------------------------------------------------------- page helpers
async function shot(page, P, name, opts = {}) {
  const file = `${String(++P.shotNo).padStart(3, '0')}-${name}.png`;
  try {
    await page.screenshot({ path: path.join(P.dir, file), ...opts, timeout: 30000 });
  } catch (e) {
    return null;
  }
  P.shots.push(file);
  return `${P.key}/${file}`;
}

async function _perf(page) {
  return page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    const s = window.__e2e || {};
    return {
      ttfb: Math.round(n.responseStart || 0), dcl: Math.round(n.domContentLoadedEventEnd || 0),
      load: Math.round(n.loadEventEnd || 0), fcp: Math.round(s.fcp || 0), lcp: Math.round(s.lcp || 0),
      cls: Number((s.cls || 0).toFixed(3)), longTasks: s.longTasks || 0, longTaskMs: Math.round(s.longTaskMs || 0),
      transferNav: n.transferSize || 0,
    };
  }).catch(() => null);
}

function resetNet(P) { P.net.bytes = 0; P.net.requests = 0; P.net.fromSW = 0; P.net.fromCache = 0; }

async function load(page, P, url, label) {
  P.step = label;
  resetNet(P);
  const t0 = Date.now();
  let ok = true, err = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 150000 });
  } catch (e) { ok = false; err = String(e.message || e).split('\n')[0]; }
  const tLoad = Date.now() - t0;
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await sleep(800);
  const p = await perf(page);
  const t = { label, url, ok, err, wallLoadMs: tLoad, wallIdleMs: Date.now() - t0, ...p, bytes: P.net.bytes, requests: P.net.requests, fromSW: P.net.fromSW, fromCache: P.net.fromCache };
  P.timings.push(t);
  log(`  ${label}: ${ok ? 'loaded' : 'FAILED ' + err} in ${tLoad} ms, LCP ${p && p.lcp} ms, ${(P.net.bytes / 1024).toFixed(0)} KB`);
  return t;
}

/** Every rendered text node (and placeholder) with a structural key, for EN-vs-other comparison. */
async function _texts(page) {
  return page.evaluate(() => {
    const out = [];
    const keyOf = (el) => {
      const parts = [];
      while (el && el !== document.body && el.parentElement) {
        const p = el.parentElement;
        parts.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ':' + Array.prototype.indexOf.call(p.children, el));
        el = p;
      }
      return parts.reverse().join('>');
    };
    const visible = (el) => {
      if (!el || !el.getClientRects().length) return false;
      if (el.closest('[hidden],[aria-hidden="true"],script,style,noscript,template,code,pre,[translate="no"],.notranslate')) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t.length < 2 || !/[A-Za-z]/.test(t)) continue;
      const el = n.parentElement;
      if (!visible(el)) continue;
      const langEl = el.closest('[lang]');
      if (langEl && langEl !== document.documentElement) continue;
      const k = el.closest('[data-i18n],[data-i18n-html]');
      out.push({ key: keyOf(el) + '|' + Array.prototype.indexOf.call(el.childNodes, n), text: t,
        i18nKey: k ? (k.getAttribute('data-i18n') || k.getAttribute('data-i18n-html')) : null });
    }
    for (const el of document.querySelectorAll('input[placeholder],textarea[placeholder]')) {
      if (!visible(el)) continue;
      const t = el.getAttribute('placeholder').trim();
      if (t && /[A-Za-z]/.test(t)) out.push({ key: keyOf(el) + '@placeholder', text: t, i18nKey: el.getAttribute('data-i18n-attr') });
    }
    return out;
  }).catch(() => []);
}

/* "Looks English": built for a page that should now be Hausa, Igbo or Yoruba.
   Short words those languages share with English (a, an, in, to, be, do, me, ma,
   na, ni, so, no, o) are deliberately NOT counted. Brand and acronym tokens are
   dropped before scoring. */
const EN_FUNC = 'the and your you of is for with this that are will not can what how from by or our have has at we they when where who why if all any more about here there only after before then than into out up get see use make take need must should would could may every each one two three it its on was were been their them these those which while until also just still yet even very most some other own same such both few many much because don\'t can\'t isn\'t won\'t i my his her he she now never always again please yes'.split(' ');
const EN_UI = 'time times day days week hours minutes way word words sign results result report reports reporting observer observers polling unit units election elections practice practise download install privacy policy terms menu home questions question answer answers help support language read open close cancel continue next back submit send code number phone mobile password account create verify choose photo photos capture sheet counts count votes vote party parties ledger entry receipt card share save try start today live map works state states ward wards local government area independent witness witnesses network contact learn view show hide loading error failed check connection required optional sample step done complete ready free official affiliated page update updated latest nigerian enter announced evidence take below above request sent tap button link visit website notifications alerts profile settings run runs national presidential governorship senate senatorial house assembly candidates candidate leaderboard coverage incidents incident integrity public verify verified anyone everyone people volunteer volunteers'.split(' ');
const EN_WORDS = new Set([...EN_FUNC, ...EN_UI]);
const EN_SINGLE = new Set(EN_UI.filter((w) => w.length >= 4));
const BRAND = new Set('hawkeye inec irev telegram whatsapp sms otp faq apc pdp lp nnpp adc ndc ndp ypp sdp apga aac ec8a ec8b bvas pu pus lga lgas ng google play apple app store iphone android github rekor sigstore ok id nin fct cso org http https www com pdf apk'.split(' '));
function looksEnglish(t) {
  const words = (t.toLowerCase().match(/[a-z']+/g) || []).filter((w) => !BRAND.has(w) && w.length > 0);
  if (!words.length) return false;
  // Words carrying Hausa/Igbo/Yoruba diacritics never reach here (a-z only), so
  // a mixed line scores on its ASCII words; require a clear majority.
  const nonAscii = (t.match(/[ɓɗƙƴọẹṣńáàéèíìóòúùụịṅ]/gi) || []).length;
  if (nonAscii > 0) return false;
  if (words.length === 1) return EN_SINGLE.has(words[0]);
  const hits = words.filter((w) => EN_WORDS.has(w)).length;
  return hits >= 2 && hits / words.length >= 0.5;
}

/** Overflow, horizontal scroll and clipped text — measured, not eyeballed. */
async function _layout(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const desc = (el) => {
      const c = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + c;
    };
    const res = { vw, docScrollW: document.documentElement.scrollWidth, hScroll: false, pane: null, offenders: [], clipped: [] };
    // Can the reader actually swipe sideways? Try it.
    const se = document.scrollingElement || document.documentElement;
    const before = se.scrollLeft; se.scrollLeft = 200; if (se.scrollLeft > 0) res.hScroll = true; se.scrollLeft = before;
    const pane = document.getElementById('page-scroll');
    if (pane) {
      res.pane = { sw: pane.scrollWidth, cw: pane.clientWidth };
      const b = pane.scrollLeft; pane.scrollLeft = 200; if (pane.scrollLeft > 0) res.hScroll = true; pane.scrollLeft = b;
    }
    const inXScroller = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && p !== pane) return true;
        if (ox === 'hidden' || ox === 'clip') { const r = p.getBoundingClientRect(); if (r.right <= vw + 1) return true; }
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (!el.getClientRects().length) continue;
      if (el.closest('[hidden],[aria-hidden="true"],svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Partly off the right edge (wholly off-screen = an off-canvas panel, intended).
      if (r.left < vw - 1 && r.right > vw + 1 && !inXScroller(el)) {
        if (!res.offenders.some((o) => o.el.contains && o.el.contains(el))) res.offenders.push({ el, d: desc(el), right: Math.round(r.right), text: (el.innerText || '').trim().slice(0, 60) });
      }
      const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim().length > 1);
      if (hasText && (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) {
        res.clipped.push({ d: desc(el), text: (el.innerText || '').trim().slice(0, 80), sw: el.scrollWidth, cw: el.clientWidth });
      }
      // Text that spills out of its own box (the Fold bug in narrow_screen_test).
      if (hasText && cs.overflowX === 'visible' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== 'inline' && cs.whiteSpace !== 'nowrap') {
        res.clipped.push({ d: desc(el), text: (el.innerText || '').trim().slice(0, 80), sw: el.scrollWidth, cw: el.clientWidth, spill: true });
      }
    }
    res.offenders = res.offenders.slice(0, 12).map(({ el, ...o }) => o);
    res.clipped = res.clipped.slice(0, 12);
    return res;
  }).catch((e) => ({ error: String(e) }));
}

/** Any blocking overlay a first-timer would meet (tour, language prompt, banners). */
async function _overlays(page) {
  return page.evaluate(() => {
    const vw = innerWidth, vh = innerHeight;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      if (el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < vw * vh * 0.5) continue;
      out.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/)[0] : ''), text: (el.innerText || '').trim().slice(0, 120) });
    }
    return out.filter((o) => o.text);
  }).catch(() => []);
}

async function currentLang(page) {
  return page.evaluate(() => (window.HawkeyeI18n && window.HawkeyeI18n.current) || document.documentElement.lang || '?').catch(() => '?');
}

/** Switch language the way a visitor does: the header button, one tap per language. */
async function switchLang(page, P, target) {
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    if ((await currentLang(page)) === target) break;
    // :visible — a page can carry two (observe.html: the header's, hidden on the
    // sign-up screen, and the sign-up screen's own); the visitor taps the one shown.
    const btn = page.locator('.lang-btn:visible').first();
    if (await btn.count() && await btn.isVisible().catch(() => false)) {
      const was = await currentLang(page);
      const clicked = await btn.click({ timeout: 8000 }).then(() => true).catch(() => false);
      if (!clicked) {
        // Something sits over the button (an open menu, a dialog). Note it and switch by API.
        (P.langClickBlocked = P.langClickBlocked || []).push(P.step);
        await page.evaluate((c) => window.HawkeyeI18n && window.HawkeyeI18n.set(c), target).catch(() => {});
      }
      await page.waitForFunction((w) => window.HawkeyeI18n && window.HawkeyeI18n.current !== w, was, { timeout: 30000 }).catch(() => {});
    } else {
      (P.noLangButton = P.noLangButton || []).push(P.step);
      await page.evaluate((c) => window.HawkeyeI18n && window.HawkeyeI18n.set(c), target).catch(() => {});
      await page.waitForFunction((c) => window.HawkeyeI18n && window.HawkeyeI18n.current === c, target, { timeout: 30000 }).catch(() => {});
    }
  }
  await sleep(600);
  const got = await currentLang(page);
  return { ok: got === target, got, ms: Date.now() - t0 };
}

/** The per-page language pass: EN baseline, then HA, IG, YO — untranslated text, layout, shots. */
async function langPass(page, P, pageKey, prof, opts = {}) {
  const res = { page: pageKey, langs: {} };
  P.step = `${pageKey}:en`;
  // CONTROL: one English sentence the page cannot translate (no i18n key). The
  // detector must flag it in every language, or its "0 strings left" means nothing.
  const CONTROL = 'Tap here to check your polling unit results';
  await page.evaluate((c) => {
    const p = document.createElement('p');
    p.id = 'e2e-control';
    p.textContent = c;
    p.style.cssText = 'position:absolute;left:0;top:0;margin:0;font-size:1px;line-height:1px;color:transparent;pointer-events:none;white-space:nowrap';
    document.body.appendChild(p);
  }, CONTROL).catch(() => {});
  const en = await texts(page);
  const enMap = new Map(en.map((x) => [x.key, x.text]));
  const enLay = await layout(page);
  res.langs.en = { layout: enLay, count: en.length };
  checkLayout(enLay, P, pageKey, 'en', prof, P.lastShot);
  for (const lang of ['ha', 'ig', 'yo']) {
    P.step = `${pageKey}:${lang}`;
    const sw = await switchLang(page, P, lang);
    if (opts.scrollTop !== false) await scrollToTop(page);
    const s = await shot(page, P, `${pageKey}-${lang}`);
    const now = await texts(page);
    const flagged = [];
    const seen = new Set();
    for (const x of now) {
      const before = enMap.get(x.key);
      if (before !== undefined && before !== x.text) continue;   // it changed: translated
      if (!looksEnglish(x.text)) continue;
      if (seen.has(x.text)) continue;
      seen.add(x.text);
      flagged.push({ text: x.text.slice(0, 160), i18nKey: x.i18nKey, sameAsEnglish: before !== undefined });
    }
    const controlSeen = flagged.some((f) => f.text === CONTROL);
    const untranslated = flagged.filter((f) => f.text !== CONTROL);
    if (!controlSeen) P.controlMisses.push(`${pageKey}:${lang}`);
    const lay = await layout(page);
    res.langs[lang] = { switched: sw, untranslated, controlSeen, layout: lay, shot: s, count: now.length };
    checkLayout(lay, P, pageKey, lang, prof, s);
    if (!sw.ok) finding('HIGH', 'i18n', `${pageKey}: language did not switch to ${lang.toUpperCase()}`, `Header language button left the page on "${sw.got}".`, [s], prof.key);
    log(`    ${pageKey} ${lang}: switch ${sw.ms} ms, ${untranslated.length} English strings left (control ${controlSeen ? 'caught' : 'MISSED'})`);
  }
  // Back to English for the next page.
  await switchLang(page, P, 'en');
  await page.evaluate(() => { const c = document.getElementById('e2e-control'); if (c) c.remove(); }).catch(() => {});
  P.langs.push(res);
  return res;
}

function checkLayout(lay, P, pageKey, lang, prof, s) {
  if (!lay || lay.error) return;
  const tag = `${pageKey} (${lang.toUpperCase()})`;
  if (lay.hScroll) finding('HIGH', 'layout', `${tag}: page scrolls sideways`, `Document ${lay.docScrollW}px wide in a ${lay.vw}px viewport${lay.pane ? `; #page-scroll ${lay.pane.sw}/${lay.pane.cw}` : ''}. Offenders: ${lay.offenders.map((o) => `${o.d} (right ${o.right}px) "${o.text}"`).join('; ') || 'n/a'}`, [s], prof.key);
  else if (lay.offenders.length) P.overflowNotes.push({ tag, offenders: lay.offenders, shot: s });
  const spill = lay.clipped.filter((c) => c.spill);
  const clip = lay.clipped.filter((c) => !c.spill);
  if (spill.length) P.spillNotes.push({ tag, items: spill, shot: s });
  if (clip.length) P.clipNotes.push({ tag, items: clip, shot: s });
}

async function scrollToTop(page) {
  await page.evaluate(() => { const p = document.getElementById('page-scroll'); if (p) p.scrollTop = 0; window.scrollTo(0, 0); }).catch(() => {});
}
async function scrollToBottom(page) {
  await page.evaluate(() => { const p = document.getElementById('page-scroll'); if (p) p.scrollTop = p.scrollHeight; window.scrollTo(0, document.body.scrollHeight); }).catch(() => {});
  await sleep(500);
}

/** In-house dialog (app/dialog.js): read it, shoot it, close it. */
async function readDialog(page, timeout = 45000) {
  const d = page.locator('.hk-dlg .hk-dlg-msg').last();
  try { await d.waitFor({ state: 'visible', timeout }); } catch { return null; }
  const text = (await d.innerText().catch(() => '')).trim();
  return text;
}
async function closeDialog(page) {
  const b = page.locator('.hk-dlg button').last();
  if (await b.count()) await b.click({ timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.hk-dlg', { state: 'detached', timeout: 5000 }).catch(() => {});
  await sleep(200);
}

/**
 * The on-screen keyboard. Android Chrome shrinks the visual viewport by the
 * keyboard height; we shrink the viewport by the same amount, tap the field,
 * and ask: is the field on screen, is anything fixed painted over it, and how
 * much of the screen is left for content once fixed chrome is subtracted.
 */
async function keyboardCheck(page, P, prof, selector, label, nextSelector = null) {
  const vp = page.viewportSize();
  const kb = Math.round(vp.height * prof.keyboardFrac);
  const res = { label, selector, keyboardPx: kb };
  try {
    // The order a phone does it in: the tap focuses the field, THEN the keyboard
    // rises and the WebView shrinks (Lite's activity sets no windowSoftInputMode,
    // so the WebView resizes — the "resizes-content" model this emulates; the
    // page's own keepAuthInView() runs on that resize).
    const loc = page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
    await loc.click({ timeout: 10000 }).catch(() => {});
    await sleep(250);
    await page.setViewportSize({ width: vp.width, height: vp.height - kb });
    // What the WebView itself does when the keyboard covers the focused field:
    // bring it into view (nearest edge). The page's own handlers then run.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.bottom > innerHeight || r.top < 0) el.scrollIntoView({ block: 'nearest' });
    }, selector).catch(() => {});
    await sleep(900);
    Object.assign(res, await page.evaluate(([sel, nextSel]) => {
      const vh = innerHeight;
      const el = document.querySelector(sel);
      if (!el) return { missing: true };
      const describe = (n) => n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/)[0] : '') : null;
      const r = el.getBoundingClientRect();
      const midY = Math.max(0, Math.min(vh - 1, r.top + r.height / 2));
      // Five points across the field: a round button in a corner covers the digits, not the label side.
      const covers = [];
      for (const fx of [0.08, 0.3, 0.5, 0.7, 0.92]) {
        const hit = document.elementFromPoint(r.left + r.width * fx, midY);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) covers.push(describe(hit) + "@" + Math.round(fx * 100) + "%");
      }
      let fixedPx = 0; const fixed = [];
      for (const n of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(n);
        if (!(cs.position === 'fixed' || cs.position === 'sticky') || cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (n.closest('[hidden]')) continue;
        const b = n.getBoundingClientRect();
        if (b.width < 40 || b.height < 10 || b.bottom <= 0 || b.top >= vh) continue;
        if (b.height > vh * 0.9) continue;   // a page-sized pane, not chrome
        fixed.push({ el: describe(n), top: Math.round(b.top), h: Math.round(b.height) });
        fixedPx += Math.min(b.bottom, vh) - Math.max(b.top, 0);
      }
      let next = null;
      if (nextSel) {
        const nb = document.querySelector(nextSel);
        if (nb) { const q = nb.getBoundingClientRect(); next = { top: Math.round(q.top), bottom: Math.round(q.bottom), inView: q.top >= 0 && q.bottom <= vh }; }
      }
      return {
        vh, focused: document.activeElement === el,
        rect: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
        inView: r.top >= 0 && r.bottom <= vh,
        coveredBy: covers.length ? [...new Set(covers)].join(", ") : null,
        fixed, contentPx: Math.round(vh - fixedPx), next,
      };
    }, [selector, nextSelector]));
    res.shot = await shot(page, P, `keyboard-${label}`);
  } catch (e) {
    res.error = String(e.message || e);
  } finally {
    await page.setViewportSize(vp);
    await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur()).catch(() => {});
    await sleep(300);
  }
  P.keyboard.push(res);
  const where = `${label} with a ${kb}px keyboard`;
  if (res.missing) return res;
  if (!res.inView) finding('HIGH', 'keyboard', `${where}: the field is off screen`, `Field at ${JSON.stringify(res.rect)} in a ${res.vh}px visible area.`, [res.shot], prof.key);
  else if (res.coveredBy) finding('HIGH', 'keyboard', `${where}: field painted over by ${res.coveredBy}`, `Fixed layers: ${JSON.stringify(res.fixed)}`, [res.shot], prof.key);
  if (res.contentPx != null && res.contentPx < 220) finding('MEDIUM', 'keyboard', `${where}: only ${res.contentPx}px left for content`, `Fixed layers take the rest: ${JSON.stringify(res.fixed)}`, [res.shot], prof.key);
  return res;
}

/**
 * styles.css turns on cross-document view transitions (@view-transition
 * { navigation: auto }) for anyone who has not asked for reduced motion. Follow
 * one in-site link with motion allowed and ask: does the next page throw, and
 * does it keep painting (requestAnimationFrame)? Recorded, then the walk runs
 * with reduced motion so it can continue either way.
 */
async function vtProbe(browser, prof, P) {
  const ctx = await browser.newContext({
    viewport: prof.viewport, deviceScaleFactor: prof.dsf, isMobile: true, hasTouch: true, userAgent: prof.ua,
    locale: 'en-NG', timezoneId: 'Africa/Lagos',
  });
  await ctx.exposeFunction('__e2eGuardHit', (s) => { SAFETY.pageGuard.push({ at: 'vt-probe', what: String(s).slice(0, 200) }); });
  await ctx.addInitScript(PAGE_GUARD);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  const res = { errors: errs };
  try {
    await page.goto(`${SITE}/`, { waitUntil: 'load', timeout: 150000 });
    await page.locator('a[href="download.html"]:visible').first().click({ timeout: 20000 });
    await page.waitForURL(/download\.html/, { timeout: 60000 });
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
    await sleep(1500);
    res.rafFires = await race(page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(true)))), 8000, false, 'vt-probe raf');
    res.visibility = await race(page.evaluate(() => document.visibilityState), 5000, '?', 'vt-probe visibility');
    const file = `${String(++P.shotNo).padStart(3, '0')}-vt-probe-download.png`;
    res.shot = await page.screenshot({ path: path.join(P.dir, file), timeout: 15000 }).then(() => `${P.key}/${file}`).catch(() => null);
  } catch (e) { res.error = String(e.message || e).split('\n')[0]; }
  P.vtProbe = res;
  const skipped = errs.some((e) => /Transition was skipped/.test(e));
  if (skipped || res.rafFires === false) {
    finding('MEDIUM', 'navigation', 'In-site link: view transition aborts ("AbortError: Transition was skipped")' + (res.rafFires === false ? ' and the next page stops painting in headless Chromium' : ''),
      `Landing -> "Get the app" with motion allowed. Uncaught: ${errs.join(' | ') || 'none'}. requestAnimationFrame on the new page fired: ${res.rafFires}. ` +
      'The stall may be headless-only; the uncaught AbortError is a real page error (styles.css @view-transition { navigation: auto }). Check on real phones: tap between pages, nothing freezes.',
      [res.shot], prof.key);
  }
  await ctx.close();
  log(`  vt-probe: rAF ${res.rafFires}, errors ${errs.length}`);
}

// =================================================================== WEB FLOW
async function runWeb(browser, prof) {
  const P = {
    key: prof.key, dir: path.join(OUT, prof.key), shotNo: 0, shots: [], step: 'init', timings: [], console: [], pageErrors: [],
    httpErrors: [], failedRequests: [], nativeDialogs: [], langs: [], keyboard: [], overflowNotes: [], clipNotes: [], spillNotes: [],
    signup: {}, practice: {}, download: {}, interactions: [], expect4xx: false, lastShot: null, controlMisses: [],
  };
  fs.rmSync(P.dir, { recursive: true, force: true });
  fs.mkdirSync(P.dir, { recursive: true });
  R.profiles[prof.key] = { label: prof.label, web: P };

  // The view-transition probe runs first, with motion allowed; the walk itself
  // asks for reduced motion, because in this Chromium a cross-document view
  // transition stops the page painting (rAF never fires) and every screenshot
  // and click after an in-site link would time out. See vtProbe().
  await vtProbe(browser, prof, P);
  const ctx = await browser.newContext({
    viewport: prof.viewport, deviceScaleFactor: prof.dsf, isMobile: true, hasTouch: true, userAgent: prof.ua,
    locale: 'en-NG', timezoneId: 'Africa/Lagos', acceptDownloads: false, reducedMotion: 'reduce',
  });
  await ctx.exposeFunction('__e2eGuardHit', (s) => { SAFETY.pageGuard.push({ at: P.step, what: String(s).slice(0, 200) }); });
  await ctx.addInitScript(PAGE_GUARD);
  await ctx.addInitScript(PERF_PROBE);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  ctx.on('page', async (pg) => {
    // A link that opens a new tab (Telegram, store, WhatsApp): note it, close it.
    if (pg === page) return;
    SAFETY.popupsClosed.push({ at: P.step, url: pg.url() });
    await pg.close().catch(() => {});
  });
  await instrument(page, prof, P);

  // ---------------------------------------------------------------- 1 landing
  log(`[${prof.key}] landing`);
  await load(page, P, `${SITE}/`, 'landing (cold)');
  P.lastShot = await shot(page, P, 'landing-en');
  const ov = await overlays(page);
  if (ov.length) P.firstOverlays = ov;
  await scrollToBottom(page);
  await shot(page, P, 'landing-en-bottom');
  await scrollToTop(page);
  if (!P.control || !P.control.bytes) {
    const t0 = Date.now();
    const bytes = await page.evaluate(async (u) => { const r = await fetch(u, { cache: 'no-store' }); return (await r.arrayBuffer()).byteLength; }, `/states_geo.json?e2e=${Date.now()}`).catch(() => 0);
    const ms = Date.now() - t0;
    P.control = { bytes, ms, kbps: bytes && ms ? Math.round((bytes * 8) / ms) : null };
  }
  // The menu a first-timer opens.
  try {
    const burger = page.locator('.menu-btn, #menu-toggle, button[aria-controls="menu-panel"]').first();
    if (await burger.count() && await burger.isVisible()) {
      await burger.click();
      await sleep(700);
      P.menuShot = await shot(page, P, 'landing-menu-en');
      P.menuItems = await page.evaluate(() => [...document.querySelectorAll('#menu-panel a, #menu-panel button')].filter((a) => a.getClientRects().length).map((a) => a.innerText.trim()).filter(Boolean).slice(0, 60));
      await page.keyboard.press('Escape').catch(() => {});
      if ((await burger.getAttribute("aria-expanded").catch(() => null)) === "true") await burger.click().catch(() => {});
      await sleep(400);
    }
  } catch { /* menu is optional */ }
  await langPass(page, P, 'landing', prof);

  // ---------------------------------------------------------------- 2 download
  log(`[${prof.key}] download`);
  P.step = 'download';
  resetNet(P);
  const getApp = page.locator('a[href="download.html"]:visible').first();
  if (await getApp.count()) {
    const t0 = Date.now();
    P.step = 'download:click';
    await getApp.click({ timeout: 15000 }).catch(() => {});
    P.step = 'download:wait-url';
    await page.waitForURL(/download\.html/, { timeout: 60000 }).catch(() => {});
    P.step = 'download:wait-load';
    await page.waitForLoadState('load').catch(() => {});
    P.interactions.push({ what: 'landing "Get the app" -> download page loaded', ms: Date.now() - t0 });
  } else {
    await load(page, P, `${SITE}/download.html`, 'download');
  }
  P.step = 'download:idle';
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  P.step = 'download:perf';
  P.timings.push({ label: 'download (via click)', ...(await perf(page)), bytes: P.net.bytes });
  P.step = 'download:shot';
  P.lastShot = await shot(page, P, 'download-en');
  P.step = 'download:links';
  P.download.links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => a.getClientRects().length)
    .map((a) => ({ text: a.innerText.trim().slice(0, 60) || a.getAttribute('aria-label') || (a.querySelector('img') && a.querySelector('img').alt) || '', href: a.href }))
    .filter((a) => /play\.google|apps\.apple|\.apk|install|download|testflight|lite/i.test(a.href + ' ' + a.text)));
  P.download.buttons = await page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => b.innerText.trim()).filter(Boolean));
  for (const l of P.download.links.filter((x) => /\.apk(\?|$)/i.test(x.href)).slice(0, 2)) {
    try {
      const r = await fetch(l.href, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20000) });
      l.head = { status: r.status, length: Number(r.headers.get('content-length') || 0), type: r.headers.get('content-type'), acceptRanges: r.headers.get('accept-ranges') };
      if (r.status !== 200 || !/android\.package-archive/.test(l.head.type || '')) {
        finding('HIGH', 'download', `Direct APK link is broken: HTTP ${r.status} (${l.head.type})`, `${l.href} — the "cannot use an app store" route on the download page.`, [P.lastShot], prof.key);
      }
    } catch (e) { l.head = { error: String(e) }; }
  }
  await scrollToBottom(page);
  await shot(page, P, 'download-en-bottom');
  await scrollToTop(page);
  await langPass(page, P, 'download', prof);

  // ---------------------------------------------------------------- 3 sign-up
  log(`[${prof.key}] sign-up`);
  await load(page, P, `${SITE}/`, 'landing (warm, to reach sign-up)');
  P.step = 'signup';
  resetNet(P);
  const cta = page.locator('a[href^="observe.html?intent=observe"]:visible').first();
  {
    const t0 = Date.now();
    if (await cta.count()) {
      P.signup.ctaText = (await cta.innerText().catch(() => '')).trim();
      await cta.click({ timeout: 15000 }).catch(() => {});
      await page.waitForURL(/observe\.html/, { timeout: 60000 }).catch(() => {});
    } else {
      await page.goto(`${SITE}/observe.html?intent=observe`, { timeout: 150000 });
    }
    await page.waitForSelector('#auth-card', { state: 'visible', timeout: 90000 }).catch(() => {});
    P.interactions.push({ what: `landing CTA "${P.signup.ctaText || '?'}" -> sign-up form visible`, ms: Date.now() - t0 });
  }
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  P.timings.push({ label: 'sign-up (via CTA)', ...(await perf(page)), bytes: P.net.bytes });
  // /api/health decides SMS and WhatsApp; let it answer.
  await page.evaluate(() => window.__hkHealthP).catch(() => {});
  await sleep(1200);
  const state0 = async () => page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[name="otp-channel"]')];
    return {
      url: location.href,
      checked: radios.filter((r) => r.checked).map((r) => r.value),
      options: radios.map((r) => {
        const lab = r.closest('label');
        const vis = !!(lab && lab.getClientRects().length && !lab.hidden && getComputedStyle(lab).display !== 'none');
        const b = lab ? lab.getBoundingClientRect() : { top: 0, left: 0 };
        return { value: r.value, visible: vis, text: lab ? lab.innerText.trim() : '', top: Math.round(b.top), left: Math.round(b.left) };
      }),
      btnDisabled: document.getElementById('btn-auth').disabled || document.getElementById('btn-auth').getAttribute('aria-disabled') === 'true',
      btnHardDisabled: document.getElementById('btn-auth').disabled,
      btnText: document.getElementById('btn-auth').innerText.trim(),
      needVisible: !document.getElementById('channel-need').hidden,
      starterCard: !!document.getElementById('starter-card') && document.getElementById('starter-card').getClientRects().length > 0,
      refVisible: !!document.getElementById('ref-opt') && !document.getElementById('ref-opt').hidden,
      pwVisible: !!document.getElementById('pw-opt') && !document.getElementById('pw-opt').hidden,
    };
  });
  const s0 = await state0();
  P.signup.initial = s0;
  P.lastShot = await shot(page, P, 'signup-en');
  await scrollToBottom(page);
  await shot(page, P, 'signup-en-bottom');
  await scrollToTop(page);
  const vis = s0.options.filter((o) => o.visible);
  P.signup.order = vis.map((o) => o.value);
  if (s0.checked.length) finding('CRITICAL', 'sign-up', 'A delivery route is pre-selected', `Checked on first paint: ${s0.checked.join(', ')} (owner rule: no default route).`, [P.lastShot], prof.key);
  if (!s0.btnDisabled) finding('CRITICAL', 'sign-up', '"Request OTP" is enabled before a route is chosen', `Button "${s0.btnText}" enabled with no route.`, [P.lastShot], prof.key);
  const expectOrder = ['telegram', 'whatsapp', 'sms'].filter((v) => P.signup.order.includes(v));
  if (P.signup.order.join() !== expectOrder.join()) finding('HIGH', 'sign-up', 'Route order is not Telegram, WhatsApp, SMS', `On screen: ${P.signup.order.join(' > ')}`, [P.lastShot], prof.key);
  if (!P.signup.order.includes('sms')) P.signup.smsHidden = true;

  // Tap the greyed button with NO route (a number typed): it must send nothing
  // and say "choose how to verify". The number is malformed, so even a bug that
  // did send would be refused by format.
  {
    P.step = 'signup:no-route-tap';
    const before = SAFETY.allowedWrites.length + SAFETY.blocked.length + SAFETY.pageGuard.length;
    await page.fill('#auth-input', '0123 456 7890');
    // force: Playwright treats aria-disabled="true" as disabled and would never tap it; a thumb does.
    await page.click('#btn-auth', { timeout: 10000, force: true }).catch(() => {});
    await sleep(2500);
    const dlg = await readDialog(page, 1500);
    const after = SAFETY.allowedWrites.length + SAFETY.blocked.length + SAFETY.pageGuard.length;
    const st = await state0();
    const s = await shot(page, P, 'signup-no-route-tap');
    P.signup.noRouteTap = { requestsMade: after - before, needVisible: st.needVisible, dialog: dlg, shot: s };
    if (dlg) await closeDialog(page);
    if (after > before) finding('CRITICAL', 'sign-up', 'Tapping Request OTP with no route sent a request', `${after - before} sign-in request(s) left the page.`, [s], prof.key);
    if (!st.needVisible && !dlg) finding('MEDIUM', 'sign-up', 'Tapping the greyed Request OTP with no route gives no feedback', 'No "choose how to verify" line and no dialog.', [s], prof.key);
    await page.fill('#auth-input', '');
  }

  // Each route: tap it, time the button coming alive.
  for (const o of vis) {
    P.step = `signup:route-${o.value}`;
    const t0 = Date.now();
    await page.locator(`input[name="otp-channel"][value="${o.value}"]`).click({ timeout: 10000, force: true }).catch(() => {});
    const enabled = await page.waitForFunction(() => { const b = document.getElementById('btn-auth'); return !b.disabled && b.getAttribute('aria-disabled') !== 'true'; }, null, { timeout: 10000 }).then(() => true).catch(() => false);
    const st = await state0();
    const s = await shot(page, P, `signup-route-${o.value}`);
    P.signup[`route_${o.value}`] = { enabled, ms: Date.now() - t0, needVisible: st.needVisible, pwVisible: st.pwVisible, shot: s };
    P.interactions.push({ what: `tap ${o.value} -> Request OTP enabled`, ms: Date.now() - t0 });
    if (!enabled) finding('HIGH', 'sign-up', `Choosing ${o.value} does not enable the button`, '', [s], prof.key);
  }

  // A refused number goes to the server, which says no before doing anything.
  const tryNumber = async (label, number, channel, lang = 'en') => {
    P.step = `signup:${label}:${lang}`;
    P.expect4xx = true;
    await page.fill('#auth-input', '');
    await page.fill('#auth-input', number);
    await page.locator(`input[name="otp-channel"][value="${channel}"]`).click({ force: true, timeout: 10000 }).catch(() => {});
    const t0 = Date.now();
    const respP = page.waitForResponse((r) => SIGNIN_PATHS.some((p) => r.url().includes(p)), { timeout: 60000 }).catch(() => null);
    await page.click('#btn-auth', { timeout: 10000 }).catch(() => {});
    let text = await readDialog(page, 60000);
    const resp = await respP;
    let body = null;
    if (resp) body = await resp.json().catch(() => null);
    const ms = Date.now() - t0;
    const s = await shot(page, P, `signup-${label}-${channel}-${lang}`);
    P.expect4xx = false;
    const r = { number, channel, lang, dialog: text, status: resp && resp.status(), body, ms, shot: s };
    await closeDialog(page);
    return r;
  };

  P.signup.tests = [];
  // +888 on each visible route, then a malformed number on each.
  for (const o of vis) {
    if (o.value === 'whatsapp') continue;   // WhatsApp asks for a password first: below
    P.signup.tests.push({ label: '+888', ...(await tryNumber('plus888', '+888 0123 4567', o.value)) });
    P.signup.tests.push({ label: 'bad number', ...(await tryNumber('badnum', '0123 456 7890', o.value)) });
  }
  if (vis.some((o) => o.value === 'whatsapp')) {
    // WhatsApp (free route): the page asks for a password before anything is sent.
    P.step = 'signup:whatsapp-password';
    await page.fill('#auth-input', '0123 456 7890');
    await page.locator('input[name="otp-channel"][value="whatsapp"]').click({ force: true }).catch(() => {});
    await page.click('#btn-auth').catch(() => {});
    const pwMsg = await readDialog(page, 20000);
    const sPw = await shot(page, P, 'signup-whatsapp-password-first');
    await closeDialog(page);
    P.signup.whatsappPasswordFirst = { dialog: pwMsg, shot: sPw, pwVisible: await page.locator('#pw-opt').isVisible().catch(() => false) };
    if (await page.locator('#pw-opt-input').isVisible().catch(() => false)) {
      await page.fill('#pw-opt-input', 'e2e-local-only-1');
      P.signup.tests.push({ label: 'bad number', ...(await tryNumber('badnum', '0123 456 7890', 'whatsapp')) });
      P.signup.tests.push({ label: '+888', ...(await tryNumber('plus888', '+888 0123 4567', 'whatsapp')) });
    }
  }
  for (const t of P.signup.tests) {
    if (!t.dialog && !t.status) finding('HIGH', 'sign-up', `${t.label} on ${t.channel}: nothing happened`, 'No dialog and no server answer within 60 s.', [t.shot], prof.key);
    if (t.label === '+888' && t.status === 200) finding('CRITICAL', 'sign-up', '+888 accepted', JSON.stringify(t.body), [t.shot], prof.key);
  }

  // Organisation code: typed only (client-side mode switch). Never submitted.
  P.step = 'signup:org-code';
  if (await page.locator('#ref-input').isVisible().catch(() => false)) {
    await page.fill('#ref-input', 'ORG-ABCD-EFGH-JKMN');
    await sleep(500);
    P.signup.orgMode = await page.evaluate(() => ({
      channelPickHidden: document.getElementById('channel-pick').hidden,
      btnText: document.getElementById('btn-auth').innerText.trim(),
      btnDisabled: document.getElementById('btn-auth').disabled || document.getElementById('btn-auth').getAttribute('aria-disabled') === 'true',
      btnHardDisabled: document.getElementById('btn-auth').disabled,
      kindLine: (document.getElementById('ref-kind-org') && !document.getElementById('ref-kind-org').hidden) ? document.getElementById('ref-kind-org').innerText.trim() : null,
    }));
    P.signup.orgMode.shot = await shot(page, P, 'signup-org-code-typed');
    await page.fill('#ref-input', '');
  } else {
    P.signup.orgMode = { refFieldVisible: false };
  }

  // The keyboard over the phone field, and over the counts later.
  await page.fill('#auth-input', '');
  await keyboardCheck(page, P, prof, '#auth-input', 'signup-phone', '#btn-auth');

  // Language pass on a clean form, with the refusal messages in each language.
  P.step = 'signup:reload';
  await page.reload({ waitUntil: 'load', timeout: 150000 }).catch(() => {});
  await page.waitForSelector('#auth-card', { state: 'visible', timeout: 60000 }).catch(() => {});
  await page.evaluate(() => window.__hkHealthP).catch(() => {});
  await sleep(800);
  P.lastShot = await shot(page, P, 'signup-en-clean');
  await langPass(page, P, 'signup', prof);
  P.signup.byLang = [];
  for (const lang of ['ha', 'ig', 'yo']) {
    await switchLang(page, P, lang);
    const a = await tryNumber('plus888', '+888 0123 4567', 'telegram', lang);
    const b = await tryNumber('badnum', '0123 456 7890', 'telegram', lang);
    for (const t of [a, b]) {
      t.english = t.dialog ? looksEnglish(t.dialog) : null;
      if (t.english) finding('HIGH', 'i18n', `Sign-up error shown in English while the page is ${lang.toUpperCase()}`, `${t.number} on ${t.channel}: "${t.dialog}" (server error ${t.body && t.body.error}; hint ${JSON.stringify(t.body && t.body.hint)})`, [t.shot], prof.key);
    }
    P.signup.byLang.push(a, b);
  }
  await switchLang(page, P, 'en');

  // ------------------------------------------------- 4 signed-out browsing
  const PAGES = [
    ['results', '/results.html'],
    ['how-it-works', '/how.html'],
    ['practice-day', '/practice-day.html'],
    ['faq', '/faq.html'],
    ['privacy', '/privacy.html'],
  ];
  for (const [k, u] of PAGES) {
    log(`[${prof.key}] ${k}`);
    const t = await load(page, P, SITE + u, k);
    P.lastShot = await shot(page, P, `${k}-en`);
    if (!t.ok) finding('CRITICAL', 'load', `${k} failed to load`, t.err, [P.lastShot], prof.key);
    const bounced = !page.url().includes(u.replace('/', ''));
    if (bounced) finding('HIGH', 'access', `${k} redirected a signed-out visitor`, `Landed on ${page.url()}`, [P.lastShot], prof.key);
    await scrollToBottom(page);
    await shot(page, P, `${k}-en-bottom`);
    await scrollToTop(page);
    await langPass(page, P, k, prof);
  }

  // --------------------------------------------------------- 5 practice run
  log(`[${prof.key}] practice`);
  await load(page, P, `${SITE}/observe.html?intent=observe`, 'sign-up (to reach practice)');
  P.step = 'practice:open';
  resetNet(P);
  {
    const card = page.locator('#starter-card');
    const t0 = Date.now();
    if (await card.isVisible().catch(() => false)) {
      await card.click({ timeout: 15000 }).catch(() => {});
      await page.waitForURL(/practice\.html/, { timeout: 60000 }).catch(() => {});
    } else {
      await page.goto(`${SITE}/practice.html`, { timeout: 150000 });
    }
    await page.waitForSelector('#flow:not([hidden]), #closed:not([hidden]), #unreachable:not([hidden])', { timeout: 90000 }).catch(() => {});
    P.interactions.push({ what: 'sign-up "New to Hawkeye? practice" card -> practice ready', ms: Date.now() - t0 });
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  P.timings.push({ label: 'practice (via card)', ...(await perf(page)), bytes: P.net.bytes });
  P.practice.state = await page.evaluate(() => ['flow', 'closed', 'unreachable'].find((id) => !document.getElementById(id).hidden) || 'none');
  P.lastShot = await shot(page, P, 'practice-en');
  if (P.practice.state !== 'flow') finding('CRITICAL', 'practice', `Practice did not open (state: ${P.practice.state})`, '', [P.lastShot], prof.key);
  if (P.practice.state === 'flow') {
    await langPass(page, P, 'practice', prof);
    // Step 1: the sheet through the (fake) camera; the venue by "Use a sample".
    P.step = 'practice:camera';
    const t0 = Date.now();
    await page.click('#btn-cam-sheet', { timeout: 15000 }).catch(() => {});
    const camOk = await page.waitForFunction(() => {
      const v = document.getElementById('video');
      return !document.getElementById('camera-overlay').hidden && v && v.readyState >= 2 && v.videoWidth > 0;
    }, null, { timeout: 30000 }).then(() => true).catch(() => false);
    P.practice.cameraMs = Date.now() - t0;
    P.practice.cameraShot = await shot(page, P, 'practice-camera');
    P.interactions.push({ what: 'practice "Take photo" -> live camera', ms: P.practice.cameraMs, ok: camOk });
    if (camOk) {
      const t1 = Date.now();
      await page.click('#btn-capture', { timeout: 10000 }).catch(() => {});
      await page.waitForSelector('#preview-sheet:not([hidden])', { timeout: 20000 }).catch(() => {});
      P.interactions.push({ what: 'practice Capture -> preview shown', ms: Date.now() - t1 });
    } else {
      P.practice.cameraFailed = true;
      await page.click('#btn-cancel-camera', { timeout: 5000 }).catch(() => {});
      await page.click('#btn-skip-sheet', { timeout: 5000 }).catch(() => {});
    }
    await page.click('#btn-skip-venue', { timeout: 10000 }).catch(() => {});
    await sleep(500);
    P.practice.afterPhotos = await shot(page, P, 'practice-photos-done');
    // Step 2: the counts.
    P.step = 'practice:counts';
    const inputs = page.locator('#vote-inputs input');
    const n = await inputs.count();
    P.practice.parties = n;
    const counts = [212, 188, 41, 9, 3, 0];
    for (let i = 0; i < n; i++) await inputs.nth(i).fill(String(counts[i] ?? 0)).catch(() => {});
    if (n) await keyboardCheck(page, P, prof, '#vote-inputs input', 'practice-counts', '#btn-submit');
    await page.locator('#vote-inputs input').first().scrollIntoViewIfNeeded().catch(() => {});
    P.practice.countsShot = await shot(page, P, 'practice-counts');
    // Step 3: submit — answered by the STUB, nothing reaches the practice chain.
    P.step = 'practice:submit';
    const enabled = await page.locator('#btn-submit').isEnabled().catch(() => false);
    P.practice.submitEnabled = enabled;
    if (!enabled) finding('HIGH', 'practice', 'Practice submit stays disabled after photos + counts', '', [P.practice.countsShot], prof.key);
    else {
      const t2 = Date.now();
      await page.click('#btn-submit').catch(() => {});
      const done = await page.waitForSelector('#done:not([hidden])', { timeout: 30000 }).then(() => true).catch(() => false);
      P.practice.done = done;
      P.interactions.push({ what: 'practice Sign & submit (stubbed) -> done screen', ms: Date.now() - t2, ok: done });
      if (done) {
        const rc = await page.waitForSelector('#receipt-img[src^="data:"]', { timeout: 20000 }).then(() => true).catch(() => false);
        P.practice.receipt = rc;
        P.practice.doneInfo = await page.evaluate(() => ({
          entryHash: document.getElementById('entry-hash').textContent,
          receiptNote: document.getElementById('receipt-note') ? document.getElementById('receipt-note').innerText : '',
          preview: document.getElementById('pv-meta') ? document.getElementById('pv-meta').innerText + ' / ' + document.getElementById('pv-votes').innerText : '',
          links: [...document.querySelectorAll('#done a')].filter((a) => a.getClientRects().length).map((a) => a.innerText.trim() + ' -> ' + a.getAttribute('href')),
        }));
        P.practice.doneShot = await shot(page, P, 'practice-done');
        await page.locator('#receipt-wrap').scrollIntoViewIfNeeded().catch(() => {});
        await shot(page, P, 'practice-receipt');
        await page.locator('#prac-preview').scrollIntoViewIfNeeded().catch(() => {});
        await shot(page, P, 'practice-preview-card');
        await scrollToTop(page);
        if (!rc) finding('HIGH', 'practice', 'No receipt card on the practice done screen', '', [P.practice.doneShot], prof.key);
        await langPass(page, P, 'practice-done', prof);
      } else {
        const st = await page.locator('#submit-status').innerText().catch(() => '');
        finding('CRITICAL', 'practice', 'Practice submit did not reach the done screen', `Status line: "${st}"`, [await shot(page, P, 'practice-submit-failed')], prof.key);
      }
    }
  }

  // A Hausa speaker's run: Hausa chosen BEFORE the run, so every paint-time
  // string is drawn in Hausa (the pass above switches after the fact, which
  // only proves what repaints). Samples for both photos, counts, stubbed submit.
  if (P.practice.state === 'flow') {
    log(`[${prof.key}] practice in Hausa`);
    await load(page, P, `${SITE}/practice.html`, 'practice (Hausa run)');
    await switchLang(page, P, 'ha');
    await page.reload({ waitUntil: 'load', timeout: 150000 }).catch(() => {});
    await page.waitForSelector('#flow:not([hidden])', { timeout: 90000 }).catch(() => {});
    P.step = 'practice-ha:run';
    const flowShot = await shot(page, P, 'practice-ha-run-start');
    await page.click('#btn-skip-sheet', { timeout: 10000 }).catch(() => {});
    await page.click('#btn-skip-venue', { timeout: 10000 }).catch(() => {});
    const inputs = page.locator('#vote-inputs input');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) await inputs.nth(i).fill(String([150, 120, 30, 5, 2, 0][i] ?? 0)).catch(() => {});
    const before = await texts(page);
    await page.click('#btn-submit', { timeout: 10000 }).catch(() => {});
    const done = await page.waitForSelector('#done:not([hidden])', { timeout: 30000 }).then(() => true).catch(() => false);
    await page.waitForSelector('#receipt-img[src^="data:"]', { timeout: 20000 }).catch(() => {});
    await sleep(800);
    const s = await shot(page, P, 'practice-ha-run-done');
    await page.locator('#receipt-wrap').scrollIntoViewIfNeeded().catch(() => {});
    const sReceipt = await shot(page, P, 'practice-ha-run-receipt');
    await scrollToTop(page);
    const CONTROL = 'Tap here to check your polling unit results';
    await page.evaluate((c) => { const p = document.createElement('p'); p.id = 'e2e-control'; p.textContent = c; p.style.cssText = 'position:absolute;left:0;top:0;margin:0;font-size:1px;color:transparent;pointer-events:none;white-space:nowrap'; document.body.appendChild(p); }, CONTROL).catch(() => {});
    const now = [...before, ...(await texts(page))];
    const flagged = [...new Map(now.filter((x) => looksEnglish(x.text)).map((x) => [x.text, { text: x.text.slice(0, 160), i18nKey: x.i18nKey }])).values()];
    const controlSeen = flagged.some((f) => f.text === CONTROL);
    if (!controlSeen) P.controlMisses.push('practice-ha-run');
    await page.evaluate(() => { const c = document.getElementById('e2e-control'); if (c) c.remove(); }).catch(() => {});
    P.langs.push({ page: 'practice-run-in-Hausa', langs: { ha: { untranslated: flagged.filter((f) => f.text !== CONTROL), controlSeen, shot: s, layout: await layout(page), switched: { ok: true, ms: 0 } } } });
    P.practice.hausaRun = { done, flowShot, shot: s, receiptShot: sReceipt };
    if (!done) finding('HIGH', 'practice', 'Practice run in Hausa did not reach the done screen', '', [s], prof.key);
    await switchLang(page, P, 'en');
  }

  // ------------------------------------------------- 6 repeat visit (warm SW)
  log(`[${prof.key}] repeat visit`);
  await load(page, P, `${SITE}/`, 'landing (repeat visit)');
  await load(page, P, `${SITE}/observe.html?intent=observe`, 'sign-up (repeat visit)');
  await ctx.close();
  return P;
}

// ================================================================ NATIVE FLOW
function startNativeServer(dir) {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
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

async function rnClickText(page, re, timeout = 15000) {
  const loc = page.getByText(re).first();
  await loc.waitFor({ state: 'visible', timeout });
  await loc.click({ timeout: 10000 });
}
async function visibleTexts(page) {
  return page.evaluate(() => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (!t || !el || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      out.push(t);
    }
    return out;
  }).catch(() => []);
}

async function runNative(browser, prof, base) {
  const P = {
    key: prof.key, dir: path.join(OUT, prof.key), shotNo: 500, shots: [], step: 'native', timings: [], console: [], pageErrors: [],
    httpErrors: [], failedRequests: [], nativeDialogs: [], langs: [], keyboard: [], overflowNotes: [], clipNotes: [], spillNotes: [],
    signup: {}, practice: { steps: [] }, interactions: [], expect4xx: false, controlMisses: [],
  };
  fs.mkdirSync(P.dir, { recursive: true });
  R.profiles[prof.key].native = P;
  const ctx = await browser.newContext({
    viewport: prof.viewport, deviceScaleFactor: prof.dsf, isMobile: true, hasTouch: true, userAgent: prof.ua,
    locale: 'en-NG', timezoneId: 'Africa/Lagos', permissions: ['camera'],
  });
  await ctx.exposeFunction('__e2eGuardHit', (s) => { SAFETY.pageGuard.push({ at: P.step, what: String(s).slice(0, 200) }); });
  await ctx.addInitScript(PAGE_GUARD);
  await ctx.addInitScript(PERF_PROBE);
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  // The JS bundle is ON the phone in the real app: CPU throttle only, no network throttle.
  await instrument(page, { ...prof, net: null }, P);

  const go = async (route, label) => {
    const t = await load(page, P, base + route, `native ${label}`);
    await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 20, null, { timeout: 60000 }).catch(() => {});
    await sleep(1500);
    return t;
  };

  // Welcome
  log(`[${prof.key}] native welcome`);
  await go('/welcome', 'welcome');
  const sWelcome = await shot(page, P, 'native-welcome-en');
  P.welcomeTexts = (await visibleTexts(page)).slice(0, 30);
  // Become an observer -> sign-up
  P.step = 'native:signup';
  try {
    const t0 = Date.now();
    await rnClickText(page, /become an observer/i, 30000);
    await page.waitForURL(/sign-in/, { timeout: 30000 });
    await page.getByText(/^Telegram$/).first().waitFor({ state: 'visible', timeout: 30000 });
    P.interactions.push({ what: 'native welcome "Become an observer" -> sign-up form', ms: Date.now() - t0 });
  } catch (e) {
    finding('HIGH', 'native', 'Native: could not reach sign-up from Welcome', String(e.message || e).split('\n')[0], [sWelcome], prof.key);
    await go('/sign-in?intent=signup', 'sign-in direct');
  }
  await page.evaluate(() => fetch('https://hawkeye.com.ng/api/health').then((r) => r.json())).catch(() => null);
  await sleep(1500);
  const chipState = async () => page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('div,span')) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (!/^(Telegram|WhatsApp)$/.test(t) && !/^SMS ·/.test(t)) continue;
      const btn = el.closest('[role="button"],[role="radio"],[tabindex]') || el.parentElement;
      const r = btn.getBoundingClientRect();
      const bg = getComputedStyle(btn).backgroundColor;
      out.push({ text: t, top: Math.round(r.top), left: Math.round(r.left), bg });
    }
    return out;
  });
  P.signup.chips = await chipState();
  P.signup.initialShot = await shot(page, P, 'native-signup-en');
  // Send code: is it presented as off before a route is picked?
  P.signup.sendInitial = await page.evaluate(() => {
    const t = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && /^Send code$/i.test(d.textContent.trim()));
    if (!t) return null;
    const b = t.closest('[role="button"]') || t.parentElement;
    return { ariaDisabled: b.getAttribute('aria-disabled'), bg: getComputedStyle(b).backgroundColor };
  }).catch(() => null);
  // Unselected chips share one background; a chip painted differently is selected.
  const main = P.signup.chips.filter((c) => !/^SMS/.test(c.text));
  if (main.length > 1 && new Set(main.map((c) => c.bg)).size > 1) finding('CRITICAL', 'native sign-up', 'Native: a route chip looks pre-selected', JSON.stringify(main), [P.signup.initialShot], prof.key);

  const nativeTry = async (label, number, chip, lang) => {
    P.step = `native:signup:${label}:${lang}`;
    P.expect4xx = true;
    const input = page.locator('input[placeholder="0803 123 4567"]').first();
    await input.fill('');
    await input.fill(number);
    const before = new Set(await visibleTexts(page));
    if (chip) await page.getByText(chip, { exact: true }).first().click({ timeout: 10000 }).catch(() => {});
    const t0 = Date.now();
    const respP = page.waitForResponse((r) => SIGNIN_PATHS.some((p) => r.url().includes(p)), { timeout: chip ? 45000 : 4000 }).catch(() => null);
    // "Send code" by its own label, in the app's language (native bundles).
    const sendLabel = (NATIVE_I18N[lang] || NATIVE_I18N.en)['n.app.profile.send-code'] || 'Send Code';
    const sendLoc = page.getByText(sendLabel, { exact: true }).first();
    const found = await sendLoc.count();
    if (!found) finding('MEDIUM', 'native sign-up', `Native: no "${sendLabel}" button found (${lang})`, '', [], prof.key);
    await sendLoc.click({ timeout: 10000 }).catch(() => {});
    const resp = await respP;
    let body = null;
    if (resp) body = await resp.json().catch(() => null);
    await sleep(1500);
    const after = await visibleTexts(page);
    const newLines = after.filter((t) => !before.has(t) && t.length > 8);
    const s = await shot(page, P, `native-signup-${label}-${lang}`);
    P.expect4xx = false;
    await page.evaluate(() => document.querySelectorAll('[data-e2e-send]').forEach((n) => n.removeAttribute('data-e2e-send'))).catch(() => {});
    const r = { label, number, chip, lang, sendLabel, status: resp && resp.status(), body, ms: Date.now() - t0, lines: newLines.slice(0, 6), shot: s };
    r.english = lang !== 'en' && newLines.some((l) => looksEnglish(l));
    if (r.english) finding('HIGH', 'i18n', `Native sign-up message in English while the app is ${lang.toUpperCase()}`, `${number}: ${JSON.stringify(newLines.slice(0, 3))}`, [s], prof.key);
    if (!resp && !newLines.length) finding('MEDIUM', 'native sign-up', `Native: ${label} produced no visible answer`, '', [s], prof.key);
    return r;
  };
  P.signup.tests = [];
  try {
    // No route picked: what does Send code do?
    P.signup.tests.push(await nativeTry('no-route', '0123 456 7890', null, 'en'));
    P.signup.tests.push(await nativeTry('plus888', '+888 0123 4567', 'Telegram', 'en'));
    P.signup.tests.push(await nativeTry('badnum', '0123 456 7890', 'Telegram', 'en'));
  } catch (e) { P.signup.error = String(e.message || e); }
  await keyboardCheck(page, P, prof, 'input[placeholder="0803 123 4567"]', 'native-signup-phone');

  // Languages: stored choice + reload (the app has no header switch signed out).
  const CONTROL = 'Tap here to check your polling unit results';
  const injectControl = () => page.evaluate((c) => {
    const p = document.createElement('p');
    p.id = 'e2e-control'; p.textContent = c;
    p.style.cssText = 'position:absolute;left:0;top:0;margin:0;font-size:1px;line-height:1px;color:transparent;pointer-events:none;white-space:nowrap';
    document.body.appendChild(p);
  }, CONTROL).catch(() => {});
  const nativeLangPass = async (route, label, afterEach = null) => {
    await page.evaluate(() => localStorage.setItem('hawkeye_lang', 'en'));
    await page.goto(base + route, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await sleep(3500);
    const enMap = new Map((await texts(page)).map((x) => [x.key, x.text]));
    const out = { page: label, langs: {} };
    for (const lang of ['ha', 'ig', 'yo']) {
      P.step = `native:${label}:${lang}`;
      await page.evaluate((l) => localStorage.setItem('hawkeye_lang', l), lang);
      await page.goto(base + route, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
      await sleep(3500);
      const s = await shot(page, P, `${label}-${lang}`);
      await injectControl();
      const now = await texts(page);
      const flagged = [...new Set(now.filter((x) => { const b = enMap.get(x.key); return (b === undefined || b === x.text) && looksEnglish(x.text); }).map((x) => x.text))];
      const controlSeen = flagged.includes(CONTROL);
      if (!controlSeen) P.controlMisses.push(`${label}:${lang}`);
      await page.evaluate(() => { const c = document.getElementById('e2e-control'); if (c) c.remove(); }).catch(() => {});
      out.langs[lang] = { untranslated: flagged.filter((t) => t !== CONTROL).map((t) => ({ text: t })), controlSeen, shot: s, layout: await layout(page) };
      log(`    ${label} ${lang}: ${out.langs[lang].untranslated.length} English strings left (control ${controlSeen ? 'caught' : 'MISSED'})`);
      if (afterEach) await afterEach(lang);
    }
    P.langs.push(out);
    await page.evaluate(() => localStorage.setItem('hawkeye_lang', 'en'));
  };
  /* A language button on the two screens before sign-in, and it WORKS: tapped
     once from English, the app must be in Hausa (stored choice AND a visible
     Hausa string). Absence or a dead button is a finding. */
  P.langButton = {};
  for (const [route, label, haText] of [
    ['/welcome', 'welcome', NATIVE_I18N.ha['index.become-an-observer']],
    ['/sign-in?intent=signup', 'signup', NATIVE_I18N.ha['n.app.sign-in.title-create-account']],
  ]) {
    P.step = `native:lang-button:${label}`;
    await page.evaluate(() => localStorage.setItem('hawkeye_lang', 'en'));
    await page.goto(base + route, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await sleep(3500);
    const btn = page.locator('[data-testid="lang-button"]').first();
    const visible = await btn.isVisible().catch(() => false);
    const res = { visible, face: visible ? (await btn.innerText().catch(() => '')).trim() : null };
    if (visible) {
      await btn.click({ timeout: 10000 }).catch(() => {});
      await sleep(2500);
      res.stored = await page.evaluate(() => localStorage.getItem('hawkeye_lang')).catch(() => null);
      res.faceAfter = (await page.locator('[data-testid="lang-button"]').first().innerText().catch(() => '')).trim();
      res.hausaShown = !!haText && await page.getByText(haText, { exact: false }).first().isVisible().catch(() => false);
      res.shot = await shot(page, P, `native-lang-button-${label}`);
    }
    P.langButton[label] = res;
    if (!visible) finding('MEDIUM', 'i18n', `Native: no language button on ${label}`, 'Someone in the wrong language cannot switch before signing in.', [], prof.key);
    else if (res.stored !== 'ha' || !res.hausaShown) finding('MEDIUM', 'i18n', `Native: the language button on ${label} did not switch to Hausa`, JSON.stringify(res), [res.shot], prof.key);
    log(`    native lang button ${label}: ${JSON.stringify(res)}`);
  }
  await page.evaluate(() => localStorage.setItem('hawkeye_lang', 'en'));

  await nativeLangPass('/sign-in?intent=signup', 'native-signup', async (lang) => {
    try { P.signup.tests.push(await nativeTry('badnum', '0123 456 7890', 'Telegram', lang)); } catch (e) { /* recorded by absence */ }
  });
  await nativeLangPass('/welcome', 'native-welcome');

  // Practice — capture-first, as far as it goes, submit answered by the stub.
  log(`[${prof.key}] native practice`);
  await go('/practice', 'practice');
  const tried = [];
  for (let i = 0; i < 16; i++) {
    P.step = `native:practice:${i}`;
    const s = await shot(page, P, `native-practice-step${String(i).padStart(2, '0')}`);
    const vt = await visibleTexts(page);
    const stepRec = { i, shot: s, texts: vt.slice(0, 14) };
    P.practice.steps.push(stepRec);
    // Done = the "Practice Complete" title is really visible AND the stubbed
    // submit was hit (a pre-mounted, invisible done view must not count).
    const doneVisible = await page.getByText(/^Practice Complete$/).first().isVisible().catch(() => false);
    const submitted = SAFETY.stubbed.some((x) => String(x.at).startsWith('native:practice'));
    if (doneVisible && submitted) { P.practice.done = true; break; }
    // Fill any empty number fields (the counts).
    const filled = await page.evaluate(() => {
      let n = 0;
      for (const inp of document.querySelectorAll('input')) {
        if (!inp.getClientRects().length || inp.value) continue;
        if (inp.inputMode === 'numeric' || inp.type === 'number' || /^0$/.test(inp.placeholder || '')) {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(inp, String(10 + n * 7)); inp.dispatchEvent(new Event('input', { bubbles: true })); n++;
        }
      }
      return n;
    }).catch(() => 0);
    if (filled) { stepRec.filled = filled; await sleep(500); }
    // The practice flow's own button labels (native/src/lib/i18n/en.json), in
    // the order a first-timer meets them. A race option is the only one that is
    // data, not copy: the practice election's office is "2027 Presidential".
    const order = [
      /^Use a sample$/, /^Yes, use this unit$/, /^Continue without a unit$/, /^Presidency \(2027\)$/, /Presidential/,
      /^Continue to the figures$/, /^Review$/, /^Sign & submit \(practice\)$/, /^Continue$/,
    ];
    // The same label three times running means the button is not taking (disabled): stop and say so.
    const last3 = tried.slice(-3);
    if (last3.length === 3 && new Set(last3).size === 1) {
      stepRec.offered = await page.evaluate(() => [...document.querySelectorAll('[role="button"],[tabindex="0"]')]
        .filter((b) => b.getClientRects().length && b.innerText.trim()).map((b) => b.innerText.trim().replace(/\s+/g, ' ').slice(0, 50)).slice(0, 20)).catch(() => []);
      stepRec.stuckOn = last3[0];
      break;
    }
    let clicked = null;
    for (const re of order) {
      const loc = page.getByText(re);
      const cnt = await loc.count();
      for (let j = 0; j < cnt; j++) {
        const l = loc.nth(j);
        if (!(await l.isVisible().catch(() => false))) continue;
        const txt = (await l.innerText().catch(() => '')).trim();
        if (!txt) continue;
        // Choices are made once; only "Use a sample" (two photos) may repeat.
        if (txt !== 'Use a sample' && tried.includes(txt)) continue;
        if (/Presidential/.test(txt) && tried.some((t) => /Presidential/.test(t))) continue;
        await l.click({ timeout: 8000 }).catch(() => {});
        tried.push(txt);
        clicked = txt;
        break;
      }
      if (clicked) break;
    }
    stepRec.clicked = clicked;
    if (!clicked) {
      // Say what WAS on offer, so a stop is diagnosable from the report alone.
      stepRec.offered = await page.evaluate(() => [...document.querySelectorAll('[role="button"],[tabindex="0"]')]
        .filter((b) => b.getClientRects().length && b.innerText.trim()).map((b) => b.innerText.trim().replace(/\s+/g, ' ').slice(0, 50)).slice(0, 20)).catch(() => []);
      break;
    }
    await sleep(1800);
  }
  P.practice.stubbed = SAFETY.stubbed.filter((x) => String(x.at).startsWith('native')).length;
  await nativeLangPass('/practice', 'native-practice');
  await ctx.close();
  return P;
}

// ================================================================ REPORT
function sevRank(s) { return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }[s] ?? 4; }

function summarise() {
  // Derived findings from the raw records.
  for (const [pk, prof] of Object.entries(R.profiles)) {
    for (const P of [prof.web, prof.native].filter(Boolean)) {
      const tag = P === prof.native ? 'native ' : '';
      // Uncaught exceptions
      const byStep = new Map();
      for (const e of P.pageErrors) {
        // Hydration errors belong to the static WEB EXPORT used to drive the
        // native screens here (expo-router "output: static"); a phone build never
        // hydrates server HTML. Counted, not reported as an app defect.
        if (P === prof.native && /React error #(418|419|423|425)/.test(e.text)) { P.hydrationErrors = (P.hydrationErrors || 0) + 1; continue; }
        const k = e.text.split('\n')[0]; if (!byStep.has(k)) byStep.set(k, []); byStep.get(k).push(e.step); }
      for (const [msg, steps] of byStep) finding(/signup|practice/.test(steps.join()) ? 'HIGH' : 'MEDIUM', 'errors', `${tag}Uncaught exception: ${msg.slice(0, 120)}`, `Steps: ${[...new Set(steps)].join(', ')}`, [], pk);
      const cons = P.console.filter((c) => !c.harness);
      const cByText = new Map();
      for (const c of cons) { const k = c.text.slice(0, 160); if (!cByText.has(k)) cByText.set(k, new Set()); cByText.get(k).add(c.step); }
      for (const [msg, steps] of cByText) finding('MEDIUM', 'console', `${tag}Console error: ${msg.slice(0, 140)}`, `Steps: ${[...steps].slice(0, 8).join(', ')}`, [], pk);
      const http4 = P.httpErrors.filter((h) => !h.expected);
      const hByUrl = new Map();
      for (const h of http4) { const k = `${h.status} ${h.url.split('?')[0]}`; if (!hByUrl.has(k)) hByUrl.set(k, new Set()); hByUrl.get(k).add(h.step); }
      for (const [k, steps] of hByUrl) finding(/^5/.test(k) ? 'HIGH' : 'LOW', 'network', `${tag}HTTP ${k}`, `Steps: ${[...steps].slice(0, 6).join(', ')}`, [], pk);
      for (const f of P.failedRequests) finding('LOW', 'network', `${tag}Request failed: ${f.error} ${f.url.slice(0, 100)}`, `Step ${f.step}`, [], pk);
      for (const d of P.nativeDialogs) finding('MEDIUM', 'dialogs', `${tag}Browser-native ${d.type}() dialog`, `"${d.message}" at ${d.step}`, [], pk);
      // Untranslated
      for (const pl of P.langs) {
        for (const [lang, v] of Object.entries(pl.langs)) {
          if (lang === 'en' || !v.untranslated || !v.untranslated.length) continue;
          const n = v.untranslated.length;
          const sev = /signup|practice/.test(pl.page) ? (n >= 3 ? 'HIGH' : 'MEDIUM') : (n >= 5 ? 'MEDIUM' : 'LOW');
          finding(sev, 'i18n', `${tag}${pl.page} (${lang.toUpperCase()}): ${n} string${n > 1 ? 's' : ''} still in English`, v.untranslated.slice(0, 8).map((u) => `"${u.text}"${u.i18nKey ? ` [${u.i18nKey}]` : ''}`).join('; '), [v.shot], pk);
        }
      }
      // Timing
      for (const t of P.timings) {
        if (!t.lcp && !t.wallLoadMs) continue;
        const lcp = t.lcp || 0;
        if (pk === 'low' && !/repeat/.test(t.label) && lcp > 10000) finding('HIGH', 'speed', `${tag}${t.label}: LCP ${(lcp / 1000).toFixed(1)} s on the low-end profile`, `Load ${(t.wallLoadMs / 1000).toFixed(1)} s, ${(t.bytes / 1024).toFixed(0)} KB, ${t.requests} requests`, [], pk);
        else if (pk === 'low' && !/repeat/.test(t.label) && lcp > 6000) finding('MEDIUM', 'speed', `${tag}${t.label}: LCP ${(lcp / 1000).toFixed(1)} s on the low-end profile`, `Load ${(t.wallLoadMs / 1000).toFixed(1)} s, ${(t.bytes / 1024).toFixed(0)} KB`, [], pk);
        if (t.bytes > 2.5 * 1024 * 1024 && !/repeat/.test(t.label)) finding('MEDIUM', 'speed', `${tag}${t.label}: ${(t.bytes / 1048576).toFixed(1)} MB transferred`, 'On Slow 4G that is ~' + Math.round(t.bytes / 180000) + ' s of transfer alone.', [], pk);
        if (t.cls > 0.1) finding('LOW', 'speed', `${tag}${t.label}: layout shift ${t.cls}`, '', [], pk);
      }
      // Overflow (no horizontal scroll, but content past the edge)
      for (const o of P.overflowNotes) finding('MEDIUM', 'layout', `${tag}${o.tag}: content past the right edge`, o.offenders.slice(0, 4).map((x) => `${x.d} right=${x.right}px "${x.text}"`).join('; '), [o.shot], pk);
      // Clipped / spilled text, grouped by element so one header rule is one finding.
      for (const [notes, what, sev] of [[P.clipNotes, 'text clipped (ellipsis/hidden)', 'LOW'], [P.spillNotes, 'text spills out of its box', 'LOW']]) {
        const by = new Map();
        for (const o of notes) for (const x of o.items) {
          if (!by.has(x.d)) by.set(x.d, { pages: new Set(), samples: [], shots: [] });
          const g = by.get(x.d);
          g.pages.add(o.tag);
          if (g.samples.length < 6 && !g.samples.some((s) => s.startsWith(`"${x.text}"`))) g.samples.push(`"${x.text}" ${x.sw}/${x.cw}px`);
          if (g.shots.length < 3 && o.shot) g.shots.push(o.shot);
        }
        for (const [d, g] of by) finding(g.pages.size >= 4 && sev === 'LOW' ? 'MEDIUM' : sev, 'layout', `${tag}${d}: ${what} on ${g.pages.size} page/language views`, `${g.samples.join('; ')} — on ${[...g.pages].slice(0, 12).join(', ')}`, g.shots, pk);
      }
      if (P.noLangButton && P.noLangButton.length) {
        const pages = [...new Set(P.noLangButton.map((s) => s.split(':')[0]))];
        finding('MEDIUM', 'i18n', `${tag}No language button on: ${pages.join(', ')}`, 'A visitor who lands here in the wrong language has no way to switch on this page (the harness used HawkeyeI18n.set).', [], pk);
      }
    }
  }
  if (SAFETY.blocked.length) finding('HIGH', 'safety', `${SAFETY.blocked.length} write(s) to production were blocked by the harness`, SAFETY.blocked.slice(0, 6).map((b) => `${b.method} ${b.url} (${b.why}) at ${b.at}`).join('; '));
  if (SAFETY.sentry) finding('MEDIUM', 'errors', `The pages tried to send ${SAFETY.sentry} Sentry event(s) during the run (blocked)`, 'Each is an error the site itself noticed; see console/uncaught sections.');
}

function mdEscape(s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function img(rel) { return rel ? `[${path.basename(rel)}](${rel})` : ''; }

function writeReport() {
  // Deduplicate identical findings across profiles: same sev+title -> merge profiles.
  const merged = new Map();
  for (const f of R.findings) {
    const k = `${f.sev}|${f.title}`;
    if (!merged.has(k)) merged.set(k, { ...f, profiles: new Set([f.profile].filter(Boolean)), shots: [...f.shots] });
    else { const m = merged.get(k); if (f.profile) m.profiles.add(f.profile); m.shots.push(...f.shots); }
  }
  const list = [...merged.values()].sort((a, b) => sevRank(a.sev) - sevRank(b.sev) || a.area.localeCompare(b.area));
  const L = [];
  L.push('# First-time observer walkthrough — automated run', '');
  L.push(`Run ${R.startedAt} against ${SITE} (live). Build: ${R.build || 'unknown'}. Native export: ${R.nativeBuild || 'not run'}.`, '');
  L.push('Profiles: ' + Object.values(R.profiles).map((p) => p.label).join('; ') + '.', '');
  L.push('## Safety log (nothing written to production)', '');
  L.push(`- Sign-in requests allowed through (all refused by FORMAT on the server, before any lookup/write/send): ${SAFETY.allowedWrites.length}`);
  const ph = [...new Set(SAFETY.allowedWrites.map((a) => `${a.path} ${a.phone}`))];
  for (const p of ph) L.push(`  - ${p}`);
  L.push(`- Writes blocked by the harness: ${SAFETY.blocked.length}${SAFETY.blocked.length ? ' — ' + SAFETY.blocked.slice(0, 5).map((b) => `${b.method} ${b.url}`).join('; ') : ''}`);
  L.push(`- Practice submits answered by the local STUB (never reached the practice chain): ${SAFETY.stubbed.length}`);
  L.push(`- Signed-out device resume calls (POST /api/observers/resume, read-only for a never-seen device id) let through: ${SAFETY.resumes || 0}`);
  L.push(`- Sentry events blocked: ${SAFETY.sentry}; APK downloads skipped: ${SAFETY.apkSkipped.length}; new tabs closed: ${SAFETY.popupsClosed.length}`);
  L.push(`- In-page guard hits (writes stopped inside the page before any request): ${SAFETY.pageGuard.length}${SAFETY.pageGuard.length ? ' — ' + [...new Set(SAFETY.pageGuard.map((h) => h.what))].slice(0, 8).join('; ') : ''}`);
  for (const [k, p] of Object.entries(R.profiles)) if (p.web && p.web.noLangButton && p.web.noLangButton.length) L.push(`- No visible header language button (switched via HawkeyeI18n.set) at: ${[...new Set(p.web.noLangButton)].join(', ')} (${k})`);
  L.push('');
  for (const [k, p] of Object.entries(R.profiles)) if (p.web && p.web.control) L.push(`Throughput control (${k}): ${p.web.control.bytes} bytes in ${p.web.control.ms} ms = ${p.web.control.kbps} kbit/s.`);
  L.push('');
  for (const [k, p] of Object.entries(R.profiles)) {
    for (const P of [p.web, p.native].filter(Boolean)) {
      const n = P.langs.reduce((a, pl) => a + Object.keys(pl.langs).filter((l) => l !== 'en').length, 0);
      L.push(`Untranslated-text detector control (${k}${P === p.native ? ' native' : ''}): an injected English sentence was caught in ${n - P.controlMisses.length}/${n} language passes${P.controlMisses.length ? ` — MISSED at ${P.controlMisses.join(', ')} (treat those passes' "0" as unproven)` : ''}.`);
    }
  }
  L.push('');
  L.push('## Findings (severity-ranked)', '');
  L.push('| # | Severity | Area | Finding | Profiles | Detail | Screenshots |', '|---|---|---|---|---|---|---|');
  list.forEach((f, i) => L.push(`| ${i + 1} | ${f.sev} | ${f.area} | ${mdEscape(f.title)} | ${[...f.profiles].join(', ')} | ${mdEscape(f.detail).slice(0, 600)} | ${[...new Set(f.shots.filter(Boolean))].slice(0, 3).map(img).join(' ')} |`));
  L.push('');
  for (const [k, p] of Object.entries(R.profiles)) {
    const P = p.web;
    L.push(`## ${p.label}`, '');
    if (P) {
      L.push('### Page loads', '', '| Step | Load (wall) | TTFB | FCP | LCP | CLS | Long tasks | KB | Requests (SW/cache) |', '|---|---|---|---|---|---|---|---|---|');
      for (const t of P.timings) L.push(`| ${t.label} | ${t.wallLoadMs ? (t.wallLoadMs / 1000).toFixed(1) + ' s' : '-'} | ${t.ttfb ?? '-'} | ${t.fcp ?? '-'} | ${t.lcp ?? '-'} | ${t.cls ?? '-'} | ${t.longTasks ?? '-'} (${t.longTaskMs ?? '-'} ms) | ${t.bytes ? (t.bytes / 1024).toFixed(0) : '-'} | ${t.requests ?? '-'} (${t.fromSW ?? '-'}/${t.fromCache ?? '-'}) |`);
      L.push('', '### Interactions', '', '| What | ms |', '|---|---|');
      for (const it of P.interactions) L.push(`| ${mdEscape(it.what)}${it.ok === false ? ' (FAILED)' : ''} | ${it.ms} |`);
      L.push('', '### Sign-up', '');
      L.push(`- Arrived via "${P.signup.ctaText}". Initial: checked=${JSON.stringify(P.signup.initial && P.signup.initial.checked)}, button disabled=${P.signup.initial && P.signup.initial.btnDisabled}, "choose a route" line shown=${P.signup.initial && P.signup.initial.needVisible}.`);
      L.push(`- Route order on screen: ${(P.signup.order || []).join(' > ')}${P.signup.smsHidden ? ' (SMS not offered: /api/health smsOtp off)' : ''}. Positions: ${JSON.stringify((P.signup.initial && P.signup.initial.options) || [])}`);
      if (P.signup.whatsappPasswordFirst) L.push(`- WhatsApp asks for a password first: "${P.signup.whatsappPasswordFirst.dialog}" ${img(P.signup.whatsappPasswordFirst.shot)}`);
      if (P.signup.orgMode) L.push(`- ORG code typed (not submitted): ${JSON.stringify(P.signup.orgMode)}`);
      if (P.signup.noRouteTap) L.push(`- Tapped the greyed Request OTP with NO route and a number typed: requests sent=${P.signup.noRouteTap.requestsMade}, "choose how to verify" line shown=${P.signup.noRouteTap.needVisible}, dialog=${JSON.stringify(P.signup.noRouteTap.dialog)} ${img(P.signup.noRouteTap.shot)}`);
      L.push('', '| Test | Route | Lang | Server | Message shown | ms | Shot |', '|---|---|---|---|---|---|---|');
      for (const t of [...(P.signup.tests || []), ...(P.signup.byLang || [])]) L.push(`| ${t.label || t.number} | ${t.channel} | ${t.lang} | ${t.status ?? '-'} ${t.body ? mdEscape(t.body.error) : ''} | ${mdEscape(t.dialog)}${t.english ? ' **(English)**' : ''} | ${t.ms} | ${img(t.shot)} |`);
      L.push('', '### Practice', '');
      L.push(`- State: ${P.practice.state}; camera ${P.practice.cameraFailed ? 'FAILED (used sample)' : `live in ${P.practice.cameraMs} ms`}; parties: ${P.practice.parties}; submit enabled: ${P.practice.submitEnabled}; done screen: ${P.practice.done}; receipt card: ${P.practice.receipt}.`);
      if (P.practice.doneInfo) L.push(`- Done screen: ${JSON.stringify(P.practice.doneInfo)}`);
      L.push('', '### Download page', '');
      for (const l of (P.download.links || [])) L.push(`- ${mdEscape(l.text) || '(no text)'} -> ${l.href}${l.head ? ` (HEAD ${JSON.stringify(l.head)})` : ''}`);
      if (P.download.buttons) L.push(`- Buttons: ${P.download.buttons.join(' | ')}`);
      L.push('', '### Keyboard', '');
      for (const kb of P.keyboard) L.push(`- ${kb.label}: in view=${kb.inView}, covered by=${kb.coveredBy || 'nothing'}, content left=${kb.contentPx}px of ${kb.vh}px, next control=${JSON.stringify(kb.next)} ${img(kb.shot)}`);
      L.push('', '### Untranslated strings by page', '');
      for (const pl of P.langs) {
        const parts = Object.entries(pl.langs).filter(([l]) => l !== 'en').map(([l, v]) => `${l.toUpperCase()} ${v.untranslated ? v.untranslated.length : '?'}${v.switched ? ` (switch ${v.switched.ms} ms)` : ''} ${img(v.shot)}`);
        L.push(`- **${pl.page}**: ${parts.join(' · ')}`);
        for (const [l, v] of Object.entries(pl.langs)) if (l !== 'en' && v.untranslated && v.untranslated.length) L.push(`  - ${l.toUpperCase()}: ${v.untranslated.slice(0, 12).map((u) => `"${mdEscape(u.text)}"`).join(', ')}`);
      }
      if (P.firstOverlays) L.push('', `First-paint overlays on landing: ${JSON.stringify(P.firstOverlays)}`);
      if (P.menuItems) L.push('', `Menu (signed out): ${P.menuItems.join(' | ')} ${img(P.menuShot)}`);
      L.push('');
    }
    const N = p.native;
    if (N) {
      L.push(`### Native app (react-native-web export) — ${k}`, '');
      L.push(`- Welcome texts: ${(N.welcomeTexts || []).slice(0, 12).join(' | ')}`);
      for (const [lbl, r] of Object.entries(N.langButton || {})) {
        L.push(`- Language button on ${lbl}: visible=${r.visible}, face ${r.face} -> ${r.faceAfter || '-'}, stored=${r.stored || '-'}, Hausa on screen=${r.hausaShown}${r.shot ? ` [shot](${r.shot})` : ''}`);
      }
      L.push(`- Harness note: ${N.hydrationErrors || 0} React hydration error(s) (#418/#419) came from the static web export itself (expo-router output: static), not from a phone build; they also account for the Sentry events blocked during this pass.`);
      L.push(`- Sign-up chips: ${JSON.stringify(N.signup.chips)}; Send code before a route: ${JSON.stringify(N.signup.sendInitial)}`);
      L.push('', '| Test | Lang | Server | New lines on screen | Shot |', '|---|---|---|---|---|');
      for (const t of (N.signup.tests || [])) L.push(`| ${t.label} (${t.number}) | ${t.lang} | ${t.status ?? '-'} ${t.body ? mdEscape(t.body.error) : ''} | ${mdEscape(t.lines.join(' / '))}${t.english ? ' **(English)**' : ''} | ${img(t.shot)} |`);
      L.push('', `- Practice: reached done=${!!N.practice.done}; steps:`);
      for (const s of N.practice.steps) L.push(`  - ${s.i}: clicked "${s.clicked || "-"}"${s.filled ? `, filled ${s.filled} counts` : ""}${s.offered ? ` (stopped; buttons on offer: ${mdEscape(s.offered.join(" | "))})` : ""} — ${mdEscape(s.texts.slice(0, 6).join(" / "))} ${img(s.shot)}`);
      for (const pl of N.langs) for (const [l, v] of Object.entries(pl.langs)) L.push(`- ${pl.page} ${l.toUpperCase()}: ${v.untranslated.length} English strings ${img(v.shot)}${v.untranslated.length ? ' — ' + v.untranslated.slice(0, 8).map((u) => `"${mdEscape(u.text)}"`).join(', ') : ''}`);
      for (const kb of N.keyboard) L.push(`- keyboard ${kb.label}: in view=${kb.inView}, covered by=${kb.coveredBy || 'nothing'} ${img(kb.shot)}`);
      L.push('');
    }
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), L.join('\n'));
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(R, (k, v) => (v instanceof Set ? [...v] : v), 2));
}

// ================================================================== MAIN
fs.mkdirSync(OUT, { recursive: true });
try {
  const sw = await (await fetch(`${SITE}/sw.js`, { signal: AbortSignal.timeout(20000) })).text();
  const m = sw.match(/(?:CACHE|VERSION)[A-Z_]*\s*=\s*['"`]([^'"`]+)['"`]/);
  R.build = m ? `sw.js ${m[1]}` : 'sw.js (no version string found)';
} catch (e) { R.build = 'unreachable: ' + e.message; }

const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (!flag('no-web')) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });
  for (const k of RUN) {
    try { await runWeb(browser, PROFILES[k]); } catch (e) {
      finding('CRITICAL', 'harness', `Web walkthrough aborted (${k})`, String(e.stack || e).slice(0, 800), [], k);
      console.error(e);
    }
  }
  await browser.close();
}
if (!flag('no-native')) {
  if (!fs.existsSync(path.join(NATIVE_DIR, 'sign-in.html'))) {
    R.nativeBuild = `missing: run npx expo export --platform web --output-dir ${NATIVE_DIR}`;
  } else {
    R.nativeBuild = `${NATIVE_DIR} (exported ${fs.statSync(path.join(NATIVE_DIR, 'sign-in.html')).mtime.toISOString()})`;
    const server = await startNativeServer(NATIVE_DIR);
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ executablePath: CHROME, args: [...ARGS, '--disable-web-security'] });
    for (const k of RUN) {
      if (!R.profiles[k]) R.profiles[k] = { label: PROFILES[k].label };
      try { await runNative(browser, PROFILES[k], base); } catch (e) {
        finding('HIGH', 'harness', `Native walkthrough aborted (${k})`, String(e.stack || e).slice(0, 800), [], k);
        console.error(e);
      }
    }
    await browser.close();
    server.close();
  }
}
summarise();
writeReport();
log(`done: ${R.findings.length} findings -> ${OUT}/REPORT.md`);
log(`safety: ${SAFETY.allowedWrites.length} refused-number requests, ${SAFETY.blocked.length} blocked, ${SAFETY.stubbed.length} stubbed, ${SAFETY.sentry} sentry blocked`);

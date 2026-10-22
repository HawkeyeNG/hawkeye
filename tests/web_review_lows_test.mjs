/**
 * THE WEB REVIEW'S LOW ITEMS (PR #17 L3, L4, L5, L6, L7, L8), each run or read
 * from the real file:
 *   L6  notifications.html localUrl(): an alert URL off our site is followed
 *       only if it is http(s) — a javascript: / data: URL becomes '#'.
 *   L8  app.js ensureKeys(): two first calls on a fresh install share ONE
 *       generated key instead of each storing their own.
 *   L3  geo-msg.js: the four location lines come from geo.* in the reader's
 *       language; L4 capture.js: "Camera unavailable" likewise.
 *   L5  outbox.js: the reason a set-aside (dropped) report is shown with is
 *       built when shown, in the reader's language (observe.err.* / outbox.refused).
 *   L7  admin.html / review.html incident queue: server fields go in as text.
 * Each check fails on the code before the fix.
 *
 *   node tests/web_review_lows_test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { APP, tally } from './helpers/harness.mjs';

const { check, finish } = tally();
const read = (f) => fs.readFileSync(`${APP}/${f}`, 'utf8');

// ---- L6 -------------------------------------------------------------------------
{
  const src = read('notifications.html');
  const fn = src.slice(src.indexOf('function localUrl(u)'), src.indexOf('// Mark ONE alert read'));
  const ctx = vm.createContext({ URL, location: { href: 'https://hawkeye.com.ng/notifications.html' }, window: {} });
  vm.runInContext(`const NOT_IN_APP = /^\\/(room\\/|situation-room\\.html)/; ${fn}; this.localUrl = localUrl;`, ctx);
  check('L6 a javascript: alert URL becomes "#"', ctx.localUrl('javascript:alert(document.cookie)'), '#');
  check('L6 a data: alert URL becomes "#"', ctx.localUrl('data:text/html,<script>alert(1)</script>'), '#');
  check('L6 CONTROL an ordinary outside https link is kept', ctx.localUrl('https://www.inecnigeria.org/x?y=1'), 'https://www.inecnigeria.org/x?y=1');
  check('L6 CONTROL our own link goes relative', ctx.localUrl('https://hawkeye.com.ng/race.html?c=PRES#u'), '/race.html?c=PRES#u');
}

// ---- L8 -------------------------------------------------------------------------
{
  const src = read('app.js');
  const at = src.indexOf('let keysInFlight') >= 0 ? src.indexOf('let keysInFlight') : src.indexOf('async function ensureKeys()');
  const end = src.indexOf('async function signPayload');
  let made = 0;
  const store = {};
  const ctx = vm.createContext({
    kvGet: async (k) => { await new Promise((r) => setTimeout(r, 5)); return store[k]; },
    kvSet: async (k, v) => { await new Promise((r) => setTimeout(r, 5)); store[k] = v; },
    crypto: { subtle: { generateKey: async () => { made += 1; await new Promise((r) => setTimeout(r, 20)); return { id: made }; } } },
    setTimeout,
  });
  vm.runInContext(`${src.slice(at, end)}; this.ensureKeys = ensureKeys;`, ctx);
  const [a, b] = await Promise.all([ctx.ensureKeys(), ctx.ensureKeys()]);
  check('L8 two first calls generate ONE key', made, 1);
  check('L8 ...and both get the key that was stored', a === b && store.keypair === a, true);
  const c = await ctx.ensureKeys();
  check('L8 CONTROL a later call reuses the stored key', c === a && made === 1, true);
}

// ---- L3 / L4 ----------------------------------------------------------------------
{
  const geo = read('geo-msg.js');
  const asked = [];
  const window = { HawkeyeI18n: { t: (k, en) => { asked.push(k); return `[${k}]`; } } };
  vm.runInContext(geo, vm.createContext({ window }));
  const line = window.HAWKEYE_GEO.line({ code: 1 });
  check('L3 a location failure is shown through geo.* (translated)', /^\[geo\.[a-z]+\]$/.test(line), true);
  const bundles = Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(read(`i18n/${l}.json`))]));
  const keys = ['geo.denied', 'geo.unavailable', 'geo.timeout', 'geo.error', 'capture.camera-unavailable'];
  const missing = [];
  for (const k of keys) for (const l of ['en', 'ha', 'ig', 'yo']) {
    const v = bundles[l][k];
    if (typeof v !== 'string' || v !== v.normalize('NFC') || (l !== 'en' && v === bundles.en[k])) missing.push(`${l}:${k}`);
  }
  check('L3/L4 every new line is in en/ha/ig/yo (NFC, not English)', missing, []);
  check('L4 capture.js shows "Camera unavailable" through its key', /T\('capture\.camera-unavailable'/.test(read('capture.js')), true);
  check('L4 ...and every language keeps {v0}', keys.slice(4).every((k) => ['en', 'ha', 'ig', 'yo'].every((l) => String(bundles[l][k]).includes('{v0}'))), true);
}

// ---- L5 -------------------------------------------------------------------------
{
  // The SHIPPED outbox.js in a service-worker-shaped realm (no document, so
  // nothing starts on load), with a bundle standing in for i18n.js.
  const load = (lang, dict) => {
    const G = {
      navigator: { onLine: true }, addEventListener() {}, dispatchEvent() {},
      HawkeyeI18n: { current: lang, t: (k, fb) => (Object.prototype.hasOwnProperty.call(dict, k) ? dict[k] : fb === undefined ? k : fb) },
    };
    vm.runInNewContext(read('outbox.js'), { self: G, indexedDB: {}, setTimeout, clearTimeout, setInterval, console });
    return G.HawkeyeOutbox;
  };
  // Before the fix the alert printed the stored English `why` as it was.
  const reason = (O, d) => (typeof O.reasonOf === 'function' ? O.reasonOf(d) : d.why);
  const ha = JSON.parse(read('i18n/ha.json'));
  const yo = JSON.parse(read('i18n/yo.json'));
  const drop = { label: '01-01-01-001 · PRES', status: 401, code: 'bad_signature',
    hint: 'Signature check failed — refresh and try again.', why: 'Signature check failed — refresh and try again. (bad_signature / HTTP 401)' };
  check('L5 Hausa: a set-aside report is explained in Hausa, not by the English hint',
    reason(load('ha', ha), drop), `${ha['observe.err.bad-signature']} (bad_signature / HTTP 401)`);
  check('L5 Yorùbá: a code we have no line for, with no hint, says "refused" in Yorùbá',
    reason(load('yo', yo), { status: 400, code: 'weird_code', hint: null }), `${yo['outbox.refused']} (weird_code / HTTP 400)`);
  check('L5 CONTROL English keeps the server hint (it can carry detail)',
    reason(load('en', {}), drop), drop.why);
  check('L5 CONTROL a drop recorded before this change still shows its stored reason',
    reason(load('ha', ha), { label: 'x', why: 'old reason (x / HTTP 400)' }), 'old reason (x / HTTP 400)');
  const src = read('outbox.js');
  check('L5 the alert shows reasonOf(d), and a drop records status, code and hint',
    src.includes('${reasonOf(d)}') && /status: resp\.status,\s*code:/.test(src) && /hint: body && typeof body\.hint/.test(src), true);
  const bad = ['en', 'ha', 'ig', 'yo'].filter((l) => {
    const v = JSON.parse(read(`i18n/${l}.json`))['outbox.refused'];
    return typeof v !== 'string' || v !== v.normalize('NFC') || (l !== 'en' && v === 'The server refused it');
  });
  check('L5 outbox.refused is in en/ha/ig/yo (NFC, not English)', bad, []);

  // The label too: an unnamed drop is stored with no English stand-in and
  // named when shown. Before the fix the stored label was printed as it was.
  const label = (O, d) => (typeof O.labelOf === 'function' ? O.labelOf(d) : d.label);
  check('L5 Hausa: an unnamed drop is called a report in Hausa', label(load('ha', ha), { label: '' }), ha['outbox.report-label']);
  check('L5 Yorùbá: a drop stored before this as "report" is named in Yorùbá too',
    label(load('yo', yo), { label: 'report' }), yo['outbox.report-label']);
  check('L5 CONTROL a real label (unit · race) is kept as it is',
    label(load('ha', ha), { label: '01-01-01-001 · PRES' }), '01-01-01-001 · PRES');
  check('L5 CONTROL English still says report', label(load('en', {}), { label: 'report' }), 'report');
  check('L5 the drop stores no English "report", and the alert shows labelOf(d)',
    !/\|\| 'report',/.test(src) && src.includes('${labelOf(d)}: ${reasonOf(d)}'), true);
  const badLabel = ['en', 'ha', 'ig', 'yo'].filter((l) => {
    const v = JSON.parse(read(`i18n/${l}.json`))['outbox.report-label'];
    return typeof v !== 'string' || v !== v.normalize('NFC') || (l !== 'en' && v === 'report');
  });
  check('L5 outbox.report-label is in en/ha/ig/yo (NFC, not English)', badLabel, []);
}

// ---- L7 -------------------------------------------------------------------------
for (const page of ['admin.html', 'review.html']) {
  const s = read(page);
  check(`L7 ${page}: the incident kind is escaped`, s.includes('<h3>${escAttr(KIND[i.kind] || i.kind)}</h3>'), true);
  check(`L7 ${page}: state, unit code and AI fields are escaped; map link uses numbers`,
    s.includes("escAttr(i.state)") && s.includes('escAttr(i.pu_code)') && s.includes('escAttr(i.ai.kind)')
      && s.includes('escAttr(i.ai.urgency)') && s.includes('?q=${Number(i.lat)},${Number(i.lng)}'), true);
}

finish();

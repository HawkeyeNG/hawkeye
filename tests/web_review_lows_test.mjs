/**
 * THE WEB REVIEW'S LOW ITEMS (PR #17 L3, L4, L6, L7, L8), each run or read
 * from the real file:
 *   L6  notifications.html localUrl(): an alert URL off our site is followed
 *       only if it is http(s) — a javascript: / data: URL becomes '#'.
 *   L8  app.js ensureKeys(): two first calls on a fresh install share ONE
 *       generated key instead of each storing their own.
 *   L3  geo-msg.js: the four location lines come from geo.* in the reader's
 *       language; L4 capture.js: "Camera unavailable" likewise.
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

// ---- L7 -------------------------------------------------------------------------
for (const page of ['admin.html', 'review.html']) {
  const s = read(page);
  check(`L7 ${page}: the incident kind is escaped`, s.includes('<h3>${escAttr(KIND[i.kind] || i.kind)}</h3>'), true);
  check(`L7 ${page}: state, unit code and AI fields are escaped; map link uses numbers`,
    s.includes("escAttr(i.state)") && s.includes('escAttr(i.pu_code)') && s.includes('escAttr(i.ai.kind)')
      && s.includes('escAttr(i.ai.urgency)') && s.includes('?q=${Number(i.lat)},${Number(i.lng)}'), true);
}

finish();

// A LINK THAT CRASHED THE APP, AND WHAT A CRASH REPORT CARRIED OFF THE PHONE
// (pre-election review, native/).
//
//   1. lib/web-routes.ts decoded join.html?t= with a bare decodeURIComponent.
//      A malformed escape (a link cut short in a forward: ?t=%E0, ?t=%) threw
//      URIError from the push-tap handler (lib/push.ts nativeRoute, in a root
//      layout effect -> the error screen) and from My Groups' paste-a-link box
//      (an uncaught throw in a press handler). Now it is no token: the link
//      lands on My Groups. CONTROL: a well-formed link still opens the invite.
//   2. lib/monitor.ts scrubbed 0803… and +234 803… but let through the other
//      ways Nigerian numbers are written, any GPS fix quoted in an error
//      message, and the group invite token in /api/join/<token> fetch
//      breadcrumbs (22 characters, under the 24-character LONG rule). The same
//      patterns as app/monitor.js now, plus the join path. CONTROL: ordinary
//      error text comes through intact.
//
// The SHIPPED web-routes.ts and monitor.ts run in Node via
// tests/helpers/native-loader.mjs (monitor's Sentry SDK is a stub that keeps
// the options it was initialised with, so beforeSend is the real one).
//
//   node tests/native_links_privacy_test.mjs
import { tally } from './helpers/harness.mjs';
import { loadNative } from './helpers/native-loader.mjs';

const { check, finish } = tally();
globalThis.__DEV__ = false;
const N = globalThis.__native;
const W = await loadNative('lib/web-routes.ts');
await loadNative('lib/monitor.ts');

console.log('=== 1. a malformed invite link ===');
const tryIt = (f) => { try { return f(); } catch (e) { return `THROWS ${e.name}`; } };
for (const u of ['https://hawkeye.com.ng/join.html?t=%E0', '/join.html?t=%', 'hawkeye.com.ng/join.html?t=%zz']) {
  check(`webPageRoute("${u}") does not throw`, tryIt(() => W.webPageRoute(u)), (v) => typeof v !== 'string' || !v.startsWith('THROWS'));
  check(`inviteToken("${u}") does not throw`, tryIt(() => W.inviteToken(u)), null);
}
check('CONTROL: a well-formed join.html link opens the invite',
  W.webPageRoute('https://hawkeye.com.ng/join.html?t=AbCdEfGhIjKlMnOpQrStUv'), '/join/AbCdEfGhIjKlMnOpQrStUv');

console.log('\n=== 2. what a crash report carries ===');
const opts = N.sentryOptions;
check('monitor.ts initialises Sentry with a beforeSend', typeof opts?.beforeSend, 'function');
const scrub = (msg) => opts.beforeSend({ exception: { values: [{ type: 'Error', value: msg }] } }).exception.values[0].value;
for (const n of ['08031234567', '+234 803 123 4567', '2348031234567', '0803-123-4567',
  '803-123-4567', '8031234567', '+234-803-123-4567', '+234 (0) 803 123 4567', '0803  123 4567']) {
  check(`phone "${n}" is removed`, scrub(`call failed for ${n} now`), (v) => !/\d{3}/.test(v));
}
for (const c of ['lat 6.524379, lng 3.379206', 'fix (-12.345678,7.123456)']) {
  check(`GPS fix "${c}" is removed`, scrub(`no unit near ${c}`), (v) => !/\d\.\d{4}/.test(v));
}
check('an invite token in a join URL path is removed',
  opts.beforeBreadcrumb({ category: 'fetch', data: { url: 'https://hawkeye.com.ng/api/join/AbCdEfGhIjKlMnOpQrStUv', status_code: 404 } }).data.url,
  (v) => !v.includes('AbCdEfGhIjKlMnOpQrStUv'));
for (const s of ['SDK 11.0.0 took 12.5 ms', 'parties 18 of 18 loaded, retry 3', 'epoch 1729000000123', 'unit 30-05-07-001', 'HTTP 503 on /api/results']) {
  check(`CONTROL: "${s}" is left alone`, scrub(s), s);
}

finish();

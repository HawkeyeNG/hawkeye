/**
 * A PUSH MUST GO TO THE PLATFORM IT IS ABOUT — and to that one only.
 *
 * Two shapes, and they are different problems:
 *
 *   SAME message, different destination — "update from the store". Solved WITHOUT
 *   targeting, by /get, which redirects each device to its own store. One
 *   notification, one URL, and it survives a third platform.
 *
 *   DIFFERENT message, one platform — an Android-only crash fix. Told to iPhone
 *   users that is noise at best, and on an election tool an invitation to
 *   distrust the next notification. That needs real targeting.
 *
 * The failure this guards is silent: a filter that matches nothing still reports
 * a successful send, to nobody.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- an in-memory stand-in for the token table ----------------------------
const ROWS = [
  { token: 'fcm-a1', observer_id: 1, platform: 'android' },
  { token: 'fcm-a2', observer_id: 1, platform: 'android' },   // same person, 2 devices
  { token: 'fcm-a3', observer_id: 2, platform: 'android' },
  { token: 'fcm-i1', observer_id: 3, platform: 'ios' },
  { token: 'a'.repeat(64), observer_id: 4, platform: 'ios' }, // pre-switch APNs token
  { token: '{"endpoint":"x"}', observer_id: 5, platform: 'web' },
];

/** Mimics the WHERE clauses in broadcast(), reading the shipped source so the
 *  test cannot drift into testing its own idea of the query. */
const SRC = fs.readFileSync(`${ROOT}/backend/src/services/push.js`, 'utf8');

console.log('=== the shipped source actually filters by platform ===');
check('broadcast takes a platforms argument', /platforms = null/.test(SRC), true);
check('and validates it against a known list', /PUSH_PLATFORMS/.test(SRC), true);
check('an unknown platform THROWS rather than matching nothing',
  /unknown platform\(s\)/.test(SRC), true);
check('an empty list throws too', /platforms was empty/.test(SRC), true);
check('the FCM query is parameterised, not string-built',
  /t\.platform IN \(\$\{holes\}\)/.test(SRC), true);
check('ios is sent through the FCM path', /fcmWant/.test(SRC), true);
check('and the people count is scoped to the same platforms',
  /peopleHoles/.test(SRC), true);
check('android and ios are still reported separately',
  /ios: iosCount/.test(SRC) && /android: androidCount/.test(SRC), true);

console.log('\n=== the selection logic, run over a fixture ===');
// The exact predicate the SQL expresses, applied to the rows above.
const select = (platforms) => {
  const PUSH_PLATFORMS = ['android', 'ios', 'web'];
  let want = PUSH_PLATFORMS;
  if (platforms != null) {
    const list = (Array.isArray(platforms) ? platforms : [platforms]).map((p) => String(p).trim());
    const bad = list.filter((p) => !PUSH_PLATFORMS.includes(p));
    if (bad.length) throw new Error(`unknown platform(s) ${bad.join(', ')}`);
    if (!list.length) throw new Error('platforms was empty');
    want = [...new Set(list)];
  }
  const fcm = ROWS.filter((r) => want.includes(r.platform) && r.platform !== 'web');
  const web = want.includes('web') ? ROWS.filter((r) => r.platform === 'web') : [];
  const ios = fcm.filter((r) => r.platform === 'ios').length;
  return {
    audience: fcm.length + web.length,
    android: fcm.length - ios,
    ios,
    web: web.length,
    people: new Set(ROWS.filter((r) => want.includes(r.platform)).map((r) => r.observer_id)).size,
  };
};

check('no argument reaches everyone', select(null),
  { audience: 6, android: 3, ios: 2, web: 1, people: 5 });
check('android only', select(['android']),
  { audience: 3, android: 3, ios: 0, web: 0, people: 2 });
check('ios only', select(['ios']),
  { audience: 2, android: 0, ios: 2, web: 0, people: 2 });
check('web only', select(['web']),
  { audience: 1, android: 0, ios: 0, web: 1, people: 1 });
check('both mobile platforms, no web', select(['android', 'ios']),
  { audience: 5, android: 3, ios: 2, web: 0, people: 4 });
check('duplicates collapse', select(['ios', 'ios']), select(['ios']));

console.log('\n=== people is DEVICES-aware: two phones, one person ===');
// observer 1 has two Android tokens. audience counts devices, people does not.
check('android audience is 3 devices but 2 people',
  [select(['android']).audience, select(['android']).people], [3, 2]);

console.log('\n=== a typo must throw, not silently target nobody ===');
// Surrounding whitespace is TRIMMED, not rejected — this comes from a form
// field, and failing a send because someone's paste carried a space would be a
// worse outcome than accepting it. Case is NOT normalised: 'IOS' is a different
// string and quietly accepting it would hide a caller using the wrong constant.
check("'ios ' is trimmed and accepted", select(['ios ']), select(['ios']));
for (const bad of [['IOS'], ['iphone'], ['android', 'windows']]) {
  let threw = false;
  try { select(bad); } catch { threw = true; }
  check(`${JSON.stringify(bad)} throws`, threw, true);
}
let emptyThrew = false;
try { select([]); } catch { emptyThrew = true; }
check('an empty array throws', emptyThrew, true);

console.log('\n=== /get sends each device to its own store ===');
const SERVER = fs.readFileSync(`${ROOT}/backend/src/server.js`, 'utf8');
check('the route exists', /app\.get\('\/get'/.test(SERVER), true);
check('it is registered BEFORE express.static, or a file would win',
  SERVER.indexOf("app.get('/get'") < SERVER.indexOf('express.static(config.appDir)'), true);
check('iPhone goes to the App Store', /iPhone\|iPod[\s\S]{0,80}STORE_IOS/.test(SERVER), true);
check('Android goes to Play', /Android\/i\.test\(ua\)[\s\S]{0,60}STORE_ANDROID/.test(SERVER), true);
check('anything else lands on the install section', /index\.html#install/.test(SERVER), true);
check('302, not 301 — store URLs can change', /redirect\(302/.test(SERVER) && !/redirect\(301/.test(SERVER), true);
check('it names the real Play package',
  /id=ng\.com\.hawkeye\.observer/.test(SERVER), true);
check('and the real App Store listing', /id6804218478/.test(SERVER), true);

console.log('\n=== /get must NOT be an App Link, or the app intercepts itself ===');
const ASSET = fs.readFileSync(`${ROOT}/app/.well-known/assetlinks.json`, 'utf8');
check('assetlinks does not claim /get', /\/get/.test(ASSET), false);
const APPJSON = fs.readFileSync(`${ROOT}/native/app.json`, 'utf8');
const filters = APPJSON.slice(APPJSON.indexOf('"intentFilters"'), APPJSON.indexOf('"intentFilters"') + 900);
check('no intent filter claims /get', /"\/get"/.test(filters), false);

/**
 * THE CONSOLE MUST NOT SHOW ONE AUDIENCE AND SEND TO ANOTHER.
 *
 * The selector was wired to the send but not to the count: /push/audience took
 * no platforms and never reported iOS, so ticking "iPhone" left the total for
 * everyone on screen — and the confirmation prompt SCRAPED that banner for the
 * number it showed and for maxAudience. "Send to 107 device(s)?" for a send of
 * four is the precise failure pushKey exists to prevent, arriving by another
 * door.
 */
console.log('\n=== the audience count is scoped to the ticked platforms ===');
const ROUTE = fs.readFileSync(`${ROOT}/backend/src/routes/push.js`, 'utf8');
const AUD = ROUTE.slice(ROUTE.indexOf("'/push/audience'"), ROUTE.indexOf("'/push/broadcast'"));
check('the endpoint reads ?platforms', /req\.query\?\.platforms/.test(AUD), true);
check('and passes them to broadcast', /platforms,/.test(AUD), true);
check('it reports ios, which it never used to', /ios: r\.ios/.test(AUD), true);
check('an unknown platform is a 400, not a confident zero', /status\(400\)/.test(AUD), true);

const ADMIN = fs.readFileSync(`${ROOT}/app/admin.html`, 'utf8');
check('the console asks for a scoped count', /push\/audience\$\{qs\}/.test(ADMIN), true);
check('and prints the iPhone share', /iPhone, \$\{j\.web\} browser/.test(ADMIN), true);
check('ticking a platform re-counts', /pushRefresh\(\);\s*\n\s*\/\/[^]*?pushAudience\(\);/.test(ADMIN), true);

// ABSENCE, asserted across the WHOLE file rather than a window around an anchor
// — a fixed-size slice once missed a handler because the comment explaining it
// was longer than the window, and absence is the stronger claim anyway.
check('the banner is NOT scraped for the send size',
  /push-audience'\)\.textContent\.match/.test(ADMIN), false);
check('the confirmation uses the dry run figure', /pushDryAudience = j\.audience/.test(ADMIN), true);
check('which is cleared once sent', /pushDryAudience = 0/.test(ADMIN), true);

/**
 * A COUNT THAT INCLUDES DEVICES NOTHING CAN REACH MUST SAY SO.
 *
 * Every iOS row registered before the FCM switch holds a raw APNs token that
 * fcmSend declines by shape. Reporting "3 iPhone" and then "0 sent, 3 failed"
 * reads as a broken APNs key and sends someone off to re-upload a good one.
 */
console.log('\n=== undeliverable iPhones are counted and named ===');
check('the service counts raw-APNs rows', /const undeliverable = android\.filter/.test(SRC), true);
check('and returns it from a dry run',
  /dryRun\) return \{[^}]*undeliverable/.test(SRC), true);
check('and from a real send', /web: web\.length, undeliverable, sent, failed/.test(SRC), true);
check('the endpoint passes it through', /undeliverable: r\.undeliverable/.test(ROUTE), true);
// Reworded 2026-08-29. The old copy said these rows were "waiting on the next
// iOS build" and would clear themselves; neither was true, so the assertion now
// pins the explanation that IS true — the sender declines them by shape.
check('the console explains it rather than showing a bare number',
  /declines by shape/.test(ADMIN), true);
// And it must not go back to promising they self-clear: fcmSend returns before
// any network call, so no send failure ever prunes one. That is what
// prunePermanentlyUndeliverable() is for (tests/push_prune_test.mjs).
check('the console does not claim a send will clear them',
  /Stale devices are cleared by the first send/.test(ADMIN), false);
check('the prune exists and runs at boot',
  /export function prunePermanentlyUndeliverable/.test(SRC)
  && /prunePermanentlyUndeliverable\(\)/.test(fs.readFileSync(`${ROOT}/backend/src/server.js`, 'utf8')), true);
// The fixture holds exactly one such row — 'a'.repeat(64), observer 4.
check('the fixture would exercise it',
  ROWS.filter((r) => /^[0-9a-f]{64}$/i.test(r.token)).length, 1);

console.log('\n=== control: these source reads can actually fail ===');
check('a string that IS in admin.html is found', /pushPlatforms/.test(ADMIN), true);
check('a string that is NOT in it is not found', /pushBananaAudience/.test(ADMIN), false);

console.log('\n=== control: the fixture can distinguish audiences ===');
check('android-only and ios-only differ',
  JSON.stringify(select(['android'])) !== JSON.stringify(select(['ios'])), true);
check('and neither equals everyone',
  JSON.stringify(select(['android'])) !== JSON.stringify(select(null)), true);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

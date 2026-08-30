/**
 * fetchData MUST GO OFF-ORIGIN IN BOTH SHELLS, and stay relative in both the
 * website and a dev server.
 *
 * The bug this pins: the dev test was `location.protocol !== 'https:'`, which is
 * TRUE under iOS's `capacitor://localhost` — so every data fetch on iOS Lite
 * read the copy baked into the app. Harmless for anything still bundled, fatal
 * for the three geo layers strip_web_assets.sh deliberately removes, which is
 * why the Senate map died on iOS and worked on Android.
 *
 * Four contexts, and the answer differs for each. A test naming only the broken
 * one would pass on a fix that broke the website.
 *
 * Run: node tests/fetchdata_scheme_test.mjs
 */
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../app/native.js', import.meta.url), 'utf8');

let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

// Pull the two decisions out of the shipped source rather than restating them,
// so the test cannot pass against a file that no longer says this.
const onLiveSrc = /var onLive = (.+);/.exec(SRC)?.[1];
const isDevSrc = /var isDev = (.+);/.exec(SRC)?.[1];
console.log(`  onLive: ${onLiveSrc}`);
console.log(`  isDev : ${isDevSrc}`);
if (!onLiveSrc || !isDevSrc) { console.log('FAIL  could not read the decisions from native.js'); process.exit(1); }

/** Evaluate the real expressions against a stand-in location. */
function routeFor(protocol, hostname) {
  const location = { protocol, hostname };
  // eslint-disable-next-line no-new-func
  const onLive = Function('location', `return ${onLiveSrc};`)(location);
  // eslint-disable-next-line no-new-func
  const isDev = Function('location', `return ${isDevSrc};`)(location);
  return onLive || isDev ? 'relative' : 'live-origin';
}

console.log('\n=== where each context reads its data from ===');
check('the website reads relative', routeFor('https:', 'hawkeye.com.ng'), 'relative');
check('a dev server reads relative', routeFor('http:', 'localhost'), 'relative');
check('ANDROID Lite reads the live origin', routeFor('https:', 'localhost'), 'live-origin');
// The regression. capacitor:// is not https:, and the old test called that dev.
check('iOS Lite reads the live origin', routeFor('capacitor:', 'localhost'), 'live-origin');

console.log('\n=== the stripped layers are the reason this matters ===');
const strip = fs.readFileSync(new URL('../mobile/scripts/strip_web_assets.sh', import.meta.url), 'utf8');
for (const f of ['lga_geo.json', 'district_geo.json', 'constituency_geo.json']) {
  check(`${f} is stripped, so it MUST come off-origin`, strip.includes(f), true);
}
// The control: states_geo is deliberately KEPT, which is why the governorship
// map kept working and pointed at the difference.
check('states_geo.json is NOT stripped', /rm -f[^\n]*states_geo\.json/.test(strip), false);

console.log('\n=== control: the router can distinguish ===');
check('a bogus scheme is not treated as the website', routeFor('zzz:', 'example.com'), 'live-origin');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

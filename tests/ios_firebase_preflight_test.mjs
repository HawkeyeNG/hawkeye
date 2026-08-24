/**
 * THE TWO iOS SETTINGS THAT COST A BUILD EACH WHEN THEY ARE WRONG.
 *
 * Adding @react-native-firebase to native/ failed two EAS builds at Install
 * pods before one produced a binary. build_ios_testflight.sh now preflights
 * both locally, because the real failure happens on Expo's machines minutes in.
 *
 * A preflight that passes on everything is worse than none — it reads as proof.
 * So each check here runs over BOTH the current config and the config that
 * actually failed, and is required to tell them apart.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';

let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

/**
 * 1. FIREBASE MUST NOT RESOLVE THROUGH SPM.
 *
 *   [!] [react-native-firebase] SPM + static linkage is not supported
 *
 * v26 defaults to Swift Package Manager; those products are automatic
 * libraries, so every react-native-firebase pod embeds its own Firebase and
 * the copies collide under this project's static linkage.
 */
console.log('=== @react-native-firebase/app opts out of SPM ===');
const hasDisableSPM = (plugins) =>
  plugins.some((p) => Array.isArray(p) && p[0] === '@react-native-firebase/app' && p[1]?.ios?.disableSPM === true);

const APPJSON = JSON.parse(fs.readFileSync(`${ROOT}/native/app.json`, 'utf8')).expo;
check('the current app.json passes', hasDisableSPM(APPJSON.plugins), true);
// Exactly what shipped in build 1a869aad: the plugin as a bare string.
check('the config that ACTUALLY FAILED does not',
  hasDisableSPM(['expo-router', '@react-native-firebase/app', '@react-native-firebase/messaging']), false);
check('disableSPM:false is rejected too',
  hasDisableSPM([['@react-native-firebase/app', { ios: { disableSPM: false } }]]), false);

/**
 * 2. GOOGLEUTILITIES NEEDS MODULAR HEADERS.
 *
 *   [!] The following Swift pods cannot yet be integrated as static libraries:
 *       FirebaseCoreInternal depends upon GoogleUtilities, which does not
 *       define modules.
 *
 * Scoped to that one pod on purpose. use_frameworks! or a global
 * use_modular_headers! would change how EVERY pod links, and the build in App
 * Store review links the other way.
 */
console.log('\n=== GoogleUtilities gets modular headers, and only it ===');
const bp = APPJSON.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-build-properties');
const pods = bp?.[1]?.ios?.extraPods ?? [];
check('expo-build-properties is configured', Array.isArray(bp), true);
check('GoogleUtilities is listed with modular_headers',
  pods.some((p) => p.name === 'GoogleUtilities' && p.modular_headers === true), true);
check('and the blast radius is still one pod', pods.length, 1);
// If this ever fails, the fix is a deliberate decision, not a silent drift.
check('no global use_frameworks was introduced', bp?.[1]?.ios?.useFrameworks ?? null, null);

/**
 * 3. APS-ENVIRONMENT IS STATED, NOT INHERITED.
 *
 * expo-notifications' plugin writes the entitlement ONLY when absent and
 * defaults mode to 'development'. It is listed as a bare string, so nothing was
 * passing 'production'. A TestFlight build with the development entitlement
 * gets a SANDBOX device token while the server sends to production APNs: the
 * send reports success, the phone never rings, and it looks like a bad key.
 */
console.log('\n=== aps-environment follows the production flag ===');
const CFG = fs.readFileSync(`${ROOT}/native/app.config.js`, 'utf8');
check('the entitlement is set explicitly', /'aps-environment':/.test(CFG), true);
check('and it is tied to the production flag',
  /'aps-environment': production \? 'production' : 'development'/.test(CFG), true);
// The control: the file is genuinely being read, and a wrong claim would fail.
check('a string that is NOT in app.config.js is not found', /apsEnvironmentBanana/.test(CFG), false);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

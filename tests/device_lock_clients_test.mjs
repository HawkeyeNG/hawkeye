/**
 * ONE PHONE, ONE COUNTING ACCOUNT PER ELECTION — the client halves (backend:
 * backend/tests/device_claims_test.mjs).
 *
 *   node tests/device_lock_clients_test.mjs
 *
 * 1. app/device.js is RUN in a sandbox against fake Lite plugins: ANDROID_ID
 *    and a DeviceCheck token are sent only when the plugin has them, the token
 *    only for a report, a hung plugin is not waited on, a browser sends { app }.
 * 2. The wiring, checked structurally, each rule beside a mutated CONTROL:
 *    the receipt notices (web/Lite + native), the translated strings in every
 *    bundle (web, native, backend), sign-out telling the server, the native
 *    module (Swift DeviceCheck + Kotlin ANDROID_ID) and the Lite plugins.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const H = '/home/elrio/hawkeye';
const read = (p) => fs.readFileSync(path.join(H, p), 'utf8');
let fails = 0;
const check = (name, ok, got) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || got === undefined ? '' : `  (got ${JSON.stringify(got)?.slice(0, 300)})`}`);
  if (!ok) fails++;
};

// ---- 1. app/device.js, run ------------------------------------------------------
const deviceJs = read('app/device.js');
async function signalsWith(plugin, { lite = true, opts } = {}) {
  const window = {};
  if (lite) window.HAWKEYE = { native: true };
  if (plugin) window.Capacitor = { Plugins: { HawkeyeDevice: plugin } };
  const ctx = vm.createContext({ window, setTimeout, Promise, Object, String, JSON, localStorage: { getItem: () => 's', setItem() {} } });
  vm.runInContext(deviceJs, ctx);
  const t0 = Date.now();
  const out = await window.getDeviceSignals(opts);
  return { out: JSON.parse(JSON.stringify(out)), ms: Date.now() - t0 };
}
const AID = 'A1B2C3D4E5F60718';
const TOKEN = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
{
  const web = await signalsWith(null, { lite: false, opts: { deviceCheck: true } });
  check('a browser sends { app: "web" } only', JSON.stringify(web.out) === '{"app":"web"}', web.out);
  const old = await signalsWith({ signals: async () => ({ sibling: true }) }, { opts: { deviceCheck: true } });
  check('Lite 1.7 plugin (no androidId, no deviceCheck): exactly what it sent before', JSON.stringify(old.out) === '{"app":"lite","sibling":true}', old.out);
  const android = await signalsWith({ signals: async () => ({ sibling: false, androidId: AID }) });
  check('new Android Lite: androidId sent, lower-cased', android.out.androidId === AID.toLowerCase() && android.out.sibling === false, android.out);
  const junk = await signalsWith({ signals: async () => ({ androidId: 'not hex!' }) });
  check('CONTROL: a malformed androidId is not sent', !('androidId' in junk.out), junk.out);
  const ios = { signals: async () => ({ shared: 'a'.repeat(64) }), deviceCheck: async () => ({ token: TOKEN }) };
  const verdict = await signalsWith(ios);
  check('new iOS Lite, no deviceCheck asked (a verdict): no token', !('dc' in verdict.out) && verdict.out.shared === 'a'.repeat(64), verdict.out);
  const rep = await signalsWith(ios, { opts: { deviceCheck: true } });
  check('new iOS Lite, a report: a fresh DeviceCheck token rides along', rep.out.dc === TOKEN, rep.out);
  const hung = await signalsWith({ signals: async () => ({}), deviceCheck: () => new Promise(() => {}) }, { opts: { deviceCheck: true } });
  check(`a hung DeviceCheck is not waited on (${hung.ms} ms) and sends no token`, hung.ms < 3600 && !('dc' in hung.out), hung);
  const broken = await signalsWith({ signals: async () => { throw new Error('x'); }, deviceCheck: async () => { throw new Error('y'); } }, { opts: { deviceCheck: true } });
  check('a throwing plugin: { app } only, nothing thrown', JSON.stringify(broken.out) === '{"app":"lite"}', broken.out);
}

// ---- 2. wiring ---------------------------------------------------------------------
const appJs = read('app/app.js');
const webRules = (s) => [
  /getDeviceSignals\(\{\s*deviceCheck:\s*true\s*\}\)/.test(s),
  /body\.counted === false[\s\S]{0,400}T\('observe\.device-owned-not-counted'/.test(s),
];
check('app.js: the report asks for a DeviceCheck token; the receipt shows the translated notice', webRules(appJs).every(Boolean), webRules(appJs));
check('CONTROL: dropping the notice is caught', webRules(appJs.replace(/T\('observe\.device-owned-not-counted'/g, "T('x'"))[1] === false);

for (const p of ['app/menu.js', 'app/profile.html']) {
  const s = read(p);
  const rule = (x) => /\/api\/observers\/sign-out[\s\S]{0,600}removeItem\('hawkeye_token'\)/.test(x);
  check(`${p}: sign-out tells the server BEFORE the token is dropped`, rule(s));
  check(`CONTROL (${p}): without the call it is caught`, rule(s.replace(/\/api\/observers\/sign-out/g, '/x')) === false);
}

const WEB_KEY = 'observe.device-owned-not-counted';
const NATIVE_KEY = 'n.app.report.result.device-owned-not-counted';
const BACKEND_KEY = 'note.report.kept.body';
const bundles = (dir, key) => Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(read(`${dir}/${l}.json`))[key]]));
const translated = (b) => ['en', 'ha', 'ig', 'yo'].every((l) => typeof b[l] === 'string' && b[l].length > 20 && b[l] === b[l].normalize('NFC'))
  && ['ha', 'ig', 'yo'].every((l) => b[l] !== b.en);
const web = bundles('app/i18n', WEB_KEY);
check('web: the notice in en/ha/ig/yo (NFC, not English)', translated(web), web);
check('web: ...and in the catalogue', JSON.parse(read('scripts/i18n/catalogue.json'))[WEB_KEY] === web.en);
check('web: ...the English matches the fallback in app.js', appJs.includes(JSON.stringify(web.en).slice(1, -1).replace(/'/g, "\\'")) || appJs.includes(web.en));
const nat = bundles('native/src/lib/i18n', NATIVE_KEY);
check('native: the notice in en/ha/ig/yo', translated(nat), nat);
check('native: ...in the catalogue (so native_bundles.mjs keeps it)', JSON.parse(read('scripts/i18n/native_catalogue.json'))[NATIVE_KEY] === nat.en);
const be = bundles('backend/src/i18n', BACKEND_KEY);
check('backend: the alert body in en/ha/ig/yo', translated(be), be);
check('backend: ...every language keeps {unit} {code} {contest}', ['en', 'ha', 'ig', 'yo'].every((l) => ['{unit}', '{code}', '{contest}'].every((p) => be[l].includes(p))), be);
check('CONTROL: an English-only bundle would be caught', translated({ ...web, ha: web.en }) === false);

const result = read('native/src/app/report/result.tsx');
const submit = read('native/src/lib/submit.ts');
const nativeRules = [
  /r\.counted === false[\s\S]{0,300}n\.app\.report\.result\.device-owned-not-counted/.test(result),
  /counted:\s*body\.counted !== false/.test(submit),
  /deviceSignalsField\(\{\s*deviceCheck:\s*true\s*\}\)/.test(submit),
  !/deviceSignalsField\(\{\s*deviceCheck/.test(read('native/src/app/case.tsx')),
];
check('native: receipt notice; submit passes `counted`; a report (not a verdict) asks for DeviceCheck', nativeRules.every(Boolean), nativeRules);

const signals = read('native/src/lib/device-signals.ts');
const sigRules = (s) => [
  /Platform\.OS !== 'android'[\s\S]{0,200}androidId/.test(s),
  /Platform\.OS !== 'ios'[\s\S]{0,300}deviceCheckToken/.test(s),
  /typeof device\?\.deviceCheckToken !== 'function'/.test(s) && /typeof device\?\.androidId !== 'function'/.test(s),
];
check('device-signals.ts: ANDROID_ID on Android, DeviceCheck on iOS, both feature-detected', sigRules(signals).every(Boolean), sigRules(signals));
check('CONTROL: an unguarded call is caught', sigRules(signals.replace(/typeof device\?\.androidId !== 'function'/g, 'false'))[2] === false);

const auth = read('native/src/lib/auth.ts');
check('native signOut tells the server (best effort) before the session is cleared',
  /export async function signOut\(\)[\s\S]{0,700}\/api\/observers\/sign-out[\s\S]{0,700}await expireSession\(\)/.test(auth));

// ---- the native module and the Lite plugins ----------------------------------------------
const cfg = JSON.parse(read('native/modules/hawkeye-device/expo-module.config.json'));
check('expo module: apple AND android', cfg.platforms.includes('apple') && cfg.platforms.includes('android')
  && cfg.apple.modules.includes('HawkeyeDeviceModule'), cfg);
const swift = read('native/modules/hawkeye-device/ios/HawkeyeDeviceModule.swift');
check('Swift: import DeviceCheck, DCDevice.current.generateToken, AsyncFunction deviceCheckToken',
  /import DeviceCheck/.test(swift) && /DCDevice\.current/.test(swift) && /generateToken/.test(swift) && /AsyncFunction\("deviceCheckToken"\)/.test(swift));
check('podspec links DeviceCheck (a system framework)', /frameworks\s*=\s*'DeviceCheck'/.test(read('native/modules/hawkeye-device/ios/HawkeyeDevice.podspec')));
const kt = read('native/modules/hawkeye-device/android/src/main/java/expo/modules/hawkeyedevice/HawkeyeDeviceModule.kt');
check('Kotlin: Function("androidId") reading Settings.Secure.ANDROID_ID', /Function\("androidId"\)/.test(kt) && /Settings\.Secure\.ANDROID_ID/.test(kt));
check('no App Attest / DeviceCheck entitlement anywhere (DCDevice needs none)',
  !/appattest|devicecheck/i.test(read('native/app.config.js')) && !/appattest-environment/i.test(read('.github/workflows/ios-lite-release.yml')));

const liteJava = read('mobile/android/app/src/main/java/ng/com/hawkeye/observer/HawkeyeDevicePlugin.java');
check('Lite Android: signals() puts androidId from Settings.Secure.ANDROID_ID', /ret\.put\("androidId"/.test(liteJava) && /Settings\.Secure\.ANDROID_ID/.test(liteJava));
const liteSwift = read('mobile/plugins/hawkeye-vision/ios/Plugin/HawkeyeDevicePlugin.swift');
check('Lite iOS: deviceCheck registered and implemented with DCDevice',
  /CAPPluginMethod\(name: "deviceCheck"/.test(liteSwift) && /@objc func deviceCheck\(/.test(liteSwift) && /import DeviceCheck/.test(liteSwift) && /DCDevice\.current/.test(liteSwift));
const firstObjc = liteSwift.search(/@objc\(/);
check('Lite iOS: the first @objc( name annotation is still the class (Capacitor CLI reads the first)', firstObjc === liteSwift.indexOf('@objc(HawkeyeDevicePlugin)'));
check('Lite podspec links DeviceCheck', /DeviceCheck/.test(read('mobile/plugins/hawkeye-vision/HawkeyeVision.podspec')));

console.log(`\n${fails ? `${fails} FAILURE(S)` : 'device_lock_clients: all checks passed'}`);
process.exit(fails ? 1 : 0);

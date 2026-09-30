/**
 * LITE OPENS ITS OWN SETTINGS PAGE — ONLY WHERE THE BINARY CAN.
 *
 * Lite 1.7 (Android vc25, iOS build 34) adds capacitor-native-settings, and
 * ready.html sends a refused camera / location / notification row to Hawkeye
 * Lite's page in the phone's Settings. The same ready.html reaches OLDER
 * binaries as a live bundle (Capgo), and those have no NativeSettings plugin —
 * so the page must fall back to the written instruction there, which is what
 * lets the bundle ship without raising minBuild.
 *
 * Evaluates the SHIPPED code (native.js's appSettings block, ready.html's
 * REFUSED decision) against stand-in bridges, both ways, so it cannot pass
 * against a file that no longer says this.
 *
 * Run: node tests/lite_settings_test.mjs
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

// --- native.js: HAWKEYE.openAppSettings exists only with the plugin -----------
const NATIVE = read('app/native.js');
const block = /\(function appSettings\(\) \{[\s\S]*?\n  \}\)\(\);/.exec(NATIVE)?.[0];
if (!block) { console.log('FAIL  could not find the appSettings block in app/native.js'); process.exit(1); }

function bridge(plugins) {
  const window = { HAWKEYE: {} };
  const Cap = { Plugins: plugins };
  // eslint-disable-next-line no-new-func
  Function('window', 'Cap', block)(window, Cap);
  return window.HAWKEYE;
}

console.log('=== native.js ===');
const calls = [];
const withPlugin = bridge({ NativeSettings: { open: async (o) => { calls.push(o); return { status: true }; } } });
check('a 1.7 binary gets HAWKEYE.openAppSettings', typeof withPlugin.openAppSettings, 'function');
await withPlugin.openAppSettings();
check('it opens Android App info', calls[0] && calls[0].optionAndroid, 'application_details');
check('it opens the iOS app page', calls[0] && calls[0].optionIOS, 'app');
check('an older binary (no plugin) gets null', bridge({ Camera: {} }).openAppSettings, null);
check('control: a plugin object without open() gets null', bridge({ NativeSettings: {} }).openAppSettings, null);
check('control: no Plugins at all gets null', bridge(undefined).openAppSettings, null);

// --- the plugin's own names for those two screens ------------------------------
// A plugin update that renamed them would make every tap reject. Read from the
// installed package when it is there (mobile/node_modules), skipped otherwise.
const PKG = JSON.parse(read('mobile/package.json'));
check('mobile/package.json depends on capacitor-native-settings', !!PKG.dependencies['capacitor-native-settings'], true);
const NM = new URL('../mobile/node_modules/capacitor-native-settings/', import.meta.url);
if (fs.existsSync(NM)) {
  const java = fs.readFileSync(new URL('android/src/main/java/nl/raphael/settings/AndroidSettings.java', NM), 'utf8');
  const swift = fs.readFileSync(new URL('ios/Sources/NativeSettingsPlugin/NativeSettings.swift', NM), 'utf8');
  const plugin = fs.readFileSync(new URL('android/src/main/java/nl/raphael/settings/NativeSettingsPlugin.java', NM), 'utf8');
  check('Android knows "application_details" as App info', /ApplicationDetails\("application_details", ACTION_APPLICATION_DETAILS_SETTINGS\)/.test(java), true);
  check('iOS knows "app" as the app settings URL', /option == "app"[\s\S]{0,80}openSettingsURLString/.test(swift), true);
  check('Android open() reads optionAndroid', /call\.getString\("optionAndroid"\)/.test(plugin), true);
  check('the JS name is NativeSettings', /@CapacitorPlugin\(name = "NativeSettings"\)/.test(plugin), true);
} else {
  console.log('SKIP  mobile/node_modules/capacitor-native-settings not installed');
}

// --- ready.html: a refused row opens Settings, or says where the switch is -----
const READY = read('app/ready.html');
const decide = /(const openAppSettings = [\s\S]*?;\n\s*const REFUSED = [\s\S]*?;\n)/.exec(READY)?.[1];
if (!decide) { console.log('FAIL  could not find the REFUSED decision in app/ready.html'); process.exit(1); }
function refused(LITE, hawkeye) {
  const window = { HAWKEYE: hawkeye };
  // eslint-disable-next-line no-new-func
  return Function('LITE', 'window', 'BLOCKED', 'openSettings', `${decide}; return REFUSED;`)(LITE, window, ['k', 'blocked'], () => {});
}
console.log('\n=== ready.html ===');
const lite17 = refused(true, { openAppSettings: async () => ({ status: true }) });
check('Lite 1.7: a refused row runs something', typeof lite17.run, 'function');
check('Lite 1.7: its verb is Open Settings', lite17.label && lite17.label[0], 'ready.open-settings');
check('Lite 1.7: no written instruction instead', lite17.say, undefined);
const liteOld = refused(true, { openAppSettings: null });
check('older Lite binary: the written instruction', liteOld.say && liteOld.say[1], 'blocked');
check('older Lite binary: nothing to run', liteOld.run, undefined);
const web = refused(false, { openAppSettings: async () => ({}) });
check('the browser never calls it (control)', web.run, undefined);
check('the browser keeps the written instruction', web.say && web.say[1], 'blocked');
check('ready.html loads native.js before its own script',
  READY.indexOf('native.js?v=') > -1 && READY.indexOf('native.js?v=') < READY.indexOf('const openAppSettings'), true);

// --- the new label is translated ------------------------------------------------
console.log('\n=== i18n ===');
for (const lang of ['en', 'ha', 'ig', 'yo']) {
  const b = JSON.parse(read(`app/i18n/${lang}.json`));
  check(`${lang}.json has ready.open-settings`, typeof b['ready.open-settings'] === 'string' && b['ready.open-settings'].length > 0, true);
}

// --- RENDERED: ready.html in a stand-in Lite shell, both binaries -------------
// Every permission refused. A 1.7 binary's rows say Open Settings and a tap
// calls the plugin; an older binary's rows open our dialog with the written
// instruction and nothing calls a plugin that is not there.
const CHROME = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
if (!fs.existsSync(CHROME)) {
  console.log('\nSKIP  rendered checks: no Playwright chromium at ' + CHROME);
} else {
  const { createRequire } = await import('node:module');
  const { chromium } = createRequire('/home/elrio/hawkeye/tests/ui/')('playwright-core');
  const http = await import('node:http');
  const path = await import('node:path');
  const APP = '/home/elrio/hawkeye/app';
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const [u] = req.url.split('?');
    if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
    const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
    if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    return fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await chromium.launch({ executablePath: CHROME });

  async function liteReady(withPlugin) {
    const p = await b.newPage({ viewport: { width: 375, height: 812 } });
    await p.addInitScript((wp) => {
      const denied = async () => ({ camera: 'denied', location: 'denied', coarseLocation: 'denied', receive: 'denied' });
      const noop = async () => ({});
      window.__settingsCalls = [];
      const Plugins = {
        App: { addListener() { return { remove() {} }; }, getState: async () => ({ isActive: true }), getInfo: async () => ({ build: '1' }), getLaunchUrl: async () => ({}) },
        Camera: { checkPermissions: denied, requestPermissions: denied },
        Geolocation: { checkPermissions: denied, requestPermissions: denied },
        PushNotifications: { checkPermissions: denied, requestPermissions: denied, addListener() { return { remove() {} }; }, register: noop },
      };
      if (wp) Plugins.NativeSettings = { open: async (o) => { window.__settingsCalls.push(o); return { status: true }; } };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: (n) => n in Plugins, Plugins };
    }, withPlugin);
    await p.goto(`${base}/ready.html`);
    await p.waitForSelector('#rd-list [data-row="camera"]', { timeout: 10000 });
    return p;
  }

  console.log('\n=== rendered: Lite 1.7 binary (plugin present) ===');
  {
    const p = await liteReady(true);
    check('camera row is blocked', await p.getAttribute('[data-row="camera"]', 'data-state'), 'blocked');
    check('camera row says Open Settings', (await p.textContent('[data-row="camera"] .rd-verb')) || '', 'Open Settings');
    await p.click('[data-row="camera"]');
    await p.waitForFunction(() => window.__settingsCalls.length > 0, null, { timeout: 5000 }).catch(() => {});
    const calls = await p.evaluate(() => window.__settingsCalls);
    check('a tap opened App info once', calls.length === 1 && calls[0].optionAndroid, 'application_details');
    check('no dialog instead', await p.locator('.hk-dialog, [role="alertdialog"]').count(), 0);
    await p.close();
  }
  console.log('\n=== rendered: older Lite binary (no plugin) — the live-bundle case ===');
  {
    const p = await liteReady(false);
    check('camera row is blocked', await p.getAttribute('[data-row="camera"]', 'data-state'), 'blocked');
    check('no Open Settings verb', await p.locator('[data-row="camera"] .rd-verb').count(), 0);
    await p.click('[data-row="camera"]');
    await p.waitForTimeout(400);
    const body = await p.evaluate(() => document.body.innerText);
    check('a tap shows the written instruction', body.includes('allow it for Hawkeye in your phone’s Settings'), true);
    // The control for "no dialog instead" above: the same selector finds it here.
    check('…in our dialog', await p.locator('.hk-dialog, [role="alertdialog"]').count(), 1);
    check('nothing called a plugin that is not there', await p.evaluate(() => window.__settingsCalls.length), 0);
    await p.close();
  }
  await b.close();
  server.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

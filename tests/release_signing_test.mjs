// Run the plugin against the REAL generated build.gradle and assert what it
// produced. A signing plugin that silently no-ops is the exact failure it exists
// to prevent, so this checks the output, not that it ran.
//
// The plugin destructures withAppBuildGradle at require time, so the stand-in
// has to be installed BEFORE the plugin is loaded.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/native/package.json');

const mod = require_('@expo/config-plugins');
let modFn = null;
mod.withAppBuildGradle = (c, fn) => { modFn = fn; return c; };

const plugin = require_('/home/elrio/hawkeye/native/plugins/with-release-signing.js');

const src = fs.readFileSync('/home/elrio/hawkeye/native/android/app/build.gradle', 'utf8');
const cfg = { modResults: { contents: src, language: 'groovy' } };
plugin(cfg);
if (typeof modFn !== 'function') { console.error('plugin never registered a mod'); process.exit(1); }
const captured = modFn(cfg).modResults.contents;

let fail = 0;
const check = (l, ok) => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}`); };

check('an upload signingConfig is added', /upload\s*\{/.test(captured));
check('it reads the store path from a gradle property', captured.includes('HAWKEYE_UPLOAD_STORE_FILE'));
// The whole point of properties: nothing secret may land in a tracked file.
check('no keystore path or password is baked in',
  !captured.includes('hawkeye-release.keystore') && !captured.includes('/hawkeye-secrets'));
check('release no longer hard-codes the debug key',
  !/see https:\/\/reactnative\.dev\/docs\/signed-apk-android\.\s*\n\s*signingConfig signingConfigs\.debug/.test(captured));
check('release picks upload when the property is present',
  captured.includes("signingConfig project.hasProperty('HAWKEYE_UPLOAD_STORE_FILE') ? signingConfigs.upload : signingConfigs.debug"));
// The team APK must keep its debug signing, or the dev Maps key stops matching.
check('the debug buildType is untouched',
  /debug\s*\{\s*\n\s*signingConfig signingConfigs\.debug\s*\n\s*\}/.test(captured));

// prebuild runs repeatedly; a second injection would be a gradle syntax error.
const cfg2 = { modResults: { contents: captured, language: 'groovy' } };
plugin(cfg2);
const twice = modFn(cfg2).modResults.contents;
check('idempotent: a second run changes nothing', twice === captured);
check('exactly one upload block', (twice.match(/upload \{/g) || []).length === 1);

// It must REFUSE rather than silently leave debug signing if Expo's template moves.
let threw = false;
try {
  const bad = { modResults: { contents: 'android { buildTypes { release { } } }', language: 'groovy' } };
  plugin(bad);
  modFn(bad);
} catch { threw = true; }
check('throws on an unrecognised template instead of no-opping', threw);

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);

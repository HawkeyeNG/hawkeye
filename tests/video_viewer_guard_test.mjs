/**
 * expo-video is new after native 1.0.9 — and 1.0.9-and-older phones run the same JS (OTA).
 *
 * expo-video's entry calls requireNativeModule('ExpoVideo') AT IMPORT, which
 * throws in a binary built without it. One runtime import of 'expo-video' in
 * the incident screen's graph would crash that screen on every older phone.
 * The same hazard as expo-print (tests/certificate_pdf_guard_test.mjs), and the
 * same proof, each part with a control:
 *
 *  1. STATIC: across native/src, 'expo-video' is loaded at runtime in exactly
 *     one place — a require() in components/video-viewer.tsx inside the branch
 *     requireOptionalNativeModule('ExpoVideo') guards. `import type` is allowed
 *     because it is erased; that is checked on the project's OWN Babel config
 *     (what Metro bundles), not assumed. Controls: the detector flags a static
 *     import, a dynamic import() and an unguarded require().
 *  2. RUNTIME: video-viewer.tsx, transpiled and run against a fake 'expo' whose
 *     native module is ABSENT and a fake 'expo-video' that throws on load like
 *     the real one does there: canPlayVideoInApp() is false, nothing throws, and
 *     expo-video is never loaded. Control: with the module PRESENT the same file
 *     loads it (once) and says true; present-but-broken is still no crash.
 *  3. STRINGS: every n.components.video-viewer.* key the file calls resolves in
 *     ha, ig and yo to something that is neither the English nor the key.
 *
 *   node tests/video_viewer_guard_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const NATIVE = '/home/elrio/hawkeye/native';
const SRC = path.join(NATIVE, 'src');
const FILE = path.join(SRC, 'components/video-viewer.tsx');
const nreq = createRequire(path.join(NATIVE, 'package.json'));
const ts = nreq('typescript');

let fail = 0;
const check = (label, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : `\n        ${extra}`}`); };

/* ---------------------------------------------------------------- 1. static */
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Every RUNTIME mention of expo-video as a module specifier, classified. `import type` is not one. */
function uses(src) {
  const out = [];
  const re = /(import\s+(?!type\s)[^;]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s+(?!type\s)[^;]*?from\s*|import\s*)['"]expo-video(?:\/[^'"]*)?['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const kind = /^import\s*\(/.test(m[1]) ? 'dynamic-import' : /^require/.test(m[1]) ? 'require' : 'static';
    const before = src.slice(0, m.index);
    const guardAt = before.search(/if \([^)]*requireOptionalNativeModule\('ExpoVideo'\)\) \{[^{}]*$/);
    const guarded = kind === 'require' && guardAt >= 0;
    out.push({ kind, guarded });
  }
  return out;
}
const hits = walk(SRC).flatMap((f) => uses(stripComments(fs.readFileSync(f, 'utf8'))).map((u) => ({ file: path.relative(NATIVE, f), ...u })));
check('expo-video is loaded at runtime from exactly one place in native/src', hits.length === 1, JSON.stringify(hits));
check('…a require() in components/video-viewer.tsx, inside the requireOptionalNativeModule guard',
  hits.length === 1 && hits[0].file === 'src/components/video-viewer.tsx' && hits[0].kind === 'require' && hits[0].guarded, JSON.stringify(hits));
check('control: a static import is flagged', uses("import { VideoView } from 'expo-video';").some((u) => u.kind === 'static'));
check('control: a side-effect import is flagged', uses("import 'expo-video';").some((u) => u.kind === 'static'));
check('control: a dynamic import() is flagged', uses("const V = await import('expo-video');").some((u) => u.kind === 'dynamic-import'));
check('control: an unguarded require() is flagged', uses("const V = require('expo-video');").every((u) => u.kind === 'require' && !u.guarded));
check('control: a require() after the guard block closed is flagged',
  uses("if (requireOptionalNativeModule('ExpoVideo')) {\n  x = 1;\n}\nconst V = require('expo-video');").every((u) => !u.guarded));
check('control: `import type` is not a runtime use', uses("import type { VideoPlayer } from 'expo-video';").length === 0);

/* What Metro actually bundles: the project's babel.config.js on this file. */
{
  let out = null;
  let err = null;
  try {
    const babel = nreq('@babel/core');
    out = babel.transformSync(fs.readFileSync(FILE, 'utf8'), {
      filename: FILE, cwd: NATIVE, babelrc: false, configFile: path.join(NATIVE, 'babel.config.js'),
      caller: { name: 'metro', bundler: 'metro', platform: 'android' },
    }).code;
  } catch (e) { err = e; }
  check('Babel (the project config) compiles the viewer', !!out, String(err && err.message).slice(0, 200));
  if (out) {
    const refs = out.match(/["']expo-video["']/g) || [];
    check('…and its output references expo-video exactly once — the guarded require (the type import is gone)',
      refs.length === 1 && /require\(["']expo-video["']\)/.test(out), `refs=${refs.length}`);
    const ctl = nreq('@babel/core').transformSync("import { VideoView } from 'expo-video';\nexport const v = VideoView;", {
      filename: path.join(SRC, 'x.tsx'), cwd: NATIVE, babelrc: false, configFile: path.join(NATIVE, 'babel.config.js'),
      caller: { name: 'metro', bundler: 'metro', platform: 'android' },
    }).code;
    check('control: Babel keeps a VALUE import of expo-video (so the count above can see one)', /expo-video/.test(ctl));
  }
}

/* --------------------------------------------------------------- 2. runtime */
const js = ts.transpileModule(fs.readFileSync(FILE, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

/** Any module the file imports but this test does not care about: callable, indexable, inert. */
const inert = () => new Proxy(function () {}, { get: (t, k) => (k === '__esModule' ? false : inert()), apply: () => inert() });

function load({ present, throws, platform = 'android' }) {
  const log = { videoLoaded: 0 };
  const fakeVideo = { useVideoPlayer: () => ({}), VideoView: () => null };
  const mods = {
    expo: { requireOptionalNativeModule: (n) => (n === 'ExpoVideo' && present ? {} : null), useEventListener: () => {} },
    'expo-video': () => {
      log.videoLoaded++;
      // Exactly what expo-modules-core throws when the binary has no such module.
      if (throws) throw new Error("Cannot find native module 'ExpoVideo'");
      return fakeVideo;
    },
    'react-native': new Proxy({ Platform: { OS: platform } }, { get: (t, k) => (k in t ? t[k] : inert()) }),
  };
  const req = (id) => (id in mods ? (typeof mods[id] === 'function' ? mods[id]() : mods[id]) : inert());
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: req, Error, Number, Math, String });
  return { api: module.exports, log };
}

// 1.0.9 and older: no native module, and loading the JS package would throw.
{
  let threw = null;
  let r;
  try { r = load({ present: false, throws: true }); } catch (e) { threw = e; }
  check('old binary: the viewer module loads without throwing', !threw, String(threw));
  check('old binary: canPlayVideoInApp() is false (the screen keeps the browser)', r && r.api.canPlayVideoInApp() === false);
  check('old binary: expo-video was NEVER loaded', r && r.log.videoLoaded === 0, `loaded ${r && r.log.videoLoaded}x`);
}
// Control: a binary with the module.
{
  const r = load({ present: true, throws: false });
  check('control new binary: canPlayVideoInApp() is true', r.api.canPlayVideoInApp() === true);
  r.api.canPlayVideoInApp();
  check('control new binary: expo-video loaded exactly once (cached)', r.log.videoLoaded === 1, `loaded ${r.log.videoLoaded}x`);
}
// Present but broken: no crash, and the browser fallback stays.
{
  let threw = null;
  let r;
  try { r = load({ present: true, throws: true }); } catch (e) { threw = e; }
  check('module present but its JS throws: no crash, canPlayVideoInApp() false', !threw && r.api.canPlayVideoInApp() === false, String(threw));
}
// The web preview has no binary to be out of step with.
check('web preview: plays in the page', load({ present: false, throws: false, platform: 'web' }).api.canPlayVideoInApp() === true);
{
  const { clock } = load({ present: false, throws: false }).api;
  const cases = [[0, '0:00'], [75.4, '1:15'], [3725, '1:02:05'], [NaN, '0:00'], [-3, '0:00'], [Infinity, '0:00']];
  const bad = cases.filter(([s, want]) => clock(s) !== want).map(([s, want]) => `${s} -> ${clock(s)} (want ${want})`);
  check('clock() formats elapsed/total and never shows NaN', bad.length === 0, bad.join('; '));
}

/* --------------------------------------------------------------- 3. strings */
{
  const B = Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(SRC, `lib/i18n/${l}.json`), 'utf8'))]));
  const src = fs.readFileSync(FILE, 'utf8');
  const keys = [...new Set([...src.matchAll(/i18nT\('([^']+)'/g)].map((m) => m[1]))];
  check('the viewer keys its strings (errors, labels and buttons included)', keys.filter((k) => k.startsWith('n.components.video-viewer.')).length >= 12, keys.join(' '));
  const bad = [];
  for (const k of keys) for (const l of ['ha', 'ig', 'yo']) {
    const v = B[l][k];
    if (typeof v !== 'string' || !v.trim() || v === k || (k !== 'common.close' && v === B.en[k])) bad.push(`${l} ${k}`);
  }
  check('every key resolves in ha/ig/yo to a translation, never the English or the key', bad.length === 0, bad.join(', '));
  const ctlKeys = ['n.components.video-viewer.no-such-key'];
  check('control: an absent key is caught', ctlKeys.some((k) => typeof B.ha[k] !== 'string'));
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);

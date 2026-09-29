/**
 * NO GREY BOXES: every dialog Hawkeye raises for itself is Hawkeye's own.
 *
 * window.alert / confirm / prompt paint the browser's box — "hawkeye.com.ng
 * says", OK/Cancel in the platform's language, an input nobody can style — and
 * React Native's Alert.alert paints the OS's. Both were replaced (2026-09-29):
 * the web by app/dialog.js (hkAlert / hkConfirm / hkPrompt / hkChoose), native
 * by components/confirm-sheet.tsx and notice-sheet.tsx. This fails the moment
 * one comes back.
 *
 * NOT covered, on purpose: permission prompts (the owner's rule is to leave the
 * system's own prompt alone), share sheets, file pickers, and the PWA install
 * prompt (`deferred.prompt()` is a method on an event, not window.prompt).
 *
 * Also checked: every page whose own code (or an app script it loads) calls an
 * hk* dialog loads dialog.js — without it the call throws, and a confirm that
 * throws is a button that does nothing.
 *
 *   node tests/no_native_dialogs_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const NATIVE = `${ROOT}/native/src`;

/* Anything left on purpose goes here, with the reason, as "file": count.
   Empty: nothing of ours still uses a platform dialog. */
const ALLOW = {};

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

/** Comments out, so a sentence ABOUT alert() is not a call to it. URLs keep
 *  their `//` (a `:` before it), and line lengths do not matter here. */
function strip(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

/** A call to the browser's own dialog: window.alert(…), or a bare alert(…) not
 *  reached through a property (x.prompt()) and not part of a longer name
 *  (hkAlert, notifyBlocked). A function DEFINITION named alert is not a call. */
const WEB_CALL = /(?:\bwindow\s*\.\s*|(?<![.\w$]))(alert|confirm|prompt)\s*\(/g;
const DEF = /(?:function\s+|(?:const|let|var)\s+)$/;
function webCalls(src) {
  const s = strip(src);
  const out = [];
  for (const m of s.matchAll(WEB_CALL)) {
    if (DEF.test(s.slice(Math.max(0, m.index - 12), m.index))) continue;
    out.push(`${s.slice(0, m.index).split('\n').length}: ${m[0]}`);
  }
  return out;
}

/** React Native: Alert.alert / Alert.prompt, or Alert imported at all. */
function nativeCalls(src) {
  const s = strip(src);
  const out = [];
  for (const m of s.matchAll(/\bAlert\s*\.\s*(alert|prompt)\s*\(/g)) out.push(`${s.slice(0, m.index).split('\n').length}: ${m[0]}`);
  for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]react-native['"]/g)) {
    if (/\bAlert\b/.test(m[1])) out.push('imports Alert from react-native');
  }
  return out;
}

console.log('=== CONTROLS: the scanners can fail, and do not cry wolf ===');
check('CONTROL window.alert is caught', webCalls("x(); window.alert('hi');").length, 1);
check('CONTROL a bare confirm is caught', webCalls("if (!confirm('sure?')) return;").length, 1);
check('CONTROL a bare prompt is caught', webCalls("const r = prompt('why?');").length, 1);
check('CONTROL window.confirm with spaces is caught', webCalls('window . confirm (1)').length, 1);
check('CONTROL the PWA prompt (a method) is not a dialog', webCalls('deferred.prompt(); p.prompt();').length, 0);
check('CONTROL hkAlert / notifyBlocked / askPrompt are not the platform', webCalls("hkAlert('a'); hkConfirm('b'); askPrompt(1); stepPrompt(2);").length, 0);
check('CONTROL a comment about alert() is not a call', webCalls("// degrades to alert() if\n/* confirm() */ <!-- prompt() -->").length, 0);
check('CONTROL a URL does not swallow the line after it', webCalls("const u = 'https://x.y'; alert(u);").length, 1);
check('CONTROL a function named prompt is a definition, not a call', webCalls('function prompt(k) {}').length, 0);
check('CONTROL Alert.alert is caught', nativeCalls("Alert.alert('t', 'b');").length, 1);
check('CONTROL importing Alert is caught', nativeCalls("import {\n  ActivityIndicator,\n  Alert,\n} from 'react-native';").length, 1);
check('CONTROL a comment about Alert.alert is not a call', nativeCalls('// replaced Alert.alert here\n/* Alert.alert */').length, 0);

console.log('\n=== the web app and Hawkeye Lite (app/) ===');
const walk = (dir, keep, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'vendor', 'i18n', 'fonts', 'reg'].includes(e.name)) continue;
      walk(p, keep, out);
    } else if (keep(e.name)) out.push(p);
  }
  return out;
};
// opencv.js is the upstream library, byte for byte; nothing in it runs a dialog of ours.
const webFiles = walk(APP, (n) => /\.(js|html)$/.test(n) && n !== 'opencv.js');
check('CONTROL the walk found the app', webFiles.length > 60, true);
const webHits = {};
for (const f of webFiles) {
  const hits = webCalls(fs.readFileSync(f, 'utf8'));
  const rel = path.relative(APP, f);
  if (hits.length && (ALLOW[rel] || 0) < hits.length) webHits[rel] = hits;
}
check('no window.alert / confirm / prompt in our web code', webHits, {});

console.log('\n=== the native app (native/src) ===');
const nativeFiles = walk(NATIVE, (n) => /\.(tsx?|jsx?)$/.test(n));
check('CONTROL the walk found the native app', nativeFiles.length > 100, true);
const nativeHits = {};
for (const f of nativeFiles) {
  const hits = nativeCalls(fs.readFileSync(f, 'utf8'));
  const rel = path.relative(NATIVE, f);
  if (hits.length && (ALLOW[rel] || 0) < hits.length) nativeHits[rel] = hits;
}
check('no Alert.alert / Alert.prompt (or an Alert import) in native', nativeHits, {});

console.log('\n=== every page that raises a dialog loads dialog.js ===');
const HK = /\bhk(Alert|Confirm|Prompt|Choose)\s*\(/;
const scriptUses = {};
for (const f of fs.readdirSync(APP).filter((n) => n.endsWith('.js'))) {
  scriptUses[f] = HK.test(strip(fs.readFileSync(`${APP}/${f}`, 'utf8')));
}
check('CONTROL the scan sees the scripts that call it', ['app.js', 'capture.js', 'practice.js'].every((f) => scriptUses[f]), true);
/** True when this page's own code, or an app script it loads, calls an hk*
 *  dialog while the page does not load dialog.js. outbox.js is exempt: its one
 *  call is guarded (`if (G.hkAlert)`) because it also runs in the worker. */
function pageMissesDialog(src) {
  const srcs = [...src.matchAll(/<script[^>]*\bsrc="\/?([\w.-]+\.js)(?:\?[^"]*)?"/g)].map((m) => m[1]);
  const inline = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const uses = HK.test(strip(inline)) || srcs.some((x) => scriptUses[x] && x !== 'dialog.js' && x !== 'outbox.js');
  return uses && !srcs.includes('dialog.js');
}
const missing = fs.readdirSync(APP).filter((n) => n.endsWith('.html'))
  .filter((f) => pageMissesDialog(fs.readFileSync(`${APP}/${f}`, 'utf8')));
check('every page that calls hkAlert/hkConfirm/hkPrompt/hkChoose loads dialog.js', missing, []);
check('CONTROL a page calling hkConfirm inline without dialog.js is caught',
  pageMissesDialog("<script>if (await hkConfirm('x')) go();</script>"), true);
check('CONTROL a page loading app.js without dialog.js is caught',
  pageMissesDialog('<script src="app.js?v=1"></script>'), true);
check('CONTROL the same page with dialog.js passes',
  pageMissesDialog('<script src="dialog.js?v=1"></script><script src="app.js?v=1"></script>'), false);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

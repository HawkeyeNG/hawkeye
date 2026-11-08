/**
 * SEVERAL PHOTOS OF ONE SHEET — the native app's join, held to the web's.
 *
 *   node tests/sheet_parts_native_test.mjs
 *
 * The join exists THREE times, on purpose: app/sheet-parts.js (web / Lite),
 * native/src/lib/sheet-parts.ts joinLayout (the native web export and the
 * single source the others are read against), and the plain-ES5 copy inside
 * JOIN_HTML that the hidden WebView runs on a phone (a Hermes build cannot
 * stringify a compiled function). This RUNS all three on many part sizes and
 * requires identical layouts, so none can drift. Also: the WebView page says
 * "ready"; mergeReads keeps the FIRST part's text and serial (the unit code is
 * read from the first photo) and pools counts; the report and practice flows
 * both turn parts on (the lockstep rule); submit.ts sends sheetParts.
 * CONTROL: a copy with a different band DOES disagree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ts = createRequire(path.join(ROOT, 'native', 'package.json'))('typescript');
let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || got === undefined ? '' : `   [${JSON.stringify(got)?.slice(0, 300)}]`}`);
  if (!ok) failed++;
};

// native/src/lib/sheet-parts.ts, transpiled and run
const src = fs.readFileSync(path.join(ROOT, 'native/src/lib/sheet-parts.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hk-parts-')), 'sheet-parts.mjs');
fs.writeFileSync(file, js);
const N = await import(pathToFileURL(file).href);

// app/sheet-parts.js, in a realm with a window
const webRealm = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/sheet-parts.js'), 'utf8'), webRealm);
const W = webRealm.window.HAWKEYE_SHEETPARTS;

// the WebView page's script, in a realm with what a WebView gives it
const posted = [];
const pageRealm = {
  window: { addEventListener() {}, ReactNativeWebView: { postMessage: (m) => posted.push(JSON.parse(m)) } },
  document: { addEventListener() {} },
  Promise, JSON, Math, String, Error,
};
const pageScript = /<script>([\s\S]*?)<\/script>/.exec(N.JOIN_HTML)[1];
vm.runInNewContext(pageScript, pageRealm);
const pageLayout = pageRealm.layout;

check('the three copies share the box, band and cap',
  W.MAX === N.MAX_SHEET_PARTS && W.MAX_W === N.JOIN_MAX_W && W.MAX_H === N.JOIN_MAX_H && W.BAND === N.JOIN_BAND
    && pageRealm.MAX_W === N.JOIN_MAX_W && pageRealm.MAX_H === N.JOIN_MAX_H && pageRealm.BAND === N.JOIN_BAND && pageRealm.Q === N.JOIN_QUALITY,
  { web: [W.MAX, W.MAX_W, W.MAX_H, W.BAND], native: [N.MAX_SHEET_PARTS, N.JOIN_MAX_W, N.JOIN_MAX_H, N.JOIN_BAND] });
check('the cap is 3 parts (the backend\'s MAX_SHEET_PARTS)', N.MAX_SHEET_PARTS === 3);

// Many part sizes: landscape halves, portrait sheets, mixed, tiny, huge, 2 and 3 parts.
const shapes = [];
let s = 7;
const rnd = (lo, hi) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return lo + (s % (hi - lo + 1)); };
for (let i = 0; i < 400; i++) {
  const n = 2 + (i % 2);
  shapes.push(Array.from({ length: n }, () => ({ w: rnd(200, 4200), h: rnd(200, 4200) })));
}
shapes.push([{ w: 1600, h: 1200 }, { w: 1600, h: 1200 }], [{ w: 1200, h: 1600 }, { w: 1200, h: 1600 }, { w: 1200, h: 1600 }], [{ w: 3000, h: 400 }, { w: 3000, h: 400 }]);
const key = (L) => JSON.stringify(L);
const diff = shapes.filter((sz) => key(N.joinLayout(sz)) !== key(W.layout(sz)) || key(N.joinLayout(sz)) !== key(pageLayout(sz)));
check(`web, native and WebView layouts agree on ${shapes.length} part sets`, diff.length === 0, diff.slice(0, 2));
const box = shapes.every((sz) => { const L = N.joinLayout(sz); return L.width <= 1500 && L.height <= 2250 && L.rows.length === sz.length; });
check('every layout fits 1500 x 2250, one row per part', box);
const ordered = shapes.every((sz) => { const L = N.joinLayout(sz); return L.rows.every((r, i) => i === 0 ? r.y === 0 : r.y === L.rows[i - 1].y + L.rows[i - 1].h + N.JOIN_BAND); });
check('parts run top to bottom, a band apart, first at the top', ordered);

// CONTROL: a copy with an 8 px band is caught by the same comparison
const drifted = new Function(`${pageScript.replace(/BAND=16/, 'BAND=8').replace(/post\(\{type:'ready'\}\);/, '').replace(/window\.addEventListener[^\n]*\n/, '')}; return layout;`);
let caught = false;
try {
  const L8 = drifted.call({})(shapes[0]);
  caught = key(L8) !== key(N.joinLayout(shapes[0]));
} catch (e) { caught = false; }
check('CONTROL: a copy with a different band does not match', caught);

check('the WebView page says it is ready once listening', posted.some((m) => m.type === 'ready'), posted);

// mergeReads
const r1 = { text: 'CODE 29-01-01-001 APC 32', numericLines: 4, counts: { APC: 32, PDP: 1 }, serial: null };
const r2 = { text: 'LP 7 SDP 167', numericLines: 3, counts: { LP: 7, SDP: 167, PDP: 9 }, serial: 'A123' };
const m = N.mergeReads([r1, null, r2]);
check('mergeReads: the FIRST part\'s text stands (the unit code is read from it)', m.text === r1.text);
check('mergeReads: counts pooled, an earlier part wins on overlap', JSON.stringify(m.counts) === JSON.stringify({ APC: 32, PDP: 1, LP: 7, SDP: 167 }), m.counts);
check('mergeReads: readable lines summed; the first serial found', m.numericLines === 7 && m.serial === 'A123', m);
check('mergeReads: nothing read -> null', N.mergeReads([null, undefined]) === null);

// wiring: both flows turn parts on, and the count reaches the form
const result = fs.readFileSync(path.join(ROOT, 'native/src/app/report/result.tsx'), 'utf8');
const practice = fs.readFileSync(path.join(ROOT, 'native/src/app/practice.tsx'), 'utf8');
const submit = fs.readFileSync(path.join(ROOT, 'native/src/lib/submit.ts'), 'utf8');
const cam = fs.readFileSync(path.join(ROOT, 'native/src/components/capture-camera.tsx'), 'utf8');
check('report AND practice turn parts on for the sheet (lockstep)', /allowParts=\{isSheet\}/.test(result) && /allowParts=\{isSheet\}/.test(practice));
check('submit.ts sends sheetParts for a joined sheet', /sheetParts: String\(input\.sheet\.parts\)/.test(submit));
check('the camera joins at Use photo and keeps the FIRST part\'s time and place',
  /joinerRef\.current\.join\(\[\.\.\.kept\.map\(\(p\) => p\.uri\), preview\.uri\]\)/.test(cam) && /capturedAt: first\.capturedAt,\s*\.\.\.first\.fix/.test(cam));
check('backing out of the next part returns to the parts kept, not out of the step',
  (cam.match(/partsRef\.current\.length && restoreLastPart\(\)/g) || []).length === 2);

console.log(failed ? `\n${failed} FAILED` : '\nsheet_parts_native: all passed');
process.exit(failed ? 1 : 0);

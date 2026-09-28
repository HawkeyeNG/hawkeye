/**
 * expo-print is new in native 1.0.9 — and 1.0.8 phones run the same JS (OTA).
 *
 * expo-print's entry calls requireNativeModule('ExpoPrint') AT IMPORT, which
 * throws in a binary built without it. One static `import … from 'expo-print'`
 * in the certificate screen's graph would crash that screen on every 1.0.8
 * phone. This proves it cannot, each with a control:
 *
 *  1. STATIC: across native/src, 'expo-print' appears in exactly one place —
 *     a require() in lib/certificate-pdf.ts, inside the branch that
 *     requireOptionalNativeModule('ExpoPrint') guards. Control: the same
 *     detector flags a static import, a dynamic import() and an unguarded
 *     require().
 *  2. RUNTIME: lib/certificate-pdf.ts, transpiled and run against a fake
 *     'expo' whose native module is ABSENT (1.0.8) and a fake 'expo-print'
 *     that throws on load exactly like the real one does there:
 *     canMakePdf() is false, nothing throws, expo-print is never loaded, and
 *     shareCertificatePdf() says 'unavailable'. Control: with the module
 *     PRESENT (1.0.9) the same file loads it, canMakePdf() is true and the PDF
 *     is made and offered. And a present-but-broken module is still no crash.
 *  3. NO WEB PAGE in the native certificate flow: no expo-web-browser,
 *     openBrowserAsync, Linking.openURL or WebView in its files, and the PDF
 *     button is drawn only when canMakePdf() said yes. Control: the detector
 *     flags a line that opens the browser.
 *
 *   node tests/certificate_pdf_guard_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const NATIVE = '/home/elrio/hawkeye/native';
const SRC = path.join(NATIVE, 'src');
const ts = createRequire(path.join(NATIVE, 'package.json'))('typescript');

let fail = 0;
const check = (label, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : `\n        ${extra}`}`); };

/* ---------------------------------------------------------------- 1. static */
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []);
/** Comments may NAME the package (certificate-pdf.ts explains the hazard); only code counts. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** Every mention of expo-print as a module specifier, classified. */
function uses(src) {
  const out = [];
  const re = /(import\s[^;]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^;]*?from\s*)['"]expo-print(?:\/[^'"]*)?['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const kind = /^import\s*\(/.test(m[1]) ? 'dynamic-import' : /^require/.test(m[1]) ? 'require' : 'static';
    // Guarded = the require sits inside an `if (requireOptionalNativeModule('ExpoPrint'))` block.
    const before = src.slice(0, m.index);
    const guardAt = before.lastIndexOf("if (requireOptionalNativeModule('ExpoPrint'))");
    const tail = guardAt >= 0 ? before.slice(guardAt) : '';
    const depth = (tail.match(/\{/g) || []).length - (tail.match(/\}/g) || []).length;   // guard block still open?
    const guarded = kind === 'require' && guardAt >= 0 && depth >= 1;
    out.push({ kind, guarded });
  }
  return out;
}
const hits = walk(SRC).flatMap((f) => uses(stripComments(fs.readFileSync(f, 'utf8'))).map((u) => ({ file: path.relative(NATIVE, f), ...u })));
check('expo-print is referenced exactly once in native/src', hits.length === 1, JSON.stringify(hits));
check('…and that one is a require() in lib/certificate-pdf.ts, inside the requireOptionalNativeModule guard',
  hits.length === 1 && hits[0].file === 'src/lib/certificate-pdf.ts' && hits[0].kind === 'require' && hits[0].guarded, JSON.stringify(hits));
// Controls: the detector sees each unsafe form.
check('control: a static import is flagged', uses("import * as Print from 'expo-print';").some((u) => u.kind === 'static'));
check('control: a dynamic import() is flagged', uses("const P = await import('expo-print');").some((u) => u.kind === 'dynamic-import'));
check('control: an unguarded require() is flagged', uses("const P = require('expo-print');").every((u) => u.kind === 'require' && !u.guarded));
check('control: a require() AFTER the guard block closed is flagged',
  uses("if (requireOptionalNativeModule('ExpoPrint')) {\n  x = 1;\n}\nconst P = require('expo-print');").every((u) => !u.guarded));

/* --------------------------------------------------------------- 2. runtime */
const file = path.join(SRC, 'lib/certificate-pdf.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function load({ nativePresent, printThrows, platform = 'android' }) {
  const log = { printLoaded: 0, printed: [], shared: [], toFile: [] };
  const fakePrint = {
    printToFileAsync: async (o) => { log.toFile.push(o); return { uri: 'file:///cache/Print/abc.pdf' }; },
    printAsync: async (o) => { log.printed.push(o); },
  };
  class FakeFile { constructor(a, b) { this.uri = b ? `${a.uri || a}/${b}` : a; } async copy() {} }
  const mods = {
    expo: { requireOptionalNativeModule: (n) => (n === 'ExpoPrint' && nativePresent ? {} : null) },
    'expo-print': () => {
      log.printLoaded++;
      // Exactly what expo-modules-core throws when the binary has no such module.
      if (printThrows) throw new Error("Cannot find native module 'ExpoPrint'");
      return fakePrint;
    },
    'expo-file-system': { File: FakeFile, Paths: { cache: { uri: 'file:///cache' } } },
    'react-native': { Platform: { OS: platform }, Share: { share: async (o) => { log.shared.push(o); } } },
    '@/lib/certificate': {},
    '@/lib/certificate-layout': { certificateHtml: () => '<html></html>', PDF_PAGE: { width: 842, height: 595 } },
  };
  const req = (id) => {
    if (!(id in mods)) throw new Error(`unexpected import ${id}`);
    return typeof mods[id] === 'function' ? mods[id]() : mods[id];
  };
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: req, Promise, Error });
  return { api: module.exports, log };
}

const CERT = { code: 'ABCD-EFGH', issuedOn: '2026-12-12', verifyUrl: 'https://hawkeye.com.ng/verify-cert?code=ABCD-EFGH' };

// 1.0.8: no native module, and loading the JS package would throw.
{
  let threw = null;
  let r;
  try { r = load({ nativePresent: false, printThrows: true }); } catch (e) { threw = e; }
  check('1.0.8: the module file loads without throwing', !threw, String(threw));
  const can = r && r.api.canMakePdf();
  check('1.0.8: canMakePdf() is false (the button is hidden)', can === false);
  const out = r && await r.api.shareCertificatePdf(CERT, 'Ada', 'en', 'x');
  check("1.0.8: shareCertificatePdf() resolves 'unavailable'", out === 'unavailable', String(out));
  check('1.0.8: expo-print was NEVER loaded', r && r.log.printLoaded === 0, `loaded ${r && r.log.printLoaded}x`);
}
// Control, 1.0.9: the module is there.
{
  const r = load({ nativePresent: true, printThrows: false, platform: 'android' });
  check('control 1.0.9: canMakePdf() is true', r.api.canMakePdf() === true);
  const out = await r.api.shareCertificatePdf(CERT, 'Ada', 'en', 'x');
  check("control 1.0.9 Android: PDF made (A4 landscape) and handed to the print dialog -> 'shown'",
    out === 'shown' && r.log.toFile.length === 1 && r.log.toFile[0].width === 842 && r.log.toFile[0].height === 595
      && r.log.printed.length === 1 && /\.pdf$/.test(r.log.printed[0].uri), JSON.stringify({ out, ...r.log }));
  const i = load({ nativePresent: true, printThrows: false, platform: 'ios' });
  const outI = await i.api.shareCertificatePdf(CERT, 'Ada', 'en', 'x');
  check("control 1.0.9 iOS: PDF handed to the share sheet as a file URL -> 'shown'",
    outI === 'shown' && i.log.shared.length === 1 && /^file:.*\.pdf$/.test(i.log.shared[0].url) && i.log.printed.length === 0, JSON.stringify({ outI, ...i.log }));
}
// Present but broken: still no crash, still no button.
{
  let threw = null;
  let r;
  try { r = load({ nativePresent: true, printThrows: true }); } catch (e) { threw = e; }
  check('module present but its JS throws: no crash, canMakePdf() false', !threw && r.api.canMakePdf() === false, String(threw));
}

/* ------------------------------------------------------------ 3. no web page */
const FLOW = ['src/app/certificate.tsx', 'src/app/verify-cert.tsx', 'src/components/certificate-card.tsx',
  'src/lib/certificate.ts', 'src/lib/certificate-layout.ts', 'src/lib/certificate-pdf.ts'];
const WEB = /expo-web-browser|openBrowserAsync|openAuthSessionAsync|Linking\.openURL|react-native-webview|<WebView\b/;
const strip = stripComments;
for (const f of FLOW) {
  const src = strip(fs.readFileSync(path.join(NATIVE, f), 'utf8'));
  check(`no web page opened from ${f}`, !WEB.test(src), (src.match(WEB) || [])[0]);
}
check('control: the web-page detector flags an openBrowserAsync line', WEB.test("WebBrowser.openBrowserAsync(url)"));
const screen = fs.readFileSync(path.join(NATIVE, 'src/app/certificate.tsx'), 'utf8');
check('the PDF button is drawn only under pdfOk (= canMakePdf())',
  /useState\(canMakePdf\)/.test(screen) && /\{pdfOk \? \(\s*<Btn[\s\S]{0,200}n\.app\.certificate\.print/.test(screen));
check('the verify link opens the native /verify-cert screen', /pathname: '\/verify-cert'/.test(screen));
check('the verify screen is registered in the root stack',
  /name="verify-cert"/.test(fs.readFileSync(path.join(NATIVE, 'src/app/_layout.tsx'), 'utf8')));

/* ------------------------------------------- 4. the PDF's page, rendered */
/* lib/certificate-layout.ts's HTML, printed by Chromium at the size the app
   asks expo-print for: ONE page, the name drawn but escaped, and not one
   network request (the CSP forbids them; the crest is inline). Control: the
   same page with the CSP removed and a remote image DOES request it, so the
   request counter can see one. */
{
  const layoutJs = ts.transpileModule(fs.readFileSync(path.join(SRC, 'lib/certificate-layout.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const lm = { exports: {} };
  vm.runInNewContext(layoutJs, {
    module: lm, exports: lm.exports,
    require: (id) => ({
      '@/lib/certificate': {},
      '@/lib/dates': { dayMonthYear: () => '12 December 2026' },
      '@/lib/i18n': { t: (k) => k },           // missing strings -> the English floor
      '@/lib/receipt-crest': { RECEIPT_CREST: PNG },
    })[id],
  });
  const EVIL = 'Ada <img src=x onerror=alert(1)> & "Q"';
  const html = lm.exports.certificateHtml(CERT, EVIL, 'ha');
  check('PDF page: the name is drawn, escaped (no live markup from it)',
    html.includes('Ada &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Q&quot;') && !html.includes('<img src=x'));
  check("PDF page: CSP default-src 'none', no <script>", /default-src 'none'/.test(html) && !/<script/i.test(html));
  const { chromium } = createRequire('/home/elrio/hawkeye/tests/ui/')('playwright-core');
  const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
  const render = async (doc) => {
    const p = await b.newPage();
    const reqs = [];
    p.on('request', (r) => { if (!r.url().startsWith('data:') && r.url() !== 'about:blank') reqs.push(r.url()); });
    await p.setContent(doc, { waitUntil: 'load' });
    // 842 x 595 pt (what lib/certificate-pdf.ts asks expo-print for), in inches.
    const pdf = await p.pdf({ width: `${842 / 72}in`, height: `${595 / 72}in`, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    await p.close();
    return { pages: (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, reqs };
  };
  const r = await render(html);
  check('PDF page: prints as exactly ONE A4-landscape page', r.pages === 1, `pages=${r.pages}`);
  const two = await render('<p>one</p><p style="break-before:page">two</p>');
  check('control: the page counter counts a two-page document as 2', two.pages === 2, `pages=${two.pages}`);
  check('PDF page: no network request at all', r.reqs.length === 0, r.reqs.join(' '));
  const ctl = await render(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('<body>', '<body><img src="https://example.invalid/x.png">'));
  check('control: without the CSP a remote image IS requested (the counter works)', ctl.reqs.length > 0);
  await b.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);

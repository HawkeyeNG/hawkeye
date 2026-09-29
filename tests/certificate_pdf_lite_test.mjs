/**
 * The web/Lite certificate's "Save as PDF", the Lite fixes around it, and the
 * quiz options' new look — app/certificate.{html,js}, app/verify-cert.html and
 * the Ask Hawkeye bubble's Lite placement in app/menu.js.
 *
 * Proven, each with a control:
 *  - THE PDF (browser download): a valid PDF — structure, xref offsets, ONE
 *    A4-landscape page, ONE image (a real JPEG, DCTDecode) — and read back by
 *    an independent parser (PyMuPDF: 1 page, 842x595, 1 image, the card's
 *    green frame and cream paper where they belong). The name is drawn into
 *    it (control: the image differs without the name) and is in no request the
 *    page made (control: the detector catches a request that carries it).
 *  - LITE ANDROID: no download, no Web Share there — the PDF goes through the
 *    Media plugin into the Hawkeye folder and out through the Share plugin as a
 *    file:// path; it is the same valid PDF; "PDF saved to your phone." shows.
 *  - LITE iOS: handed to Web Share as one application/pdf file.
 *  - LITE, NEVER THE WEBSITE: the certificate's check link stays in the bundle
 *    (control: the website keeps the public address), and verify-cert.html
 *    loads its scripts and links from the bundle, sits in the app shell with
 *    the tab bar and close button (control: the page as it was — every link
 *    and script pointed at hawkeye.com.ng).
 *  - NO STRAY CHAT BUBBLE in Lite on practice, certificate and verify-cert
 *    (controls: Lite keeps it on an ordinary page; the website keeps it on
 *    practice).
 *  - THE QUIZ OPTIONS read as choices: role=radio, a radio circle, >=44px, a
 *    visible border in both themes; right/wrong fill the circle with a check /
 *    cross.
 *
 *   node tests/certificate_pdf_lite_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const REPO = '/home/elrio/hawkeye';
const APP = `${REPO}/app`;
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const KEY = JSON.parse(/QUIZ_ANSWERS = (\[[^\]]+\])/.exec(fs.readFileSync(`${REPO}/backend/src/services/certificates.js`, 'utf8'))[1]);
// The control for the Lite verify page: the page exactly as it was before this change.
const OLD_VERIFY = execSync("git -c safe.directory='*' show c2b8a2af:app/verify-cert.html", { cwd: REPO, encoding: 'utf8' });
/* The same old page with its scripts written as LIVE urls — what the Lite shell
   used to make of its root-relative ones — so the script half of the check
   still has something it must catch now that native.js leaves scripts alone. */
const LIVE_SCRIPTS = OLD_VERIFY.replace(/<script src="\/(?!native\.js)/g, '<script src="https://hawkeye.com.ng/');

const CODE = 'ABCD-EFGH';
const NAME = 'Zainab Qwertyuiop-Okafor';
let mine = { certified: true, practised: true };

function api(u) {
  if (u.pathname === '/api/cert/mine') {
    return mine.certified
      ? { certified: true, code: CODE, issuedOn: '2026-12-12', verifyUrl: `https://hawkeye.com.ng/verify-cert?code=${CODE}`, practised: true }
      : { certified: false, code: null, issuedOn: null, verifyUrl: null, practised: true };
  }
  if (u.pathname === '/api/cert/verify') return { valid: true, code: CODE, issuedAt: 0, issuedOn: '2026-12-12' };
  if (u.pathname === '/api/assistant/health') return { enabled: true };
  return {};
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(api(u))); }
  if (u.pathname === '/__old_verify.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(OLD_VERIFY); }
  if (u.pathname === '/__live_scripts.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(LIVE_SCRIPTS); }
  const f = path.join(APP, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, ok, extra) => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || extra === undefined ? '' : `\n        got ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`); };

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const TOKEN = 'x.' + Buffer.from(JSON.stringify({ sub: '7', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.y';

const carries = (log, name) => {
  const forms = [name, encodeURIComponent(name), name.replace(/ /g, '+'), name.split(' ')[1]];
  return log.filter((r) => forms.some((f) => (r.url + JSON.stringify(r.headers) + r.body).includes(f))).map((r) => r.url);
};

/**
 * mode: 'web' | 'android' | 'ios'. Lite = a Capacitor stub BEFORE native.js
 * runs, so native.js takes its real app-shell path (the class, the URL
 * rewriting, fetch to the live host) — and the live host is answered here.
 */
async function open(page, { mode = 'web', theme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads: true, isMobile: mode !== 'web', hasTouch: mode !== 'web' });
  await ctx.addInitScript(([tok, m, th]) => {
    try { localStorage.setItem('hawkeye_token', tok); localStorage.setItem('hawkeye_lang', 'en'); localStorage.setItem('hawkeye_tour_done', '1'); localStorage.setItem('hawkeye_theme', th); } catch (e) { /* */ }
    window.__cap = { saved: [], shared: [], webShared: [] };
    if (m === 'web') return;
    const Plugins = {};
    if (m === 'android') {
      const dir = '/storage/emulated/0/Android/media/ng.com.hawkeye.lite/Hawkeye';
      Plugins.Media = {
        getAlbums: async () => ({ albums: [{ name: 'Hawkeye', identifier: dir }] }),
        createAlbum: async () => ({}),
        savePhoto: async (o) => { window.__cap.saved.push(o); return { filePath: `${dir}/${o.fileName}.pdf` }; },
      };
      Plugins.Share = { share: async (o) => { window.__cap.shared.push(o); return {}; } };
    } else {
      // iOS WKWebView: Web Share with files, no Media PDF path.
      navigator.canShare = (d) => !!(d && d.files && d.files.length);
      navigator.share = async (d) => { window.__cap.webShared.push((d.files || []).map((f) => ({ name: f.name, type: f.type, size: f.size }))); };
    }
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => m, Plugins, convertFileSrc: (x) => x };
  }, [TOKEN, mode, theme]);
  const log = [];
  const offBundle = [];     // non-API requests to the live site from inside Lite
  await ctx.route('https://hawkeye.com.ng/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/')) return route.fulfill({ json: api(u) });
    offBundle.push(u.pathname);
    return route.fulfill({ status: 404, body: '' });
  });
  const pg = await ctx.newPage();
  pg.on('request', (rq) => { if (!/^(data|blob):/.test(rq.url())) log.push({ url: rq.url(), headers: rq.headers(), body: rq.postData() || '' }); });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${base}/${page}`, { waitUntil: 'networkidle' });
  await pg.waitForTimeout(900);   // the chat bubble mounts after /api/assistant/health
  return { pg, ctx, log, offBundle, errs };
}

/** Structural checks on the bytes, plus an independent parser (PyMuPDF). */
function validatePdf(buf, label) {
  const s = buf.toString('latin1');
  const out = {};
  out.header = s.startsWith('%PDF-1.');
  out.eof = /%%EOF\s*$/.test(s);
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  out.startxref = !!sx && s.slice(Number(sx[1]), Number(sx[1]) + 4) === 'xref';
  const rows = sx ? s.slice(Number(sx[1])).split('\n').slice(2).filter((l) => / n $/.test(l)) : [];
  out.xrefOffsets = rows.length > 0 && rows.every((l, i) => s.slice(Number(l.slice(0, 10)), Number(l.slice(0, 10)) + 10).startsWith(`${i + 1} 0 obj`));
  out.onePage = (s.match(/\/Type \/Page\b(?!s)/g) || []).length === 1 && /\/Count 1\b/.test(s);
  out.a4Landscape = /\/MediaBox \[0 0 842 595\]/.test(s);
  const im = /\/Subtype \/Image[^>]*\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/.exec(s);
  out.oneImage = (s.match(/\/Subtype \/Image/g) || []).length === 1 && !!im;
  if (im) {
    const start = im.index + im[0].length;
    const n = Number(im[1]);
    out.jpeg = buf[start] === 0xff && buf[start + 1] === 0xd8 && buf[start + n - 2] === 0xff && buf[start + n - 1] === 0xd9
      && s.slice(start + n, start + n + 10) === '\nendstream';
    out.image = buf.subarray(start, start + n);
  }
  const tmp = path.join(os.tmpdir(), `cert-${process.pid}-${label}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    out.mupdf = JSON.parse(execFileSync('python3', ['-c', `
import fitz, json, sys
d = fitz.open(sys.argv[1]); p = d[0]; pm = p.get_pixmap(dpi=36)
px = lambda fx, fy: pm.pixel(int(pm.width * fx), int(pm.height * fy))
print(json.dumps({"pages": d.page_count, "w": round(p.rect.width), "h": round(p.rect.height),
  "images": len(p.get_images()), "imgw": p.get_images()[0][2] if p.get_images() else 0,
  "text": p.get_text().strip(), "corner": px(0.004, 0.5), "paper": px(0.1, 0.6)}))
`, tmp], { encoding: 'utf8' }));
  } catch (e) { out.mupdf = { error: String(e).slice(0, 300) }; }
  return out;
}
const near = (rgb, hex, tol = 40) => {
  const t = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return Array.isArray(rgb) && rgb.every((v, i) => Math.abs(v - t[i]) <= tol);
};
function pdfChecks(v, who) {
  check(`${who}: a PDF (header, %%EOF, startxref -> xref)`, v.header && v.eof && v.startxref, v);
  check(`${who}: every xref offset lands on its object`, v.xrefOffsets);
  check(`${who}: ONE page, A4 landscape (842 x 595 pt)`, v.onePage && v.a4Landscape);
  check(`${who}: ONE image, a whole JPEG (FFD8 … FFD9, /Length exact)`, v.oneImage && v.jpeg);
  const m = v.mupdf || {};
  check(`${who}: PyMuPDF reads it — 1 page, 842x595, 1 image 2400px wide`, m.pages === 1 && m.w === 842 && m.h === 595 && m.images === 1 && m.imgw === 2400, m);
  check(`${who}: …the card's green frame at the edge, cream paper inside`, near(m.corner, '#004225') && near(m.paper, '#fbf7ea'), m);
  check(`${who}: no text layer — the name is only pixels`, m.text === '', m.text);
}

/* ------------------------------------------------ 1. web: the download */
let r = await open('certificate.html');
await r.pg.fill('#cert-name', NAME);
await r.pg.waitForTimeout(400);
check('web: Print stays as an extra option', await r.pg.isVisible('#cert-print'));
check('web: the check link is the public address', await r.pg.getAttribute('#cert-link', 'href') === `https://hawkeye.com.ng/verify-cert?code=${CODE}`);
let [dl] = await Promise.all([r.pg.waitForEvent('download', { timeout: 15000 }), r.pg.click('#cert-pdf')]);
check('web: the file is named hawkeye-observer-certificate.pdf', dl.suggestedFilename() === 'hawkeye-observer-certificate.pdf', dl.suggestedFilename());
const webPdf = fs.readFileSync(await dl.path());
const v1 = validatePdf(webPdf, 'web');
pdfChecks(v1, 'web PDF');
check('web: the name is not in the PDF bytes (nor its /Title)', !webPdf.toString('latin1').includes(NAME.split(' ')[1]) && /\/Title \(Hawkeye Observer Certificate\)/.test(webPdf.toString('latin1')));
check('web: the name is in NO request the page made', carries(r.log, NAME).length === 0, carries(r.log, NAME));
await r.pg.evaluate((n) => fetch('/echo?who=' + encodeURIComponent(n)).catch(() => {}), NAME);
await r.pg.waitForTimeout(200);
check('control: the detector catches a request that does carry it', carries(r.log, NAME).length === 1);
await r.pg.fill('#cert-name', '');
await r.pg.waitForTimeout(300);
[dl] = await Promise.all([r.pg.waitForEvent('download', { timeout: 15000 }), r.pg.click('#cert-pdf')]);
const v0 = validatePdf(fs.readFileSync(await dl.path()), 'web-noname');
check('the name IS drawn into the PDF: its image differs without it', v0.image && v1.image && Buffer.compare(v0.image, v1.image) !== 0);
check('web: no page errors', r.errs.length === 0, r.errs);
await r.ctx.close();

/* ------------------------------------------ 2. Lite Android: Media + Share */
r = await open('certificate.html', { mode: 'android' });
await r.pg.fill('#cert-name', NAME);
await r.pg.waitForTimeout(400);
check('Lite: Print is hidden (window.print does nothing there)', !(await r.pg.isVisible('#cert-print')));
check('Lite: Save as PDF is offered', await r.pg.isVisible('#cert-pdf'));
check('Lite: the check link stays in the bundle', await r.pg.getAttribute('#cert-link', 'href') === `verify-cert.html?code=${CODE}`);
await r.pg.click('#cert-pdf');
await r.pg.waitForFunction(() => window.__cap.shared.length > 0, null, { timeout: 15000 }).catch(() => {});
const cap = await r.pg.evaluate(() => window.__cap);
const saved = cap.saved[0] || {};
check('Lite Android: saved through the Media plugin as a data:application/pdf URL, into the album',
  /^data:application\/pdf;base64,/.test(saved.path || '') && /Hawkeye$/.test(saved.albumIdentifier || '') && saved.fileName === 'hawkeye-observer-certificate', { ...saved, path: String(saved.path).slice(0, 40) });
const litePdf = Buffer.from(String(saved.path || '').replace(/^data:[^,]*,/, ''), 'base64');
pdfChecks(validatePdf(litePdf, 'lite'), 'Lite PDF');
const sh = cap.shared[0] || {};
check('Lite Android: then offered by the Share plugin as ONE file:// path to that .pdf',
  Array.isArray(sh.files) && sh.files.length === 1 && sh.files[0] === 'file:///storage/emulated/0/Android/media/ng.com.hawkeye.lite/Hawkeye/hawkeye-observer-certificate.pdf', sh);
check('Lite Android: "PDF saved to your phone." shows', (await r.pg.textContent('#cert-status')).trim() === 'PDF saved to your phone.');
check('Lite Android: the name is in no network request', carries(r.log, NAME).length === 0, carries(r.log, NAME));
/* No exemptions: /monitor.js, /i18n.js and /lang.js are root-relative on every
   page, and native.js used to send them to the live site in Lite. It leaves
   scripts alone now, so they come from the bundle like everything else. */
check('Lite Android: nothing of the certificate flow fetched from the live site (API aside)',
  r.offBundle.length === 0, r.offBundle);
check('Lite: no chat bubble on the certificate', (await r.pg.$('#hk-fab')) === null);
// Following the check link: the bundled page, in the app.
await Promise.all([r.pg.waitForURL(/verify-cert\.html/, { timeout: 10000 }).catch(() => {}), r.pg.click('#cert-link')]);
await r.pg.waitForTimeout(800);
check('Lite: tapping the check link opens the BUNDLED verify page', new URL(r.pg.url()).origin === base && new URL(r.pg.url()).pathname === '/verify-cert.html', r.pg.url());
check('Lite: …which shows the valid result', await r.pg.isVisible('#vc-valid'));
check('Lite Android: no page errors', r.errs.length === 0, r.errs);
await r.ctx.close();

/* ---------------------------------------------------- 3. Lite iOS: Web Share */
r = await open('certificate.html', { mode: 'ios' });
await r.pg.click('#cert-pdf');
await r.pg.waitForFunction(() => window.__cap.webShared.length > 0, null, { timeout: 15000 }).catch(() => {});
const ws = (await r.pg.evaluate(() => window.__cap.webShared))[0] || [];
check('Lite iOS: handed to the share sheet as ONE application/pdf file', ws.length === 1 && ws[0].type === 'application/pdf' && ws[0].name === 'hawkeye-observer-certificate.pdf' && ws[0].size > 50000, ws);
await r.ctx.close();

/* -------------------------------------- 4. Lite: verify-cert in the shell */
async function shellOf(page) {
  const x = await open(page, { mode: 'android' });
  // The page's OWN <script src>s (menu.js and monitor.js inject outbox.js and
  // Sentry themselves, site-wide, and are not this page's markup).
  const file = page.startsWith('__old_verify') ? OLD_VERIFY : page.startsWith('__live_scripts') ? LIVE_SCRIPTS
    : fs.readFileSync(path.join(APP, page.replace(/\?.*$/, '')), 'utf8');
  const own = [...file.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1].replace(/^https:\/\/hawkeye\.com\.ng/, '').replace(/^\//, ''));
  const s = await x.pg.evaluate((ownSrcs) => {
    const pane = document.getElementById('page-scroll');
    const live = (u) => /^https:\/\/hawkeye\.com\.ng\//.test(u);
    return {
      shell: document.documentElement.classList.contains('has-shell') && !!pane && getComputedStyle(pane).position === 'fixed',
      native: document.documentElement.classList.contains('native-app'),
      tabbar: !!document.querySelector('.tabbar'),
      close: !!document.querySelector('.close-btn'),
      liveLinks: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter(live),
      liveScripts: [...document.scripts].map((sc) => sc.src).filter((u) => live(u) && ownSrcs.some((o) => u.endsWith('/' + o))),
      fab: !!document.getElementById('hk-fab'),
    };
  }, own);
  await x.ctx.close();
  return { ...s, offBundle: x.offBundle, errs: x.errs };
}
const vc = await shellOf(`verify-cert.html?code=${CODE}`);
check('Lite verify-cert: in the app shell (native-app, fixed pane, tab bar, close)', vc.native && vc.shell && vc.tabbar && vc.close, vc);
check('Lite verify-cert: no link and no script points at the website', vc.liveLinks.length === 0 && vc.liveScripts.length === 0, vc);
check('Lite verify-cert: nothing but the API fetched from the live site', vc.offBundle.length === 0, vc.offBundle);
check('Lite verify-cert: no chat bubble', !vc.fab);
check('Lite verify-cert: no page errors', vc.errs.length === 0, vc.errs);
const old = await shellOf(`__old_verify.html?code=${CODE}`);
check('control: the page AS IT WAS sent its links to the website from Lite',
  old.liveLinks.length >= 5, { links: old.liveLinks.length });
/* Its root-relative scripts used to go there too (native.js rewrote every
   leading-slash src). It leaves scripts alone now, so even this page's load
   from the bundle — the fix for Lite pages coming up untranslated offline. */
check('…but even its root-relative scripts now load from the bundle',
  old.liveScripts.length === 0 && old.offBundle.filter((p) => p.endsWith('.js')).length === 0, { scripts: old.liveScripts, off: old.offBundle });
const planted = await shellOf(`__live_scripts.html?code=${CODE}`);
check('control: the script check catches a page whose scripts ARE on the website',
  planted.liveScripts.length >= 3, { scripts: planted.liveScripts.length });

/* -------------------------------------------- 5. the chat bubble placement */
const pr = await shellOf('practice.html');
check('Lite practice: no chat bubble (native hides it on practice too)', !pr.fab);
const cg = await shellOf('captain-guide.html');
check('control: Lite keeps the bubble on an ordinary page', cg.fab);
r = await open('practice.html');
check('control: the website keeps the bubble on practice', (await r.pg.$('#hk-fab')) !== null);
await r.ctx.close();

/* ----------------------------------------------------- 6. the quiz options */
mine = { certified: false, practised: true };
for (const theme of ['light', 'dark']) {
  r = await open('certificate.html', { theme });
  await r.pg.waitForSelector('#cq-options .cq-opt');
  const look = await r.pg.evaluate(() => [...document.querySelectorAll('#cq-options .cq-opt')].map((b) => {
    const cs = getComputedStyle(b);
    const dot = b.querySelector('.cq-dot');
    return { role: b.getAttribute('role'), h: b.getBoundingClientRect().height, dot: !!dot && getComputedStyle(dot).borderTopWidth === '2px',
      border: cs.borderTopWidth, bc: cs.borderTopColor, bg: cs.backgroundColor, group: b.parentElement.getAttribute('role') };
  }));
  check(`${theme}: 3 options, each role=radio in a radiogroup, with a radio circle`, look.length === 3 && look.every((o) => o.role === 'radio' && o.dot && o.group === 'radiogroup'), look);
  check(`${theme}: each at least 44px tall with a 2px border that differs from its fill`, look.every((o) => o.h >= 44 && o.border === '2px' && o.bc !== o.bg), look);
  const wrongIdx = (KEY[0] + 1) % 3;
  await r.pg.click(`#cq-options button:nth-child(${wrongIdx + 1})`);
  const bad = await r.pg.evaluate((i) => {
    const b = document.querySelectorAll('#cq-options .cq-opt')[i];
    return { cls: b.className, cross: getComputedStyle(b.querySelector('.cq-bad')).display, tick: getComputedStyle(b.querySelector('.cq-ok')).display, checked: b.getAttribute('aria-checked') };
  }, wrongIdx);
  check(`${theme}: a wrong pick fills the circle with a cross (not a check)`, /\bbad\b/.test(bad.cls) && bad.cross === 'block' && bad.tick === 'none' && bad.checked === 'true', bad);
  await r.pg.click('#cq-retry');
  await r.pg.click(`#cq-options button:nth-child(${KEY[0] + 1})`);
  const ok = await r.pg.evaluate((i) => {
    const b = document.querySelectorAll('#cq-options .cq-opt')[i];
    return { cls: b.className, tick: getComputedStyle(b.querySelector('.cq-ok')).display, dotBg: getComputedStyle(b.querySelector('.cq-dot')).backgroundColor };
  }, KEY[0]);
  check(`${theme}: the right pick fills the circle with a check`, /\bok\b/.test(ok.cls) && ok.tick === 'block' && ok.dotBg !== 'rgba(0, 0, 0, 0)', ok);
  check(`${theme}: no page errors`, r.errs.length === 0, r.errs);
  await r.ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);

// Hawkeye data-use guide for parties: one A4 page, printed from HTML by headless Chromium.
//
//   node scripts/press/build_data_use.mjs [out.pdf]
//
// ONE SOURCE OF COPY, as with the fact sheet: every sentence is the English
// column of scripts/i18n/batches/stay_web.json (the press.data-* keys), the
// same strings app/press.html shows under "How much data does it use?". Change
// the figures there, re-merge the batch, then re-run this.
//
// The figures were checked against the code on 2026-09-27: report photos are
// compressed on the phone before signing (sheet 1500 px / q0.76, venue 1280 px
// / q0.72 — app/app.js compressCapture, native capture-camera.tsx
// downscaleForUpload, the document-scanner path included), two photos per
// report, 365 KB measured per submission; the native home tab polls six
// endpoints every 30 s only while the app is in the foreground. Re-measure on
// the 12 December Practice Day.
//
// The build fails if the PDF is not exactly one page, or if any sentence is
// missing from its TEXT LAYER (read with PyMuPDF, never from a rendering).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const { chromium } = createRequire(`${ROOT}/tests/ui/`)('playwright-core');

const OUT = process.argv[2] || `${ROOT}/app/press/Hawkeye-Data-Use.pdf`;
const SITE = 'https://hawkeye.com.ng/';
const batch = JSON.parse(fs.readFileSync(`${ROOT}/scripts/i18n/batches/stay_web.json`, 'utf8'));
const en = (k) => {
  if (!batch[k]) throw new Error(`missing key ${k}`);
  return batch[k].en.replace(/href="(?!https?:|mailto:|tel:)([^"]+)"/g, `href="${SITE}$1"`);
};
const plain = (k) => batch[k].en.replace(/<[^>]*>/g, '');

const font = (w) => `url(data:font/woff2;base64,${fs.readFileSync(`${ROOT}/app/fonts/inter-${w}.woff2`).toString('base64')}) format('woff2')`;
const icon = 'data:image/png;base64,' + fs.readFileSync(`${ROOT}/app/press/hawkeye-icon-512.png`).toString('base64');

const rows = [1, 2, 3, 4].map((n) => `<tr><th>${en(`press.data-r${n}-k`)}</th><td>${en(`press.data-r${n}-v`)}</td></tr>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How much data does Hawkeye use?</title><style>
@font-face { font-family: Inter; font-weight: 400; src: ${font(400)}; }
@font-face { font-family: Inter; font-weight: 600; src: ${font(600)}; }
@font-face { font-family: Inter; font-weight: 700; src: ${font(700)}; }
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: Inter, sans-serif; color: #10221a; font-size: 10.5pt; line-height: 1.45; width: 210mm; height: 297mm; position: relative; }
a { color: #0a6b40; text-decoration: none; font-weight: 600; }
.band { background: #00331e; color: #e8f2ec; padding: 9mm 16mm 8mm; display: flex; align-items: center; gap: 6mm; }
.band img { width: 17mm; height: 17mm; border-radius: 4mm; }
.band .kicker { margin: 0; color: #f5b301; font-weight: 700; font-size: 9.5pt; letter-spacing: 0.08em; text-transform: uppercase; }
.band h1 { margin: 1mm 0 0; font-size: 22pt; line-height: 1.12; font-weight: 700; color: #fff; }
main { padding: 8mm 16mm 0; }
.lead { font-size: 11.5pt; margin: 0 0 6mm; }
table { width: 100%; border-collapse: collapse; margin: 0 0 7mm; }
thead th { text-align: left; font-size: 8.6pt; letter-spacing: 0.08em; text-transform: uppercase; color: #526058; padding: 0 3mm 2mm 0; border-bottom: 0.5mm solid #00482b; }
tbody th, tbody td { text-align: left; vertical-align: top; padding: 3.2mm 3mm 3.2mm 0; border-bottom: 0.3mm solid #dde4de; }
tbody th { font-weight: 600; width: 52%; }
tbody td { font-weight: 700; }
.box { background: #eef5f0; border-left: 1.4mm solid #f5b301; border-radius: 0 2mm 2mm 0; padding: 4mm 5mm; margin: 0 0 5mm; }
.box p { margin: 0 0 2.2mm; }
.box p:last-child { margin: 0; }
.small { color: #526058; font-size: 9.6pt; margin: 0 0 2.4mm; }
footer { position: absolute; left: 0; right: 0; bottom: 0; padding: 5mm 16mm 8mm; border-top: 0.3mm solid #dde4de; background: #eef5f0; font-size: 9pt; }
footer p { margin: 0 0 1.2mm; }
footer .inec { color: #526058; font-size: 8.4pt; margin: 0; }
</style></head><body>
<div class="band">
  <img src="${icon}" alt="">
  <div><p class="kicker">Hawkeye · 16 January 2027</p><h1>${en('press.data-h')}</h1></div>
</div>
<main>
  <p class="lead">${en('press.data-lede')}</p>
  <table>
    <thead><tr><th>${en('press.data-col-use')}</th><th>${en('press.data-col-data')}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="box">
    <p>${en('press.data-advice')}</p>
    <p>${en('press.data-before')}</p>
  </div>
  <p class="small">${en('press.data-why')}</p>
  <p class="small">${en('press.data-browser')}</p>
  <p class="small">${en('press.data-note')}</p>
</main>
<footer>
  <p>Get the app: <a href="${SITE}download">hawkeye.com.ng/download</a> · Stay for the count: <a href="${SITE}stay">hawkeye.com.ng/stay</a> · Press kit: <a href="${SITE}press.html#data">hawkeye.com.ng/press.html</a></p>
  <p>Questions: <a href="mailto:info@hawkeye.com.ng">info@hawkeye.com.ng</a> · <a href="tel:+2349078727777">+234 907 872 7777</a></p>
  <p class="inec">Hawkeye is independent and nonpartisan. It does not declare results; official results are those declared by INEC.</p>
</footer>
</body></html>`;

const exe = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const browser = await chromium.launch(fs.existsSync(exe) ? { executablePath: exe } : {});
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const gap = await page.evaluate(() => document.querySelector('footer').getBoundingClientRect().top - document.querySelector('main').getBoundingClientRect().bottom);
  if (gap < 4) throw new Error(`content runs into the footer (gap ${gap.toFixed(1)}px): cut copy or shrink type`);
  const fam = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
  if (fam < 3) throw new Error(`Inter did not load (${fam} faces) — check app/fonts`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.pdf({ path: OUT, format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  console.log(`footer gap ${gap.toFixed(1)}px, ${fam} font faces loaded`);
} finally {
  await browser.close();
}

const keys = ['press.data-h', 'press.data-lede', 'press.data-r1-k', 'press.data-r1-v', 'press.data-r2-k', 'press.data-r2-v',
  'press.data-r3-k', 'press.data-r3-v', 'press.data-r4-k', 'press.data-r4-v', 'press.data-advice', 'press.data-before',
  'press.data-why', 'press.data-browser', 'press.data-note'];
const py = `
import fitz, json, sys
d = fitz.open(sys.argv[1])
print(json.dumps({"pages": d.page_count, "text": " ".join(" ".join(p.get_text().split()) for p in d)}))`;
const res = JSON.parse(execFileSync('python3', ['-c', py, OUT], { encoding: 'utf8' }));
const norm = (s) => s.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/(\w)- (?=\w)/g, '$1-').trim();
const text = norm(res.text);
const missing = keys.map(plain).filter((s) => !text.includes(norm(s)));
const control = !text.includes('This sentence is not on the data-use guide');
if (res.pages !== 1 || missing.length || !control) {
  console.error(`FAIL pages=${res.pages} missing=${JSON.stringify(missing)} control=${control}`);
  process.exit(1);
}
console.log(`OK ${OUT}: 1 page, ${keys.length} sentences found in the text layer (control passed), ${fs.statSync(OUT).size} bytes`);

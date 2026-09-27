// Hawkeye press fact sheet: one A4 page, printed from HTML by headless Chromium.
//
//   node scripts/press/build_fact_sheet.mjs [out.pdf]
//
// ONE SOURCE OF COPY. Every sentence comes from the English column of
// scripts/i18n/batches/press_web.json, the same strings app/press.html shows,
// so the page and the PDF cannot drift apart. Relative links are made absolute
// (the PDF is read away from the site). Change the copy there, then re-run.
//
// The build fails if the PDF is not exactly one page, or if any expected
// sentence is missing from its TEXT LAYER (read with PyMuPDF, never from a
// rendering). Keep it neutral: no party names or colours, no figures that could
// read as a result, no fraud / rigging / watchdog vocabulary.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/tests/ui/`);
const { chromium } = require_('playwright-core');

const OUT = process.argv[2] || `${ROOT}/app/press/hawkeye-fact-sheet.pdf`;
const SITE = 'https://hawkeye.com.ng/';
const batch = JSON.parse(fs.readFileSync(`${ROOT}/scripts/i18n/batches/press_web.json`, 'utf8'));
const en = (k) => {
  if (!batch[k]) throw new Error(`missing key ${k}`);
  // Absolute links: a relative href in a PDF points nowhere.
  return batch[k].en.replace(/href="(?!https?:|mailto:|tel:)([^"]+)"/g, `href="${SITE}$1"`);
};
const plain = (k) => batch[k].en.replace(/<[^>]*>/g, '');

// Inlined: a page set with setContent() is about:blank, which may not load file:// URLs.
const font = (w) => `url(data:font/woff2;base64,${fs.readFileSync(`${ROOT}/app/fonts/inter-${w}.woff2`).toString('base64')}) format('woff2')`;
const icon = 'data:image/png;base64,' + fs.readFileSync(`${ROOT}/app/press/hawkeye-icon-512.png`).toString('base64');

const facts = ['what', 'where', 'cost', 'code', 'lang', 'units', 'operator', 'status']
  .map((f) => `<dt>${en(`press.fact-${f}-k`)}</dt><dd>${en(`press.fact-${f}-v`)}</dd>`).join('');
const steps = [1, 2, 3].map((n) => `<li>${en(`press.step-${n}`)}</li>`).join('');
const trust = ['open', 'ledger', 'photos', 'nonpartisan'].map((t) => `<li>${en(`press.trust-${t}`)}</li>`).join('');
const dates = [['pd1', 'pd1-what'], ['pd2', 'pd2-what'], ['pres', 'pres-what'], ['gov', 'gov-what']]
  .map(([d, w]) => `<dt>${en(`press.date-${d}`)}</dt><dd>${en(`press.date-${w}`)}</dd>`).join('');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hawkeye fact sheet</title><style>
@font-face { font-family: Inter; font-weight: 400; src: ${font(400)}; }
@font-face { font-family: Inter; font-weight: 600; src: ${font(600)}; }
@font-face { font-family: Inter; font-weight: 700; src: ${font(700)}; }
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font-family: Inter, sans-serif; color: #10221a; font-size: 8.9pt; line-height: 1.4; width: 210mm; height: 297mm; position: relative; }
a { color: #0a6b40; text-decoration: none; font-weight: 600; }
.band { background: #00331e; color: #e8f2ec; padding: 8mm 14mm 7mm; display: flex; align-items: center; gap: 6mm; }
.band img { width: 17mm; height: 17mm; border-radius: 4mm; }
.band h1 { margin: 0; font-size: 21pt; letter-spacing: 0.06em; font-weight: 700; color: #fff; }
.band p { margin: 1mm 0 0; color: #b9d3c4; font-size: 10pt; }
.band .url { margin-left: auto; text-align: right; font-size: 9pt; color: #f5b301; font-weight: 700; }
main { padding: 6mm 14mm 0; }
h2 { font-size: 10.5pt; margin: 0 0 2mm; color: #00482b; text-transform: uppercase; letter-spacing: 0.08em; }
.lead { font-size: 9.8pt; margin: 0 0 4.5mm; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; }
section { margin-bottom: 4.5mm; }
dl.facts { display: grid; grid-template-columns: 24mm 1fr; gap: 1.6mm 3mm; margin: 0; }
dl.facts dt { font-weight: 700; color: #526058; }
dl.facts dd { margin: 0; }
ol, ul { margin: 0; padding-left: 4.5mm; }
li { margin-bottom: 1.6mm; }
dl.dates { margin: 0 0 1.5mm; }
dl.dates dt { font-weight: 700; }
dl.dates dd { margin: 0 0 1.8mm; }
.note { color: #526058; font-size: 8.3pt; margin: 0; }
footer { position: absolute; left: 0; right: 0; bottom: 0; padding: 5mm 14mm 8mm; border-top: 0.3mm solid #dde4de; background: #eef5f0; }
footer p { margin: 0 0 1.2mm; }
footer .links { color: #526058; font-size: 8.3pt; }
footer .inec { color: #526058; font-size: 8pt; margin: 0; }
</style></head><body>
<div class="band">
  <img src="${icon}" alt="">
  <div><h1>HAWKEYE</h1><p>Press fact sheet</p></div>
  <div class="url">hawkeye.com.ng</div>
</div>
<main>
  <p class="lead">${en('press.summary')}</p>
  <div class="cols">
    <div>
      <section><h2>${en('press.key-facts')}</h2><dl class="facts">${facts}</dl></section>
      <section><h2>${en('press.dates-h')}</h2><dl class="dates">${dates}</dl><p class="note">${en('press.dates-note')}</p></section>
    </div>
    <div>
      <section><h2>${en('press.how-h')}</h2><ol>${steps}</ol></section>
      <section><h2>${en('press.trust-h')}</h2><ul>${trust}</ul></section>
    </div>
  </div>
</main>
<footer>
  <p><strong>${en('press.contact-h')}.</strong> ${en('press.contact-body')}</p>
  <p class="links">Website <a href="${SITE}">hawkeye.com.ng</a> · Apps <a href="${SITE}download.html">hawkeye.com.ng/download.html</a> · Press kit <a href="${SITE}press.html">hawkeye.com.ng/press.html</a> · Code <a href="https://github.com/HawkeyeNG/hawkeye">github.com/HawkeyeNG/hawkeye</a></p>
  <p class="inec">Hawkeye does not declare results. Official results are those declared by INEC.</p>
</footer>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  // Overflow gate: main must end above the footer, or the page is overfull.
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

// Read the PDF's own text layer back and check it: one page, every sentence present.
const expect = ['press.summary', 'press.fact-operator-v', 'press.step-3', 'press.trust-photos', 'press.date-gov', 'press.contact-body']
  .map(plain);
const py = `
import fitz, json, sys
d = fitz.open(sys.argv[1])
print(json.dumps({"pages": d.page_count, "text": " ".join(" ".join(p.get_text().split()) for p in d)}))`;
const res = JSON.parse(execFileSync('python3', ['-c', py, OUT], { encoding: 'utf8' }));
const norm = (s) => s.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").trim();
const text = norm(res.text);
const missing = expect.filter((s) => !text.includes(norm(s)));
// Control: a sentence that is NOT on the sheet must be reported missing.
const control = !text.includes('This sentence is not on the fact sheet');
if (res.pages !== 1 || missing.length || !control) {
  console.error(`FAIL pages=${res.pages} missing=${JSON.stringify(missing)} control=${control}`);
  process.exit(1);
}
console.log(`OK ${OUT}: 1 page, ${expect.length} sentences found in the text layer (control passed), ${fs.statSync(OUT).size} bytes`);

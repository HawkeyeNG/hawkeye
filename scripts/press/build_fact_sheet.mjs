// Hawkeye press fact sheet: one A4 page, printed from HTML by headless Chromium.
//
//   node scripts/press/build_fact_sheet.mjs [out.pdf]
//
// ONE SOURCE OF COPY. Every sentence comes from the English column of
// scripts/i18n/batches/press_web.json, the same keys app/press.html uses, so
// the page and the PDF cannot drift apart. The page may show a key in a
// shorter card form (stay2_web.json); the sheet keeps the full original
// sentences, so the facts on paper do not move. Relative links are made
// absolute (the PDF is read away from the site). Change the copy there, then
// re-run.
//
// THE LOOK is the Stay-for-the-count flyer's (docs/private/outreach/
// stay-for-the-count/build.mjs): green band, gold accents, numbered steps,
// green footer with a QR code. The QR opens https://hawkeye.com.ng/press.html,
// and it and every URL on the sheet are live links in the PDF.
//
// The build fails if the PDF is not exactly one page, if anything spills off
// the page, if any sentence is missing from its TEXT LAYER (read with PyMuPDF,
// never from a rendering), or if a link is missing or relative. Keep it
// neutral: no party names or colours, no figures that could read as a result,
// no fraud / rigging / watchdog vocabulary.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/tests/ui/`);
const { chromium } = require_('playwright-core');
const QRCode = createRequire(`${ROOT}/native/`)('qrcode');

const OUT = process.argv[2] || `${ROOT}/app/press/hawkeye-fact-sheet.pdf`;
const SITE = 'https://hawkeye.com.ng/';
const QR_URL = `${SITE}press.html`;
const batch = JSON.parse(fs.readFileSync(`${ROOT}/scripts/i18n/batches/press_web.json`, 'utf8'));
const en = (k) => {
  if (!batch[k]) throw new Error(`missing key ${k}`);
  // Absolute links: a relative href in a PDF points nowhere.
  return batch[k].en.replace(/href="(?!https?:|mailto:|tel:)([^"]+)"/g, `href="${SITE}$1"`);
};
const plain = (s) => s.replace(/<[^>]*>/g, '');

// Inlined: a page set with setContent() is about:blank, which may not load file:// URLs.
const font = (w) => `url(data:font/woff2;base64,${fs.readFileSync(`${ROOT}/app/fonts/inter-${w}.woff2`).toString('base64')}) format('woff2')`;
const icon = 'data:image/png;base64,' + fs.readFileSync(`${ROOT}/app/press/hawkeye-icon-512.png`).toString('base64');
const qrSvg = (await QRCode.toString(QR_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#00331eff', light: '#ffffffff' } }))
  .replace(/<\?xml[^>]*>/, '').replace('<svg ', '<svg aria-label="QR code: hawkeye.com.ng/press.html" role="img" ');

const FACTS = ['what', 'where', 'cost', 'code', 'lang', 'units', 'status', 'operator'];
const TRUST = ['open', 'ledger', 'photos', 'nonpartisan'];
const DATES = [['pd1', 'pd1-what'], ['pd2', 'pd2-what'], ['pres', 'pres-what'], ['gov', 'gov-what']];

const ICO = {
  open: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
  ledger: '<path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 12.8 4.7a3.9 3.9 0 0 1 5.5 5.5L16.5 12"/><path d="M13 17.5 11.2 19.3a3.9 3.9 0 0 1-5.5-5.5L7.5 12"/>',
  photos: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  nonpartisan: '<path d="M12 3v18M5 7h14M5 7l-2.5 6a3 3 0 0 0 5 0zM19 7l-2.5 6a3 3 0 0 0 5 0zM8 21h8"/>',
};
const ico = (d) => `<svg class="ico" viewBox="0 0 24 24">${d}</svg>`;

const facts = FACTS.map((f) => {
  let v = en(`press.fact-${f}-v`);
  if (f === 'units') v = v.replace(/(\d{1,3}(?:,\d{3})+)/, '<strong class="n">$1</strong>');
  return `<div class="fact"><dt>${en(`press.fact-${f}-k`)}</dt><dd>${v}</dd></div>`;
}).join('');
const steps = [1, 2, 3].map((n) => `<li><span class="num">${n}</span><p>${en(`press.step-${n}`)}</p></li>`).join('');
const trust = TRUST.map((t) => `<li><span class="badge">${ico(ICO[t])}</span><p>${en(`press.trust-${t}`)}</p></li>`).join('');
const dates = DATES.map(([d, w], i) => `<li class="${i > 1 ? 'vote' : ''}"><span class="dot"></span><div><div class="when">${en(`press.date-${d}`)}</div><div class="what">${en(`press.date-${w}`)}</div></div></li>`).join('');

// Lines that are the sheet's own, not keys: the same words the previous edition printed.
const SUBTITLE = 'Press fact sheet';
const LINKS = `Website <a href="${SITE}">hawkeye.com.ng</a> · Apps <a href="${SITE}download.html">hawkeye.com.ng/download.html</a> · Press kit <a href="${SITE}press.html">hawkeye.com.ng/press.html</a> · Code <a href="https://github.com/HawkeyeNG/hawkeye">github.com/HawkeyeNG/hawkeye</a>`;
const INEC = 'Hawkeye does not declare results. Official results are those declared by INEC.';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hawkeye fact sheet</title><style>
@font-face { font-family: "HK Inter"; font-weight: 400; src: ${font(400)}; }
@font-face { font-family: "HK Inter"; font-weight: 600; src: ${font(600)}; }
@font-face { font-family: "HK Inter"; font-weight: 700; src: ${font(700)}; }
@page { size: A4; margin: 0; }
:root { --green:#004225; --deep:#00331e; --gold:#f5b301; --gold-ink:#7a5200; --cream:#fff7dc; --tint:#eef5f1; --ink:#10231a; --muted:#3b5849; --line:#dde4de; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 210mm; height: 297mm; }
body { font-family: "HK Inter", sans-serif; color: var(--ink); font-size: 8.3pt; line-height: 1.36; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
a { color: var(--green); font-weight: 600; text-decoration: none; }
.page { width: 210mm; height: 297mm; display: flex; flex-direction: column; overflow: hidden; }
header { background: var(--green); color: #fff; padding: 7mm 13mm 6mm; }
.brand { display: flex; align-items: center; gap: 3.5mm; }
.brand img { width: 13mm; height: 13mm; border-radius: 3.2mm; display: block; }
.brand h1 { font-size: 20pt; line-height: 1; letter-spacing: .16em; font-weight: 700; }
.brand .sub { margin-top: 1.4mm; font-size: 10pt; color: #b9d3c4; font-weight: 600; }
.brand .url { margin-left: auto; font-size: 9.4pt; font-weight: 700; color: var(--deep); background: var(--gold); border-radius: 10mm; padding: 1.4mm 3.6mm; }
.brief { margin-top: 4mm; display: flex; gap: 5mm; align-items: flex-start; }
.kicker { flex: none; display: inline-block; background: var(--gold); color: var(--deep); font-weight: 700; font-size: 8.4pt; padding: 1mm 2.6mm; border-radius: 1.2mm; margin-top: .6mm; }
.lead { font-size: 9.6pt; line-height: 1.42; color: #e2efe8; text-wrap: pretty; }
.tag { display: inline-block; margin-left: 2mm; vertical-align: 1px; font-size: 8pt; font-weight: 600; color: var(--gold); border: .3mm solid var(--gold); border-radius: 10mm; padding: .7mm 2.6mm; }
main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; column-gap: 7mm; padding: 4mm 13mm; }
.col { min-height: 0; display: flex; flex-direction: column; justify-content: space-evenly; gap: 3mm; }
h2 { font-size: 10pt; font-weight: 700; color: var(--green); padding-bottom: 1.1mm; border-bottom: .55mm solid var(--gold); margin-bottom: 2.4mm; }
dl.facts { display: grid; gap: 1.5mm; }
.fact { background: var(--tint); border-radius: 1.8mm; padding: 1.7mm 2.8mm; display: grid; grid-template-columns: 19mm 1fr; column-gap: 2.2mm; }
.fact dt { font-weight: 700; color: var(--gold-ink); font-size: 8pt; padding-top: .2mm; }
.fact dd { font-size: 8.2pt; }
.fact .n { color: var(--green); font-size: 9.6pt; }
ol.steps { list-style: none; display: grid; gap: 1.8mm; }
ol.steps li { display: flex; gap: 2.6mm; align-items: flex-start; border: .3mm solid var(--line); border-radius: 2mm; padding: 2.2mm 2.8mm; }
.num { width: 6.4mm; height: 6.4mm; border-radius: 50%; background: var(--green); color: var(--gold); font-weight: 700; font-size: 9pt; display: flex; align-items: center; justify-content: center; flex: none; }
ol.steps strong, ul.trust strong { display: block; color: var(--green); font-size: 9.2pt; margin-bottom: .5mm; }
ol.steps p, ul.trust p { font-size: 8.1pt; }
ul.trust { list-style: none; display: grid; gap: 1.8mm; }
ul.trust li { display: flex; gap: 2.2mm; align-items: flex-start; background: var(--tint); border-radius: 2mm; padding: 2.3mm 2.6mm; }
.badge { width: 6.6mm; height: 6.6mm; border-radius: 1.8mm; background: var(--cream); color: var(--gold-ink); display: flex; align-items: center; justify-content: center; flex: none; }
.ico { width: 4.4mm; height: 4.4mm; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
ul.dates { list-style: none; position: relative; }
ul.dates::before { content: ""; position: absolute; left: 1.45mm; top: 1.6mm; bottom: 3mm; width: .5mm; background: var(--line); }
ul.dates li { position: relative; display: flex; gap: 3mm; margin-bottom: 2mm; }
.dot { flex: none; width: 3.4mm; height: 3.4mm; border-radius: 50%; background: #fff; border: .7mm solid var(--green); margin-top: .5mm; position: relative; }
ul.dates li.vote .dot { background: var(--gold); border-color: var(--gold); }
.when { font-weight: 700; font-size: 8.6pt; color: var(--gold-ink); }
.what { font-size: 8.2pt; }
.what strong { color: var(--green); }
.note { color: var(--muted); font-size: 7.8pt; }
footer { background: var(--green); color: #fff; padding: 4.5mm 13mm 5mm; display: flex; gap: 5.5mm; align-items: center; }
.qr { flex: none; display: block; width: 25mm; height: 25mm; background: #fff; border-radius: 1.8mm; padding: 1.8mm; }
.qr svg { width: 100%; height: 100%; display: block; }
.contact { flex: 1; min-width: 0; }
.contact .h { color: var(--gold); font-weight: 700; font-size: 10.5pt; }
.contact .body { font-size: 9.6pt; margin-top: .8mm; }
.contact a { color: #fff; font-weight: 700; }
.contact .links { font-size: 8pt; color: #cfe3d8; margin-top: 1.8mm; }
.contact .links a { font-weight: 600; }
.contact .inec { font-size: 7.8pt; color: #a9c7b7; margin-top: 1.2mm; }
</style></head><body><div class="page">
<header>
  <div class="brand">
    <img src="${icon}" alt="">
    <div><h1>HAWKEYE</h1><p class="sub">${SUBTITLE} <span class="tag">Independent · Nonpartisan</span></p></div>
    <a class="url" href="${SITE}">hawkeye.com.ng</a>
  </div>
  <div class="brief">
    <span class="kicker">${en('press.summary-h')}</span>
    <p class="lead">${en('press.summary')}</p>
  </div>
</header>
<main>
  <div class="col">
    <section><h2>${en('press.key-facts')}</h2><dl class="facts">${facts}</dl></section>
    <section><h2>${en('press.dates-h')}</h2><ul class="dates">${dates}</ul><p class="note">${en('press.dates-note')}</p></section>
  </div>
  <div class="col">
    <section><h2>${en('press.how-h')}</h2><ol class="steps">${steps}</ol></section>
    <section><h2>${en('press.trust-h')}</h2><ul class="trust">${trust}</ul></section>
  </div>
</main>
<footer>
  <a class="qr" href="${QR_URL}">${qrSvg}</a>
  <div class="contact">
    <div class="h">${en('press.contact-h')}.</div>
    <p class="body">${en('press.contact-body')}</p>
    <p class="links">${LINKS}</p>
    <p class="inec">${INEC}</p>
  </div>
</footer>
</div></body></html>`.normalize('NFC');

// Nothing may spill: main's content must fit between the band and the footer.
const MEASURE = () => {
  const page = document.querySelector('.page').getBoundingClientRect();
  const main = document.querySelector('main');
  const bad = [];
  if (main.scrollHeight > main.clientHeight + 1) bad.push(`main overflows by ${main.scrollHeight - main.clientHeight}px`);
  for (const el of document.querySelectorAll('.page *')) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.right > page.right + 0.5 || r.bottom > page.bottom + 0.5) bad.push(`${el.tagName}.${el.className?.baseVal ?? el.className} spills`);
  }
  const cols = [...document.querySelectorAll('.col')].map((col) => {
    col.style.justifyContent = 'flex-start';
    const room = col.getBoundingClientRect().bottom - col.lastElementChild.getBoundingClientRect().bottom;
    col.style.justifyContent = '';
    return +(room / 3.7795).toFixed(1);
  });
  const spare = Math.min(...cols) * 3.7795;
  if (spare < 0) bad.push(`main content is ${(-spare / 3.7795).toFixed(1)}mm too tall`);
  return { bad: bad.length ? [...bad, `column spare (mm) ${cols.join(' / ')}`] : bad, spareMm: +(spare / 3.7795).toFixed(1), cols };
};

const exe = '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const browser = await chromium.launch(fs.existsSync(exe) ? { executablePath: exe } : {});
try {
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  await page.emulateMedia({ media: 'print' });
  // Control: squeezing the page MUST be reported as overflowing, or the check is blind.
  await page.setContent(html.replace('height: 297mm; display: flex', 'height: 200mm; display: flex'), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const control = await page.evaluate(MEASURE);
  if (!control.bad.length) throw new Error('CONTROL FAILED: a 200 mm page reported no overflow');
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const m = await page.evaluate(MEASURE);
  if (m.bad.length) throw new Error(`layout does not fit: ${m.bad.slice(0, 5).join('; ')}`);
  const fam = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length);
  if (fam < 3) throw new Error(`Inter did not load (${fam} faces) — check app/fonts`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await page.pdf({ path: OUT, format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  console.log(`spare ${m.cols.join(' / ')}mm per column, control reported ${control.bad.length} issue(s), ${fam} font faces loaded`);
} finally {
  await browser.close();
}

// Read the PDF's own text layer back and check it: one page, EVERY sentence present, every link absolute.
const keys = ['press.summary-h', 'press.summary', 'press.key-facts',
  ...FACTS.flatMap((f) => [`press.fact-${f}-k`, `press.fact-${f}-v`]),
  'press.how-h', 'press.step-1', 'press.step-2', 'press.step-3',
  'press.trust-h', ...TRUST.map((t) => `press.trust-${t}`),
  'press.dates-h', ...DATES.flat().map((d) => `press.date-${d}`), 'press.dates-note',
  'press.contact-h', 'press.contact-body'];
const expect = [...keys.map((k) => plain(batch[k].en)), 'HAWKEYE', SUBTITLE, plain(LINKS), INEC];
const py = `
import fitz, json, sys
d = fitz.open(sys.argv[1])
print(json.dumps({"pages": d.page_count, "text": " ".join(" ".join(p.get_text().split()) for p in d),
                  "links": [l.get("uri") for p in d for l in p.get_links()]}))`;
const res = JSON.parse(execFileSync('python3', ['-c', py, OUT], { encoding: 'utf8' }));
// Case-folded: a heading may be set in capitals. A word wrapped at its own hyphen ("non-" / "profit") comes back as "non- profit".
const norm = (s) => s.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/(\w)- (?=\w)/g, '$1-').trim().toLowerCase();
const text = norm(res.text);
const missing = expect.filter((s) => !text.includes(norm(s)));
// Control: a sentence that is NOT on the sheet must be reported missing.
const control = !text.includes(norm('This sentence is not on the fact sheet'));
const wantLinks = [QR_URL, SITE, `${SITE}download.html`, `${SITE}ledger.html`, `${SITE}practice-day.html`,
  'https://github.com/HawkeyeNG/hawkeye', 'https://github.com/hawkeye-ng/hawkeye-verify', 'https://www.inecnigeria.org',
  'mailto:info@hawkeye.com.ng', 'tel:+2349078727777'];
// Chromium writes a bare origin with its trailing slash; compare without it.
const bare = (u) => (u || '').replace(/\/$/, '');
const linkMissing = wantLinks.filter((u) => !res.links.some((l) => bare(l) === bare(u)));
const relative = res.links.filter((u) => !/^(https:|mailto:|tel:)/.test(u || ''));
if (res.pages !== 1 || missing.length || !control || linkMissing.length || relative.length) {
  console.error(`FAIL pages=${res.pages} missing=${JSON.stringify(missing)} control=${control} linksMissing=${JSON.stringify(linkMissing)} relative=${JSON.stringify(relative)}`);
  process.exit(1);
}
console.log(`OK ${OUT}: 1 page, ${expect.length} sentences in the text layer (control passed), ${res.links.length} links (QR → ${QR_URL}), ${fs.statSync(OUT).size} bytes`);

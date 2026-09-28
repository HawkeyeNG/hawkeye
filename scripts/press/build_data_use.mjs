// Hawkeye data-use guide for parties: one A4 page, printed from HTML by headless Chromium.
//
//   node scripts/press/build_data_use.mjs [out.pdf]
//
// ONE SOURCE OF COPY, as with the fact sheet: every sentence is the English
// column of scripts/i18n/batches/stay_web.json (the press.data-* keys), the
// same figures app/press.html shows under "How much data does it use?". Change
// the figures there, re-merge the batch, then re-run this. The page shows some
// of them split (press.data-r1-fig / -sub in stay2_web.json); the PDF keeps
// the full original sentences, so the facts on paper do not move.
//
// THE LOOK is the Stay-for-the-count flyer's (docs/private/outreach/
// stay-for-the-count/build.mjs): green band, gold kicker, gold-ringed callout,
// green footer with a QR code. The QR opens https://hawkeye.com.ng/stay, and
// it, the footer and every URL on the page are live links in the PDF.
//
// The figures were checked against the code on 2026-09-27: report photos are
// compressed on the phone before signing (sheet 1500 px / q0.76, venue 1280 px
// / q0.72 — app/app.js compressCapture, native capture-camera.tsx
// downscaleForUpload, the document-scanner path included), two photos per
// report, 365 KB measured per submission; the native home tab polls six
// endpoints every 30 s only while the app is in the foreground. Re-measure on
// the 12 December Practice Day.
//
// The build fails if the PDF is not exactly one page, if anything spills off
// the page, if any sentence is missing from its TEXT LAYER (read with PyMuPDF,
// never from a rendering), or if a link is missing or relative.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const { chromium } = createRequire(`${ROOT}/tests/ui/`)('playwright-core');
const QRCode = createRequire(`${ROOT}/native/`)('qrcode');

const OUT = process.argv[2] || `${ROOT}/app/press/Hawkeye-Data-Use.pdf`;
const SITE = 'https://hawkeye.com.ng/';
const QR_URL = `${SITE}stay`;
const batch = JSON.parse(fs.readFileSync(`${ROOT}/scripts/i18n/batches/stay_web.json`, 'utf8'));
const en = (k) => {
  if (!batch[k]) throw new Error(`missing key ${k}`);
  return batch[k].en.replace(/href="(?!https?:|mailto:|tel:)([^"]+)"/g, `href="${SITE}$1"`);
};
const plain = (s) => s.replace(/<[^>]*>/g, '');

const font = (w) => `url(data:font/woff2;base64,${fs.readFileSync(`${ROOT}/app/fonts/inter-${w}.woff2`).toString('base64')}) format('woff2')`;
const icon = 'data:image/png;base64,' + fs.readFileSync(`${ROOT}/app/press/hawkeye-icon-512.png`).toString('base64');
const qrSvg = (await QRCode.toString(QR_URL, { type: 'svg', errorCorrectionLevel: 'M', margin: 0, color: { dark: '#00331eff', light: '#ffffffff' } }))
  .replace(/<\?xml[^>]*>/, '').replace('<svg ', '<svg aria-label="QR code: hawkeye.com.ng/stay" role="img" ');

// Footer and kicker lines: the same words the previous edition printed.
const KICKER = 'Hawkeye · 16 January 2027';
const FOOT_LINKS = `Get the app: <a href="${SITE}download">hawkeye.com.ng/download</a> · Stay for the count: <a href="${SITE}stay">hawkeye.com.ng/stay</a> · Press kit: <a href="${SITE}press.html#data">hawkeye.com.ng/press.html</a>`;
const FOOT_ASK = 'Questions: <a href="mailto:info@hawkeye.com.ng">info@hawkeye.com.ng</a> · <a href="tel:+2349078727777">+234 907 872 7777</a>';
const FOOT_INEC = 'Hawkeye is independent and nonpartisan. It does not declare results; official results are those declared by INEC.';

// Each bar is the figure against a 100 MB bundle (the advice): solid to the low
// end of the range, lighter to the high end. [from %, to %].
const BARS = { 1: [2, 2], 2: [10, 15], 3: [30, 50] };
const bar = (n) => {
  const [a, b] = BARS[n];
  return `<div class="bar"><i style="width:${a}%"></i>${b > a ? `<i class="hi" style="left:${a}%;width:${b - a}%"></i>` : ''}</div>`;
};
const rows = [1, 2, 3].map((n) => `<div class="row"><div class="lab">${en(`press.data-r${n}-k`)}</div><div class="val">${en(`press.data-r${n}-v`).replace(/ (\([^)]*\))$/, ' <span class="paren">$1</span>')}</div>${bar(n)}</div>`).join('');
const h1 = en('press.data-h').replace(/\bdata\b/, '<span class="gold">data</span>');

const ICO = {
  video: '<svg class="ico" viewBox="0 0 24 24"><rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="m15.5 10.5 5-3v9l-5-3z"/></svg>',
  wifi: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 9.5a13.5 13.5 0 0 1 18 0"/><path d="M6.2 13a8.8 8.8 0 0 1 11.6 0"/><path d="M9.4 16.4a4 4 0 0 1 5.2 0"/><circle cx="12" cy="19.4" r=".9" fill="currentColor"/></svg>',
  why: '<svg class="ico" viewBox="0 0 24 24"><path d="M4 14 9 9l4 4 7-7"/><path d="M15 6h5v5"/></svg>',
  web: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/></svg>',
  note: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/></svg>',
};
// Signal bars and a download arrow: the header art.
const ART = `<svg class="art" viewBox="0 0 64 64" aria-hidden="true">
<rect x="2" y="2" width="60" height="60" rx="12" fill="#00331e" stroke="#f5b301" stroke-width="1.6"/>
<g fill="#f5b301"><rect x="12" y="40" width="7" height="12" rx="1.6"/><rect x="22" y="32" width="7" height="20" rx="1.6"/><rect x="32" y="24" width="7" height="28" rx="1.6" opacity=".4"/><rect x="42" y="16" width="7" height="36" rx="1.6" opacity=".4"/></g>
<path d="M18 12 v14 m-5-5 l5 5 l5-5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How much data does Hawkeye use?</title><style>
@font-face { font-family: "HK Inter"; font-weight: 400; src: ${font(400)}; }
@font-face { font-family: "HK Inter"; font-weight: 600; src: ${font(600)}; }
@font-face { font-family: "HK Inter"; font-weight: 700; src: ${font(700)}; }
@page { size: A4; margin: 0; }
:root { --green:#004225; --deep:#00331e; --gold:#f5b301; --gold-ink:#7a5200; --cream:#fff7dc; --tint:#eef5f1; --ink:#10231a; --muted:#3b5849; --line:#dde4de; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 210mm; height: 297mm; }
body { font-family: "HK Inter", sans-serif; color: var(--ink); font-size: 10.5pt; line-height: 1.4; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
a { color: inherit; text-decoration: none; }
.page { width: 210mm; height: 297mm; display: flex; flex-direction: column; overflow: hidden; }
header { background: var(--green); color: #fff; padding: 9mm 14mm 9mm; }
.brand { display: flex; align-items: center; gap: 3mm; }
.brand img { width: 12mm; height: 12mm; border-radius: 2.6mm; display: block; }
.brand .name { font-weight: 700; letter-spacing: .16em; font-size: 12.5pt; }
.brand .tag { margin-left: auto; font-size: 8.4pt; font-weight: 600; color: var(--gold); border: .3mm solid var(--gold); border-radius: 10mm; padding: 1mm 3mm; }
.hero { display: flex; gap: 8mm; align-items: center; margin-top: 6mm; }
.hero-text { flex: 1; min-width: 0; }
.kicker { display: inline-block; background: var(--gold); color: var(--deep); font-weight: 700; font-size: 9.4pt; padding: 1.2mm 3mm; border-radius: 1.4mm; }
h1 { font-size: 30pt; line-height: 1.05; font-weight: 700; letter-spacing: -.012em; margin-top: 3.5mm; text-wrap: balance; }
.gold { color: var(--gold); }
.lede { margin-top: 3.2mm; font-size: 11.5pt; line-height: 1.4; color: #dcebe3; text-wrap: pretty; }
.art { width: 30mm; height: 30mm; flex: none; }
main { flex: 1; min-height: 0; display: flex; flex-direction: column; justify-content: space-evenly; gap: 3mm; padding: 3mm 14mm; }
.meter .mhead { display: flex; justify-content: space-between; font-size: 8.4pt; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); padding-bottom: 1.6mm; border-bottom: .55mm solid var(--gold); }
.row { display: grid; grid-template-columns: 1fr 68mm; column-gap: 6mm; align-items: start; padding: 3.2mm 0; border-bottom: .3mm solid var(--line); }
.lab { font-weight: 600; font-size: 11pt; line-height: 1.3; }
.val { font-weight: 700; font-size: 11pt; line-height: 1.3; color: var(--green); text-align: right; }
.bar { grid-column: 1 / -1; position: relative; height: 3.2mm; margin-top: 2.2mm; border-radius: 1.6mm; background: #e3ebe6; overflow: hidden; }
.bar i { position: absolute; top: 0; bottom: 0; left: 0; min-width: 2mm; border-radius: 1.6mm; background: var(--gold); }
.bar i.hi { background: rgba(245, 179, 1, .42); border-radius: 0 1.6mm 1.6mm 0; min-width: 0; }
.scale { display: flex; justify-content: space-between; font-size: 8.2pt; font-weight: 600; color: var(--muted); padding: 1.4mm 0 0; }
.row.video { grid-template-columns: auto 1fr 68mm; column-gap: 3.5mm; align-items: center; border-bottom: 0; margin-top: 2mm; background: var(--tint); border-radius: 2.4mm; padding: 3mm 4mm; }
.val .paren { display: block; font-weight: 600; font-size: 9.4pt; color: var(--muted); margin-top: .6mm; }
.row.video .val { font-size: 9.6pt; text-align: left; }
.badge { width: 9mm; height: 9mm; border-radius: 2.4mm; background: var(--cream); color: var(--gold-ink); display: flex; align-items: center; justify-content: center; flex: none; }
.ico { width: 5.2mm; height: 5.2mm; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.advice { display: grid; grid-template-columns: 1.15fr 1fr; gap: 4mm; }
.best { border: .9mm solid var(--gold); background: var(--cream); border-radius: 2.8mm; padding: 3.6mm 4mm; display: flex; gap: 4mm; align-items: center; }
.big { flex: none; font-weight: 700; font-size: 26pt; line-height: .95; color: var(--green); text-align: center; letter-spacing: -.02em; }
.big small { display: block; font-size: 9pt; letter-spacing: .12em; color: var(--gold-ink); margin-top: .8mm; }
.best p, .wifi p { font-size: 10.4pt; line-height: 1.38; }
.best strong, .wifi strong { color: var(--green); }
.wifi { background: var(--tint); border-radius: 2.8mm; padding: 3.6mm 4mm; display: flex; gap: 3.5mm; align-items: center; }
.notes { list-style: none; display: grid; gap: 2mm; }
.notes li { display: flex; gap: 2.6mm; align-items: flex-start; font-size: 9.6pt; color: var(--muted); line-height: 1.38; }
.notes .ico { width: 4.4mm; height: 4.4mm; color: var(--gold-ink); margin-top: .3mm; flex: none; }
footer { background: var(--green); color: #fff; padding: 6mm 14mm 6.5mm; display: flex; gap: 6mm; align-items: center; }
.qr { flex: none; display: block; width: 30mm; height: 30mm; background: #fff; border-radius: 2mm; padding: 2mm; }
.qr svg { width: 100%; height: 100%; display: block; }
.get { flex: 1; min-width: 0; }
.get .h { color: var(--gold); font-weight: 700; font-size: 11pt; }
.get .site { font-size: 17pt; font-weight: 700; line-height: 1.15; margin-top: .6mm; }
.get p { font-size: 9pt; color: #cfe3d8; margin-top: 1.6mm; line-height: 1.38; }
.get p a { color: #fff; font-weight: 600; }
.get .inec { font-size: 8.2pt; color: #a9c7b7; }
</style></head><body><div class="page">
<header>
  <div class="brand"><img src="${icon}" alt=""><span class="name">HAWKEYE</span><span class="tag">Independent · Nonpartisan</span></div>
  <div class="hero">
    <div class="hero-text">
      <span class="kicker">${KICKER}</span>
      <h1>${h1}</h1>
      <p class="lede">${en('press.data-lede')}</p>
    </div>
    ${ART}
  </div>
</header>
<main>
  <section class="meter">
    <div class="mhead"><span>${en('press.data-col-use')}</span><span>${en('press.data-col-data')}</span></div>
    ${rows}
    <div class="scale"><span>0</span><span>50 MB</span><span>100 MB</span></div>
    <div class="row video"><span class="badge">${ICO.video}</span><div class="lab">${en('press.data-r4-k')}</div><div class="val">${en('press.data-r4-v')}</div></div>
  </section>
  <section class="advice">
    <div class="best"><div class="big">100<small>MB</small></div><p>${en('press.data-advice')}</p></div>
    <div class="wifi"><span class="badge">${ICO.wifi}</span><p>${en('press.data-before')}</p></div>
  </section>
  <ul class="notes">
    <li>${ICO.why}<span>${en('press.data-why')}</span></li>
    <li>${ICO.web}<span>${en('press.data-browser')}</span></li>
    <li>${ICO.note}<span>${en('press.data-note')}</span></li>
  </ul>
</main>
<footer>
  <a class="qr" href="${QR_URL}">${qrSvg}</a>
  <div class="get">
    <div class="h">Stay for the count · Get the app</div>
    <div class="site"><a href="${QR_URL}">hawkeye.com.ng/stay</a></div>
    <p>${FOOT_LINKS}</p>
    <p>${FOOT_ASK}</p>
    <p class="inec">${FOOT_INEC}</p>
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
  main.style.justifyContent = 'flex-start';
  const spare = main.getBoundingClientRect().bottom - parseFloat(getComputedStyle(main).paddingBottom) - main.lastElementChild.getBoundingClientRect().bottom;
  main.style.justifyContent = '';
  if (spare < 0) bad.push(`main content is ${(-spare / 3.7795).toFixed(1)}mm too tall`);
  return { bad, spareMm: +(spare / 3.7795).toFixed(1) };
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
  console.log(`spare ${m.spareMm}mm, control reported ${control.bad.length} issue(s), ${fam} font faces loaded`);
} finally {
  await browser.close();
}

// Read the PDF back: one page, every sentence in the TEXT LAYER, every link absolute.
const keys = ['press.data-h', 'press.data-lede', 'press.data-col-use', 'press.data-col-data',
  'press.data-r1-k', 'press.data-r1-v', 'press.data-r2-k', 'press.data-r2-v',
  'press.data-r3-k', 'press.data-r3-v', 'press.data-r4-k', 'press.data-r4-v', 'press.data-advice', 'press.data-before',
  'press.data-why', 'press.data-browser', 'press.data-note'];
const expect = [...keys.map((k) => plain(batch[k].en)), KICKER, plain(FOOT_LINKS), plain(FOOT_ASK), FOOT_INEC];
const py = `
import fitz, json, sys
d = fitz.open(sys.argv[1])
print(json.dumps({"pages": d.page_count, "text": " ".join(" ".join(p.get_text().split()) for p in d),
                  "links": [l.get("uri") for p in d for l in p.get_links()]}))`;
const res = JSON.parse(execFileSync('python3', ['-c', py, OUT], { encoding: 'utf8' }));
// Case-folded: a heading may be set in capitals. A word wrapped at its own hyphen comes back as "non- profit".
const norm = (s) => s.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/(\w)- (?=\w)/g, '$1-').trim().toLowerCase();
const text = norm(res.text);
const missing = expect.filter((s) => !text.includes(norm(s)));
const control = !text.includes(norm('This sentence is not on the data-use guide'));
const wantLinks = [QR_URL, `${SITE}download`, `${SITE}press.html#data`, 'mailto:info@hawkeye.com.ng', 'tel:+2349078727777'];
const linkMissing = wantLinks.filter((u) => !res.links.includes(u));
const relative = res.links.filter((u) => !/^(https:|mailto:|tel:)/.test(u || ''));
if (res.pages !== 1 || missing.length || !control || linkMissing.length || relative.length) {
  console.error(`FAIL pages=${res.pages} missing=${JSON.stringify(missing)} control=${control} linksMissing=${JSON.stringify(linkMissing)} relative=${JSON.stringify(relative)}`);
  process.exit(1);
}
console.log(`OK ${OUT}: 1 page, ${expect.length} sentences in the text layer (control passed), ${res.links.length} links (QR → ${QR_URL}), ${fs.statSync(OUT).size} bytes`);

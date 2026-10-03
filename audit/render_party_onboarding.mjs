// Render the PARTY ONBOARDING pack: the A4 guide (PDF) and the agent card
// (1080x1350 + 1080x1080 PNG).
//
//   node audit/render_party_onboarding.mjs [outDir]
//
// Fonts are EMBEDDED from local files (no network at render time), so a render
// is the same on any day. The QR is made locally with the `qrcode` package
// already in native/node_modules — no third-party QR service ever sees the URL.
//
// GATES, each of which fails the run (exit 1) rather than printing a warning:
//   - a font that did not load (the page would silently fall back to Segoe/Arial)
//   - any guide page whose content runs past its footer, or past the page edge
//   - any card whose content boxes overlap or leave the canvas (measured from
//     the boxes, never document.scrollHeight: the .hash backdrop is
//     deliberately larger than the card and clipped)
//   - a card QR that does not DECODE to the URL (zxing-wasm, also already in
//     native/node_modules), with a control: the same card with the QR hidden
//     must decode to nothing, or the check is not checking anything.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/tests/ui/`);
const { chromium } = require_('playwright-core');
const QRCode = createRequire(`${ROOT}/native/`)('qrcode');
const { prepareZXingModule, readBarcodes } = await import(`${ROOT}/native/node_modules/zxing-wasm/dist/es/reader/index.js`);

const OUT = process.argv[2] || '/mnt/c/Users/HP/Downloads/Hawkeye-ADC-Meeting-2026-09-29';
const QR_URL = 'https://hawkeye.com.ng/download';
const HERE = path.dirname(new URL(import.meta.url).pathname);
if (!fs.existsSync(OUT)) throw new Error(`output folder missing: ${OUT}`);

// ---- assets (fail loudly on a missing one) ---------------------------------
const need = (p) => { if (!fs.existsSync(p)) throw new Error(`missing asset: ${p}`); return fs.readFileSync(p); };
const CANVAS = '/home/elrio/.claude/skills/canvas-design/canvas-fonts';
const face = (family, weight, file, fmt) =>
  `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:block;`
  + `src:url(data:font/${fmt};base64,${need(file).toString('base64')}) format('${fmt === 'ttf' ? 'truetype' : 'woff2'}');}`;
const FONTS = [
  face('Inter', 400, `${ROOT}/app/fonts/inter-400.woff2`, 'woff2'),
  face('Inter', 500, `${ROOT}/app/fonts/inter-500.woff2`, 'woff2'),
  face('Inter', 600, `${ROOT}/app/fonts/inter-600.woff2`, 'woff2'),
  face('Inter', 700, `${ROOT}/app/fonts/inter-700.woff2`, 'woff2'),
  face('Bricolage Grotesque', 700, `${CANVAS}/BricolageGrotesque-Bold.ttf`, 'ttf'),
  face('JetBrains Mono', 400, `${CANVAS}/JetBrainsMono-Regular.ttf`, 'ttf'),
  face('JetBrains Mono', 700, `${CANVAS}/JetBrainsMono-Bold.ttf`, 'ttf'),
].join('\n');
const LOGO = `data:image/png;base64,${need(`${ROOT}/design/hawk-crest.png`).toString('base64')}`;
const QR_SVG = (await QRCode.toString(QR_URL, {
  type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#05271aff', light: '#ffffffff' },
})).replace(/<\?xml[^>]*>/, '').replace('<svg ', '<svg role="img" aria-label="QR code: hawkeye.com.ng/download" ');

const fill = (html) => {
  for (const k of ['/*FONTS*/', '__LOGO__', '__QR__']) if (!html.includes(k)) throw new Error(`template lacks ${k}`);
  return html.replace('/*FONTS*/', FONTS).replaceAll('__LOGO__', LOGO).replaceAll('__QR__', QR_SVG);
};
const guideHtml = fill(fs.readFileSync(path.join(HERE, 'party_onboarding.html'), 'utf8'));
const cardHtml = fill(fs.readFileSync(path.join(HERE, 'party_onboarding_card.html'), 'utf8'));

const FONT_CHECKS = ['400 12px Inter', '700 12px Inter', '700 12px "Bricolage Grotesque"', '400 12px "JetBrains Mono"', '700 12px "JetBrains Mono"'];
async function fontsOk(p) {
  await p.evaluate(() => document.fonts.ready);
  const bad = await p.evaluate((list) => list.filter((f) => !document.fonts.check(f)), FONT_CHECKS);
  if (bad.length) throw new Error(`fonts not loaded: ${bad.join(', ')}`);
}

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
let failed = false;

// ---- the guide (PDF) ------------------------------------------------------
{
  const p = await browser.newPage({ viewport: { width: 794, height: 1123 } });
  await p.setContent(guideHtml, { waitUntil: 'load' });
  await fontsOk(p);
  await p.emulateMedia({ media: 'print' });
  const pages = await p.evaluate(() => [...document.querySelectorAll('.page')].map((pg) => {
    const r = pg.getBoundingClientRect();
    const body = pg.querySelector('.body');
    const foot = pg.querySelector('.pf').getBoundingClientRect();
    let lowest = 0, widest = 0, culprit = '';
    for (const el of body.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      if (!b.height) continue;
      if (b.bottom > lowest) { lowest = b.bottom; culprit = (el.className || el.tagName) + ': ' + (el.textContent || '').trim().slice(0, 50); }
      if (b.right > widest) widest = b.right;
    }
    return {
      id: pg.id, overflowY: body.scrollHeight - body.clientHeight, spare: Math.round(foot.top - lowest),
      footPastEdge: Math.round(foot.bottom - r.bottom), widePastEdge: Math.round(widest - r.right), culprit,
    };
  }));
  for (const m of pages) {
    const bad = [];
    if (m.overflowY > 1) bad.push(`body overflows by ${m.overflowY}px`);
    if (m.spare < 0) bad.push(`content runs ${-m.spare}px into the footer (${m.culprit})`);
    if (m.footPastEdge > 1) bad.push('footer past the page edge');
    if (m.widePastEdge > 1) bad.push(`content ${m.widePastEdge}px past the right edge`);
    console.log(`guide ${m.id}: spare ${m.spare}px above footer${bad.length ? ' — OVERFLOW: ' + bad.join('; ') : ''}`);
    if (bad.length) failed = true;
  }
  // Rendered to /tmp first, then copied: a PDF open in Acrobat on Windows is
  // locked, and a failed overwrite must not stop the cards from rendering or
  // leave the reader believing they have the new copy.
  const tmpPdf = '/tmp/Hawkeye-Party-Onboarding-Guide.pdf';
  await p.pdf({ path: tmpPdf, preferCSSPageSize: true, printBackground: true });
  try {
    fs.copyFileSync(tmpPdf, `${OUT}/Hawkeye-Party-Onboarding-Guide.pdf`);
    console.log('wrote Hawkeye-Party-Onboarding-Guide.pdf', pages.length, 'pages laid out');
  } catch (e) {
    console.error(`PDF NOT UPDATED (${e.code}): the old copy is open somewhere (Acrobat?). New copy at ${tmpPdf}`);
    failed = true;
  }
  await p.close();
}

// ---- the card (PNG, two sizes) ----------------------------------------------
await prepareZXingModule({
  overrides: { wasmBinary: need(`${ROOT}/native/node_modules/zxing-wasm/dist/reader/zxing_reader.wasm`).buffer.slice(0) },
  fireImmediately: true,
});
const decode = async (png) => (await readBarcodes(new Uint8Array(png), { formats: ['QRCode'], tryHarder: true })).map((r) => r.text);

for (const [w, h, cls, name] of [
  [1080, 1350, 'tall', 'Hawkeye-Party-Onboarding-Card.png'],
  [1080, 1080, 'square', 'Hawkeye-Party-Onboarding-Card-Square.png'],
]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(cardHtml.replace('<body class="tall" id="card-body">', `<body class="${cls}" id="card-body">`), { waitUntil: 'load' });
  await fontsOk(p);
  await p.waitForTimeout(200);
  // The variant must actually be applied: a replace() that misses its target
  // renders the tall layout into a square canvas and "passes" everything else.
  const applied = await p.evaluate(() => document.body.className);
  if (applied !== cls) throw new Error(`variant not applied: body class is "${applied}", wanted "${cls}"`);
  const m = await p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const items = [...document.querySelectorAll('.top, .kicker, h1, li, .get, .foot')].map((el) => {
      const b = el.getBoundingClientRect();
      return { s: el.className || el.tagName, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    });
    const texts = [...document.querySelectorAll('li .t, .get p, h1')].map((el) => ({ s: el.textContent.slice(0, 30), over: el.scrollWidth - el.clientWidth }));
    return { W: innerWidth, H: innerHeight, items, texts, h1: r('h1'), main: r('.main'), foot: r('.foot') };
  });
  const bad = [];
  for (const it of m.items) {
    if (it.top < 0 || it.left < 0 || it.right > m.W + 1 || it.bottom > m.H + 1) bad.push(`${it.s} leaves the canvas`);
  }
  if (m.main.top < m.h1.bottom - 1) bad.push('steps overlap the headline');
  const lowest = Math.max(...m.items.filter((i) => i.s !== 'foot').map((i) => i.bottom));
  if (lowest > m.foot.top + 1) bad.push(`content runs ${Math.round(lowest - m.foot.top)}px into the footer`);
  for (const t of m.texts) if (t.over > 1) bad.push(`text clipped: ${t.s}`);

  const png = await p.screenshot();
  const got = await decode(png);
  if (got.length !== 1 || got[0] !== QR_URL) bad.push(`QR decodes to ${JSON.stringify(got)}, wanted ${QR_URL}`);
  // CONTROL: the same card with the QR hidden must decode to nothing.
  await p.addStyleTag({ content: '.qr svg { visibility: hidden; }' });
  const ctrl = await decode(await p.screenshot());
  if (ctrl.length) bad.push(`CONTROL FAILED: QR-less card still decoded ${JSON.stringify(ctrl)}`);

  fs.writeFileSync(`${OUT}/${name}`, png);
  console.log(`wrote ${name} ${w}x${h} · spare ${Math.round(m.foot.top - lowest)}px above footer · QR -> ${got.join(',')} · control -> ${ctrl.length ? 'DECODED (bad)' : 'nothing (good)'}`
    + (bad.length ? ' — FAIL: ' + bad.join('; ') : ''));
  if (bad.length) failed = true;
  await p.close();
}
await browser.close();
if (failed) { console.error('RENDER GATES FAILED'); process.exit(1); }
console.log('all gates passed');

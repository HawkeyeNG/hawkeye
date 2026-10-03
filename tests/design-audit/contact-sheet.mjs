/**
 * Contact sheets: every screen of a surface on one PNG.
 *   node contact-sheet.mjs [--surface web|lite|native|all] [--vp s360] [--dry-run]
 * Per screen: dark EN, light EN, dark HA, dark YO at the chosen phone size.
 * Web also gets a desktop sheet (1366, dark + light EN).
 * Output: out/contact-<surface>.png (+ out/contact-web-desktop.png)
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, CHROME, OUT, log } from './lib.mjs';
import { SURFACES } from './inventory.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const surfaces = arg('surface', 'all') === 'all' ? ['web', 'lite', 'native'] : [arg('surface')];
const dry = argv.includes('--dry-run');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SURF = { web: 'Website — hawkeye.com.ng', lite: 'Hawkeye Lite — Capacitor app (app/ in the phone shell)', native: 'Hawkeye — native app (Expo / React Native, via its web export)' };

function sheetHtml(surface, title, cards, variants, thumbW) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Inter; src: url('file:///home/elrio/hawkeye/app/fonts/inter-400.woff2'); font-weight: 400; }
  @font-face { font-family: Inter; src: url('file:///home/elrio/hawkeye/app/fonts/inter-600.woff2'); font-weight: 600; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 36px 40px 48px; background: #f4f1e8; color: #10241a; font: 13px/1.35 Inter, system-ui, sans-serif; }
  header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 2px solid #004225; padding-bottom: 12px; margin-bottom: 22px; }
  h1 { font-size: 26px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  header p { margin: 0; color: #4a5a50; }
  .area { font-size: 12px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #004225; margin: 26px 0 10px; }
  .grid { display: grid; grid-template-columns: repeat(${Math.max(1, Math.floor(2400 / (variants.length * (thumbW + 8) + 24)))}, max-content); gap: 18px 22px; }
  .card { background: #fff; border: 1px solid #d9d3c3; border-radius: 10px; padding: 10px 12px 12px; }
  .card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; max-width: ${variants.length * (thumbW + 8)}px; }
  .row { display: flex; gap: 8px; }
  figure { margin: 0; width: ${thumbW}px; }
  figure img { width: ${thumbW}px; display: block; border: 1px solid #cfc8b6; border-radius: 4px; background: #ddd; }
  figure.missing div { width: ${thumbW}px; height: ${Math.round(thumbW * 1.6)}px; border: 1px dashed #b9b09a; border-radius: 4px; display: grid; place-items: center; color: #8a8270; font-size: 11px; }
  figcaption { font-size: 10px; color: #6a756d; margin-top: 3px; text-align: center; letter-spacing: .04em; }
  .flag { color: #a33; font-weight: 600; }
  </style></head><body>
  <header><h1>${esc(title)}</h1><p>${esc(SURF[surface])} · captured ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p></header>
  ${cards.map((group) => `<div class="area">${esc(group.area)}</div><div class="grid">${group.items.map((c) => `
    <div class="card"><h3>${esc(c.title)}${c.bounced ? ' <span class="flag">· bounced</span>' : ''}</h3><div class="row">${c.thumbs.map((t) => t.src
      ? `<figure><img src="file://${t.src}"><figcaption>${esc(t.label)}</figcaption></figure>`
      : `<figure class="missing"><div>not captured</div><figcaption>${esc(t.label)}</figcaption></figure>`).join('')}</div></div>`).join('')}</div>`).join('')}
  </body></html>`;
}

async function build(browser, surface, { vp, variants, name, title, thumbW }) {
  const resFile = path.join(OUT, surface, dry ? 'results-dry.json' : 'results.json');
  const results = fs.existsSync(resFile) ? JSON.parse(fs.readFileSync(resFile, 'utf8')).results : [];
  const groups = [];
  for (const s of SURFACES[surface].screens) {
    const rs = results.filter((r) => r.id === s.id);
    if (!rs.length) continue;
    const thumbs = variants.map(([theme, lang]) => {
      const f = path.join(OUT, surface, 'shots', s.id, `${vp}-${theme}-${lang}.png`);
      return { label: `${theme} · ${lang.toUpperCase()}`, src: fs.existsSync(f) ? f : null };
    });
    const bounced = rs.some((r) => r.vp === vp && r.lang === 'en' && r.kind === 'matrix' && r.bounced);
    let g = groups.find((x) => x.area === s.area);
    if (!g) { g = { area: s.area, items: [] }; groups.push(g); }
    g.items.push({ title: s.title, thumbs, bounced });
  }
  const html = sheetHtml(surface, title, groups, variants, thumbW);
  const htmlFile = path.join(OUT, `${name}.html`);
  fs.writeFileSync(htmlFile, html);
  const page = await browser.newPage({ viewport: { width: 2480, height: 1200 }, deviceScaleFactor: 1 });
  await page.goto('file://' + htmlFile, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  const png = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: png, fullPage: true });
  await page.close();
  log('wrote', png);
  return png;
}

/**
 * PARITY SHEETS (--parity): the same screen on web, Lite and native side by
 * side, dark + light, 360 EN — the consistency review. Chunked so each PNG
 * stays legible: out/parity-01.png, parity-02.png, ...
 */
async function parity(browser, langSurface = null) {
  const ids = [];
  const pool = langSurface ? SURFACES[langSurface].screens : SURFACES.native.screens.concat(SURFACES.web.screens);
  for (const s of pool) if (!ids.includes(s.id)) ids.push(s.id);
  const prefix = langSurface ? `langs-${langSurface}` : 'parity';
  const rowsAll = ids.map((id) => {
    const cells = [];
    if (langSurface) {
      // --langs <surface>: the same screen in EN HA IG YO (dark) + EN light — the overflow review
      for (const [theme, lang] of [['dark', 'en'], ['dark', 'ha'], ['dark', 'ig'], ['dark', 'yo'], ['light', 'en'], ['light', 'ha']]) {
        const f = path.join(OUT, langSurface, 'shots', id, `s360-${theme}-${lang}.png`);
        cells.push({ label: `${lang} · ${theme}`, src: fs.existsSync(f) ? f : null });
      }
    } else for (const theme of ['dark', 'light']) for (const surface of ['web', 'lite', 'native']) {
      const f = path.join(OUT, surface, 'shots', id, `s360-${theme}-en.png`);
      cells.push({ label: `${surface} · ${theme}`, src: fs.existsSync(f) ? f : null });
    }
    const t = (SURFACES.web.screens.find((s) => s.id === id) || SURFACES.native.screens.find((s) => s.id === id)).title;
    return { id, title: t, cells, n: cells.filter((c) => c.src).length };
  }).filter((r) => r.n >= (langSurface ? 1 : 3));
  const per = Number(arg('per', 4));
  const files = [];
  for (let i = 0; i < rowsAll.length; i += per) {
    const rows = rowsAll.slice(i, i + per);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; padding: 24px; background: #f4f1e8; font: 13px Inter, system-ui, sans-serif; color: #10241a; }
      .r { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 18px; background: #fff; padding: 10px; border: 1px solid #d9d3c3; border-radius: 8px; }
      .t { width: 120px; font-weight: 600; } .t small { display: block; font-weight: 400; color: #6a756d; margin-top: 4px; }
      figure { margin: 0; width: 240px; } img { width: 240px; display: block; border: 1px solid #cfc8b6; }
      .gap { width: 14px; } figcaption { font-size: 11px; text-align: center; color: #6a756d; }
      .miss { width: 240px; height: 300px; border: 1px dashed #b9b09a; display: grid; place-items: center; color: #8a8270; }
    </style></head><body>${rows.map((r) => `<div class="r"><div class="t">${esc(r.title)}<small>${esc(r.id)}</small></div>${r.cells.map((c, k) => `${k === 3 ? '<div class="gap"></div>' : ''}<figure>${c.src ? `<img src="file://${c.src}">` : '<div class="miss">—</div>'}<figcaption>${esc(c.label)}</figcaption></figure>`).join('')}</div>`).join('')}</body></html>`;
    const hf = path.join(OUT, 'sheets', `${prefix}-${String(i / per + 1).padStart(2, '0')}.html`);
    fs.mkdirSync(path.dirname(hf), { recursive: true });
    fs.writeFileSync(hf, html);
    const page = await browser.newPage({ viewport: { width: 1660, height: 900 } });
    await page.goto('file://' + hf);
    await page.waitForTimeout(500);
    const png = hf.replace(/\.html$/, '.png');
    await page.screenshot({ path: png, fullPage: true });
    await page.close();
    files.push(png);
  }
  log(prefix, 'sheets:', files.length);
}

const browser = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files'] });
if (argv.includes('--parity')) { await parity(browser); await browser.close(); process.exit(0); }
if (arg('langs')) { for (const s of arg('langs').split(',')) await parity(browser, s); await browser.close(); process.exit(0); }
for (const surface of surfaces) {
  const vp = arg('vp', 's360');
  const label = { web: 'Website', lite: 'Hawkeye Lite', native: 'Native app' }[surface];
  await build(browser, surface, {
    vp, name: `contact-${surface}`, thumbW: 150,
    title: `${label} — every screen at ${vp === 's360' ? '360×740' : '390×844'}`,
    variants: [['dark', 'en'], ['light', 'en'], ['dark', 'ha'], ['dark', 'yo']],
  });
  if (surface === 'web') {
    await build(browser, surface, {
      vp: 'd1366', name: 'contact-web-desktop', thumbW: 300,
      title: 'Website — every page at 1366×900',
      variants: [['dark', 'en'], ['light', 'en']],
    });
  }
}
await browser.close();

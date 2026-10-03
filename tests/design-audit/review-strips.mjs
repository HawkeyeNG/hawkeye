/**
 * Reviewer aid: one PNG per screen with the fold and every scroll frame side by
 * side at CSS-pixel scale, so a whole page reads in one image.
 *   node review-strips.mjs --surface web [--vp s360] [--theme dark] [--lang en] [--only a,b]
 * Output: out/review/<surface>-<id>-<vp>-<theme>-<lang>.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, CHROME, OUT, VIEWPORTS, log } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const surface = arg('surface', 'web');
const vp = arg('vp', 's360');
const theme = arg('theme', 'dark');
const lang = arg('lang', 'en');
const only = arg('only') ? arg('only').split(',') : null;
const W = VIEWPORTS[vp].width;
const root = path.join(OUT, surface, 'shots');
const dest = path.join(OUT, 'review');
fs.mkdirSync(dest, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 800 } });
let n = 0;
for (const id of fs.readdirSync(root)) {
  if (only && !only.includes(id)) continue;
  const stem = `${vp}-${theme}-${lang}`;
  const frames = [`${stem}.png`, ...[1, 2, 3, 4].map((i) => `${stem}-s${i}.png`), `${stem}-menu.png`, `${stem}-report-sheet.png`]
    .filter((f) => fs.existsSync(path.join(root, id, f)));
  if (!frames.length) continue;
  const html = `<html><body style="margin:0;background:#888;display:flex;gap:6px;padding:6px;width:max-content">${frames.map((f) => `<div><img src="file://${path.join(root, id, f)}" style="width:${W}px;display:block"><div style="font:11px monospace;color:#fff">${f}</div></div>`).join('')}</body></html>`;
  const hf = path.join(dest, '_strip.html');
  fs.writeFileSync(hf, html);
  await page.goto('file://' + hf);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(dest, `${surface}-${id}-${stem}.png`), fullPage: true });
  n++;
}
await browser.close();
log('strips', n);
process.exit(0);

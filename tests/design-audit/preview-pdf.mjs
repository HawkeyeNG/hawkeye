/**
 * Render the report HTML as print-sized page images, to check the PDF layout.
 *   node preview-pdf.mjs [--pages 1-4]
 * Uses print media emulation at A4 width; out/pdf-preview/page-NN.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, CHROME, OUT } from './lib.mjs';
const dir = path.join(OUT, 'pdf-preview');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const b = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 680, height: 934 }, deviceScaleFactor: 1 });
await p.goto('file://' + path.join(OUT, 'report.html'), { waitUntil: 'load' });
await p.emulateMedia({ media: 'print' });
await p.waitForTimeout(800);
// A PDF of the report, re-rendered page by page through pdf.js is heavy; instead screenshot the
// screen layout at A4 width in slices — close enough to judge spacing, images and type.
const h = await p.evaluate(() => document.documentElement.scrollHeight);
let n = 0;
for (let y = 0; y < h && n < 40; y += 934) {
  await p.screenshot({ fullPage: true, path: path.join(dir, `page-${String(++n).padStart(2, '0')}.png`), clip: { x: 0, y, width: 680, height: Math.min(934, h - y) } });
}
console.log('slices', n, 'height', h);
await b.close();
process.exit(0);

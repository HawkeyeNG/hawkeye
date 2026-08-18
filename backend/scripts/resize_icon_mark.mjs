/**
 * Shrink the eagle inside its tile, without redrawing it.
 *
 * WHY THREE HAWKEYE ICONS ON ONE HOME SCREEN LOOK LIKE THREE SIZES. Android
 * adaptive icons draw the foreground on a 108dp canvas and guarantee only the
 * middle 72dp is visible — so what a launcher SHOWS is not the mark's share of
 * the source PNG, it is that share divided by 72/108. And the two Android builds
 * feed that canvas differently:
 *
 *   Capacitor  <inset 16.7%> round the foreground, so the PNG is squeezed to
 *              66.6% of the canvas first: 83.3% of PNG -> 55.5% of canvas
 *              -> 83.2% of the visible mask.
 *   Native     no inset, the foreground IS the canvas: 61.5% -> 92.3% visible.
 *   PWA        Chrome's WebAPK uses the maskable icon as the whole foreground:
 *              60.4% -> 90.6% visible.
 *
 * Hence the ask: land between the largest (PWA) and the smallest (Capacitor).
 *
 * HOW IT SHRINKS. Not by re-exporting from source art — there is no vector
 * master for the eagle here, and a re-trace would change the drawing as well as
 * its size. Instead the whole image is scaled about its centre by a factor and
 * the revealed border is refilled with the tile's own background (or with
 * transparency where the source has none). The mark is untouched apart from one
 * resample, and stays exactly centred.
 *
 *   node scripts/resize_icon_mark.mjs <file> <factor> [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'));
const sharp = require_('sharp');

const file = process.argv[2];
const factor = Number(process.argv[3]);
const dry = process.argv.includes('--dry');
if (!file || !Number.isFinite(factor) || factor <= 0 || factor > 1.5) {
  console.error('usage: resize_icon_mark.mjs <file> <factor 0-1.5> [--dry]');
  process.exit(2);
}
if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }

/** The mark's largest dimension as a fraction of the canvas. */
async function measure(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const at = (x, y) => { const i = (y * w + x) * ch; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  const bg = at(0, 0);
  const near = (a, b, t) => Math.abs(a[0] - b[0]) < t && Math.abs(a[1] - b[1]) < t && Math.abs(a[2] - b[2]) < t;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = at(x, y);
    if (px[3] < 24) continue;
    if (bg[3] > 24 && near(px, bg, 26)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return { span: 0, w, h, bg };
  return { span: Math.max((maxX - minX + 1) / w, (maxY - minY + 1) / h), w, h, bg };
}

const src = fs.readFileSync(file);
const before = await measure(src);
const meta = await sharp(src).metadata();
const W = meta.width, H = meta.height;

// Scale the whole tile, then pad back to size with the tile's own field. Padding
// rather than cropping is the point: the mark shrinks and the background grows,
// which is exactly "the logo is smaller inside the same icon".
const inner = await sharp(src)
  .resize({ width: Math.round(W * factor), height: Math.round(H * factor), fit: 'fill' })
  .toBuffer();

const padL = Math.floor((W - Math.round(W * factor)) / 2);
const padT = Math.floor((H - Math.round(H * factor)) / 2);
// A transparent source (an adaptive foreground) must stay transparent — filling
// it with a colour would paint a square behind the mark and defeat the mask.
const fill = before.bg[3] < 24
  ? { r: 0, g: 0, b: 0, alpha: 0 }
  : { r: before.bg[0], g: before.bg[1], b: before.bg[2], alpha: before.bg[3] / 255 };

const out = await sharp({
  create: { width: W, height: H, channels: 4, background: fill },
})
  .composite([{ input: inner, left: padL, top: padT }])
  .png()
  .toBuffer();

const after = await measure(out);
const pct = (v) => `${(v * 100).toFixed(1)}%`;
console.log(
  `${path.basename(file).padEnd(28)} ${W}x${H}  mark ${pct(before.span)} -> ${pct(after.span)}` +
  `  (x${factor})  bg ${before.bg[3] < 24 ? 'transparent' : `rgb(${before.bg.slice(0, 3).join(',')})`}` +
  `${dry ? '   [dry run, not written]' : ''}`);
if (!dry) fs.writeFileSync(file, out);

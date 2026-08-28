/**
 * Size the Lite crest inside the Android adaptive foreground.
 *
 *   node scripts/make_lite_icon.mjs [--target 0.64] [--dry]
 *
 * WHY THIS EXISTS. An Android adaptive icon is a 108dp foreground of which only
 * the inner 72dp — 66.7% — is guaranteed visible; launchers mask the rest. The
 * Lite foreground had the crest at 54% x 51% of the canvas, comfortably inside
 * that but noticeably smaller than the full-bleed green icons sitting next to it
 * on the home screen. On a phone with all three Hawkeye apps installed, Lite
 * looked like the runt.
 *
 * 0.64 fills the safe zone without touching it: 64% of 108dp = 69dp against the
 * 72dp guarantee, so nothing important can be masked away on any launcher shape.
 * Above ~0.667 the beak starts landing where a circular mask cuts.
 *
 * The crest is re-measured and re-placed from whatever the file currently holds,
 * so running it twice does not compound the scale.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const sharp = require_('sharp');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const TARGET = Number(arg('target', '0.64'));
const DRY = argv.includes('--dry');
const SRC = arg('src', 'assets/icon-foreground.png');

if (!(TARGET > 0.2 && TARGET <= 0.667)) {
  console.log(`FAIL: --target ${TARGET} is outside the sane range (0.2, 0.667]`);
  console.log('  above 0.667 the crest leaves the Android safe zone and launchers can crop it');
  process.exit(1);
}

const base = sharp(SRC);
const meta = await base.metadata();
const { data, info } = await base.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H, channels: C } = info;

// Ink = anything not transparent. The foreground layer is a crest on nothing.
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * C + 3] <= 24) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
if (maxX < 0) { console.log('FAIL: the foreground is empty — nothing to scale'); process.exit(1); }

const cw = maxX - minX + 1, ch = maxY - minY + 1;
const longest = Math.max(cw, ch);
const want = Math.round(Math.min(W, H) * TARGET);
const scale = want / longest;
console.log(`  crest now  ${cw}x${ch}  (${((cw / W) * 100).toFixed(1)}% x ${((ch / H) * 100).toFixed(1)}%)`);
console.log(`  target     longest side ${want}px  (${(TARGET * 100).toFixed(0)}% of ${W})  scale x${scale.toFixed(3)}`);

if (Math.abs(scale - 1) < 0.02) { console.log('  already at target — nothing to do'); process.exit(0); }
if (DRY) { console.log('  --dry: not writing'); process.exit(0); }

// Crop to the crest, scale it, and centre it on a fresh transparent canvas.
const crest = await sharp(SRC).extract({ left: minX, top: minY, width: cw, height: ch })
  .resize({ width: Math.round(cw * scale), height: Math.round(ch * scale), fit: 'fill' })
  .png().toBuffer();
const cm = await sharp(crest).metadata();

const out = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: crest, left: Math.round((W - cm.width) / 2), top: Math.round((H - cm.height) / 2) }])
  .png().toBuffer();

fs.copyFileSync(SRC, SRC.replace(/\.png$/, '.pre-scale.png'));
fs.writeFileSync(SRC, out);
console.log(`  wrote ${SRC} (previous kept as ${SRC.replace(/\.png$/, '.pre-scale.png')})`);

// Read it back rather than trusting the write.
const check = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let a = check.info.width, b = -1;
for (let y = 0; y < check.info.height; y++) {
  for (let x = 0; x < check.info.width; x++) {
    if (check.data[(y * check.info.width + x) * check.info.channels + 3] <= 24) continue;
    if (x < a) a = x; if (x > b) b = x;
  }
}
const got = ((b - a + 1) / check.info.width) * 100;
console.log(`  verified: crest is now ${got.toFixed(1)}% of the canvas wide`);
if (got > 66.7) { console.log('FAIL: that is outside the Android safe zone'); process.exit(1); }

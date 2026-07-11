// Mascot trial: crop the generated hawk+ballot mark, key out the white bg,
// emit logo.svg (PNG wrapped, keeps the site's existing icon filename/type),
// apple-touch-icon.png (opaque) and a trimmed master PNG.
//   cd ~/hawkeye/backend && node ../design/make_mascot_assets.mjs "<src.jpg>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../backend/', import.meta.url))('sharp');

const SRC = process.argv[2];
const OUT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(OUT, '..', 'app');

const img = sharp(SRC);
const meta = await img.metadata();
console.log('src', meta.width, 'x', meta.height);

// центр crop around the mark (drop caption): generous box, then trim
const crop = await sharp(SRC)
  .extract({ left: Math.round(meta.width * 0.33), top: Math.round(meta.height * 0.175), width: Math.round(meta.width * 0.36), height: Math.round(meta.height * 0.60) })
  .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

// white -> transparent (flat white bg): hard key + soft feather near-white
const { data, info } = crop;
for (let i = 0; i < data.length; i += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const min = Math.min(r, g, b);
  if (min >= 244) data[i + 3] = 0;
  else if (min >= 228) data[i + 3] = Math.round(((244 - min) / 16) * 255);
}
const keyed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .png().toBuffer();
const master = await sharp(keyed).trim().png().toBuffer();
fs.writeFileSync(path.join(OUT, 'hawk-mascot.png'), master);
const m2 = await sharp(master).metadata();
console.log('master', m2.width, 'x', m2.height);

// logo.svg — PNG-in-SVG wrapper so every page's existing <link rel=icon> works
const png128 = await sharp(master).resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
fs.writeFileSync(path.join(APP, 'logo.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><image width="128" height="128" href="data:image/png;base64,${png128.toString('base64')}"/></svg>`);

// apple-touch-icon: opaque paper bg, 180x180, small margin
const inner = await sharp(master).resize(150, 150, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
await sharp({ create: { width: 180, height: 180, channels: 4, background: '#F5F3EC' } })
  .composite([{ input: inner, left: 15, top: 15 }])
  .png().toFile(path.join(APP, 'apple-touch-icon.png'));
console.log('wrote app/logo.svg + app/apple-touch-icon.png + design/hawk-mascot.png');

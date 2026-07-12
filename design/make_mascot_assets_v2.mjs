// Mascot v2 (flat vector redraw): key out the white bg, trim, emit
//   app/logo.svg            plain mark (favicon on light/dark browser UI)
//   app/logo-crest.svg      white-keyline version (survives the dark green header)
//   app/apple-touch-icon.png opaque
//   design/hawk-mascot.png  trimmed master
//   cd ~/hawkeye/backend && node ../design/make_mascot_assets_v2.mjs "<src.jpg>"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const sharp = createRequire(new URL('../backend/', import.meta.url))('sharp');

const SRC = process.argv[2];
const OUT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(OUT, '..', 'app');

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
for (let i = 0; i < data.length; i += 4) {
  const min = Math.min(data[i], data[i + 1], data[i + 2]);
  if (min >= 244) data[i + 3] = 0;
  else if (min >= 228) data[i + 3] = Math.round(((244 - min) / 16) * 255);
}
const master = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  .png().trim().toBuffer();
fs.writeFileSync(path.join(OUT, 'hawk-mascot.png'), master);
const m = await sharp(master).metadata();
console.log('master', m.width, 'x', m.height);

const wrap = (png) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><image width="128" height="128" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;

// plain favicon
const png128 = await sharp(master).resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
fs.writeFileSync(path.join(APP, 'logo.svg'), wrap(png128));

// crest: dilate the alpha into a white halo, composite the mark on top.
// Work at 512 for a clean edge; ~10px dilation there ≈ 2.5px halo at 128.
const base512 = await sharp(master).resize(472, 472, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({ top: 20, bottom: 20, left: 20, right: 20, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
const alpha = await sharp(base512).extractChannel(3).blur(5).threshold(6).png().toBuffer();
const halo = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#ffffff' } })
  .joinChannel(alpha).png().toBuffer();
const crest512 = await sharp(halo).composite([{ input: base512 }]).png().toBuffer();
const crest = await sharp(crest512).resize(128, 128).png().toBuffer();
fs.writeFileSync(path.join(APP, 'logo-crest.svg'), wrap(crest));

// apple-touch-icon: opaque paper bg
const inner = await sharp(master).resize(150, 150, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
await sharp({ create: { width: 180, height: 180, channels: 4, background: '#F5F3EC' } })
  .composite([{ input: inner, left: 15, top: 15 }])
  .png().toFile(path.join(APP, 'apple-touch-icon.png'));
console.log('wrote logo.svg, logo-crest.svg, apple-touch-icon.png, hawk-mascot.png');

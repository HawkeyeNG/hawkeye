import { createRequire } from 'module';
import path from 'node:path';
const require = createRequire('/home/elrio/hawkeye/backend/');
const sharp = require('sharp');
const OUT = '/home/elrio/hawkeye/audit/icons/build';
const master = path.join(OUT, 'master.png');
const S = 460, PAD = 40, GAP = 40, small = 96;

const circle = async (size) => {
  const m = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  return sharp(await sharp(master).resize(size, size).png().toBuffer()).composite([{ input: m, blend: 'dest-in' }]).png().toBuffer();
};
const sq = (size) => sharp(master).resize(size, size).png().toBuffer();

const W = PAD * 2 + S * 2 + GAP, H = PAD * 2 + S + GAP + small;
const bg = sharp({ create: { width: W, height: H, channels: 4, background: { r: 200, g: 202, b: 205, alpha: 1 } } });
const layers = [
  { input: await sq(S), top: PAD, left: PAD },                       // square (iOS/web/favicon)
  { input: await circle(S), top: PAD, left: PAD + S + GAP },          // circle (Android adaptive/round)
  { input: await sq(small), top: PAD + S + GAP, left: PAD },          // small square
  { input: await circle(small), top: PAD + S + GAP, left: PAD + small + 24 }, // small circle
];
await bg.composite(layers).png().toFile(path.join(OUT, 'preview.png'));
console.log('preview -> build/preview.png', W + 'x' + H);

/**
 * Does any caption actually run off its canvas?
 *
 * The size is chosen by measuring a trimmed render, but that measurement lives
 * in the same script that draws them — so this checks the FILES. White ink on a
 * brand-green field: scan the caption band for near-white pixels and report the
 * leftmost and rightmost columns. A caption is wrong if its ink reaches the
 * margin, and this must also SEE ink, or it is reporting on nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from '/home/elrio/hawkeye/backend/node_modules/sharp/dist/index.cjs';

const ROOT = '/mnt/c/Users/HP/Downloads/hawkeye-screenshots';
let bad = 0, seen = 0;
for (const [label, dir] of [['play', `${ROOT}/play-phone`], ['ios ', `${ROOT}/ios-6.9`]]) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
    const p = path.join(dir, f);
    const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels: c } = info;
    const band = Math.round(h * 0.20);            // captions live in the top fifth
    let minX = w, maxX = -1, ink = 0;
    for (let y = 0; y < band; y += 2) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * c;
        if (data[i] > 225 && data[i + 1] > 225 && data[i + 2] > 225) {
          ink += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    const margin = Math.round(w * 0.04);
    const ok = ink > 500 && minX >= margin && maxX <= w - margin;
    if (ink > 500) seen += 1;
    if (!ok) bad += 1;
    console.log(`  ${label} ${f.padEnd(18)} w=${w} ink=[${minX}..${maxX}] margin=${margin} ${ok ? 'fits' : ink <= 500 ? 'NO INK FOUND' : 'RUNS OFF'}`);
  }
}
console.log('');
if (!seen) console.log('CONTROL FAILED: found no caption ink anywhere — this check is measuring nothing');
else console.log(`control: caption ink located in ${seen} of 12 files`);
console.log(bad ? `${bad} caption(s) wrong` : 'every caption sits inside its margin');
process.exit(bad ? 1 : 0);

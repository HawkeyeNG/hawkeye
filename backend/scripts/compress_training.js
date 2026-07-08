// Downscale/re-encode training sheets in place to the same size the viewer uses
// (max 1500px wide, q76 mozjpeg) so uploads and page loads are fast. Idempotent:
// a file already at/under target is left untouched (never re-enlarged).
//   node scripts/compress_training.js
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';

const dir = path.join(path.dirname(config.dbPath), 'training');
const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g)$/i.test(f));
let before = 0, after = 0, shrunk = 0, kept = 0;
for (let i = 0; i < files.length; i++) {
  const p = path.join(dir, files[i]);
  const b = fs.statSync(p).size;
  before += b;
  try {
    const buf = await sharp(p).rotate().resize({ width: 1500, withoutEnlargement: true })
      .jpeg({ quality: 76, mozjpeg: true }).toBuffer();
    if (buf.length < b) { fs.writeFileSync(p, buf); after += buf.length; shrunk++; }
    else { after += b; kept++; }
  } catch { after += b; kept++; }
  if ((i + 1) % 100 === 0) process.stdout.write(`\r  ${i + 1}/${files.length}`);
}
console.log(`\ncompressed ${shrunk} (kept ${kept}): ${(before / 1e6).toFixed(0)}MB -> ${(after / 1e6).toFixed(0)}MB`);

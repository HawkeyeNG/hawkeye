/** Small review copies of the raw captures, so they can be eyeballed cheaply. */
import fs from 'node:fs';
import path from 'node:path';
import sharp from '/home/elrio/hawkeye/backend/node_modules/sharp/dist/index.cjs';

const dir = process.argv[2] || '/tmp/raw';
const out = process.argv[3] || '/tmp/raw/thumbs';
const width = Number(process.argv[4] || 380);

fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.png'))) {
  const dest = path.join(out, f);
  await sharp(path.join(dir, f)).resize({ width }).png({ quality: 70 }).toFile(dest);
  console.log(dest, Math.round(fs.statSync(dest).size / 1024) + ' KB');
}

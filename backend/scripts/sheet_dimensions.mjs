/**
 * What sizes are the sheets, really?
 *
 *   node scripts/sheet_dimensions.mjs storage/audit-osun2026/sheets
 *
 * The party pass was calibrated on the first 20 sheets, which are all
 * 1500x2000, and a scale FACTOR of 1.6 was chosen from that. Across the archive
 * 239 requests then came back 400 for exceeding the context: a factor applied
 * to a bigger source produces a bigger image, and vision tokens go up with
 * AREA, so a sheet twice the width costs four times the tokens.
 *
 * The calibration set was the first 20 sheets by unit code — one LGA, one
 * officer, one camera. Anything measured only on those describes that camera.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const dir = process.argv[2] || 'storage/audit-osun2026/sheets';
const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const step = Math.max(1, Math.floor(files.length / 400));
const sample = files.filter((_, i) => i % step === 0);

const sizes = new Map();
let maxW = 0, maxFile = '';
for (const f of sample) {
  const m = await sharp(path.join(dir, f)).metadata();
  const k = `${m.width}x${m.height}`;
  sizes.set(k, (sizes.get(k) || 0) + 1);
  if (m.width > maxW) { maxW = m.width; maxFile = f; }
}

console.log(`sampled ${sample.length} of ${files.length} sheets\n`);
for (const [k, v] of [...sizes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}  ${((v / sample.length) * 100).toFixed(1)}%`);
}
console.log(`\nwidest sampled: ${maxW}px (${maxFile})`);
console.log('\nAt scale 1.6 a 0.72-wide crop of the widest sheet becomes '
  + `${Math.round(maxW * 0.72 * 1.6)}px, against ${Math.round(1500 * 0.72 * 1.6)}px for a 1500px sheet`);
console.log(`— roughly ${((maxW / 1500) ** 2).toFixed(1)}x the vision tokens for the same table.`);

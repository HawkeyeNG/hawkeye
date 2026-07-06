// TrOCR feasibility probe (LOCAL tooling only — too heavy for the shared host).
// Crops known "IN FIGURES" cells from two ground-truth sheets and runs
// microsoft TrOCR (small, handwritten) via transformers.js.
//   node scripts/trocr_probe.js
import sharp from 'sharp';
import { pipeline } from '@xenova/transformers';

const cases = [
  // [file, crop{left,top,width,height} on the 3072x4096 originals, expected]
  ['storage/training/13-13-02-004.jpg', { left: 800, top: 1850, width: 560, height: 160 }, '341'],
  ['storage/training/13-13-06-003.jpg', { left: 640, top: 2070, width: 540, height: 170 }, '228'],
  ['storage/training/13-13-02-004.jpg', { left: 800, top: 2290, width: 560, height: 150 }, '10'],
  ['storage/training/13-13-06-003.jpg', { left: 640, top: 2510, width: 540, height: 160 }, '39'],
];

console.log('loading TrOCR (first run downloads ~250MB)…');
const ocr = await pipeline('image-to-text', 'Xenova/trocr-small-handwritten');

let i = 0;
for (const [file, box, expect] of cases) {
  const tmp = `/tmp/trocr_cell_${i++}.png`;
  await sharp(file).extract(box).grayscale().normalize().toFile(tmp);
  const out = await ocr(tmp);
  const text = out?.[0]?.generated_text ?? '?';
  console.log(`${file.split('/').pop()} expect=${expect} -> "${text.trim()}"`);
}
process.exit(0);

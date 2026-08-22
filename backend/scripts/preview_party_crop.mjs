/**
 * Render the party-table crop to disk so a human can see what the model sees.
 *
 *   node scripts/preview_party_crop.mjs storage/audit-osun2026/sheets 29-01-01-001.jpg ...
 *   node scripts/preview_party_crop.mjs storage/audit-osun2026/sheets --sample 12
 *
 * A crop that clips a row costs the sheet SILENTLY — the reading comes back
 * short and looks exactly like an unreadable cell. Worse, on 29-13-07-001 an
 * earlier bound cut the TOTAL VALID VOTES figures while leaving the printed
 * label in frame, so the crop looked complete and was not. There is no way to
 * see that in the output, so it gets checked by looking, before the pass runs.
 *
 * Geometry is imported, never re-declared: a preview of a crop nobody uses is
 * worse than no preview at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PARTY_TABLE_CROP } from '../src/services/ec8a_prompt.js';

const argv = process.argv.slice(2);
const dir = argv[0];
const sampleIdx = argv.indexOf('--sample');
let files = argv.slice(1).filter((a) => !a.startsWith('--') && a !== argv[sampleIdx + 1]);

if (!dir) {
  console.error('usage: node scripts/preview_party_crop.mjs <sheets-dir> <file.jpg>... | --sample N');
  process.exit(2);
}

if (sampleIdx > -1) {
  // Spread the sample across the whole archive rather than taking the first N —
  // the first sheets are all from one LGA, photographed by one officer, on one
  // desk. A crop validated only on those tells you nothing about the rest.
  const all = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  const n = Math.max(1, Number(argv[sampleIdx + 1]) || 10);
  const step = Math.max(1, Math.floor(all.length / n));
  files = Array.from({ length: n }, (_, i) => all[i * step]).filter(Boolean);
}
if (!files.length) { console.error('no files selected'); process.exit(2); }

const outDir = path.join(path.dirname(dir), 'crop_preview');
fs.mkdirSync(outDir, { recursive: true });

for (const f of files) {
  const src = path.join(dir, f);
  const m = await sharp(src).metadata();
  const left = Math.round(m.width * PARTY_TABLE_CROP.left);
  const right = Math.round(m.width * PARTY_TABLE_CROP.right);
  const top = Math.round(m.height * PARTY_TABLE_CROP.top);
  const bottom = Math.round(m.height * PARTY_TABLE_CROP.bottom);
  const out = path.join(outDir, f.replace(/\.[^.]+$/, '.crop.jpg'));
  await sharp(src)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: Math.round((right - left) * PARTY_TABLE_CROP.scale), kernel: 'lanczos3' })
    .jpeg({ quality: 88 })
    .toFile(out);
  console.log(`${f}  ${m.width}x${m.height} -> ${out}`);
}
console.log(`\ncrop: x ${PARTY_TABLE_CROP.left}-${PARTY_TABLE_CROP.right}, y ${PARTY_TABLE_CROP.top}-${PARTY_TABLE_CROP.bottom}`);

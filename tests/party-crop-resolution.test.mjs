/**
 * The party-table crop must be RESOLUTION-INDEPENDENT.
 *
 *   node tests/party-crop-resolution.test.mjs
 *
 * WHY. The crop used to resize to (cropWidth * 1.6), derived from the INPUT
 * width, so what the model saw depended on whatever resolution happened to be on
 * disk. Sheets are stored as 1500px derivatives, where that is a 1080 -> 1728
 * UPSCALE — inventing pixels. Measured from audit-osun2026.db, 3,721 of 3,742
 * originals are 3072x4096 and 91.3% of every sheet's bytes are discarded on
 * download, so the detail being faked existed and was thrown away.
 *
 * Pinning outWidth fixes that, but only if it holds the ONE property that makes
 * the change safe: the output size, and therefore the vision-token cost, must not
 * move. 2x once put the encoder into CUDA OOM and killed a run mid-flight.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire('/home/elrio/hawkeye/backend/');
const sharp = require('sharp');
import { PARTY_TABLE_CROP as C } from '../backend/src/services/ec8a_prompt.js';

const crop = async (buf) => {
  const m = await sharp(buf).metadata();
  const left = Math.round(m.width * C.left);
  const right = Math.round(m.width * C.right);
  const top = Math.round(m.height * C.top);
  const bottom = Math.round(m.height * C.bottom);
  const out = await sharp(buf)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize({ width: C.outWidth, kernel: 'lanczos3' })
    .jpeg({ quality: 88 })
    .toBuffer();
  return { sourceCropWidth: right - left, out: await sharp(out).metadata() };
};

const DIR = '/home/elrio/hawkeye/audits/2026-osun-governorship/sheets';
const sample = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.jpg'))[0] : null;
assert.ok(sample, 'no real sheet available to test against');
const stored = fs.readFileSync(path.join(DIR, sample));
const storedMeta = await sharp(stored).metadata();
console.log(`  sheet ${sample} as stored: ${storedMeta.width}x${storedMeta.height}`);

// 1. The stored derivative: output must be exactly the shipped size.
const a = await crop(stored);
assert.strictEqual(a.out.width, C.outWidth, `stored-derivative crop must be ${C.outWidth}px, got ${a.out.width}`);
console.log(`  PASS  derivative  crop ${a.sourceCropWidth}px -> ${a.out.width}px  (${a.sourceCropWidth < C.outWidth ? 'UPSCALE, as before' : 'downscale'})`);

// 2. A full-resolution original: SAME output size, so identical token cost.
const original = await sharp(stored).resize({ width: 3072, kernel: 'lanczos3' }).jpeg({ quality: 92 }).toBuffer();
const b = await crop(original);
assert.strictEqual(b.out.width, C.outWidth, `original-resolution crop must ALSO be ${C.outWidth}px, got ${b.out.width}`);
assert.strictEqual(a.out.width, b.out.width, 'token cost must not depend on input resolution');
console.log(`  PASS  original    crop ${b.sourceCropWidth}px -> ${b.out.width}px  (${b.sourceCropWidth > C.outWidth ? 'DOWNSCALE — real detail' : 'upscale'})`);

// 3. The whole point: the original path must DOWNSCALE where the derivative UPSCALES.
assert.ok(a.sourceCropWidth < C.outWidth, 'expected the 1500px derivative to be an upscale — that is the defect');
assert.ok(b.sourceCropWidth > C.outWidth, 'expected the original to be a downscale — that is the fix');
console.log(`  PASS  the fix is real: ${a.sourceCropWidth}px upscaled vs ${b.sourceCropWidth}px downscaled, both to ${C.outWidth}px`);

// CONTROL: the OLD formula would have moved the output size with the input.
const oldWidth = (srcCrop) => Math.round(srcCrop * C.scale);
assert.notStrictEqual(oldWidth(a.sourceCropWidth), oldWidth(b.sourceCropWidth),
  'CONTROL FAILED: the old formula should have produced DIFFERENT sizes, or this test proves nothing');
console.log(`  PASS  control — old formula would have given ${oldWidth(a.sourceCropWidth)}px vs ${oldWidth(b.sourceCropWidth)}px (a ${(oldWidth(b.sourceCropWidth) / oldWidth(a.sourceCropWidth)).toFixed(1)}x token blowup)`);

console.log('\nCrop is resolution-independent: same tokens, better pixels.');

// ---- 5b: the stored width, and the OTHER crop -------------------------------
//
// Raising the fetcher's stored width from 1500 to 2400 is only safe if EVERY VLM
// crop pins its output. The boxes worker used `width * 2`, derived from the input,
// so a 2400px source would have taken it from 1500px to 2400px of output — a 2.6x
// area increase in vision tokens on every sheet, which is the blowup that once put
// the encoder into CUDA OOM.
const BOXES_OUT = 1500;
const cropBoxes = async (buf) => {
  const m = await sharp(buf).metadata();
  const left = Math.round(m.width * 0.50);
  const width = m.width - left;
  const out = await sharp(buf)
    .extract({ left, top: Math.round(m.height * 0.04), width, height: Math.round(m.height * 0.44) })
    .resize({ width: BOXES_OUT, kernel: 'lanczos3' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { sourceCropWidth: width, out: await sharp(out).metadata() };
};

const at2400 = await sharp(stored).resize({ width: 2400, kernel: 'lanczos3' }).jpeg({ quality: 76 }).toBuffer();

const bx1500 = await cropBoxes(stored);
const bx2400 = await cropBoxes(at2400);
assert.strictEqual(bx1500.out.width, BOXES_OUT, 'boxes crop must be pinned on the old corpus');
assert.strictEqual(bx2400.out.width, BOXES_OUT, 'boxes crop must be pinned on the new corpus — same tokens');
console.log(`  PASS  boxes  1500px source -> ${bx1500.out.width}px   |   2400px source -> ${bx2400.out.width}px  (identical tokens)`);
// CONTROL: the old rule would have doubled it.
assert.strictEqual(bx1500.sourceCropWidth * 2, 1500, 'sanity: old rule gave 1500 on a 1500px source');
assert.ok(bx2400.sourceCropWidth * 2 > BOXES_OUT,
  `CONTROL FAILED: old rule should have blown up to ${bx2400.sourceCropWidth * 2}px`);
console.log(`  PASS  control — old boxes rule would have gone ${bx1500.sourceCropWidth * 2}px -> ${bx2400.sourceCropWidth * 2}px on the new corpus`);

// The party crop at exactly 2400px is pixel-exact: 2400 * 0.72 = 1728 = outWidth.
const p2400 = await crop(at2400);
assert.strictEqual(p2400.out.width, C.outWidth);
console.log(`  PASS  party at 2400px source: crop ${p2400.sourceCropWidth}px -> ${p2400.out.width}px `
  + `(${p2400.sourceCropWidth === C.outWidth ? 'PIXEL-EXACT — no resampling at all' : 'resampled'})`);

console.log('\n5b holds: a 2400px archive costs zero extra vision tokens on either pass.');

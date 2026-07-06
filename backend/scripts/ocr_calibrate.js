// OCR calibration harness. Runs the production OCR pipeline (services/ocr.js)
// over every image in storage/training/ and reports what digits it can read.
// With ground truth (storage/training/truth.json: { "<image-basename>": {"APC":123,...} })
// it scores match rates so preprocessing/thresholds can be tuned.
// NOTE: Tesseract itself is not retrained here — "learning" = tuning our
// preprocessing + match rules against real sheets, and live telemetry
// (/api/ocr/stats) accumulating from real submissions.
//   node scripts/ocr_calibrate.js [--ensemble]
// --ensemble adds a TrOCR pass (local only): the figures column is sliced into row
// strips, each read by trocr-small-printed in a SEPARATE Node-20 process
// (set TROCR_NODE=~/tmp/node20/bin/node), and its digits union with Tesseract's.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ocrMatchCounts } from '../src/services/ocr.js';

const ENSEMBLE = process.argv.includes('--ensemble');
const LABELED_ONLY = process.argv.includes('--labeled'); // skip sheets without ground truth
const TROCR_NODE = process.env.TROCR_NODE || path.join(os.homedir(), 'tmp', 'node20', 'bin', 'node');

async function trocrTokens(imgPath) {
  // slice the figures column into 19 row strips (fixed EC8A table layout)
  const m = await sharp(imgPath).metadata();
  const left = Math.round(m.width * 0.18), width = Math.round(m.width * 0.30);
  const top = Math.round(m.height * 0.33), height = Math.round(m.height * 0.50);
  const strip = Math.floor(height / 19);
  const files = [];
  for (let i = 0; i < 19; i++) {
    const f = path.join(os.tmpdir(), `strip_${path.basename(imgPath)}_${i}.png`);
    await sharp(imgPath).extract({ left, top: top + i * strip, width, height: strip }).grayscale().normalize().toFile(f);
    files.push(f);
  }
  try {
    const out = execFileSync(TROCR_NODE, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'trocr_worker.js'), ...files], { timeout: 300000 }).toString();
    const toks = [];
    for (const line of out.split('\n')) {
      try { toks.push(...(JSON.parse(line).text?.match(/\d+/g) || [])); } catch { /* skip */ }
    }
    return toks;
  } catch (e) {
    console.error('  [trocr]', e.message.slice(0, 80));
    return [];
  } finally {
    for (const f of files) fs.rmSync(f, { force: true });
  }
}

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'training');
if (!fs.existsSync(dir)) { console.error('put EC8A photos in storage/training/ first'); process.exit(1); }
const truthPath = path.join(dir, 'truth.json');
const truth = fs.existsSync(truthPath) ? JSON.parse(fs.readFileSync(truthPath, 'utf8')) : {};

const imgs = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))
  .filter((f) => !LABELED_ONLY || truth[f.replace(/\.[^.]+$/, '')]);
if (!imgs.length) { console.error('no images in storage/training/'); process.exit(1); }

let scoredImgs = 0, matchedSum = 0, totalSum = 0;
for (const f of imgs) {
  const buf = fs.readFileSync(path.join(dir, f));
  const key = f.replace(/\.[^.]+$/, '');
  const votes = truth[key] ? Object.entries(truth[key]).map(([party, count]) => ({ party, count })) : [];
  const r = await ocrMatchCounts(buf, votes.length ? votes : [{ party: 'X', count: 1 }]);
  if (!r) { console.log(`${f}: OCR FAILED`); continue; }
  if (ENSEMBLE) {
    const extra = await trocrTokens(path.join(dir, f));
    const set = new Set([...r.tokens, ...extra]);
    r.tokens = [...set];
    if (votes.length) r.matched = votes.filter((v) => v.count > 0 && set.has(String(v.count))).length;
  }
  if (votes.length) {
    scoredImgs++; matchedSum += r.matched; totalSum += r.total;
    console.log(`${f}: ${r.matched}/${r.total} counts matched · ${r.tokens.length} digit tokens read`);
  } else {
    console.log(`${f}: ${r.tokens.length} digit tokens read (no truth) e.g. ${r.tokens.slice(0, 10).join(',')}`);
  }
}
if (scoredImgs) console.log(`\nOVERALL: ${matchedSum}/${totalSum} (${((matchedSum / totalSum) * 100).toFixed(1)}%) across ${scoredImgs} scored sheets`);
process.exit(0);

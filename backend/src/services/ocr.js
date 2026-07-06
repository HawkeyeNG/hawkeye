import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

// Best-effort OCR cross-check: read the numbers off the photographed EC8A sheet and
// see how many of the observer's TYPED party counts appear on it. Corroboration
// signal, not a hard gate. Degrades to null on failure.
//
// Calibrated on real 2026 EC8A photos (storage/training/): CLAHE, binarization and
// figures-column cropping were all tested and each REDUCED accuracy — plain
// grayscale+normalize+sharpen at 1600px wins (5/7 truth counts). Remaining misses
// are handwriting-legibility limits of Tesseract; a handwriting model (TrOCR) is
// the upgrade path, not more preprocessing.
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const w = await createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: '0123456789 ' });
      return w;
    })().catch((err) => {
      console.error('[ocr] init failed:', err.message);
      workerPromise = null;
      return null;
    });
  }
  return workerPromise;
}

async function pass(worker, buf) {
  const { data } = await worker.recognize(buf);
  return data.text.match(/\d+/g) || [];
}

export async function ocrMatchCounts(jpegBuffer, votes) {
  const wanted = votes.filter((v) => v.count > 0).map((v) => String(v.count));
  if (wanted.length === 0) return { matched: 0, total: 0, tokens: [] };
  try {
    const worker = await getWorker();
    if (!worker) return null;

    const pre = await sharp(jpegBuffer).grayscale().resize({ width: 1600, withoutEnlargement: true }).normalize().sharpen().toBuffer();
    const tokens = await pass(worker, pre);

    const set = new Set(tokens);
    const matched = wanted.reduce((n, c) => n + (set.has(c) ? 1 : 0), 0);
    return { matched, total: wanted.length, tokens };
  } catch (err) {
    console.error('[ocr] recognize failed:', err.message);
    return null;
  }
}

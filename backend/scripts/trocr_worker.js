// TrOCR worker — MUST run in its own process (no sharp import here: two libvips
// copies in one process segfault) and under Node 20 (Node 25 crashes onnxruntime).
//   node scripts/trocr_worker.js img1.png img2.png ...  -> JSON lines {file, text}
import { pipeline } from '@xenova/transformers';

const files = process.argv.slice(2);
const ocr = await pipeline('image-to-text', 'Xenova/trocr-small-printed');
for (const f of files) {
  try {
    const out = await ocr(f);
    console.log(JSON.stringify({ file: f, text: (out?.[0]?.generated_text || '').trim() }));
  } catch (e) {
    console.log(JSON.stringify({ file: f, error: e.message }));
  }
}
process.exit(0);

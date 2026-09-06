/**
 * SECOND PASS: read just the EC8A summary boxes from a crop of each sheet.
 *
 *   VISION_API_BASE=... VISION_API_KEY=... \
 *   node scripts/vlm_boxes_worker.mjs --dir storage/audit-osun2026/sheets --out storage/audit-osun2026/boxes_full.jsonl
 *
 *   --limit N --concurrency N --retries N --restart   as vlm_worker.mjs
 *
 * The full-sheet pass read 95% of party cells but only 57% of summary boxes —
 * asked for everything at once, the model spends itself on the big table. This
 * pass crops the top-right corner (where the #1-#8 block lives), upscales it,
 * and asks one narrow question. Same technique that settled 29-01-02-004 by
 * hand: cut the region out, blow it up, read one thing.
 *
 * Output is one JSON line per sheet with the RAW text of each box, so merging
 * and parsing can be iterated offline without re-paying for inference.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { chatComplete } from '../src/services/assistant.js';
import { boxesPrompt, BOXES_SCHEMA, BOX_FIELDS, parseModelJson } from '../src/services/ec8a_prompt.js';
import { summaryBoxesRect } from '../src/services/ec8a_cell_crop.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const dir = arg('dir');
const outPath = arg('out');
const limit = Number(arg('limit', 0)) || Infinity;
const concurrency = Math.max(1, Number(arg('concurrency', 16)));
const retries = Math.max(1, Number(arg('retries', 3)));

if (!dir || !outPath) { console.error('need --dir <folder> --out <file.jsonl>'); process.exit(2); }
if (!config.visionApiBase) { console.error('VISION_API_BASE is not set. Refusing to start.'); process.exit(2); }

const provider = {
  name: 'vlm-boxes', base: config.visionApiBase,
  key: config.visionApiKey || 'dummy', model: config.visionModel,
};

/**
 * The crop. Generous on purpose: across the hand-labelled 20 the box block sits
 * roughly at x 60-95%, y 18-40%, but photos arrive tilted and off-centre, so
 * this takes the whole right half of the upper portion and upscales 2x. A crop
 * that includes too much costs tokens; a crop that misses the block costs the
 * sheet — asymmetric, so err large.
 */
// = the output a 1500px source produced under the old `width * 2` rule.
const BOXES_CROP_OUT_WIDTH = 1500;

// GEOMETRY MOVED, NOT CHANGED. The four lines that used to compute this rect
// inline now live in services/ec8a_cell_crop.js, because the review UI shows a
// human this same crop while they check what this worker read. Two copies would
// drift, and the drift would present as a disagreement about the numbers rathe
// than as the geometry bug it is. tests/box-crop.test.mjs pins the new helper to
// the exact pixels the old arithmetic produced, on real sheet dimensions.
async function cropBoxes(full) {
  const m = await sharp(full).metadata();
  const { left, top, width, height } = summaryBoxesRect(m);
  return sharp(full)
    .extract({ left, top, width, height })
    // PINNED, like the party crop. This used to be `width * 2`, derived from the
    // INPUT — so raising the stored sheet width from 1500 to 2400 would have
    // silently taken this crop from 1500px to 2400px of output, a 1.6x linear /
    // 2.6x area increase in vision tokens on every sheet. That is the blowup that
    // once put the encoder into CUDA OOM and killed a run mid-flight. 1500 is
    // exactly what a 1500px source produced before, so behaviour is unchanged on
    // the old corpus and becomes a real downscale on the new one.
    .resize({ width: BOXES_CROP_OUT_WIDTH, kernel: 'lanczos3' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function preflight() {
  const r = await fetch(`${provider.base}/models`, {
    headers: { authorization: `Bearer ${provider.key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GET /models -> ${r.status}`);
  const ids = (await r.json())?.data?.map((m) => m.id) || [];
  if (ids.length && !ids.includes(provider.model)) {
    console.log(`note: served model(s) ${ids.join(', ')} — using ${ids[0]}`);
    provider.model = ids[0];
  }
}

/** Prove the schema binds — never infer it from the absence of an error. */
async function structuredOutputWorks() {
  const schema = { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'], additionalProperties: false };
  try {
    const m = await chatComplete(provider, [{ role: 'user', content: 'say hi' }], {
      maxTokens: 20, timeoutMs: 60_000,
      extra: { temperature: 0, response_format: { type: 'json_schema', json_schema: { name: 'probe', schema } } },
    });
    const v = JSON.parse(String(m.content || '').trim());
    return Number.isInteger(v?.a) && Object.keys(v).length === 1;
  } catch { return false; }
}

// --- resume ---------------------------------------------------------------
const done = new Set();
if (has('restart')) {
  if (fs.existsSync(outPath)) fs.renameSync(outPath, `${outPath}.${Date.now()}.bak`);
} else if (fs.existsSync(outPath)) {
  for (const line of fs.readFileSync(outPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (j.file) done.add(path.basename(j.file)); } catch { /* torn tail */ }
  }
}

const all = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const todo = all.filter((f) => !done.has(f)).slice(0, limit);
if (!todo.length) { console.log(`nothing to do — ${done.size}/${all.length} already in ${outPath}`); process.exit(0); }

const PROMPT = boxesPrompt();

async function readBoxes(file) {
  const buf = await cropBoxes(path.join(dir, file));
  const content = [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
  ];
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const m = await chatComplete(provider, [{ role: 'user', content }], {
        maxTokens: 400,
        timeoutMs: 120_000,
        extra: {
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: { name: 'ec8a_boxes', schema: BOXES_SCHEMA } },
        },
      });
      return m.content || '';
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('failed');
}

console.log(`[boxes] ${provider.model} at ${provider.base}`);
try { await preflight(); } catch (e) { console.error(`[boxes] endpoint unreachable: ${e.message}`); process.exit(2); }
if (await structuredOutputWorks()) {
  console.log('[boxes] structured output: VERIFIED');
} else {
  console.error('[boxes] structured output does NOT bind on this endpoint. Refusing to run.');
  process.exit(2);
}
console.log(`[boxes] ${all.length} sheet(s); ${done.size} already read; ${todo.length} to go; ${concurrency} in flight`);

const out = fs.createWriteStream(outPath, { flags: 'a' });
const started = Date.now();
let n = 0, ok = 0, unparsed = 0, errored = 0;
let cursor = 0;

async function work() {
  for (;;) {
    const i = cursor++;
    if (i >= todo.length) return;
    const file = todo[i];
    const t0 = Date.now();
    const rec = { file, ms: 0 };
    try {
      const text = await readBoxes(file);
      const v = parseModelJson(text);
      if (!v) { rec.error = 'unparseable'; rec.raw = String(text).slice(0, 2000); unparsed++; }
      else {
        rec.boxesRaw = Object.fromEntries(BOX_FIELDS.map((f) => [f, v[f] ?? null]));
        ok++;
      }
    } catch (e) {
      rec.error = String(e?.message || e).slice(0, 200);
      errored++;
    }
    rec.ms = Date.now() - t0;
    out.write(`${JSON.stringify(rec)}\n`);
    if (++n % 50 === 0 || n === todo.length) {
      const mins = (Date.now() - started) / 60000;
      const rate = n / Math.max(mins, 0.001);
      console.log(`[boxes] ${n}/${todo.length} · ok=${ok} unparsed=${unparsed} err=${errored}`
        + ` · ${(60 / Math.max(rate, 0.001)).toFixed(2)}s/sheet · ~${((todo.length - n) / Math.max(rate, 0.001)).toFixed(0)} min left`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, work));
await new Promise((r) => out.end(r));

const secs = (Date.now() - started) / 1000;
console.log(`\n[boxes] ${n} sheet(s) in ${secs.toFixed(0)}s — ${(secs / Math.max(n, 1)).toFixed(2)}s/sheet`);
console.log(`  read ok: ${ok}   unparseable: ${unparsed}   errored: ${errored}`);
if (unparsed + errored) console.log(`!! ${unparsed + errored} sheet(s) produced no reading — rerun to retry just those.`);
process.exit(0);

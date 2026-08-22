/**
 * Read EC8A sheets with a vision-language model.
 *
 *   VISION_API_BASE=http://<pod>:8000/v1 VISION_API_KEY=dummy \
 *   VISION_MODEL=Qwen/Qwen2.5-VL-7B-Instruct \
 *   node scripts/vlm_worker.mjs --dir storage/audit-osun2026/sheets --out storage/audit-osun2026/vlm.jsonl
 *
 *   --limit N         stop after N sheets (default: all)
 *   --concurrency N   requests in flight (default 4 — vLLM batches these)
 *   --retries N       attempts per sheet (default 2)
 *   --width N         downscale to N px wide before sending (default: send as-is)
 *   --restart         ignore the existing output and start over
 *
 * RESUMABLE BY CONSTRUCTION. Output is JSONL appended one sheet at a time, and
 * on start every filename already in it is skipped. A kill, a dropped pod or an
 * expired rental costs the in-flight requests and nothing else — which matters
 * when the full archive is 3,742 sheets on rented hardware billed by the hour.
 *
 * The output shape deliberately matches paddle_worker.py's one-JSON-line-per-image
 * so ocr_calibrate.js can score the two engines side by side.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { chatComplete } from '../src/services/assistant.js';
import { auditPrompt, auditSchema, OSUN_2026_BALLOT, parseModelJson } from '../src/services/ec8a_prompt.js';
import { verifySheet } from '../src/services/ec8a_verify.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const dir = arg('dir');
const outPath = arg('out');
const limit = Number(arg('limit', 0)) || Infinity;
const concurrency = Math.max(1, Number(arg('concurrency', 4)));
const retries = Math.max(1, Number(arg('retries', 2)));
const width = Number(arg('width', 0)) || 0;

if (!dir || !outPath) { console.error('need --dir <folder> --out <file.jsonl>'); process.exit(2); }
if (!fs.existsSync(dir)) { console.error(`no such directory: ${dir}`); process.exit(2); }

// FAIL AT ARM TIME, LOUDLY. An unconfigured endpoint must not become 3,742
// individually-logged failures that look like a bad model; it must be one error
// before any work starts.
if (!config.visionApiBase) {
  console.error('VISION_API_BASE is not set — nothing to call. Refusing to start.');
  process.exit(2);
}
const provider = {
  name: 'vlm', base: config.visionApiBase,
  key: config.visionApiKey || 'dummy', model: config.visionModel,
};

async function preflight() {
  const r = await fetch(`${provider.base}/models`, {
    headers: { authorization: `Bearer ${provider.key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GET /models -> ${r.status}`);
  const ids = (await r.json())?.data?.map((m) => m.id) || [];
  if (ids.length && !ids.includes(provider.model)) {
    console.log(`note: served model(s) ${ids.join(', ')} — using ${ids[0]} instead of ${provider.model}`);
    provider.model = ids[0];
  }
  return ids;
}

/**
 * PROVE that structured output binds. Do not infer it from the absence of an
 * error.
 *
 * vLLM 0.27 accepts a `guided_json` body field, returns 200, and ignores it
 * completely. Two full runs recorded "guided: true" on that basis while the
 * model was in fact unconstrained — emitting figures as strings ("110", "01"),
 * wrapping replies in code fences, and once producing `"spoiled": 06`, which is
 * not valid JSON and cost two sheets outright. The flag was true because
 * nothing had said no.
 *
 * So: ask for a schema whose only valid answer is {"a":<int>}, against a prompt
 * ("say hi") that would otherwise produce prose. If the reply is not that
 * object, the constraint is not in force, whatever the status code said.
 */
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
    try { const j = JSON.parse(line); if (j.file) done.add(path.basename(j.file)); } catch { /* half-written tail */ }
  }
}

const all = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
const todo = all.filter((f) => !done.has(f)).slice(0, limit);
if (!todo.length) { console.log(`nothing to do — ${done.size}/${all.length} already in ${outPath}`); process.exit(0); }

let sharp = null;
if (width) ({ default: sharp } = await import('sharp'));

async function encode(file) {
  const full = path.join(dir, file);
  const buf = width
    ? await sharp(full).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
    : fs.readFileSync(full);
  return buf.toString('base64');
}

const BALLOT = OSUN_2026_BALLOT;
const PROMPT = auditPrompt(BALLOT);
const SCHEMA = auditSchema(BALLOT);

/**
 * One sheet. `guided_json` constrains vLLM's decoder so malformed JSON is
 * impossible rather than handled — but it is a vLLM extension, and a server
 * that has never heard of it answers 400. That falls back to a plain call once,
 * so the same worker runs against Gemini or any OpenAI-compatible endpoint.
 */
async function readSheet(file) {
  const b64 = await encode(file);
  const content = [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
  ];
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const m = await chatComplete(provider, [{ role: 'user', content }], {
        maxTokens: 1600,
        timeoutMs: 180_000,
        extra: {
          temperature: 0,
          ...(GUIDED ? { response_format: { type: 'json_schema', json_schema: { name: 'ec8a', schema: SCHEMA } } } : {}),
        },
      });
      return { text: m.content || '', guided: GUIDED };
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('failed');
}

// --- run ------------------------------------------------------------------
console.log(`[vlm] ${provider.model} at ${provider.base}`);
try { await preflight(); } catch (e) { console.error(`[vlm] endpoint unreachable: ${e.message}`); process.exit(2); }

const GUIDED = await structuredOutputWorks();
if (GUIDED) {
  console.log('[vlm] structured output: VERIFIED (schema-constrained decoding is in force)');
} else if (has('unconstrained')) {
  console.log('[vlm] structured output: NOT AVAILABLE — continuing because --unconstrained was passed.');
  console.log('      Expect string figures, code fences and occasional invalid JSON.');
} else {
  console.error('[vlm] structured output does NOT bind on this endpoint.');
  console.error('      A schema demanding {"a":<int>} came back as something else, so the model is free');
  console.error('      to answer however it likes and the schema is decoration. Refusing to run: an');
  console.error('      unconstrained pass over the archive produces data that has to be thrown away.');
  console.error('      Pass --unconstrained to override.');
  process.exit(2);
}
console.log(`[vlm] ${all.length} sheet(s) in ${dir}; ${done.size} already read; ${todo.length} to go`
  + `; ${concurrency} in flight`);

const out = fs.createWriteStream(outPath, { flags: 'a' });
const started = Date.now();
let n = 0, ok = 0, unparsed = 0, errored = 0;
let flagged = 0, publishable = 0;
let cursor = 0;

async function work() {
  for (;;) {
    const i = cursor++;
    if (i >= todo.length) return;
    const file = todo[i];
    const t0 = Date.now();
    const rec = { file, ms: 0, model: provider.model };
    try {
      const { text, guided } = await readSheet(file);
      rec.guided = guided;
      const sheet = parseModelJson(text);
      if (!sheet) {
        // Keep the raw reply. Re-running inference to recover a parse bug is
        // paying twice for the same tokens.
        rec.error = 'unparseable';
        rec.raw = String(text).slice(0, 4000);
        unparsed++;
      } else {
        rec.sheet = sheet;
        rec.verify = verifySheet(sheet, { expectedParties: BALLOT.length });
        ok++;
        if (rec.verify.summary.verdict === 'flagged') flagged++;
        if (rec.verify.summary.verdict === 'publishable') publishable++;
      }
    } catch (e) {
      rec.error = String(e?.message || e).slice(0, 200);
      errored++;
    }
    rec.ms = Date.now() - t0;
    out.write(`${JSON.stringify(rec)}\n`);

    if (++n % 25 === 0 || n === todo.length) {
      const mins = (Date.now() - started) / 60000;
      const rate = n / Math.max(mins, 0.001);
      console.log(`[vlm] ${n}/${todo.length} · ok=${ok} unparsed=${unparsed} err=${errored}`
        + ` · ${(60 / Math.max(rate, 0.001)).toFixed(2)}s/sheet · ~${((todo.length - n) / Math.max(rate, 0.001)).toFixed(0)} min left`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, work));
await new Promise((r) => out.end(r));

const secs = (Date.now() - started) / 1000;
console.log(`\n[vlm] ${n} sheet(s) in ${secs.toFixed(0)}s — ${(secs / Math.max(n, 1)).toFixed(2)}s/sheet`);
console.log(`  read ok    : ${ok}`);
console.log(`  unparseable: ${unparsed}`);
console.log(`  errored    : ${errored}`);
if (ok) {
  console.log(`  of those read: ${publishable} self-verified fully · ${flagged} flagged for a human`
    + ` · ${ok - publishable - flagged} need review`);
}
// A run that lost sheets must say so here, not leave it to be inferred from a
// line count later.
if (unparsed + errored) console.log(`\n!! ${unparsed + errored} sheet(s) produced no reading — rerun to retry just those.`);
console.log(`\nappended to ${outPath}`);
process.exit(0);

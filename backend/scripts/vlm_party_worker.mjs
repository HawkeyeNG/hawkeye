/**
 * THIRD PASS: read just the party table from a crop of each sheet.
 *
 *   VISION_API_BASE=... VISION_API_KEY=... \
 *   node scripts/vlm_party_worker.mjs \
 *     --dir storage/audit-osun2026/sheets \
 *     --out storage/audit-osun2026/party_full.jsonl \
 *     [--only storage/audit-osun2026/party_targets.json]
 *
 *   --limit N --concurrency N --retries N --restart   as vlm_worker.mjs
 *
 * Pass 2 cropped the summary boxes and took their coverage from 55% to 92%.
 * After that the party column is what blocks the audit: unresolved on 1,326
 * sheets, with party_sum unknown on 964 — more than any box. This is the same
 * technique pointed at it.
 *
 * TWO THINGS THE CROP BUYS BEYOND MAGNIFICATION.
 *
 * It cuts off the polling-agent signature column on the right. On sheet
 * 29-01-01-001 the words cell reads "ONE HUNDRED AND TEN" and an agent's
 * signature — "JOLOMON AKINLOYE" — begins immediately after it, in the same
 * hand, at the same size, with no ruled line between them in the photograph.
 * Nothing in the prompt can reliably tell a model where the votes stop and the
 * signature starts; a crop can.
 *
 * It also takes in the TOTAL VALID VOTES row, which no pass has ever read. That
 * line is a fourth independent statement of #7 in the officer's own hand, and
 * it is how 29-01-03-003's three-different-totals anomaly was found — by a
 * human, one sheet at a time. Capturing it makes that a check over all 3,742.
 *
 * Output is one JSON line per sheet holding the RAW cell text, so merging and
 * parsing can be re-run offline without re-paying for inference.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { chatComplete } from '../src/services/assistant.js';
import {
  partyTablePrompt, partyTableSchema, OSUN_2026_BALLOT, parseModelJson, PARTY_TABLE_CROP, normaliseParty,
} from '../src/services/ec8a_prompt.js';
import { cellConfidences } from '../src/services/logprob_cells.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const dir = arg('dir');
const outPath = arg('out');
const onlyPath = arg('only');
const limit = Number(arg('limit', 0)) || Infinity;
const concurrency = Math.max(1, Number(arg('concurrency', 16)));
const retries = Math.max(1, Number(arg('retries', 3)));

if (!dir || !outPath) { console.error('need --dir <folder> --out <file.jsonl>'); process.exit(2); }
if (!config.visionApiBase) { console.error('VISION_API_BASE is not set. Refusing to start.'); process.exit(2); }

const provider = {
  name: 'vlm-party', base: config.visionApiBase,
  key: config.visionApiKey || 'dummy', model: config.visionModel,
};

/** Geometry lives in ec8a_prompt.js so the preview tool cannot drift from it. */
async function cropPartyTable(full) {
  const m = await sharp(full).metadata();
  const left = Math.round(m.width * PARTY_TABLE_CROP.left);
  const right = Math.round(m.width * PARTY_TABLE_CROP.right);
  const top = Math.round(m.height * PARTY_TABLE_CROP.top);
  const bottom = Math.round(m.height * PARTY_TABLE_CROP.bottom);
  return sharp(full)
    .extract({ left, top, width: right - left, height: bottom - top })
    // Pinned output, NOT input-width x scale — see PARTY_TABLE_CROP. This is what
    // makes the pass resolution-independent: the same 1728px reaches the model
    // whether the crop came from the 1500px derivative (upscaled, as today) or
    // from the 3072px original (downscaled, real detail). Same tokens either way.
    .resize({ width: PARTY_TABLE_CROP.outWidth, kernel: 'lanczos3' })
    .jpeg({ quality: 88 })
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

/**
 * Prove the schema binds. vLLM 0.27 accepted `guided_json` and silently ignored
 * it — two full runs recorded `guided: true` having been constrained by
 * nothing. Never infer that a constraint applied from the absence of an error.
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
  // DONE MEANS READ, NOT ATTEMPTED. Marking every record seen as done meant a
  // sheet that errored could never be retried: when the server OOMed mid-run,
  // 50 sheets were written as `{"error":"vlm-party 502"}` and a resume would
  // have skipped all 50 for good, leaving them permanently unread with nothing
  // in the logs to say so. Only a record with an actual reading counts.
  for (const line of fs.readFileSync(outPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.file && Array.isArray(j.parties) && j.parties.length) done.add(path.basename(j.file));
    } catch { /* torn tail */ }
  }
}

let all = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
if (onlyPath) {
  const want = new Set(JSON.parse(fs.readFileSync(onlyPath, 'utf8'))
    .map((x) => path.basename(typeof x === 'string' ? x : x.file)));
  const before = all.length;
  all = all.filter((f) => want.has(f));
  console.log(`[party] --only: ${all.length} of ${before} sheet(s) selected from ${path.basename(onlyPath)}`);
  if (all.length < want.size) {
    console.log(`[party] !! ${want.size - all.length} name(s) in the target list had no image on disk`);
  }
}
const todo = all.filter((f) => !done.has(f)).slice(0, limit);
if (!todo.length) { console.log(`nothing to do — ${done.size} already in ${outPath}`); process.exit(0); }

const PROMPT = partyTablePrompt(OSUN_2026_BALLOT);
const SCHEMA = partyTableSchema(OSUN_2026_BALLOT);

async function readTable(file) {
  const buf = await cropPartyTable(path.join(dir, file));
  const content = [
    { type: 'text', text: PROMPT },
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
  ];
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const m = await chatComplete(provider, [{ role: 'user', content }], {
        maxTokens: 1600,
        timeoutMs: 180_000,
        extra: {
          temperature: 0,
          response_format: { type: 'json_schema', json_schema: { name: 'ec8a_party_table', schema: SCHEMA } },
          // ASK FOR THE UNCERTAINTY. The forward pass has computed this on every
          // request since the first run and nothing has ever read it. It costs
          // 1-3% of throughput and is the only thing that separates "I can see
          // this cell is empty" from "I could not read it and guessed empty" —
          // the failure behind 2,813 provably-false blanks in the Osun run.
          //
          // vLLM V1 returns logprobs RAW, before the grammar mask, so they
          // survive the structured-output constraint already in force here.
          logprobs: true,
          top_logprobs: 5,
        },
      });
      // The text is still the return value; confidence rides alongside so a run
      // without logprobs behaves exactly as before.
      return { text: m.content || '', logprobs: m._logprobs || null };
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('failed');
}

console.log(`[party] ${provider.model} at ${provider.base}`);
try { await preflight(); } catch (e) { console.error(`[party] endpoint unreachable: ${e.message}`); process.exit(2); }
if (await structuredOutputWorks()) {
  console.log('[party] structured output: VERIFIED');
} else {
  console.error('[party] structured output does NOT bind on this endpoint. Refusing to run.');
  process.exit(2);
}
console.log(`[party] ${all.length} sheet(s); ${done.size} already read; ${todo.length} to go; ${concurrency} in flight`);

const out = fs.createWriteStream(outPath, { flags: 'a' });
const started = Date.now();
let n = 0, ok = 0, unparsed = 0, errored = 0, badRowSet = 0, empties = 0;
let cursor = 0;

async function work() {
  for (;;) {
    const i = cursor++;
    if (i >= todo.length) return;
    const file = todo[i];
    const t0 = Date.now();
    const rec = { file, ms: 0 };
    try {
      const { text, logprobs } = await readTable(file);
      const v = parseModelJson(text);
      if (!v || !Array.isArray(v.parties)) { rec.error = 'unparseable'; rec.raw = String(text).slice(0, 2000); unparsed++; }
      else {
        // Per-cell confidence, aligned to the response text by token offsets.
        // RECORDED, NOT ACTED ON. Where the abstention threshold sits is a
        // calibration decision that must be made against the 2,813 rows whose
        // figures cell came back blank while the words cell on the same row
        // carried a value — known-false blanks with exactly the right failure
        // distribution. Guessing a cutoff here would be the same mistake as the
        // schema that let "" through: a number chosen because it seemed
        // reasonable rather than because it was measured.
        const figConf = cellConfidences(text, logprobs, 'figures');
        const wordConf = cellConfidences(text, logprobs, 'words');
        rec.parties = v.parties.map((p, i) => ({
          // normaliseParty, not toUpperCase: the model returned "ACCORD" for
          // row 1 of 29-01-01-003 — the party's real name, of which the ballot
          // code "A" is the abbreviation. A correct reading, thrown away by a
          // name lookup that only knew the code.
          party: normaliseParty(p?.party),
          figures: p?.figures ?? null,
          words: p?.words ?? null,
          // null when the endpoint returned no logprobs, so a run without them
          // is byte-identical to before rather than carrying empty scaffolding.
          conf: figConf[i] ? { fig: figConf[i].minLogprob, word: wordConf[i]?.minLogprob ?? null } : null,
        }));
        rec.totalRow = v.totalRow ? { figures: v.totalRow.figures ?? null, words: v.totalRow.words ?? null } : null;
        // Counted here so a systematic regression is visible in the run log
        // rather than only after the merge: the whole point of this pass is the
        // "" / null distinction, and a model quietly ignoring it would leave
        // coverage looking unchanged for no obvious reason.
        empties += rec.parties.filter((p) => p.figures === '' || p.words === '').length;
        const names = new Set(rec.parties.map((p) => p.party));
        if (names.size !== OSUN_2026_BALLOT.length) { rec.badRowSet = true; badRowSet++; }
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
      console.log(`[party] ${n}/${todo.length} · ok=${ok} unparsed=${unparsed} err=${errored} dupRows=${badRowSet}`
        + ` · ${(60 / Math.max(rate, 0.001)).toFixed(2)}s/sheet · ~${((todo.length - n) / Math.max(rate, 0.001)).toFixed(0)} min left`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, work));
await new Promise((r) => out.end(r));

const secs = (Date.now() - started) / 1000;
console.log(`\n[party] ${n} sheet(s) in ${secs.toFixed(0)}s — ${(secs / Math.max(n, 1)).toFixed(2)}s/sheet`);
console.log(`  read ok: ${ok}   unparseable: ${unparsed}   errored: ${errored}`);
console.log(`  sheets whose row set is not the 15 parties: ${badRowSet}`);
console.log(`  cells reported EMPTY (the point of this pass): ${empties}`);
if (!empties && ok) {
  console.log('  !! not one empty cell reported. Either the prompt rule is not landing or the schema');
  console.log('     is coercing "" away — check before trusting this run.');
}
if (unparsed + errored) console.log(`!! ${unparsed + errored} sheet(s) produced no reading — rerun to retry just those.`);
process.exit(0);

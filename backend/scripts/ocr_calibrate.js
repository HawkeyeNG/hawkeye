// OCR calibration harness. Runs the production OCR pipeline (services/ocr.js)
// over every image in storage/training/ and reports what digits it can read.
// With ground truth (storage/training/truth.json: { "<image-basename>": {"APC":123,...} })
// it scores match rates so preprocessing/thresholds can be tuned.
// NOTE: Tesseract itself is not retrained here — "learning" = tuning our
// preprocessing + match rules against real sheets, and live telemetry
// (/api/ocr/stats) accumulating from real submissions.
//   node scripts/ocr_calibrate.js [--ensemble] [--paddle] [--vlm <run.jsonl>]
// --vlm scores a vlm_worker.mjs run as a third engine. It reads a FILE rather
// than running the model: inference happens on rented GPU hardware, the scoring
// happens here, and the two must not be welded together.
// --paddle adds a PaddleOCR pass and reports EACH engine separately plus their
// union and their AGREEMENT. Agreement is the figure that matters for the audit:
// a count both engines read independently is far safer to assert than one only
// a single engine saw. Needs ~/paddle/venv (python3.12 — Paddle ships no 3.14 wheel).
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
import { wordsToNumber } from '../src/services/ec8a_words.js';

const ENSEMBLE = process.argv.includes('--ensemble');
const PADDLE = process.argv.includes('--paddle');
const argAt = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const VLM_FILE = argAt('vlm');
const PADDLE_PY = process.env.PADDLE_PY || path.join(os.homedir(), 'paddle', 'venv', 'bin', 'python');
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

/**
 * Run every image through PaddleOCR in ONE process — model load is ~10s, so
 * per-image invocation would dominate the run. Returns Map<basename, tokens[]>.
 */
function paddleTokensBatch(dirPath, files) {
  const out = new Map();
  if (!files.length) return out;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'paddle_worker.py');
  if (!fs.existsSync(PADDLE_PY)) {
    console.error(`[paddle] interpreter not found at ${PADDLE_PY} — skipping (set PADDLE_PY)`);
    return out;
  }
  // CHUNKED, and every chunk reports. One execFileSync over all 549 sheets with
  // a wall-clock timeout produced the worst possible outcome: it died at
  // ETIMEDOUT having read 24, the other 525 scored against EMPTY token sets, and
  // the run printed "paddleocr 5.4%" — an engine that actually reads ~90% on the
  // sheets it sees. A partial batch must never masquerade as a bad engine, so
  // coverage is now reported next to the score and a stalled chunk costs only
  // that chunk.
  const CHUNK = Number(process.env.PADDLE_CHUNK || 20);
  const PER_SHEET_MS = Number(process.env.PADDLE_SHEET_MS || 600000);
  for (let i = 0; i < files.length; i += CHUNK) {
    const batch = files.slice(i, i + CHUNK);
    const args = [script, ...batch.map((f) => path.join(dirPath, f))];
    let stdout = '';
    try {
      stdout = execFileSync(PADDLE_PY, args, {
        timeout: PER_SHEET_MS * batch.length,
        maxBuffer: 256 * 1024 * 1024,
      }).toString();
    } catch (e) {
      stdout = (e.stdout || '').toString();   // keep whatever the chunk managed
      console.error(`[paddle] chunk ${i}-${i + batch.length}:`, String(e.message).slice(0, 100));
    }
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.fatal) { console.error('[paddle] FATAL:', j.fatal); continue; }
      if (j.error) { console.error(`[paddle] ${path.basename(j.file)}: ${j.error}`); continue; }
      const toks = [];
      for (const t of j.texts || []) for (const d of String(t).match(/\d+/g) || []) toks.push(d);
      out.set(path.basename(j.file), toks);
    }
    console.log(`[paddle] ${out.size}/${files.length} read`);
  }
  return out;
}

/**
 * Tokens from a vlm_worker.mjs run. A VLM returns structured fields rather than
 * loose text, so its "tokens" are the numbers it actually committed to: each
 * party's figures, each party's words run through the SAME wordsToNumber() used
 * on PaddleOCR output, and the summary boxes. Using one parser on both sides is
 * the difference between comparing two engines and comparing two parsers.
 *
 * A sheet the run errored on contributes NOTHING and is absent from the map, so
 * it shows up in the coverage line rather than as a zero score.
 */
function vlmTokens(file) {
  const out = new Map();
  if (!fs.existsSync(file)) { console.error(`[vlm] no such file: ${file}`); return out; }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!j.file || !j.sheet) continue;
    const toks = new Set();
    for (const party of j.sheet.parties || []) {
      if (Number.isInteger(party?.figures)) toks.add(String(party.figures));
      const w = party?.words == null ? null : wordsToNumber(party.words);
      if (w !== null) toks.add(String(w));
    }
    for (const k of ['registered', 'accredited', 'spoiled', 'rejected', 'totalValid', 'usedBallots']) {
      if (Number.isInteger(j.sheet[k])) toks.add(String(j.sheet[k]));
    }
    out.set(path.basename(j.file), [...toks]);
  }
  return out;
}

// --dir/--limit exist so a change to the harness can be smoke-tested on three
// sheets instead of a 549-sheet Tesseract run, and so the audit archive can be
// scored without being moved into storage/training.
const dir = path.resolve(argAt('dir') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'training'));
if (!fs.existsSync(dir)) { console.error('put EC8A photos in storage/training/ first'); process.exit(1); }
const truthPath = path.join(dir, 'truth.json');
const truth = fs.existsSync(truthPath) ? JSON.parse(fs.readFileSync(truthPath, 'utf8')) : {};

// QA gate: labels APPROVED in the review console are the ML set. Defaults to
// approved-only once any approvals exist; --all scores every label regardless.
const ALL = process.argv.includes('--all');
let approved = {};
try { approved = JSON.parse(fs.readFileSync(path.join(dir, 'approved.json'), 'utf8')); } catch { /* none yet */ }
const gated = !ALL && Object.keys(approved).length > 0;
if (gated) console.log(`QA gate: scoring ${Object.keys(approved).length} APPROVED label(s) only (pass --all to include unreviewed)`);

const imgs = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f))
  .filter((f) => !LABELED_ONLY || truth[f.replace(/\.[^.]+$/, '')])
  .filter((f) => !LABELED_ONLY || !gated || approved[f.replace(/\.[^.]+$/, '')])
  .slice(0, Number(argAt('limit', 0)) || Infinity);
if (!imgs.length) { console.error('no images in storage/training/'); process.exit(1); }

let paddleMap = new Map();
if (PADDLE) {
  console.log(`[paddle] reading ${imgs.length} sheet(s) in one process — first run downloads models...`);
  const t0 = Date.now();
  paddleMap = paddleTokensBatch(dir, imgs);
  console.log(`[paddle] ${paddleMap.size}/${imgs.length} sheet(s) read in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

let vlmMap = new Map();
if (VLM_FILE) {
  vlmMap = vlmTokens(VLM_FILE);
  console.log(`[vlm] ${vlmMap.size} sheet(s) with a reading in ${VLM_FILE}`);
}

// Every engine past Tesseract scores through the same registry, so adding a
// fourth needs one push and no new branches in the loop below.
const extra = [];
if (PADDLE) extra.push({ label: 'paddleocr', map: paddleMap, sum: 0, cov: 0 });
if (VLM_FILE) extra.push({ label: 'vlm', map: vlmMap, sum: 0, cov: 0 });

let scoredImgs = 0, matchedSum = 0, totalSum = 0;
let unionSum = 0, agreeSum = 0;
const scoredSet = new Set();
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
    scoredImgs++; matchedSum += r.matched; totalSum += r.total; scoredSet.add(f);
    if (extra.length) {
      const wanted = votes.filter((v) => v.count > 0).map((v) => String(v.count));
      const sets = [new Set(r.tokens), ...extra.map((e) => new Set(e.map.get(f) || []))];
      const per = extra.map((e, i) => {
        const n = wanted.filter((c) => sets[i + 1].has(c)).length;
        e.sum += n;
        return ` · ${e.label} ${n}/${r.total}`;
      }).join('');
      const um = wanted.filter((c) => sets.some((set) => set.has(c))).length;
      const am = wanted.filter((c) => sets.every((set) => set.has(c))).length;
      unionSum += um; agreeSum += am;
      console.log(`${f}: tess ${r.matched}/${r.total}${per} · union ${um} · agree ${am}`);
    } else {
      console.log(`${f}: ${r.matched}/${r.total} counts matched · ${r.tokens.length} digit tokens read`);
    }
  } else {
    console.log(`${f}: ${r.tokens.length} digit tokens read (no truth) e.g. ${r.tokens.slice(0, 10).join(',')}`);
  }
}
if (scoredImgs) {
  const pct = (n) => `${n}/${totalSum} (${((n / totalSum) * 100).toFixed(1)}%)`;
  if (extra.length) {
    console.log(`\nOVERALL across ${scoredImgs} scored sheets`);
    // Coverage FIRST. Scoring a sheet an engine never saw as "that engine missed
    // it" is how a 90% engine reported 5.4% once already.
    for (const e of extra) {
      e.cov = [...e.map.keys()].filter((k) => scoredSet.has(k)).length;
      if (e.cov < scoredImgs) {
        console.log(`  !! ${e.label} read only ${e.cov}/${scoredImgs} sheets — its row below is`);
        console.log(`     diluted by ${scoredImgs - e.cov} sheets it never saw. Not a fair comparison.`);
      }
    }
    console.log(`  tesseract : ${pct(matchedSum)}`);
    for (const e of extra) {
      console.log(`  ${e.label.padEnd(10)}: ${pct(e.sum)}${e.cov < scoredImgs ? '  <- see coverage warning' : ''}`);
    }
    console.log(`  union     : ${pct(unionSum)}   (ANY engine read it)`);
    console.log(`  agreement : ${pct(agreeSum)}   (ALL ${extra.length + 1} read it — the assertable set)`);
    console.log(`\nAgreement is the audit-relevant figure: a count only one engine`);
    console.log(`saw still needs a human before it can be published.`);
  } else {
    console.log(`\nOVERALL: ${pct(matchedSum)} across ${scoredImgs} scored sheets`);
  }
}
process.exit(0);

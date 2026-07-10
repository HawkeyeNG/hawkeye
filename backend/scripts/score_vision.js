// Score the AI vision reader against the labeled EC8A sheets (truth.json) — the
// counterpart to ocr_calibrate.js for Tesseract. Sends each labeled sheet to the
// vision model (VISION_API_* env, OpenAI-compatible; Gemini by default), parses
// the read counts, and compares to ground truth. Rate-limited + resumable so the
// free tier isn't blown: progress is checkpointed to /tmp/vision_score.json and
// finished sheets are skipped on re-run.
//   VISION_API_KEY=... [VISION_API_BASE=...] [VISION_MODEL=...] node scripts/score_vision.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.VISION_API_KEY;
const BASE = process.env.VISION_API_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODEL = process.env.VISION_MODEL || 'gemini-2.5-flash-lite';
const DELAY = Number(process.env.SCORE_DELAY_MS || 4500); // stay under free RPM
if (!KEY) { console.error('set VISION_API_KEY'); process.exit(1); }

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'training');
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
// Durable checkpoint (NOT /tmp): survives reboots so a sheet already sent to the
// vision API is never re-sent (and never re-charged) on a later run. storage/ is
// gitignored, so this stays a local artifact. Override with SCORE_CKPT if needed.
const CKPT = process.env.SCORE_CKPT || path.join(dir, 'vision_scored.json');
const LIMIT = Number(process.env.SCORE_LIMIT || 100); // sample the first N sheets by default
const done = fs.existsSync(CKPT) ? JSON.parse(fs.readFileSync(CKPT, 'utf8')) : {};

const imgFor = (k) => ['jpg', 'jpeg', 'png'].map((e) => path.join(dir, `${k}.${e}`)).find(fs.existsSync);
const prompt = 'This is a photo of a Nigerian INEC EC8A result sheet. Reply with ONLY JSON: {"counts":[{"party":"<CODE>","count":<integer>}]} — the recorded score for each party you can clearly read (integers only); omit any you cannot read. Do not guess.';

async function readSheet(file) {
  const b64 = fs.readFileSync(file).toString('base64');
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
    ] }] }),
    signal: AbortSignal.timeout(40_000),
  });
  if (res.status === 429) throw new Error('quota_429');
  if (!res.ok) throw new Error('http_' + res.status);
  const j = await res.json();
  const txt = j.choices?.[0]?.message?.content || '';
  const m = /\{[\s\S]*\}/.exec(txt);
  return m ? JSON.parse(m[0]).counts || [] : [];
}

const keys = Object.keys(truth).filter((k) => imgFor(k)).slice(0, LIMIT);
let i = 0;
for (const k of keys) {
  i++;
  if (done[k]) continue;
  const file = imgFor(k);
  const want = Object.entries(truth[k]).filter(([, c]) => c > 0).map(([party, count]) => ({ party, count }));
  try {
    const read = await readSheet(file);
    const readMap = Object.fromEntries(read.filter((c) => c && Number.isInteger(c.count)).map((c) => [String(c.party).toUpperCase(), c.count]));
    const readVals = new Set(Object.values(readMap).map(String));
    const strict = want.filter((v) => readMap[v.party.toUpperCase()] === v.count).length; // party+count
    const value = want.filter((v) => readVals.has(String(v.count))).length;               // value present (OCR-comparable)
    done[k] = { strict, value, total: want.length };
    fs.writeFileSync(CKPT, JSON.stringify(done));
    console.log(`${i}/${keys.length} ${k}: strict ${strict}/${want.length}, value ${value}/${want.length}`);
  } catch (e) {
    if (e.message === 'quota_429') { console.error(`\nSTOPPED at ${i}/${keys.length} — quota (429). Re-run later to resume.`); break; }
    console.error(`${k}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, DELAY));
}

const rows = keys.filter((k) => done[k]).map((k) => done[k]); // report over the sampled window only
const s = rows.reduce((a, r) => a + r.strict, 0), v = rows.reduce((a, r) => a + r.value, 0), t = rows.reduce((a, r) => a + r.total, 0);
if (t) console.log(`\nVISION OVERALL (${rows.length} sheets): party+count ${s}/${t} (${(s / t * 100).toFixed(1)}%) · value-present ${v}/${t} (${(v / t * 100).toFixed(1)}%)`);

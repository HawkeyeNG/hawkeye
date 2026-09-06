/**
 * What does the digit-spelling fix change, and nothing else?
 *
 *   node scripts/rerun_verify.mjs                 # sandbox, audit untouched
 *   node scripts/rerun_verify.mjs --in-place
 *
 * A/B ON THE SAME INPUT. A first attempt compared the STORED verify block
 * against a freshly computed one, and reported 253 sheets moving from
 * publishable to review — the opposite direction from a fix that makes rows
 * AGREE. The cause was not the parser: the stored block was built by a pipeline
 * that merges a separate party pass, so calling verifySheet(sheet) with default
 * options measured my options against theirs. Any difference it found was noise
 * wearing the shape of a result.
 *
 * So both sides are computed here, from the same sheet, by the same
 * verifySheet, differing ONLY in which ec8a_words.js is behind it — the current
 * one, and the one from the commit before the fix. Whatever differs is the fix.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = '/home/elrio/hawkeye';
const AUDIT = path.join(REPO, 'audits', '2026-osun-governorship');
const SERVICES = path.join(REPO, 'backend', 'src', 'services');
const IN_PLACE = process.argv.includes('--in-place');

/** A services tree whose ec8a_words.js is the pre-fix one. */
function oldServices() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'services-old-'));
  for (const f of fs.readdirSync(SERVICES)) {
    const s = path.join(SERVICES, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dir, f));
  }
  const before = execFileSync('git', ['show', 'HEAD~1:backend/src/services/ec8a_words.js'],
    { cwd: REPO, encoding: 'utf8' });
  if (/DIGIT_WORDS/.test(before)) throw new Error('HEAD~1 already has the fix — wrong commit');
  fs.writeFileSync(path.join(dir, 'ec8a_words.js'), before);
  return dir;
}

const OLD_DIR = oldServices();
// ec8a_verify imports '../db.js' etc. via relative paths from services/, so the
// copy must sit where those resolve. It does not: import from the copy would
// break. Instead the copy is placed INSIDE services/ under a temp name.
const shadow = path.join(SERVICES, '_words_before_tmp');
fs.rmSync(shadow, { recursive: true, force: true });
fs.mkdirSync(shadow);
for (const f of fs.readdirSync(OLD_DIR)) fs.copyFileSync(path.join(OLD_DIR, f), path.join(shadow, f));
// fix the one level of relative depth the copy gained
for (const f of fs.readdirSync(shadow)) {
  const p = path.join(shadow, f);
  const src = fs.readFileSync(p, 'utf8').replace(/(['"])\.\.\//g, '$1../../');
  fs.writeFileSync(p, src);
}

const { verifySheet: verifyNEW } = await import(path.join(SERVICES, 'ec8a_verify.js'));
const { verifySheet: verifyOLD } = await import(pathToFileURL(path.join(shadow, 'ec8a_verify.js')).href);
const { wordsToNumber: wNEW } = await import(path.join(SERVICES, 'ec8a_words.js'));
const { wordsToNumber: wOLD } = await import(pathToFileURL(path.join(shadow, 'ec8a_words.js')).href);

// CONTROL: the two trees must really differ, or "no change" means nothing.
if (!(wOLD('ONE THREE ZERO') === 4 && wNEW('ONE THREE ZERO') === 130)) {
  console.error(`CONTROL FAILED: old=${wOLD('ONE THREE ZERO')} new=${wNEW('ONE THREE ZERO')}`);
  fs.rmSync(shadow, { recursive: true, force: true });
  process.exit(2);
}
console.log('control: old("ONE THREE ZERO")=4, new=130 — two genuinely different parsers\n');

const lines = fs.readFileSync(path.join(AUDIT, 'vlm_stage0b.jsonl'), 'utf8').trim().split('\n');
const outOld = [], outNew = [];
const moves = new Map();
let changed = 0, failed = 0;

for (const line of lines) {
  const r = JSON.parse(line);
  let vo = null, vn = null;
  try { vo = verifyOLD(r.sheet); vn = verifyNEW(r.sheet); } catch { failed++; }
  const ro = { ...r, verify: vo || r.verify };
  const rn = { ...r, verify: vn || r.verify };
  outOld.push(JSON.stringify(ro));
  outNew.push(JSON.stringify(rn));
  const a = vo?.summary?.verdict, b = vn?.summary?.verdict;
  if (vo && vn && a !== b) {
    changed++;
    const k = `${a} -> ${b}`;
    moves.set(k, (moves.get(k) || 0) + 1);
  }
}
console.log(`re-verified ${lines.length} sheets under BOTH parsers` + (failed ? `, ${failed} failed` : ''));
console.log(`verdict changed on ${changed} sheet(s)  <- attributable to the words fix alone`);
if (moves.size) {
  console.log('\nverdict movements:');
  for (const [k, n] of [...moves.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${n}`);
}

// ---- triage both sides -----------------------------------------------------
function triage(rowsJson, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `triage-${label}-`));
  for (const f of fs.readdirSync(AUDIT)) {
    const s = path.join(AUDIT, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, 'vlm_stage0b.jsonl'), rowsJson.join('\n') + '\n');
  execFileSync('node', [path.join('scripts', 'stage1_triage.mjs'), dir],
    { cwd: path.join(REPO, 'backend'), encoding: 'utf8' });
  const n = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).length;
  return { dir, a: n('tier_a.json'), b: n('tier_b.json'), c: n('tier_c.json') };
}

const OLD = triage(outOld, 'old');
const NEW = triage(outNew, 'new');

console.log('\n================ TIER COUNTS ================');
console.log('          old parser   new parser   change');
for (const [k, label] of [['a', 'tier_a'], ['b', 'tier_b'], ['c', 'tier_c']]) {
  const d = NEW[k] - OLD[k];
  console.log(`  ${label.padEnd(8)} ${String(OLD[k]).padStart(10)} ${String(NEW[k]).padStart(12)}   ${d > 0 ? '+' : ''}${d}`);
}
console.log(`  ${'total'.padEnd(8)} ${String(OLD.a + OLD.b + OLD.c).padStart(10)} ${String(NEW.a + NEW.b + NEW.c).padStart(12)}`);
console.log('\n(the audit as it stands today reports 516 / 300 / 1854 — that was produced by');
console.log(' the full pipeline, which merges a party pass this A/B does not, so compare the');
console.log(' two columns above with each other, not with the standing numbers)');

if (IN_PLACE) {
  for (const f of ['tier_a.json', 'tier_b.json', 'tier_c.json', 'vlm_stage0b.jsonl']) {
    fs.copyFileSync(path.join(NEW.dir, f), path.join(AUDIT, f));
  }
  console.log('\nWritten IN PLACE.');
} else {
  console.log(`\nSandbox only — the audit's own files are untouched.\n  old: ${OLD.dir}\n  new: ${NEW.dir}`);
}
fs.rmSync(shadow, { recursive: true, force: true });
fs.rmSync(OLD_DIR, { recursive: true, force: true });

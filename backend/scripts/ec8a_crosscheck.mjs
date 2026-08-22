/**
 * Run the EC8A figures-vs-words cross-check over sheets.
 *
 *   node scripts/ec8a_crosscheck.mjs <image...>
 *   node scripts/ec8a_crosscheck.mjs --dir storage/training --limit 20
 *   node scripts/ec8a_crosscheck.mjs --dir storage/audit-osun2026/sheets --limit 50 --json out.json
 *
 * Needs no ground truth and no second engine: the sheet carries each count
 * twice, in figures and in words, and this compares them. Agreement is a
 * strong read; disagreement is a finding for a human — never auto-resolved.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crossCheckSheet } from '../src/services/ec8a_words.js';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : def;
};
const PADDLE_PY = process.env.PADDLE_PY || path.join(os.homedir(), 'paddle', 'venv', 'bin', 'python');
const HERE = path.dirname(fileURLToPath(import.meta.url));

let files = argv.filter((a) => /\.(jpe?g|png)$/i.test(a));
const dir = arg('dir');
if (dir) {
  const limit = Number(arg('limit', 0)) || Infinity;
  files = fs.readdirSync(dir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .slice(0, limit)
    .map((f) => path.join(dir, f));
}
if (!files.length && !process.argv.includes("--fixture")) { console.error('give image paths or --dir <folder> [--limit N]'); process.exit(2); }
if (!fs.existsSync(PADDLE_PY)) { console.error(`no interpreter at ${PADDLE_PY} (set PADDLE_PY)`); process.exit(2); }

// --fixture replays saved worker output. OCR costs minutes per sheet on CPU;
// the PARSER is what gets iterated on, and it must not need a fresh OCR run to
// test. Dump one with: paddle_worker.py <imgs> > fixture.jsonl
let stdout = '';
const fixture = arg('fixture');
if (fixture) {
  stdout = fs.readFileSync(fixture, 'utf8');
  console.log(`[fixture] replaying ${fixture}\n`);
} else {
  console.log(`[paddle] reading ${files.length} sheet(s) in one process...`);
  const t0 = Date.now();
  try {
    stdout = execFileSync(PADDLE_PY, [path.join(HERE, 'paddle_worker.py'), ...files],
      { timeout: 6 * 3600 * 1000, maxBuffer: 512 * 1024 * 1024 }).toString();
  } catch (e) {
    stdout = (e.stdout || '').toString();          // keep partial work
    console.error('[paddle]', String(e.message).slice(0, 140));
  }
  console.log(`[paddle] done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}

const results = [];
let agree = 0, disagree = 0, unreadable = 0, checked = 0;

for (const line of stdout.split('\n')) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (j.fatal) { console.error('[paddle] FATAL:', j.fatal); break; }
  if (j.error) { console.error(`  ${path.basename(j.file)}: ${j.error}`); continue; }

  const r = crossCheckSheet(j.texts || [], j.boxes || []);
  results.push({ file: path.basename(j.file), ...r });
  agree += r.agree; disagree += r.disagree; unreadable += r.unreadable; checked += r.checked;

  const bad = r.rows.filter((x) => x.status === 'disagree');
  if (r.note) console.log(`  ^ note: ${r.note}`);
  console.log(`${path.basename(j.file)}: ${r.agree} agree · ${r.disagree} disagree · ${r.unreadable} unreadable (${r.checked} party rows)`);
  for (const b of bad) console.log(`    MISMATCH ${b.party}: figures=${b.figures} words=${b.words}`);
}

const pct = (n) => (checked ? ((n / checked) * 100).toFixed(1) : '0.0');
console.log(`\nOVERALL across ${results.length} sheet(s), ${checked} party rows`);
console.log(`  agree      : ${agree} (${pct(agree)}%)   ← two independent writings of the same number, read consistently`);
console.log(`  disagree   : ${disagree} (${pct(disagree)}%)   ← for a human: misread, or an inconsistent sheet`);
console.log(`  unreadable : ${unreadable} (${pct(unreadable)}%)   ← explicit unknown, never counted either way`);

const outPath = arg('json');
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

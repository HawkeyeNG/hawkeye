/**
 * Add `import { t } from '@/lib/i18n';` to every file the extractor keyed.
 *
 * Placed after the LAST existing import so it cannot land inside a block
 * comment or ahead of a side-effecting import. Idempotent: a file that already
 * has it is skipped, so this can be re-run after another extraction pass.
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = '/home/elrio/hawkeye/native/src';
const LINE = "import { t as i18nT } from '@/lib/i18n';";

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.tsx') && e.name !== 'i18n.tsx') files.push(p);
  }
})(SRC);

let added = 0;
let already = 0;
let noNeed = 0;
const problems = [];

for (const file of files.sort()) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\bi18nT\('/.test(src)) { noNeed++; continue; }
  if (src.includes(LINE)) { already++; continue; }

  /* The last top-level import statement. Matching every `^import ... ;` and
     taking the final one keeps this behind multi-line import blocks, which
     several of these files have. */
  const matches = [...src.matchAll(/^import[\s\S]*?;$/gm)];
  if (!matches.length) { problems.push(file + ': no import to anchor to'); continue; }
  const last = matches[matches.length - 1];
  const at = last.index + last[0].length;
  const out = src.slice(0, at) + '\n' + LINE + src.slice(at);

  // Only an insertion: removing the line again must restore the file exactly.
  if (out.replace('\n' + LINE, '') !== src) { problems.push(file + ': not a clean insertion'); continue; }
  fs.writeFileSync(file, out);
  added++;
}

console.log('import added : ' + added);
console.log('already had  : ' + already);
console.log('no t() calls : ' + noNeed);
if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 1;
}

// Control: every file that calls t() must now import it, or the count is a lie.
const missing = files.filter((f) => {
  const s = fs.readFileSync(f, 'utf8');
  return /\bi18nT\('/.test(s) && !s.includes(LINE);
});
console.log(missing.length
  ? 'FAIL — ' + missing.length + ' file(s) call t() without importing it:\n  ' + missing.map((f) => path.relative(SRC, f)).join('\n  ')
  : 'every file that calls t() imports it');
if (missing.length) process.exitCode = 1;

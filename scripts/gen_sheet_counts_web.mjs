#!/usr/bin/env node
// app/sheet-counts.js is GENERATED from native/src/lib/sheet-counts.ts, so the website, Hawkeye Lite and
// the native app pair a sheet's counts with the same code.
//
//   node scripts/gen_sheet_counts_web.mjs           regenerate app/sheet-counts.js
//   node scripts/gen_sheet_counts_web.mjs --check   exit 1 if it is stale (tests/sheet_counts_test.mjs runs this)
//
// Node strips the types in place (each annotation becomes spaces; comments and layout survive), the
// padding is tidied, and the module syntax is swapped for a browser global. Needs Node 22.13+.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'native/src/lib/sheet-counts.ts');
const OUT = path.join(root, 'app/sheet-counts.js');

export function generate() {
  const js = stripTypeScriptTypes(fs.readFileSync(SRC, 'utf8'), { mode: 'strip' })
    .replace(/^[\s\S]*?\*\//, '') // the web file gets its own header
    .replace(/^\/\*\* One recognised line.*\*\/\n/m, '') // documented a type that is gone
    .replace(/^export function /m, 'function ')
    .replace(/ +\)/g, ')')
    .replace(/ +,/g, ',')
    .replace(/ +;/g, ';')
    .replace(/(\S) {2,}=/g, '$1 =')
    .replace(/\) {2,}\{/g, ') {')
    .replace(/(\w) {2,}\(/g, '$1(')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `/* Party counts off a recognised EC8A sheet, for the website and Hawkeye Lite.
 *
 * GENERATED from native/src/lib/sheet-counts.ts by scripts/gen_sheet_counts_web.mjs
 * (the same code with the types stripped). Do not edit this copy: change the
 * TypeScript and regenerate. tests/sheet_counts_test.mjs fails if this file is
 * stale, and runs every check against BOTH copies, so a sheet pre-fills the same
 * way in the app, in Lite and on the website. The reasoning, the history and
 * the rules are documented in the TypeScript.
 *
 * Exposes window.HAWKEYE_SHEETCOUNTS.parseCounts(text, partyCodes, lines), where
 * lines are {text, left, right, top, bottom} in pixels, origin top-left.
 */
(function () {
${js.split('\n').map((l) => (l ? '  ' + l : l)).join('\n')}

  window.HAWKEYE_SHEETCOUNTS = { parseCounts };
})();
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fresh = generate();
  if (process.argv.includes('--check')) {
    const stale = !fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== fresh;
    console.log(stale ? 'STALE: app/sheet-counts.js differs from the TypeScript — run node scripts/gen_sheet_counts_web.mjs' : 'app/sheet-counts.js is up to date');
    process.exit(stale ? 1 : 0);
  }
  fs.writeFileSync(OUT, fresh);
  console.log(`wrote ${path.relative(root, OUT)} (${fresh.length} chars)`);
}

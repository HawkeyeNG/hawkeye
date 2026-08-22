/**
 * Parse every inline <script> in an HTML page and report syntax errors.
 *
 *   node scripts/check_html_scripts.mjs ../app/admin.html [...]
 *
 * The admin console sits behind a passphrase, so its JavaScript cannot be
 * exercised in a browser here — but a syntax error in it takes the entire
 * console down for the person who CAN log in, and template literals spanning
 * several lines are exactly where an unbalanced backtick hides. Parsing costs
 * nothing and catches the failure that matters most.
 *
 * This proves the scripts PARSE. It does not prove they behave.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

let bad = 0;
for (const file of process.argv.slice(2)) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  console.log(`\n${path.basename(file)} — ${blocks.length} inline script block(s)`);
  blocks.forEach((m, i) => {
    const code = m[1];
    const line = html.slice(0, m.index).split('\n').length;
    if (!code.trim()) { console.log(`  ${i + 1}: empty`); return; }
    try {
      // eslint-disable-next-line no-new
      new vm.Script(code, { filename: `${path.basename(file)}#${i + 1}` });
      console.log(`  ${i + 1}: ok (from line ${line}, ${code.split('\n').length} lines)`);
    } catch (e) {
      bad++;
      console.log(`  ${i + 1}: SYNTAX ERROR near page line ${line}`);
      console.log(`     ${e.message}`);
    }
  });
}
console.log(bad ? `\n${bad} block(s) FAILED to parse` : '\nall inline scripts parse');
process.exit(bad ? 1 : 0);

/**
 * Control for i18n_extract.mjs. A verifier that cannot fail is not a verifier:
 * this plants three different corruptions in the extractor's output and asserts
 * each one is caught. Run it whenever the extractor changes.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = '/home/elrio/hawkeye/scripts/i18n/i18n_extract.mjs';
const TMP = '/home/elrio/hawkeye/scripts/i18n/_ctl.mjs';
const base = fs.readFileSync(SRC, 'utf8');
const anchor = '  const strip = (s) =>';

const defects = [
  ['drops a word', "out = out.replace('Report', 'Repbrt');"],
  ['deletes a tag', "out = out.replace('</p>', '');"],
  ['adds an untracked attribute', 'out = out.replace(\'<p \', \'<p data-i18n="ghost" \');'],
];

let pass = 0;
for (const [label, defect] of defects) {
  fs.writeFileSync(TMP, base
    .replace('const { orig, out } = scan(', 'let { orig, out } = scan(')
    .replace(anchor, '  ' + defect + '\n' + anchor));
  let output = '';
  try {
    output = execSync('node ' + TMP + ' observe.html index.html 2>&1', { cwd: '/home/elrio/hawkeye', encoding: 'utf8' });
  } catch (e) {
    output = String(e.stdout || '') + String(e.stderr || '');
  }
  const caught = /FAIL/.test(output);
  console.log((caught ? 'caught  ' : 'MISSED  ') + label);
  if (!caught) console.log(output.split('\n').slice(0, 4).map((l) => '        ' + l).join('\n'));
  if (caught) pass++;
}
fs.rmSync(TMP, { force: true });

// And the other direction: unmodified, it must report no failure at all.
const clean = execSync('node ' + SRC + ' observe.html index.html', { cwd: '/home/elrio/hawkeye', encoding: 'utf8' });
const quiet = !/FAIL/.test(clean);
console.log((quiet ? 'quiet   ' : 'NOISY   ') + 'unmodified extractor reports no failure');

console.log('\n' + (pass === defects.length && quiet ? 'CONTROL OK' : 'CONTROL BROKEN'));
process.exitCode = pass === defects.length && quiet ? 0 : 1;

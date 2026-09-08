/**
 * Control for native_extract.mjs. The extractor edits CODE, so its only safety
 * net is the inverse check — substitute the English back for every {t('key')}
 * and require the file to equal the original. This plants three corruptions and
 * requires all three to be caught, and confirms a clean run reports none.
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const SRC = '/home/elrio/hawkeye/scripts/i18n/native_extract.mjs';
const TMP = '/home/elrio/hawkeye/scripts/i18n/_nctl.mjs';
const base = fs.readFileSync(SRC, 'utf8');
const anchor = "  const restored = out";

const defects = [
  ['a character dropped from the output', "out = out.replace('the', 'teh');", /FAIL \(not reversible\)/],
  ['a JSX tag deleted', "out = out.replace('</Text>', '');", /FAIL \(not reversible\)/],
  ['a key written that is not in the catalogue', "out = out.replace(/\\{i18nT\\('([^']+)'\\)\\}/, \"{i18nT('made.up.key')}\");", /FAIL \(not reversible\)/],
  /* THE ONE THAT ACTUALLY HAPPENED. The first version keyed
     `0 && contest.states.length` out of a JavaScript comparison and every
     reversibility check passed, because substituting it back restores the file
     exactly. Reversible is not the same as correct. */
  ['a code fragment keyed as if it were prose', "catalogue.set('n.fake.code', '0 && contest.states.length');", /NOT PROSE/],
];

let caught = 0;
for (const [label, defect, want] of defects) {
  fs.writeFileSync(TMP, base.replace(anchor, '  ' + defect + '\n' + anchor));
  let out = '';
  try {
    out = execSync('node ' + TMP, { cwd: '/home/elrio/hawkeye', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const ok = want.test(out);
  console.log((ok ? 'caught  ' : 'MISSED  ') + label);
  if (ok) caught++; else console.log(out.split('\n').slice(0, 3).map((l) => '        ' + l).join('\n'));
}
fs.rmSync(TMP, { force: true });

const clean = execSync('node ' + SRC, { cwd: '/home/elrio/hawkeye', encoding: 'utf8' });
const quiet = !/FAIL/.test(clean);
console.log((quiet ? 'quiet   ' : 'NOISY   ') + 'an unmodified run reports nothing irreversible');
console.log('\n' + (caught === defects.length && quiet ? 'CONTROL OK' : 'CONTROL BROKEN'));
process.exitCode = caught === defects.length && quiet ? 0 : 1;

/**
 * Run races.ts's own reconciliation and print it.
 *
 * catalogueTotals() is the file's runtime self-check — it exists so a bad edit
 * to the seat catalogue fails loudly rather than silently shipping the wrong
 * number of race pages. Nothing outside the app was calling it, so a catalogue
 * change could only be checked by opening a screen. This runs it directly.
 *
 * Transpiled with TypeScript's own compiler rather than a hand-rolled regex
 * strip: the first version of this file tried the latter, and quietly left
 * annotations on function parameters behind. A checker that cannot run is worse
 * than no checker, because it looks like one.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire('/home/elrio/hawkeye/native/');
const ts = require('typescript');

const SRC = '/home/elrio/hawkeye/native/src/lib/races.ts';
const out = ts.transpileModule(readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const dir = mkdtempSync(join(tmpdir(), 'catalogue-'));
const file = join(dir, 'races.mjs');
writeFileSync(file, out);

const { catalogueTotals } = await import('file://' + file);
const t = catalogueTotals();

const row = (label, value, ok) =>
  console.log(`${label.padEnd(22)}${String(value).padStart(5)}  ${ok === undefined ? '' : ok ? 'ok' : 'MISMATCH'}`);

row('presidential', t.presidential, t.presidential === 1);
row('governorships', t.governorships, t.governorships === 36);
row('senatorial', t.senatorial, t.senatorial === 109);
row('federal', t.federal, t.federal === 360);
row('state assembly', t.assembly);
row('  located', t.assemblyLocated);
row('  with centroid', t.assemblyWithCentroid);
row('  unresolved lgas', t.assemblyUnresolved);
row('  no location entry', t.assemblyWithoutLocation);
console.log('');
console.log('catalogue ok:', t.ok);
process.exit(t.ok ? 0 : 1);

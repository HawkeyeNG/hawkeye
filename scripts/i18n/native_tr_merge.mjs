/**
 * Fold a translation batch — { key: { ha, ig, yo } } — into the three native
 * translation modules (native_tr.mjs, native_tr_ig.mjs, native_tr_yo.mjs),
 * which are what native_bundles.mjs builds the `n.*` bundles from. Writing keys
 * straight into native/src/lib/i18n/*.json is futile: the next build drops
 * anything not produced from these sources.
 *
 * ADD-ONLY, and it refuses a batch that is not complete: keying and translating
 * must land together, or the builder refuses to write, every bundle goes stale,
 * and t() falls through to the raw key on screen.
 *
 *   node scripts/i18n/native_tr_merge.mjs tmp/native_tr_batch*.json
 *   node scripts/i18n/native_tr_merge.mjs --check tmp/…      # verify, write nothing
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const CAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/i18n/native_catalogue.json'), 'utf8'));
const FILES = { ha: 'native_tr.mjs', ig: 'native_tr_ig.mjs', yo: 'native_tr_yo.mjs' };
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const batches = args.filter((a) => !a.startsWith('--'));

const incoming = {};
for (const f of batches) {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f.startsWith('/') ? f : path.join(ROOT, f), 'utf8')))) {
    if (incoming[k]) { console.log(`DUPLICATE across batches: ${k}`); process.exit(1); }
    incoming[k] = v;
  }
}

let bad = 0;
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const [k, v] of Object.entries(incoming)) {
  if (!(k in CAT)) { console.log(`NOT IN CATALOGUE: ${k}`); bad++; continue; }
  for (const lang of Object.keys(FILES)) {
    const t = v[lang];
    if (typeof t !== 'string' || !t.trim()) { console.log(`MISSING ${lang}: ${k}`); bad++; }
    else if (t.trim() === CAT[k].trim()) { console.log(`UNTRANSLATED ${lang}: ${k}`); bad++; }
    else if (ph(t) !== ph(CAT[k])) { console.log(`PLACEHOLDERS ${lang}: ${k} (en has {${ph(CAT[k])}})`); bad++; }
  }
}
if (bad) { console.log(`\n${bad} problem(s) — nothing written`); process.exit(1); }

for (const [lang, file] of Object.entries(FILES)) {
  const p = path.join(ROOT, 'scripts/i18n', file);
  const mod = (await import(p)).default;
  // The three files do not share a shape: native_tr.mjs nests its table under
  // `ha`, the other two are flat. Write back whichever shape was found.
  const nested = !!mod[lang] && typeof mod[lang] === 'object';
  const table = nested ? mod[lang] : mod;
  let added = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (table[k] !== undefined && table[k] !== v[lang]) { console.log(`CONFLICT ${lang} ${k}`); process.exit(1); }
    if (table[k] === undefined) { table[k] = v[lang]; added++; }
  }
  const sorted = Object.fromEntries(Object.entries(table).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const rows = (pad) => Object.entries(sorted).map(([k, v]) => `${pad}${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n');
  const out = nested
    ? `export default {\n  ${lang}: {\n${rows('    ')}\n  },\n};\n`
    : `export default {\n${rows('  ')}\n};\n`;
  if (!CHECK) fs.writeFileSync(p, out);
  console.log(`${file}: +${added} (${Object.keys(sorted).length} total, ${nested ? 'nested' : 'flat'})${CHECK ? '  [check only]' : ''}`);
}

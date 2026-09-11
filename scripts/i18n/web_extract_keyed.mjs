/**
 * TURN A PAGE'S `T('key', 'English')` CALLS INTO A CATALOGUE BATCH.
 *
 * The template keyer rewrites source and keeps the English as the fallback
 * argument; the catalogue and en.json still have to learn those strings, or the
 * bundles never carry them and every language falls back to English — silently,
 * because a fallback IS the English. This reads the call sites (the same
 * discipline as web_keys_resolve.mjs) so the batch cannot drift from the code:
 * hand-written catalogue entries are where a typo becomes an untranslated
 * string nobody notices.
 *
 * Writes { key: English } to the given path, ready for add_catalogue.mjs.
 *
 *   node scripts/i18n/web_extract_keyed.mjs situation-room.html scripts/i18n/batches/room_catalogue.json
 */
import fs from 'node:fs';

const APP = '/home/elrio/hawkeye/app';
const [page, outPath] = process.argv.slice(2);
if (!page || !outPath) { console.log('usage: web_extract_keyed.mjs <page.html> <out.json>'); process.exit(1); }

const src = fs.readFileSync(`${APP}/${page}`, 'utf8');
const out = {};
let dup = 0;
// T('key', 'English') — the two arguments may sit on separate lines, and the
// English may carry escaped quotes.
for (const m of src.matchAll(/\bT\(\s*'([a-z0-9][a-z0-9.-]+)',\s*'((?:[^'\\]|\\.)*)'/g)) {
  const key = m[1];
  // \n and \t are REAL characters at runtime — a prompt's blank line is two of
  // them. Leaving them as backslash-n put the literal characters in the
  // catalogue, so en.json no longer matched what the code renders and every
  // translation would have carried the wrong thing.
  const en = m[2]
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
  if (out[key] !== undefined && out[key] !== en) {
    console.log(`CONFLICT ${key}:\n  ${JSON.stringify(out[key])}\n  ${JSON.stringify(en)}`);
    dup++;
  }
  out[key] = en;
}
if (dup) { console.log(`\n${dup} key(s) used with two different English strings — nothing written`); process.exit(1); }
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
fs.writeFileSync(outPath.startsWith('/') ? outPath : `/home/elrio/hawkeye/${outPath}`, JSON.stringify(sorted, null, 2) + '\n');
console.log(`${Object.keys(sorted).length} keyed strings -> ${outPath}`);

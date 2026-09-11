/**
 * Add hand-keyed strings (text a SCRIPT paints, which the markup extractor
 * cannot see) to en.json AND catalogue.json. ADD-ONLY on both.
 *
 * DO NOT RUN `i18n_check.mjs --build-en`. It rebuilds en.json from the
 * catalogue alone, and en.json holds ~340 live keys that never went through the
 * catalogue (nav.*, race.*, index.*, time.*, …) — a rebuild on 2026-09-11
 * dropped every one of them, and each would have fallen back to English in all
 * three languages. Caught by diffing the key sets before and after; nothing
 * shipped. This script is the safe path: it only ever adds.
 *
 * Refuses to overwrite a key with a different English value — that would change
 * what every translation is a translation OF.
 *
 *   node scripts/i18n/add_catalogue.mjs scripts/i18n/batches/<batch>.json
 */
import fs from 'node:fs';
const P = '/home/elrio/hawkeye/scripts/i18n/catalogue.json';
const E = '/home/elrio/hawkeye/app/i18n/en.json';
const add = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [path, label] of [[P, 'catalogue.json'], [E, 'en.json']]) {
  const obj = JSON.parse(fs.readFileSync(path, 'utf8'));
  let n = 0;
  for (const [k, v] of Object.entries(add)) {
    if (obj[k] !== undefined && obj[k] !== v) { console.log(`CONFLICT ${label} ${k}: has ${JSON.stringify(obj[k])}`); process.exit(1); }
    if (obj[k] === undefined) { obj[k] = v; n++; }
  }
  // The catalogue is kept sorted; en.json keeps its order, new keys at the end.
  const out = label === 'catalogue.json'
    ? Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : obj;
  fs.writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`${label} +${n} (${Object.keys(out).length} total)`);
}

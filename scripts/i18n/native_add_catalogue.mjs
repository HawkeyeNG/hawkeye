/**
 * Add keys to scripts/i18n/native_catalogue.json — ADD-ONLY, sorted.
 *
 * The native twin of add_catalogue.mjs, and it exists because of a real loss:
 * the join screen's 14 `n.app.join.*` keys had been written STRAIGHT INTO
 * native/src/lib/i18n/*.json, which are GENERATED. The next
 * `native_bundles.mjs` run rebuilt them from the catalogue and dropped all 14 —
 * and native's t() returns the KEY when it falls off the end, so that screen
 * would have shown `N.APP.JOIN.SIGN-IN` to an observer. Caught by
 * native_keys_resolve.mjs, which reads the call sites.
 *
 * Anything the code calls belongs HERE plus the three native_tr*.mjs files.
 *
 *   node scripts/i18n/native_add_catalogue.mjs tmp/<batch>.json
 */
import fs from 'node:fs';
const P = '/home/elrio/hawkeye/scripts/i18n/native_catalogue.json';
const cat = JSON.parse(fs.readFileSync(P, 'utf8'));
const add = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let n = 0;
for (const [k, v] of Object.entries(add)) {
  if (cat[k] !== undefined && cat[k] !== v) { console.log(`CONFLICT ${k}: catalogue has ${JSON.stringify(cat[k])}`); process.exit(1); }
  if (cat[k] === undefined) { cat[k] = v; n++; }
}
const sorted = Object.fromEntries(Object.entries(cat).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
fs.writeFileSync(P, JSON.stringify(sorted, null, 2) + '\n');
console.log(`native_catalogue.json +${n} (${Object.keys(sorted).length} total)`);

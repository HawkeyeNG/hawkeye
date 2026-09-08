/**
 * Build native/src/lib/content-i18n.ts from the two translation batches.
 *
 * CHECKS, all of which must pass before anything is written:
 *  - every English string extract_native_content.mjs found has a translation in
 *    ha, ig and yo (except the deliberate SAME_OK list),
 *  - no translation is byte-identical to its English unless it is on that list,
 *  - no translation is empty,
 *  - the batches carry nothing the extractor did not find, which is how a stale
 *    translation for copy that has since been reworded gets caught instead of
 *    silently shipping alongside the new English.
 *
 *   node scripts/i18n/build_native_content_i18n.mjs
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const EN = JSON.parse(fs.readFileSync(`${ROOT}/tmp/native_content_en.json`, 'utf8'));
const batches = ['tmp/content_tr_a.json', 'tmp/content_tr_b.json']
  .map((f) => JSON.parse(fs.readFileSync(`${ROOT}/${f}`, 'utf8')));

const TR = {};
for (const b of batches) {
  for (const [k, v] of Object.entries(b)) {
    if (TR[k]) { console.log(`DUPLICATE across batches: ${JSON.stringify(k.slice(0, 60))}`); process.exit(1); }
    TR[k] = v;
  }
}

/** Identical in every language on purpose. */
const SAME_OK = new Set(['Telegram']);

let bad = 0;
const english = Object.keys(EN);
for (const s of english) {
  const t = TR[s];
  if (!t) { console.log(`UNTRANSLATED: ${JSON.stringify(s.slice(0, 76))}`); bad++; continue; }
  for (const l of ['ha', 'ig', 'yo']) {
    if (typeof t[l] !== 'string' || !t[l].trim()) { console.log(`MISSING ${l}: ${JSON.stringify(s.slice(0, 60))}`); bad++; continue; }
    if (t[l] === s && !SAME_OK.has(s)) { console.log(`SAME AS ENGLISH ${l}: ${JSON.stringify(s.slice(0, 60))}`); bad++; }
  }
}
const stale = Object.keys(TR).filter((k) => !(k in EN));
for (const s of stale) console.log(`STALE (no longer in content.ts): ${JSON.stringify(s.slice(0, 76))}`);
bad += stale.length;

console.log(`\n${english.length} strings, ${bad} problems`);
if (bad) { console.log('nothing written.'); process.exit(1); }

const out = { ha: {}, ig: {}, yo: {} };
for (const s of english) for (const l of ['ha', 'ig', 'yo']) out[l][s] = TR[s][l];

const body = `/**
 * Translations for the explainer content in lib/content.ts.
 *
 * GENERATED — do not edit. Source: tmp/content_tr_{a,b}.json, built by
 * scripts/i18n/build_native_content_i18n.mjs.
 *
 * KEYED BY THE ENGLISH STRING. content.ts is a nested typed content tree with
 * ${english.length} prose strings buried at every depth; threading a key beside each of
 * them would mean touching every line of a file whose whole value is that it
 * reads as prose. This corpus is closed and authored in one voice, so "the same
 * sentence gets the same translation" is the right outcome rather than a
 * collision — see the note in scripts/i18n/extract_native_content.mjs.
 *
 * A string with no entry here falls through as English, which is what the
 * privacy page wants (it is English by policy) and is also the safe degradation
 * for anything reworded in content.ts before this file was rebuilt.
 */
export const CONTENT_I18N: Record<string, Record<string, string>> = ${JSON.stringify(out, null, 2)};
`;
fs.writeFileSync(`${ROOT}/native/src/lib/content-i18n.ts`, body);
console.log(`wrote native/src/lib/content-i18n.ts (${english.length} strings x 3 languages)`);

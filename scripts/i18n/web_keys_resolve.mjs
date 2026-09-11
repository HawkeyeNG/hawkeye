/**
 * Every key a page USES — T('key', …), a key passed as a literal to a helper,
 * or data-i18n(-html)="key" — must exist in en.json and be translated in ha, ig
 * and yo (unless englishOnly), with the same {placeholders} as the English.
 * The web twin of native_keys_resolve.mjs: it reads the CALL SITES, so a key
 * nobody added to the bundles fails here instead of rendering English quietly.
 *
 *   node scripts/i18n/web_keys_resolve.mjs join.html my-groups.html
 */
import fs from 'node:fs';
const DIR = '/home/elrio/hawkeye/app';
const B = Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(fs.readFileSync(`${DIR}/i18n/${l}.json`, 'utf8'))]));
const eo = new Set((B.en._meta && B.en._meta.englishOnly) || []);
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
let bad = 0, n = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(`${DIR}/${f}`, 'utf8');
  const keys = new Set([
    ...[...src.matchAll(/'([a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)'/g)].map((m) => m[1]).filter((k) => !/\.(html|js|json|png|svg|css)$/.test(k)),
    ...[...src.matchAll(/data-i18n(?:-html)?="([\w.-]+)"/g)].map((m) => m[1]),
  ]);
  for (const k of keys) {
    n++;
    if (!(k in B.en)) { console.log(`NOT IN en   ${f}  ${k}`); bad++; continue; }
    if (eo.has(k)) continue;
    for (const l of ['ha', 'ig', 'yo']) {
      const v = B[l][k];
      if (typeof v !== 'string' || !v.trim()) { console.log(`MISSING ${l}  ${k}`); bad++; }
      else if (v === B.en[k]) { console.log(`UNTRANSLATED ${l}  ${k}`); bad++; }
      else if (ph(v) !== ph(B.en[k])) { console.log(`PLACEHOLDERS ${l}  ${k}`); bad++; }
    }
  }
}
console.log(`${n} keys checked, ${bad} problems`);
process.exit(bad ? 1 : 0);

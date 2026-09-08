/**
 * THE NATIVE APP'S OWN COVERAGE — asserted against the bundles the app ships,
 * not against the source that references them.
 *
 * The native gap was never missing translations: the bundles were 100% complete
 * the whole time. It was WIRING. more.tsx rendered `{it.label}` — the raw English
 * out of a module-level constant — while `profile.my-profile` sat in its own
 * bundle, translated. tour.ts, flags.ts and integrity.tsx did the same. Every
 * source-reading check passed, because the strings were all present; nothing
 * asked whether anything USED them.
 *
 * So this test reads the constants the app actually renders from, resolves each
 * key through the shipped bundle exactly as t() would, and requires the result to
 * differ from English. It is the native counterpart of
 * scripts/i18n/rendered_gaps.mjs.
 *
 * WHY NOT RENDER THE APP. React Native has no headless DOM to read, and standing
 * up a device emulator per CI run to read four labels is not a trade worth making.
 * The two things that can actually break — a key that resolves to nothing, and a
 * label rendered without going through a key at all — are both visible from here:
 * the first by resolving it, the second by parsing the constant and requiring
 * every entry to carry one.
 */
import fs from 'node:fs';

const NATIVE = '/home/elrio/hawkeye/native/src';
const I18N = `${NATIVE}/lib/i18n`;

const B = {};
for (const l of ['en', 'ha', 'ig', 'yo']) B[l] = JSON.parse(fs.readFileSync(`${I18N}/${l}.json`, 'utf8'));

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

/** Exactly what lib/i18n.tsx's translate() does for a key with no params. */
const resolve = (lang, key) => (B[lang][key] ?? B.en[key] ?? key);

/** Identical in every language on purpose — product names, handles, a year. */
const SAME_OK = new Set(['n.app.osun.osun-2026', 'n.app.tabs.more.inixien-llc', 'common.menu',
  'n.components.gov-disclaimer.inecnigeria-org', 'n.components.gov-disclaimer.inecelectionresults-ng']);

function keysResolve(label, keys) {
  const missing = keys.filter((k) => !(k in B.en));
  check(`${label}: every key is in the bundle`, missing.length === 0, missing);
  const untranslated = keys.filter((k) => !SAME_OK.has(k) && !missing.includes(k)
    && ['ha', 'ig', 'yo'].some((l) => resolve(l, k) === B.en[k]));
  check(`${label}: every key is translated in ha/ig/yo`, untranslated.length === 0, untranslated);
  const asKey = keys.filter((k) => resolve('ha', k) === k);
  check(`${label}: nothing resolves to the raw key (which is what a reader would SEE)`, asKey.length === 0, asKey);
}

console.log('=== the More menu — GROUPS, the constant that rendered raw English ===');
{
  const whole = fs.readFileSync(`${NATIVE}/app/(tabs)/more.tsx`, 'utf8');
  /* SCOPED TO GROUPS. THEME_OPTIONS in the same file also carries labelKey
     entries, and counting both compared 23 labels against 26 keys — a check that
     reads as a failure while nothing is wrong, which is exactly as useless as one
     that reads as a pass while something is. */
  const g0 = whole.indexOf('const GROUPS');
  const src = whole.slice(g0, whole.indexOf('\n];', g0));
  const labels = [...src.matchAll(/\{\s*label:\s*'([^']+)'/g)].map((m) => m[1]);
  const labelKeys = [...src.matchAll(/labelKey:\s*'([^']+)'/g)].map((m) => m[1]);
  const titleKeys = [...src.matchAll(/titleKey:\s*'([^']+)'/g)].map((m) => m[1]);
  const accKeys = [...src.matchAll(/accKey:\s*'([^']+)'/g)].map((m) => m[1]);

  check('the GROUPS block was actually found', g0 > 0 && labels.length > 0, { at: g0, labels: labels.length });
  check('the menu still has its rows', labels.length >= 20, labels.length);
  check('EVERY row carries a key', labelKeys.length === labels.length, { labels: labels.length, keys: labelKeys.length });
  check('every group heading carries a key', titleKeys.length >= 4, titleKeys);
  check('the Report accordion carries a key', accKeys.length === 1, accKeys);
  check('the rows RENDER through the key, not the label',
    whole.includes('{i18nT(it.labelKey)}') && !/>\{it\.label\}</.test(whole),
    whole.match(/\{it\.label[^}]*\}/g));

  /* Every LITERAL key this screen resolves, not only the ones in GROUPS. Four
     keys added to this file earlier — Preferences, System, Language and the
     draft-translation note — were never added to native_catalogue.json, so the
     generator dropped them and the screen rendered "n.app.tabs.more.preferences"
     as a heading. Nothing looked at the literal call sites until this line. */
  const literals = [...new Set([...whole.matchAll(/i18nT\('([^']+)'\)/g)].map((m) => m[1]))];
  check('the screen resolves literal keys too', literals.length >= 5, literals.length);
  keysResolve('More menu', [...labelKeys, ...titleKeys, ...accKeys, ...literals]);
}

console.log('\n=== the first-run tour — five cards, all hardcoded before this ===');
{
  const src = fs.readFileSync(`${NATIVE}/lib/tour.ts`, 'utf8');
  const titleKeys = [...src.matchAll(/titleKey:\s*'([^']+)'/g)].map((m) => m[1]);
  const bodyKeys = [...src.matchAll(/bodyKey:\s*'([^']+)'/g)].map((m) => m[1]);
  check('all five cards carry a title key', titleKeys.length === 5, titleKeys);
  check('all five cards carry a body key', bodyKeys.length === 5, bodyKeys);
  const ui = fs.readFileSync(`${NATIVE}/components/tour.tsx`, 'utf8');
  check('the card RENDERS through the keys',
    ui.includes('{i18nT(step.titleKey)}') && ui.includes('{i18nT(step.bodyKey)}'),
    [ui.includes('{step.title}'), ui.includes('{step.body}')]);
  keysResolve('tour', [...titleKeys, ...bodyKeys]);
}

console.log('\n=== integrity flag card titles ===');
{
  const src = fs.readFileSync(`${NATIVE}/lib/flags.ts`, 'utf8');
  const english = [...src.matchAll(/^\s{2}(\w+):\s*'([^']+)',$/gm)].map((m) => m[1]);
  const keyed = [...src.matchAll(/^\s{2}(\w+):\s*'(n\.flags\.[^']+)',$/gm)].map((m) => m[2]);
  check('flagLabel resolves through a key map', src.includes('const k = FLAG_KEY[type];') && src.includes('return t(k);'));
  check('every flag type has a key', keyed.length >= 12, { english: english.length, keyed: keyed.length });
  keysResolve('flag titles', keyed);
}

console.log('\n=== the "What We Check" checklist ===');
{
  const src = fs.readFileSync(`${NATIVE}/app/integrity.tsx`, 'utf8');
  const rows = [...src.matchAll(/\[\s*'([^']+)',\s*(?:"[^"]*"|'[^']*'),\s*'([^']+)',\s*'([^']+)'\s*\]/g)];
  check('every checklist row carries a label key and a description key', rows.length >= 17, rows.length);
  check('the row RENDERS through the keys',
    src.includes('{i18nT(nameKey)}') && src.includes('{i18nT(whatKey)}'),
    src.match(/\{name\}|\{what\}/g));
  keysResolve('checklist', rows.flatMap((m) => [m[2], m[3]]));
}

/**
 * CONTROL. Two planted defects — a key that is not in the bundle, and one whose
 * Hausa is still the English — must both be reported. Without this, a bundle that
 * silently failed to load would make every check above pass trivially.
 */
console.log('\n=== CONTROL: the resolver must reject a bad key and an untranslated one ===');
{
  const before = failed;
  B.en['zz.control.missing'] = undefined;
  delete B.en['zz.control.missing'];
  B.en['zz.control.same'] = 'Control string';
  for (const l of ['ha', 'ig', 'yo']) B[l]['zz.control.same'] = 'Control string';
  keysResolve('CONTROL (expected to fail)', ['zz.control.missing', 'zz.control.same']);
  const caught = failed - before;
  // 3 = missing-from-bundle, untranslated, and resolves-to-the-raw-key.
  console.log(`${caught === 3 ? 'PASS' : 'FAIL'}  CONTROL both planted defects were reported (${caught} findings)`);
  if (caught !== 3) failed++;
  failed = before;   // the planted failures are not real ones
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

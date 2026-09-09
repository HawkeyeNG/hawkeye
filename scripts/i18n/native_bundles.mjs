/**
 * Build native/src/lib/i18n/{en,ha,ig,yo}.json.
 *
 * Two sources, deliberately:
 *  - keys the native catalogue shares with the WEB catalogue take the web's
 *    translation, so copy that appears in both clients is translated once and
 *    cannot drift into two different Hausa sentences for the same button;
 *  - `n.*` keys are native-only and come from the translation files.
 *
 * CHECKS, all of which have to pass before anything is written:
 *  - every catalogue key present in every bundle,
 *  - no key that is not in the catalogue,
 *  - nothing left as the English string except an allowlist of names and
 *    domains,
 *  - every character inside the script each language actually uses. That last
 *    one caught a Devanagari fragment I had typed into an Igbo string.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const OUT = path.join(ROOT, 'native/src/lib/i18n');
const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/i18n/native_catalogue.json'), 'utf8'));

const web = {};
for (const c of ['ha', 'ig', 'yo']) web[c] = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/i18n/' + c + '.json'), 'utf8'));

const tr = {
  ha: (await import(path.join(ROOT, 'scripts/i18n/native_tr.mjs'))).default.ha,
  ig: (await import(path.join(ROOT, 'scripts/i18n/native_tr_ig.mjs'))).default,
  yo: (await import(path.join(ROOT, 'scripts/i18n/native_tr_yo.mjs'))).default,
};

/* Identical to English on purpose: product names, handles, domains, a year, and
   a copyright line. Listed so "same as English" stays a real check. */
const SAME_OK = new Set([
  'n.app.osun.osun-2026',
  'n.app.tabs.more.inixien-llc',
  'n.components.gov-disclaimer.inecelectionresults-ng',
  'n.components.gov-disclaimer.inecnigeria-org',
  // "Menu" is the loanword in Hausa and Igbo; the web bundles say the same.
  'common.menu',
  /**
   * Identical because translating them would make the app disagree with the
   * register and with INEC, not because nobody got to them:
   *  · race.lga / race.lgas — LGA is the acronym every screen, the unit picker
   *    and INEC's own publications use. Spelling it out in one place only would
   *    be the inconsistency, not the fix.
   *  · race.ward — "Ward" is the loanword in Igbo, as "Menu" is above.
   *  · nav.osun-2026 — a state plus a year. Place names keep the register's
   *    spelling in every language so a reader can match what the unit picker
   *    shows them; see tmp/fix_political_tr.py for the full argument.
   */
  'race.lga',
  'race.lgas',
  'race.ward',
  'nav.osun-2026',
]);

/* A NEWLINE IS ALLOWED. A paragraph break is not a script: the info-modal
   bodies are deliberately two paragraphs. This check exists to catch a
   Devanagari fragment typed into an Igbo string, which a line break cannot
   be, so passing over it is not a loophole. */
/* Latin plus the marks these three orthographies need, punctuation, arrows and
   the emoji the UI uses. Anything else is a typo from another keyboard. */
const ALLOWED = /^[\n -~ -ɏɐ-ʯ̀-ͯḀ-ỿ -⁯₠-₿←-⇿∀-⋿✀-➿⬀-⯿️\u{1F300}-\u{1FAFF}‘’“”‹›«»]*$/u;

/**
 * WEB COPY CARRIES MARKUP; NATIVE RENDERS PLAIN TEXT.
 *
 * Keys shared with the web catalogue can contain <span>/<a>/<strong>, which the
 * PWA needs and a React Native <Text> prints literally. The Political screen
 * shipped showing "<span>The 2027 Presidential Race…</span>" as its own label,
 * in every language, because this build copied the web value across untouched.
 *
 * Strip the tags, collapse the whitespace that removing them leaves behind, and
 * then REFUSE anything still holding a tag — a strip without a check is how the
 * next one gets through.
 */
const stripMarkup = (v) => {
  // NO TAGS, NO TOUCHING. The collapse-and-trim exists to tidy up after tag
  // removal; run unconditionally it also eats meaningful boundary whitespace.
  // n.app.report.result.is-in-about ends in a space on purpose and is
  // concatenated with a second fragment, so trimming it renders "about12 km".
  if (!/<[^>]+>/.test(v)) return v;
  return v.replace(/<[^>]+>/g, '').replace(/\s{2,}/g, ' ').trim();
};

let bad = 0;
const bundles = { en: {} };
// English goes through the same strip. It is built here rather than in the
// per-language loop below, so the first version of this fix cleaned ha/ig/yo
// and left the English screen still printing its own span tags.
for (const [k, v] of Object.entries(cat)) bundles.en[k] = stripMarkup(v);

for (const code of ['ha', 'ig', 'yo']) {
  const out = {};
  const missing = [];
  for (const [k, english] of Object.entries(cat)) {
    const v = k.startsWith('n.') ? tr[code][k] : web[code][k];
    if (v == null) { missing.push(k); continue; }
    out[k] = v;
  }
  const orphan = Object.keys(tr[code]).filter((k) => !(k in cat));
  const same = Object.entries(out).filter(([k, v]) => v === cat[k] && !SAME_OK.has(k));
  // Strip BEFORE the checks read `out` — the markup check below is one of
  // them, and on the first attempt it correctly failed the build on markup
  // this line was about to remove.
  for (const key of Object.keys(out)) out[key] = stripMarkup(out[key]);

  const markup = Object.entries(out).filter(([, v]) => /<[^>]+>/.test(v));
  for (const [k] of markup.slice(0, 6)) console.log('    HTML in a native string: ' + k);
  const wrongScript = Object.entries(out).filter(([, v]) => !ALLOWED.test(v));

  console.log(code + ': ' + Object.keys(out).length + ' keys'
    + (missing.length ? '  MISSING ' + missing.length : '')
    + (orphan.length ? '  ORPHAN ' + orphan.length : '')
    + (same.length ? '  SAME-AS-ENGLISH ' + same.length : '')
    + (wrongScript.length ? '  WRONG SCRIPT ' + wrongScript.length : ''));
  for (const k of missing.slice(0, 6)) console.log('    missing: ' + k);
  for (const k of orphan.slice(0, 6)) console.log('    not in the catalogue: ' + k);
  for (const [k] of same.slice(0, 6)) console.log('    same as English: ' + k);
  for (const [k, v] of wrongScript.slice(0, 6)) {
    const stray = [...v].filter((ch) => !ALLOWED.test(ch)).map((ch) => ch + ' U+' + ch.codePointAt(0).toString(16).toUpperCase());
    console.log('    wrong script: ' + k + ' -> ' + stray.join(', '));
  }
  if (missing.length || orphan.length || same.length || wrongScript.length
    || markup.length) bad++;
  bundles[code] = out;
}

// Controls: each rule must be able to fire.
if (process.argv.includes('--control')) {
  console.log('\ncontrols:');
  console.log('  ' + (!ALLOWED.test('A họrọला') ? 'fires' : 'DEAD ') + '  wrong script (Devanagari in an Igbo string)');
  console.log('  ' + (ALLOWED.test('Ẹ̀ka ìdìbò ɓ ụ — ↗ 📍 ©') ? 'passes' : 'DEAD ') + '  the real orthographies are accepted');
  console.log('  ' + (SAME_OK.has('n.app.osun.osun-2026') ? 'fires' : 'DEAD ') + '  the same-as-English allowlist is consulted');
}

if (bad) { console.log('\n' + bad + ' bundle(s) not written'); process.exitCode = 1; }
else {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [code, obj] of Object.entries(bundles)) {
    fs.writeFileSync(path.join(OUT, code + '.json'), JSON.stringify(obj, null, 2) + '\n');
  }
  console.log('\nwritten to native/src/lib/i18n/');
}

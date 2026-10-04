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
 *
 *   node scripts/i18n/native_bundles.mjs            # check, then write
 *   node scripts/i18n/native_bundles.mjs --check    # check, then DIFF against the
 *                                                   # bundles on disk; writes nothing
 *   node scripts/i18n/native_bundles.mjs --control  # prove each rule can fire
 *
 * WHY --check EXISTS (2026-09-29). Forty keys had been written straight into the
 * built bundles and never into the catalogue or native_tr*.mjs. This script then
 * refused to write — correctly, since a write would have DELETED all forty and
 * t() would have rendered their raw keys — but the only way to see that was to
 * run it and hope. --check says, per bundle, what a write would add, remove or
 * change, and exits non-zero unless the bundles on disk already match the
 * sources. Run it before a write; a write should never remove a key.
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
  'observe.sms', // "SMS" in every language (the sign-up route chip; web exempts it too)
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
  // "{v0}–{v1} WAT" — two clock times and the time-zone abbreviation, an
  // identifier like LGA above, not a word to translate.
  'n.components.practice-day-card.window',
]);

/* A FORMAT PATTERN IS NOT PROSE. n.lib.dates.day-month is "{v0} {v1}" —
   placeholders and punctuation, no word of its own: the words arrive through
   the placeholders (month and weekday names are keys of their own), so every
   language carries the same pattern. "Same as English" says nothing about such
   a key, and listing each one here would hide the rule behind five names. A
   single letter outside a placeholder makes it prose again, and checked. */
const isPattern =(s) => !/\p{L}/u.test(String(s).replace(/\{\w+\}/g, ''));

/* A NEWLINE IS ALLOWED. A paragraph break is not a script: the info-modal
   bodies are deliberately two paragraphs. This check exists to catch a
   Devanagari fragment typed into an Igbo string, which a line break cannot
   be, so passing over it is not a loophole. */
/* Latin plus the marks these three orthographies need, punctuation, arrows and
   the emoji the UI uses. Anything else is a typo from another keyboard.
   ʼ (U+02BC, the modifier-letter apostrophe) is Hausa orthography — the
   glottal stop in "Jummaʼa" and ʼy — and sits just past the IPA block. */
const ALLOWED = /^[\n -~ -ɏɐ-ʯʼ̀-ͯḀ-ỿ -⁯₠-₿←-⇿∀-⋿✀-➿⬀-⯿️\u{1F300}-\u{1FAFF}‘’“”‹›«»]*$/u;

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
  const same = Object.entries(out).filter(([k, v]) => v === cat[k] && !SAME_OK.has(k) && !isPattern(cat[k]));
  // Strip BEFORE the checks read `out` — the markup check below is one of
  // them, and on the first attempt it correctly failed the build on markup
  // this line was about to remove.
  for (const key of Object.keys(out)) out[key] = stripMarkup(out[key]);

  const markup = Object.entries(out).filter(([, v]) => /<[^>]+>/.test(v));
  for (const [k] of markup.slice(0, 6)) console.log('    HTML in a native string: ' + k);
  // ALLOWED, PLUS WHAT THE ENGLISH FOR THIS KEY ALREADY USES.
  //
  // The class rejected the warning sign and the dotted circle, both of which
  // are in the English source and correctly preserved. Widening the class by
  // guesswork means guessing again next time. This check is for a wrong WRITING
  // SYSTEM — Devanagari in an Igbo string — and a character the English itself
  // uses for this key cannot be that. Self-limiting: it only ever admits what
  // the source already contains.
  const wrongScript = Object.entries(out).filter(([k, v]) => {
    if (ALLOWED.test(v)) return false;
    const src = bundles.en[k] ?? cat[k] ?? '';
    const extra = new Set([...src]);
    return [...v].some((ch) => !ALLOWED.test(ch) && !extra.has(ch));
  });

  console.log(code + ': ' + Object.keys(out).length + ' keys'
    + (missing.length ? '  MISSING ' + missing.length : '')
    + (orphan.length ? '  ORPHAN ' + orphan.length : '')
    + (same.length ? '  SAME-AS-ENGLISH ' + same.length : '')
    + (wrongScript.length ? '  WRONG SCRIPT ' + wrongScript.length : ''));
  for (const k of missing.slice(0, 6)) console.log('    missing: ' + k);
  for (const k of orphan.slice(0, 6)) console.log('    not in the catalogue: ' + k);
  for (const [k] of same.slice(0, 6)) console.log('    same as English: ' + k);
  for (const [k, v] of wrongScript.slice(0, 6)) {
    const src = bundles.en[k] ?? cat[k] ?? '';
    const extra = new Set([...src]);
    const stray = [...v].filter((ch) => !ALLOWED.test(ch) && !extra.has(ch)).map((ch) => ch + ' U+' + ch.codePointAt(0).toString(16).toUpperCase());
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
  console.log('  ' + (isPattern('{v0}, {v1} {v2}') && !isPattern('{v0} votes') && !isPattern('{v0} ọ̀kan')
    ? 'fires' : 'DEAD ') + '  a format pattern is exempt from same-as-English, prose around a placeholder is not');
}

/* --check: what a write WOULD do, per bundle, against the files on disk. A value
   change or a removal is the dangerous kind — a removed key renders as its raw
   name — so those are listed first and in full. Key order is reported apart:
   the bundles are written in catalogue order, and a hand-appended key sits out
   of order without being wrong. */
const CHECK = process.argv.includes('--check');
if (CHECK) {
  let drift = 0;
  let orderOnly = 0;
  console.log('\n--check against native/src/lib/i18n/ (nothing is written):');
  for (const [code, obj] of Object.entries(bundles)) {
    const p = path.join(OUT, code + '.json');
    const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    const added = Object.keys(obj).filter((k) => !(k in cur));
    const removed = Object.keys(cur).filter((k) => !(k in obj));
    const changed = Object.keys(obj).filter((k) => k in cur && cur[k] !== obj[k]);
    const sameOrder = JSON.stringify(Object.keys(cur)) === JSON.stringify(Object.keys(obj));
    console.log(`  ${code}: +${added.length} added  -${removed.length} REMOVED  ~${changed.length} CHANGED`
      + (added.length || removed.length || changed.length || sameOrder ? '' : '  (key order only)'));
    for (const k of removed) console.log(`      removed: ${k}`);
    for (const k of changed) console.log(`      changed: ${k}\n        disk:  ${JSON.stringify(cur[k])}\n        build: ${JSON.stringify(obj[k])}`);
    for (const k of added.slice(0, 40)) console.log(`      added:   ${k}`);
    if (added.length || removed.length || changed.length) drift++;
    else if (!sameOrder) orderOnly++;
  }
  console.log(drift ? `\n${drift} bundle(s) differ from the sources`
    : `\nbundles match the sources${orderOnly ? ` (${orderOnly} would be re-sorted into catalogue order; no value changes)` : ''}`);
  if (drift) process.exitCode = 1;
}

if (bad) { console.log('\n' + bad + ' bundle(s) not written'); process.exitCode = 1; }
else if (CHECK || process.argv.includes('--control')) { /* read-only modes */ }
else {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [code, obj] of Object.entries(bundles)) {
    fs.writeFileSync(path.join(OUT, code + '.json'), JSON.stringify(obj, null, 2) + '\n');
  }
  console.log('\nwritten to native/src/lib/i18n/');
}

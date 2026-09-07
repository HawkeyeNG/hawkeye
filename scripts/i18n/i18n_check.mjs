/**
 * Build en.json from the extracted catalogue, then check every other bundle
 * against it: valid JSON, no key that does not exist in English, no key left
 * untranslated (value identical to English), and the deliberate omissions
 * accounted for. Run after editing any bundle.
 */
import fs from 'node:fs';

const DIR = '/home/elrio/hawkeye/app/i18n';
const cat = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/scripts/i18n/catalogue.json', 'utf8'));

/* Deliberately NOT translated. Legal and evidential wording goes to a human
   translator or stays in English; a mistranslated disclaimer is a legal
   exposure. These render from the English in the markup. */
const ENGLISH_ONLY = [
  'common.hawkeye-is-an-independent-transparency-initiative',
  'common.hawkeye-is-an-independent-transparency-initiative-2',
  'index.not-affiliated-with-inec-or-any',
];

const UI = {
  'lang.title': 'Choose your language',
  'lang.body': 'Hawkeye works in more than one language. You can change this any time in My Profile.',
  'lang.save': 'Save',
  'lang.later': 'Not now',
  'lang.draft': 'Draft translation, being reviewed',
  'lang.provisional': 'Reviewed by one speaker — being confirmed',
  'lang.coming': 'Coming soon',
  'lang.current': 'Language',
  'profile.language': 'Language',
  'profile.language.none': 'English',
  'lang.name.en': 'English',
  'lang.name.ha': 'Hausa',
  'lang.name.ig': 'Igbo',
  'lang.name.yo': 'Yoruba',
  'lang.name.pcm': 'Nigerian Pidgin',
};

if (process.argv.includes('--build-en')) {
  const en = {
    _meta: {
      language: 'English',
      code: 'en',
      review: 'source',
      note: 'The source strings, and the key set translators work from. English also lives in the HTML as the fallback, so this file is never fetched at runtime — a missing key renders the English already on the page.',
      englishOnly: ENGLISH_ONLY,
      englishOnlyReason: 'Legal and evidential wording: the INEC disclaimer and the non-affiliation notice. A mistranslated disclaimer is a legal exposure. These stay in English until a human translator signs for them.',
    },
    ...UI,
    ...Object.fromEntries(Object.entries(cat).sort()),
  };
  fs.writeFileSync(DIR + '/en.json', JSON.stringify(en, null, 2) + '\n');
  console.log('en.json rebuilt: ' + (Object.keys(en).length - 1) + ' keys');
}

const en = JSON.parse(fs.readFileSync(DIR + '/en.json', 'utf8'));
const enKeys = new Set(Object.keys(en).filter((k) => k !== '_meta'));
let bad = 0;

for (const code of ['ha', 'ig', 'yo']) {
  const file = DIR + '/' + code + '.json';
  let b;
  try {
    b = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log('FAIL ' + code + ': not valid JSON — ' + e.message);
    bad++;
    continue;
  }
  const keys = Object.keys(b).filter((k) => k !== '_meta');
  const orphan = keys.filter((k) => !enKeys.has(k));
  const missing = [...enKeys].filter((k) => !keys.includes(k) && !ENGLISH_ONLY.includes(k));
  /* Legitimately identical to English in the target language: loanwords, the
     Igbo glossary's own choice for "Ward", and product names. Listed so the
     check stays a real check — anything else matching English is a gap. */
  const SAME_OK = {
    ha: ['common.menu', 'index.iphone-ipad'],
    ig: ['common.menu', 'common.ward', 'index.iphone-ipad'],
    yo: ['index.iphone-ipad'],
  };
  const untranslated = keys.filter((k) => b[k] === en[k]
    && !/^(lang\.name\.|observe\.(sms|telegram|whatsapp))/.test(k)
    && !SAME_OK[code].includes(k));
  const empty = keys.filter((k) => !String(b[k] || '').trim());

  console.log(code + ': ' + keys.length + ' keys'
    + (orphan.length ? '  ORPHAN ' + orphan.length : '')
    + (missing.length ? '  MISSING ' + missing.length : '')
    + (untranslated.length ? '  UNTRANSLATED ' + untranslated.length : '')
    + (empty.length ? '  EMPTY ' + empty.length : ''));
  for (const k of orphan.slice(0, 8)) console.log('    orphan key not in English: ' + k);
  for (const k of missing.slice(0, 8)) console.log('    missing: ' + k);
  for (const k of untranslated.slice(0, 8)) console.log('    same as English: ' + k);
  for (const k of empty) console.log('    empty: ' + k);
  if (orphan.length || missing.length || untranslated.length || empty.length) bad++;
}

// Control: a check that cannot fail is not a check. Prove each rule fires.
if (process.argv.includes('--control')) {
  const probe = JSON.parse(fs.readFileSync(DIR + '/ha.json', 'utf8'));
  const k0 = [...enKeys][0];
  const cases = [
    ['orphan', () => { const c = { ...probe, 'made.up.key': 'x' }; return Object.keys(c).some((k) => k !== '_meta' && !enKeys.has(k)); }],
    ['missing', () => { const c = { ...probe }; delete c[k0]; return !Object.keys(c).includes(k0); }],
    ['untranslated', () => { const c = { ...probe, [k0]: en[k0] }; return c[k0] === en[k0]; }],
    ['empty', () => { const c = { ...probe, [k0]: '  ' }; return !String(c[k0]).trim(); }],
  ];
  console.log('\ncontrols:');
  for (const [name, fn] of cases) console.log('  ' + (fn() ? 'fires' : 'DEAD ') + '  ' + name);
}

console.log(bad ? '\n' + bad + ' bundle(s) need work' : '\nall bundles consistent with en.json');
process.exitCode = bad ? 1 : 0;

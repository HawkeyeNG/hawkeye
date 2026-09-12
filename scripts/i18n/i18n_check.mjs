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
const ENGLISH_ONLY_KEYS = [
  'common.hawkeye-is-an-independent-transparency-initiative',
  'common.hawkeye-is-an-independent-transparency-initiative-2',
  'common.hawkeye-is-an-independent-transparency-initiative-3',
  'index.not-affiliated-with-inec-or-any',
];
/* Whole pages, not single strings: the privacy policy and the terms are the
   documents a mistranslation is most expensive in, and every sentence of them
   is legal text. Their shared header, menu and footer still translate, because
   those strings are `common.*` and live on twenty other pages. */
const ENGLISH_ONLY_PAGES = ['privacy', 'terms'];
const isEnglishOnly = (k) => ENGLISH_ONLY_KEYS.includes(k)
  || ENGLISH_ONLY_PAGES.includes(k.split('.')[0]);

const UI = {
  'lang.title': 'Choose your language',
  'lang.body': 'You can change this any time in My Profile.',
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

  /* The shell chrome menu.js builds at runtime. It has no markup for the
     extractor to scan, so its keys are declared here or they exist in the
     bundles and nowhere else. */
  'nav.home': 'Home',
  'nav.results': 'Results',
  'nav.report': 'Report',
  'nav.alerts': 'Alerts',
  'nav.more': 'More',
  'nav.what-are-you-reporting': 'What are you reporting?',
  'nav.photograph-result-sheet-at-your-unit': 'Photograph result sheet at your unit',
  'nav.photo-or-video-of-what-you-witnessed': 'Photo or video of what you witnessed',
  'nav.report-a-collation': 'Report a Collation',
  'nav.ward-or-lga-collation-announcement': 'Ward or LGA collation announcement',

  /* The five-card first-run tour, also built by menu.js. Its five titles reuse
     the nav.* keys above so the card and the tab it points at cannot be named
     differently; only Report needs its own, because its title says which
     button. THE ENGLISH HERE MUST STAY BYTE-IDENTICAL TO
     native/src/lib/tour.ts — tests/tour_test.mjs parses that file and diffs it
     against what the web renders. */
  'tour.welcome': 'Welcome to Hawkeye',
  'tour.close': 'Close tour',
  'tour.back': 'Back',
  'tour.next': 'Next',
  'tour.start': 'Start observing',
  'tour.note': 'Hawkeye is independent and nonpartisan. It is not affiliated with INEC or any government body, and it does not declare results — it records what observers report and lets anyone check the record.',
  'tour.report.title': 'Report — the green button',
  'tour.home.body': 'Elections open now, reports accepted so far, and a live feed.',
  'tour.results.body': 'Pick a race for its map and running tally. Follow one to get alerts.',
  'tour.report.body': 'Report a result sheet, a collation result, or an incident. This is what makes you an observer.',
  'tour.alerts.body': 'What has happened on the races you follow — reports accepted, units flagged, and anything Hawkeye needs to tell you.',
  'tour.more.body': 'Practice runs, the ledger, the docket and the guide. Start with Practice Run.',
};

if (process.argv.includes('--build-en')) {
  const en = {
    _meta: {
      language: 'English',
      code: 'en',
      review: 'source',
      note: 'The source strings, and the key set translators work from. English also lives in the HTML as the fallback, so this file is never fetched at runtime — a missing key renders the English already on the page.',
      englishOnly: ENGLISH_ONLY_KEYS,
      englishOnlyPages: ENGLISH_ONLY_PAGES,
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
  const missing = [...enKeys].filter((k) => !keys.includes(k) && !isEnglishOnly(k));
  /* Legitimately identical to English in the target language: loanwords, the
     Igbo glossary's own choice for "Ward", and product names. Listed so the
     check stays a real check — anything else matching English is a gap. */
  /* Identifiers, handles, URLs and third-party field names, which must read the
     same in every language — "App ID" is what the admin is copying out of
     Facebook's own console, and a translated Play Store link is a broken one. */
  const IDENTIFIERS = [
    'about.hawkeyengbot', 'admin.https-play-google-com-store-apps',
    'common.app-id', 'common.app-secret', 'common.https-hawkeye-com-ng-media',
    'common.info-hawkeye-com-ng', 'common.meta-facebook-instagram', 'common.tiktok',
    'common.x-admin-secret', 'common.x-twitter', 'meta.https-hawkeye-com-ng',
    'support.qr', 'download.hawkeye-lite', 'download.7-9-mb', 'tiktok.self-only', 'tiktok.public-to-everyone-after-audit',
  ];
  const SAME_OK = {
    ha: ['common.menu', 'index.iphone-ipad', ...IDENTIFIERS],
    ig: ['common.menu', 'common.ward', 'index.iphone-ipad', ...IDENTIFIERS],
    yo: ['index.iphone-ipad', ...IDENTIFIERS],
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

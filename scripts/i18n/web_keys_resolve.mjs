/**
 * Every key a page USES — T('key', …), a key passed as a literal to a helper,
 * or data-i18n(-html)="key" — must exist in en.json and be translated in ha, ig
 * and yo (unless englishOnly), with the same {placeholders} as the English.
 * The web twin of native_keys_resolve.mjs: it reads the CALL SITES, so a key
 * nobody added to the bundles fails here instead of rendering English quietly.
 *
 *   node scripts/i18n/web_keys_resolve.mjs join.html my-groups.html
 *   node scripts/i18n/web_keys_resolve.mjs --control   # prove each rule can fire
 */
import fs from 'node:fs';
const DIR = '/home/elrio/hawkeye/app';
const B = Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(fs.readFileSync(`${DIR}/i18n/${l}.json`, 'utf8'))]));
const eo = new Set((B.en._meta && B.en._meta.englishOnly) || []);

/**
 * LEGITIMATELY IDENTICAL TO ENGLISH. Without this list the untranslated-check
 * fires on a correct answer, and a check that cries wolf stops being read. Each
 * entry says WHY; an allowlist that grows is visible in review, a loosened rule
 * is not. Kept in step with native_bundles.mjs's own SAME_OK (the same keys,
 * the same reasons) and merge_translations.mjs's.
 */
const SAME_OK = new Set([
  // The GLOSSARY's loanword: Igbo for "Ward" is "Ward".
  'common.ward',
  'race.ward',
  'unit.ward.one',
  // LGA is the acronym every screen, the unit picker and INEC's own
  // publications use; spelling it out in one place only would be the
  // inconsistency, not the fix (native_bundles.mjs says the same).
  'race.lga',
  // BRAND AND PRODUCT NAMES — a name, with at most an emoji, a handle or a
  // size beside it and no translatable word around it. Translating "Telegram"
  // or "iPhone" would make the button disagree with the app it opens.
  'about.telegram-hawkeyengbot',   // "Telegram: @HawkEyeNGBot"
  'captain.admin.reach-telegram',  // "Telegram"
  'observe.telegram',              // "Telegram" — the sign-in channel chips
  'observe.whatsapp',              // "WhatsApp"
  'observe.sms',                   // "SMS" — the channel's own name on every Nigerian phone
  'common.tiktok',                 // "TikTok"
  'common.meta-facebook-instagram', // "Meta (Facebook + Instagram)"
  'common.x-twitter',              // "X (Twitter)"
  'index.android',                 // "📱 Android"
  'index.iphone-ipad',             // "🍎 iPhone & iPad"
  'download.android-35-mb',        // "Android 35 MB"
  'support.qr',                    // "QR" — the code's name, printed on the code
  'tiktok.self-only',              // "SELF_ONLY" — TikTok's API privacy value, shown as the API spells it
  // "{start}–{end} WAT": two clock times and the time-zone abbreviation, an
  // identifier like LGA above (native: n.components.practice-day-card.window).
  'practiceday.window',
]);

/**
 * A FORMAT PATTERN IS NOT PROSE — the same rule as native_bundles.mjs.
 * practiceday.date is "{weekday}, {day} {month}": placeholders and punctuation,
 * no word of its own. The words arrive through the placeholders (weekday and
 * month names are keys of their own), so every language carries the same
 * pattern and "same as English" says nothing about it. A single letter outside
 * a placeholder makes it prose again, and checked.
 */
const isPattern = (s) => !/\p{L}/u.test(String(s).replace(/\{\w+\}/g, ''));

/**
 * NOT KEYS, THOUGH THEY LOOK LIKE ONE. The literal scan below reads any quoted
 * 'word.word', so it also meets file names ('ec8a.jpg' and 'venue.jpg' are the
 * names the outbox gives a report's two photos), host names ('hawkeye.com.ng'),
 * CSS selectors ('g.badges', 'button.v') and dotted API names
 * ('performance.now'). Two filters, both narrow:
 *   1. a literal ending in a file extension is a file, never a key;
 *   2. a BARE literal (not the first argument of T()/t()/i18nT()) counts only
 *      when its first segment is a namespace en.json actually has — a selector's
 *      "g" or a host's "tiles" is not one. A key CALLED through T() is checked
 *      whatever its namespace, so a typo in a call site still fails.
 */
const FILE = /\.(html?|m?js|json|css|png|jpe?g|webp|gif|svg|pdf|txt|csv|pmtiles|mp4|webm)$/i;
const NAMESPACES = new Set(Object.keys(B.en).filter((k) => k !== '_meta').map((k) => k.split('.')[0]));
const KEYLIKE = /'([a-z][a-z0-9-]*\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)'/g;
const CALLED = /\b(?:T|t|i18nT)\(\s*'([a-z][a-z0-9-]*\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)'/g;

function keysOf(src) {
  const called = new Set([...src.matchAll(CALLED)].map((m) => m[1]));
  return new Set([
    // A key's first segment starts with a LETTER: without that, the literal
    // '0.0' in a stylesheet value read as a key and was reported missing.
    ...[...src.matchAll(KEYLIKE)].map((m) => m[1])
      .filter((k) => !FILE.test(k) && (called.has(k) || NAMESPACES.has(k.split('.')[0]))),
    ...[...src.matchAll(/data-i18n(?:-html)?="([\w.-]+)"/g)].map((m) => m[1]),
  ]);
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
/** The problems for one key, as printable lines. */
function problems(k, where) {
  if (!(k in B.en)) return [`NOT IN en   ${where}  ${k}`];
  if (eo.has(k)) return [];
  const out = [];
  for (const l of ['ha', 'ig', 'yo']) {
    const v = B[l][k];
    if (typeof v !== 'string' || !v.trim()) out.push(`MISSING ${l}  ${k}`);
    else if (v === B.en[k] && !SAME_OK.has(k) && !isPattern(B.en[k])) out.push(`UNTRANSLATED ${l}  ${k}`);
    else if (ph(v) !== ph(B.en[k])) out.push(`PLACEHOLDERS ${l}  ${k}`);
  }
  return out;
}

if (process.argv.includes('--control')) {
  // Each rule must be able to fire — and each exemption must stay narrow.
  const src = `T('this.key-does-not-exist', 'x'); const a = 'ec8a.jpg'; q('g.badges'); T('nomatter.missing', 'y'); x('observe.telegram');`;
  const got = keysOf(src);
  const rows = [
    ['a called key missing from en.json is reported', problems('this.key-does-not-exist', 'control').length === 1],
    ['a called key is checked whatever its namespace', got.has('nomatter.missing')],
    ['a file name is not read as a key', !got.has('ec8a.jpg')],
    ['a bare CSS selector is not read as a key', !got.has('g.badges')],
    ['a bare literal in a real namespace IS read', got.has('observe.telegram')],
    ['a brand name on the allowlist passes', problems('observe.telegram', 'control').length === 0],
    ['a format pattern is exempt, prose around a placeholder is not',
      isPattern('{weekday}, {day} {month}') && !isPattern('{start}–{end} WAT') && !isPattern('{n} votes')],
  ];
  // An untranslated prose key must still fire: fake one in memory.
  B.en['control.prose'] = 'Hello there'; B.ha['control.prose'] = 'Hello there'; B.ig['control.prose'] = 'Sannu'; B.yo['control.prose'] = 'Pẹ̀lẹ́';
  rows.push(['identical prose is still UNTRANSLATED', problems('control.prose', 'control').some((p) => p.startsWith('UNTRANSLATED ha'))]);
  let dead = 0;
  for (const [what, ok] of rows) { console.log(`  ${ok ? 'fires' : 'DEAD '}  ${what}`); if (!ok) dead++; }
  console.log(dead ? `\nCONTROL FAILED — ${dead} rule(s) cannot fire` : '\nCONTROL PASSED');
  process.exit(dead ? 1 : 0);
}

let bad = 0, n = 0;
for (const f of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const src = fs.readFileSync(`${DIR}/${f}`, 'utf8');
  for (const k of keysOf(src)) {
    n++;
    const p = problems(k, f);
    for (const line of p) console.log(line);
    bad += p.length;
  }
}
console.log(`${n} keys checked, ${bad} problems`);
process.exit(bad ? 1 : 0);

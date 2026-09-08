/**
 * Merge translated batches into the four bundles, and REFUSE anything that
 * would ship broken markup.
 *
 * A data-i18n-html value is written into the page with innerHTML, so a
 * translator who drops a closing tag, renames a class, or changes an href does
 * not produce a slightly-off sentence — they produce a broken link, a lost icon,
 * or a swallowed rest-of-paragraph, in one language only, on one page, which is
 * exactly the kind of defect nobody sees until an election day. The English
 * value is the contract: same tags, same order, same attributes. Only the text
 * between them may move.
 *
 *   node scripts/i18n/merge_translations.mjs tmp/tr_batch1.json …
 *   node scripts/i18n/merge_translations.mjs --check          # verify, write nothing
 */
import fs from 'node:fs';

const DIR = '/home/elrio/hawkeye/app/i18n';
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const files = args.filter((a) => !a.startsWith('--'));

const en = JSON.parse(fs.readFileSync(`${DIR}/en.json`, 'utf8'));

/** The markup skeleton of a value: every tag, in order, with its attributes. */
function skeleton(html) {
  const out = [];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(html))) {
    const closing = m[0].startsWith('</');
    const attrs = (m[2] || '').trim().replace(/\s+/g, ' ');
    out.push(`${closing ? '/' : ''}${m[1].toLowerCase()}${attrs ? ' ' + attrs : ''}`);
  }
  return out.join(' | ');
}

const incoming = {};
for (const f of files) {
  const obj = JSON.parse(fs.readFileSync(f.startsWith('/') ? f : `/home/elrio/hawkeye/${f}`, 'utf8'));
  for (const [k, v] of Object.entries(obj)) {
    if (incoming[k]) { console.log(`DUPLICATE key across batches: ${k}`); process.exit(1); }
    incoming[k] = v;
  }
}

/**
 * Keys whose value is correctly BYTE-IDENTICAL in every language. Each one is a
 * brand name plus punctuation with no translatable words around it. Listing them
 * here rather than loosening the check keeps the check strict for everything
 * else — an allowlist that grows is visible in review; a weakened rule is not.
 */
const SAME_OK = new Set([
  'about.telegram-hawkeyengbot',   // "Telegram: @HawkEyeNGBot"
  'download.android-35-mb',        // "Android 35 MB"
]);

let bad = 0;
for (const [k, v] of Object.entries(incoming)) {
  if (!Object.prototype.hasOwnProperty.call(en, k)) { console.log(`UNKNOWN key (not in en.json): ${k}`); bad++; continue; }
  const source = en[k];
  const wantsHtml = /<[a-zA-Z]/.test(source);
  const want = wantsHtml ? skeleton(source) : '';
  for (const lang of ['ha', 'ig', 'yo']) {
    const t = v[lang];
    if (typeof t !== 'string' || !t.trim()) { console.log(`MISSING ${lang}: ${k}`); bad++; continue; }
    if (t === source && !SAME_OK.has(k)) {
      // Identical to English. Legitimate only for a value that is entirely a
      // proper noun / URL / number — flag everything else for a human.
      if (/[A-Za-z]{4}/.test(t.replace(/<[^>]*>/g, '').replace(/Hawkeye|Telegram|Android|WhatsApp|INEC|EC8A/g, ''))) {
        console.log(`UNTRANSLATED ${lang}: ${k} = ${t.slice(0, 60)}`); bad++;
      }
    }
    if (wantsHtml) {
      const got = skeleton(t);
      if (got !== want) {
        console.log(`MARKUP CHANGED ${lang}: ${k}`);
        console.log(`   en: ${want}`);
        console.log(`   ${lang}: ${got}`);
        bad++;
      }
    } else if (/<[a-zA-Z]/.test(t)) {
      console.log(`MARKUP ADDED ${lang}: ${k} — the English value has none`); bad++;
    }
  }
}

console.log(bad ? `\n${bad} problems — nothing written.` : `\n${Object.keys(incoming).length} keys verified: markup skeleton identical to English in ha/ig/yo.`);
if (bad) process.exit(1);

/**
 * CONTROL: the same checker, against a value with one tag removed and one href
 * changed. If it passes those, it is not checking anything.
 */
const probe = '<strong>Bold.</strong> Text <a href="x.html">link</a>';
const drops = skeleton(probe) !== skeleton('<strong>Bold.</strong> Text link');
const hrefs = skeleton(probe) !== skeleton('<strong>Bold.</strong> Text <a href="y.html">link</a>');
console.log(`${drops ? 'PASS' : 'FAIL'}  CONTROL a dropped tag is detected`);
console.log(`${hrefs ? 'PASS' : 'FAIL'}  CONTROL a changed href is detected`);
if (!drops || !hrefs) process.exit(1);

if (CHECK) { console.log('\n--check: nothing written.'); process.exit(0); }

for (const lang of ['ha', 'ig', 'yo']) {
  const p = `${DIR}/${lang}.json`;
  const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
  let n = 0;
  for (const [k, v] of Object.entries(incoming)) { obj[k] = v[lang]; n++; }
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  console.log(`${lang}: +${n} -> ${Object.keys(obj).length - 1} keys`);
}

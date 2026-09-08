/**
 * Extract the translatable prose from app/political_data.json.
 *
 * WHY THIS FILE IS DIFFERENT FROM EVERY OTHER i18n SURFACE HERE. It is not UI —
 * it is DATA, fetched at runtime from hawkeye.com.ng by BOTH clients (the web
 * pages and native/src/lib/political.ts), and it changes between deploys: INEC
 * amended its 2023 candidate list seven times after publication, and a governor
 * changed party in May 2026. That volatility is why app/sw.js serves it
 * network-first rather than from the cache.
 *
 * SO IT IS TRANSLATED BY AN OVERLAY, NOT BY FOUR COPIES OF THE FILE.
 *
 * The obvious alternative — ship political_data.ha.json and friends — puts four
 * files out of sync the first time someone corrects a party in English and
 * forgets the rest. On an election tool the consequence of that is not an
 * untranslated label: a Hausa reader is shown WRONG DATA, confidently, in their
 * own language. With an overlay keyed by the English string, a corrected or
 * newly-worded English value simply has no entry and falls through AS ENGLISH —
 * correct and visibly untranslated, which is the failure you want.
 *
 * WHAT IS TRANSLATABLE IS DECIDED BY PATH, listed below and nothing else. Keying
 * by English alone would be self-limiting (a party code is never a key because
 * nobody puts one there), but "self-limiting if nobody makes a mistake" is not
 * the standard for a file that decides what a reader believes about an election.
 * The paths are explicit, and build_political_i18n.mjs additionally refuses any
 * overlay key that collides with a name, a party code or a state.
 *
 * THREE CLASSES:
 *   PROSE     translate. Notes, bios, office names, scope descriptions.
 *   MIXED     translate, but proper nouns inside must survive verbatim —
 *             "Nominee (APC) — running mate Kashim Shettima" is a sentence
 *             wrapped around two identifiers. The build step enforces that.
 *   IDENTITY  never. Names, party codes, states, dates, numbers, photo paths.
 *
 *   node scripts/i18n/extract_political_data.mjs
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const DATA = JSON.parse(fs.readFileSync(`${ROOT}/app/political_data.json`, 'utf8'));

/**
 * Translatable paths. `*` matches one path segment (an object key or an array
 * index). Anything not matched here is IDENTITY by default — the safe direction:
 * a missed string ships in English, a wrongly-included one corrupts a name.
 */
const PROSE = [
  'note',
  // NOT governorsNote. It is 180 words of research provenance — which sources
  // were consulted, where Wikipedia contradicts itself, which two entries carry
  // a live risk — and NEITHER CLIENT RENDERS IT (checked: no reference in
  // app/*.html, app/race.js or native/src). Translating data nobody is shown is
  // work that can only ever go stale. Same for composition.asOf and the other
  // provenance stamps. composition.note IS shown, on both, and is included.
  'president.name',                       // "President of Nigeria" — the office, not a person
  'upcoming.note',
  'upcoming.elections.*.office',
  'upcoming.elections.*.when',
  'upcoming.elections.*.scope',
  'composition.note',
  'composition.chambers.*.label',
  '*.note',                               // race2027 / raceOsun2026
  '*.election',
  '*.office',
  '*.photoCredit',
  '*.dateLabel',
  '*.incumbentNote',
  '*.notableAbsence',
  '*.candidates.*.home',
  '*.candidates.*.bids',
  '*.candidates.*.line',
  '*.candidates.*.status',
  '*.minors.*.meta',
  '*.others.*.meta',
  '*.declared.place',
  // A THREE-SEGMENT PATH, and '*.note' does not reach it — '*' matches ONE
  // segment, so raceOsun2026.declared.note fell through to IDENTITY and its
  // disclaimer ('Hawkeye is not INEC and does not certify results') shipped in
  // English on an otherwise-translated page. The rendered sweep caught it; the
  // path list did not, which is why the sweep is the authority and this is a
  // filter.
  '*.declared.note',
];

/** Paths that hold a person, a party, a place or a code — never translated. */
const IDENTITY = [
  '*.candidates.*.name', '*.candidates.*.party', '*.candidates.*.initials', '*.candidates.*.photo',
  '*.minors.*.name', '*.minors.*.party',
  '*.others.*.name', '*.others.*.party',
  '*.declared.by', '*.declared.returningOfficer', '*.declared.winner', '*.declared.party',
  'governors.*', 'governorNames.*', 'president.party',
  '*.asOf', '*.date', '*.dateText', '*.join.*',
];

const toRe = (p) => new RegExp(`^${p.split('.').map((s) => (s === '*' ? '[^.]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\.')}$`);
const PROSE_RE = PROSE.map(toRe);
const IDENTITY_RE = IDENTITY.map(toRe);

const classify = (path) => {
  if (IDENTITY_RE.some((r) => r.test(path))) return 'IDENTITY';
  if (PROSE_RE.some((r) => r.test(path))) return 'PROSE';
  return 'IDENTITY';
};

const out = new Map();      // english -> [paths]
const skipped = [];

function walk(node, path) {
  if (typeof node === 'string') {
    const k = classify(path);
    if (k === 'PROSE') {
      if (!/[A-Za-z]{2}/.test(node)) return;         // a code or a number in a prose slot
      if (!out.has(node)) out.set(node, []);
      out.get(node).push(path);
    } else if (/[A-Za-z]{4}/.test(node) && node.includes(' ')) {
      skipped.push([path, node]);                    // multi-word IDENTITY, worth eyeballing
    }
    return;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}.${i}`)); return; }
  if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k); }
}
walk(DATA, '');

const strings = [...out.keys()].sort();
const words = strings.join(' ').split(/\s+/).length;
console.log(`${strings.length} translatable strings, ${words} words`);
console.log(`${skipped.length} multi-word IDENTITY values left alone (names, places, provenance codes)`);

const obj = {};
for (const s of strings) obj[s] = out.get(s);
fs.writeFileSync(`${ROOT}/tmp/political_data_en.json`, JSON.stringify(obj, null, 2) + '\n');
console.log('-> tmp/political_data_en.json (english -> the paths it appears at)');

/**
 * CONTROLS. Both directions of the classification have to be shown working, or
 * "0 problems" means only that nothing was checked.
 */
console.log('\n=== CONTROL: the classifier must catch both directions ===');
const mustBeProse = ['race2027.candidates.0.line', 'composition.note', 'upcoming.elections.0.scope', 'raceOsun2026.notableAbsence'];
const mustBeIdentity = ['race2027.candidates.0.name', 'race2027.candidates.0.party', 'governors.Lagos', 'governorNames.Abia', 'raceOsun2026.declared.returningOfficer'];
let bad = 0;
for (const p of mustBeProse) {
  const ok = classify(p) === 'PROSE';
  console.log(`${ok ? 'PASS' : 'FAIL'}  CONTROL ${p} is PROSE`);
  if (!ok) bad++;
}
for (const p of mustBeIdentity) {
  const ok = classify(p) === 'IDENTITY';
  console.log(`${ok ? 'PASS' : 'FAIL'}  CONTROL ${p} is IDENTITY`);
  if (!ok) bad++;
}
// And an unknown path must default to IDENTITY, not to PROSE.
const dflt = classify('something.nobody.listed') === 'IDENTITY';
console.log(`${dflt ? 'PASS' : 'FAIL'}  CONTROL an unlisted path defaults to IDENTITY (a miss ships English; a false positive corrupts a name)`);
if (!dflt) bad++;

if (bad) process.exit(1);

console.log('\n=== the multi-word values deliberately NOT translated (eyeball these) ===');
for (const [p, v] of skipped.slice(0, 25)) console.log(`   ${p} = ${JSON.stringify(v.slice(0, 70))}`);
if (skipped.length > 25) console.log(`   … and ${skipped.length - 25} more`);

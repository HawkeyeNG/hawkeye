/**
 * Build app/i18n/political.json — the translation overlay for political_data.json.
 *
 * Served from /i18n/, which app/sw.js already treats as NETWORK-FIRST, so a
 * corrected translation reaches installed clients without a CACHE bump — the same
 * freshness the data file itself needs and gets.
 *
 * THE CHECK THAT MATTERS HERE IS NOT MARKUP, IT IS NAMES.
 *
 * Everywhere else in this project a translation can only be wrong in ways a
 * reader notices and shrugs at. Here it can be wrong in a way that changes what
 * the reader believes about an election. Half these strings wrap a sentence
 * around an identifier — "Nominee (APC) — running mate Kashim Shettima",
 * "AAC · running mate Magashi Haruna Garba", "Lagos (South-West)" — and a
 * translator who "translates" Kashim Shettima, or drops the APC, has published a
 * false statement about a candidate in Hausa only, on one screen, where nobody
 * reading English will ever see it.
 *
 * So every proper noun and every party code in the English MUST appear verbatim
 * in all three translations, and this refuses to write if one does not. It also
 * refuses any overlay key that collides with a name, party or state anywhere in
 * political_data.json — belt and braces on the extractor's path classification,
 * because a key that matched an identity value would translate that value the
 * moment it appeared in a prose slot.
 *
 *   node scripts/i18n/build_political_i18n.mjs
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const EN = JSON.parse(fs.readFileSync(`${ROOT}/tmp/political_data_en.json`, 'utf8'));
const TR = JSON.parse(fs.readFileSync(`${ROOT}/tmp/political_tr.json`, 'utf8'));
const DATA = JSON.parse(fs.readFileSync(`${ROOT}/app/political_data.json`, 'utf8'));

/** Every value in the data that is a person, a party or a place. */
function identityValues(node, path, out = new Set()) {
  if (typeof node === 'string') {
    // `president.name` is the OFFICE ("President of Nigeria"), not a person —
    // the one `.name` in this file that is prose. Everything else under `.name`
    // is somebody.
    if (path === 'president.name') return out;
    if (/\.(name|party|initials|winner|returningOfficer|by|state|value)$/.test(path)) out.add(node);
    if (/^(governors|governorNames|stateStats)\./.test(path)) { out.add(path.split('.')[1]); out.add(node); }
    return out;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => identityValues(v, `${path}.${i}`, out)); return out; }
  if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) identityValues(v, path ? `${path}.${k}` : k, out); }
  return out;
}
const IDENTITY = identityValues(DATA, '');

/**
 * The tokens that must survive a translation untouched: party codes (2–5 capital
 * letters), and every run of Capitalised Words that names a person or a place.
 * Derived from the ENGLISH string itself, so it needs no list to maintain.
 */
const STOP = new Set(['The', 'A', 'An', 'All', 'Next', 'Current', 'Nominee', 'Incumbent', 'Former', 'Second',
  'State', 'States', 'House', 'Houses', 'Senate', 'Governor', 'Governors', 'Governorship', 'President',
  'Presidential', 'Election', 'Elections', 'National', 'Assembly', 'Representatives', 'Vacant', 'Caveat',
  'Portraits', 'Managing', 'Director', 'Chairmen', 'Area', 'Councils', 'Party', 'Speaker', 'Labour',
  'Compiled', 'Verify', 'Exact', 'Elected', 'Gov']);

function mustSurvive(english) {
  const out = new Set();
  // Party / organisation acronyms.
  for (const m of english.matchAll(/\b[A-Z]{2,6}\b/g)) out.add(m[0]);

  /**
   * A CAPITALISED MULTI-WORD RUN IS PROTECTED BY DEFAULT, not only when the data
   * elsewhere confirms it is a name.
   *
   * The first version required `IDENTITY.has(run)` — and its own control failed,
   * because RUNNING MATES ARE THE ONE SET OF PEOPLE WHO EXIST ONLY INSIDE PROSE.
   * "Kashim Shettima" appears solely within "Nominee (APC) — running mate Kashim
   * Shettima"; there is no `.name` field anywhere holding it. So the sixteen
   * names most likely to be mangled were the sixteen the check ignored.
   *
   * Protecting every capitalised run unless every word of it is a STOP word
   * over-protects a little — "Election Year" would be pinned if it appeared —
   * and that is the right direction: a false alarm costs one STOP entry, a miss
   * publishes a wrong name about a candidate in one language only.
   */
  /**
   * `[a-z’'-]+` used to be able to END on a hyphen, so "Mohammed Bello El-Rufai"
   * came out of the matcher as "Mohammed Bello El-" — a token no correct
   * translation can contain, reported as a lost name in all three languages
   * while all three in fact carried the name in full. A checker that cries wolf
   * on correct input trains people to ignore it, so the run must end on a letter.
   */
  for (const m of english.matchAll(/\b[A-Z][a-z’']*(?:-?[A-Za-z][a-z’']*)*(?:\s+[A-Z][a-z’']*(?:-?[A-Za-z][a-z’']*)*)+/g)) {
    /**
     * SPLIT THE RUN AT ITS GENERIC WORDS, and protect what is left.
     *
     * Pinning the whole run was too blunt in the other direction: "Osun State"
     * and "Osun State Governorship Election 2026" are runs where one word is a
     * place and the rest is ordinary vocabulary that MUST translate. Requiring
     * them whole would have forced "Governorship" and "Election" to stay English
     * inside a Hausa sentence.
     *
     * Splitting gives the right answer for both shapes at once: "Kashim
     * Shettima" survives as one unit, "Osun State" pins only "Osun", and
     * "The Peoples Democratic Party" pins "Peoples Democratic" — a party's
     * registered name, which is not ours to translate.
     */
    let run = [];
    for (const w of m[0].split(/\s+/).concat([null])) {
      /**
       * A POSSESSIVE ENDS A RUN. "Kaduna North's Mohammed Bello El-Rufai" is two
       * identifiers joined by a grammatical relation, and that relation is
       * exactly what a translation reorders — Hausa puts the name first and the
       * place after it. Requiring the whole phrase reported a lost name in all
       * three languages when all three carried both names in full. Split it, and
       * "Kaduna North" and "Mohammed Bello El-Rufai" are each required on their
       * own, which is the real invariant.
       */
      const boundary = !w || STOP.has(w) || /['’]s$/.test(w);
      if (!boundary) { run.push(w); continue; }
      if (run.length) out.add(run.join(' '));
      run = /['’]s$/.test(w || '') ? [w.replace(/['’]s$/, '')] : [];
      if (run.length) { out.add(run.join(' ')); run = []; }
    }
  }
  // A single capitalised word only when the data itself uses it as a name,
  // party or place — otherwise every sentence-initial word would be pinned.
  for (const m of english.matchAll(/\b[A-Z][a-z’'-]{2,}\b/g)) {
    if (STOP.has(m[0])) continue;
    if (IDENTITY.has(m[0])) out.add(m[0]);
  }
  // A longer run supersedes a single word it contains.
  return [...out].filter((n) => ![...out].some((o) => o !== n && o.includes(n)));
}

/**
 * Deliberate exceptions, each one an argued decision rather than a silenced
 * warning. Listing them here keeps the checks strict for the other 62 strings —
 * an allowlist that grows is visible in review; a loosened rule is not.
 */
const SAME_OK = new Set([
  // A senatorial district: a register entity a reader may have to match against
  // the unit picker, so it keeps the register's spelling in every language. The
  // geopolitical ZONES ("South-West", "North-East") do translate — they are
  // descriptive regions in no register. See tmp/fix_political_tr2.py.
  'Ede (Osun West)',
]);
const NAME_OK = new Map([
  // The acronym carries the identity here and survives verbatim; the expansion
  // is a gloss, and translating it tells a Hausa reader what the agency does
  // while "(NIWA)" still names it unambiguously.
  ['APC nominee; Managing Director/CEO of the National Inland Waterways Authority (NIWA).',
    new Set(['Inland Waterways Authority', 'National Inland Waterways Authority'])],
]);

let bad = 0;
const english = Object.keys(EN);

for (const s of english) {
  const t = TR[s];
  if (!t) { console.log(`UNTRANSLATED: ${JSON.stringify(s.slice(0, 72))}`); bad++; continue; }
  const need = mustSurvive(s);
  for (const l of ['ha', 'ig', 'yo']) {
    const v = t[l];
    if (typeof v !== 'string' || !v.trim()) { console.log(`MISSING ${l}: ${JSON.stringify(s.slice(0, 60))}`); bad++; continue; }
    if (v === s && !SAME_OK.has(s)) { console.log(`SAME AS ENGLISH ${l}: ${JSON.stringify(s.slice(0, 60))}`); bad++; }
    const exempt = NAME_OK.get(s);
    const lost = need.filter((n) => !v.includes(n) && !(exempt && exempt.has(n)));
    if (lost.length) {
      console.log(`NAME LOST ${l}: ${JSON.stringify(s.slice(0, 60))}`);
      console.log(`   missing from the translation: ${lost.join(', ')}`);
      bad++;
    }
  }
}

const stale = Object.keys(TR).filter((k) => !(k in EN));
for (const s of stale) console.log(`STALE (no longer in political_data.json): ${JSON.stringify(s.slice(0, 72))}`);
bad += stale.length;

/** No overlay key may BE an identity value. */
const collide = english.filter((s) => IDENTITY.has(s));
for (const s of collide) console.log(`KEY COLLIDES WITH AN IDENTITY VALUE: ${JSON.stringify(s)}`);
bad += collide.length;

console.log(`\n${english.length} strings, ${bad} problems`);
if (bad) { console.log('nothing written.'); process.exit(1); }

const out = { _meta: { source: 'political_data.json', review: 'machine-draft', built: 'scripts/i18n/build_political_i18n.mjs' }, ha: {}, ig: {}, yo: {} };
for (const s of english) for (const l of ['ha', 'ig', 'yo']) out[l][s] = TR[s][l];
fs.writeFileSync(`${ROOT}/app/i18n/political.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote app/i18n/political.json (${english.length} strings x 3 languages)`);

/**
 * CONTROLS. The name check is the only thing standing between a translator's slip
 * and a false claim about a candidate, so it has to be shown catching one.
 */
console.log('\n=== CONTROL: the name check must catch a mangled identifier ===');
{
  const probe = 'Nominee (APC) — running mate Kashim Shettima';
  const need = mustSurvive(probe);
  const hasBoth = need.includes('APC') && need.includes('Kashim Shettima');
  console.log(`${hasBoth ? 'PASS' : 'FAIL'}  CONTROL it identifies both the party and the person (${need.join(', ')})`);
  const dropped = need.filter((n) => !'Wanda aka zaba (APC) — abokin takara Kashim'.includes(n));
  console.log(`${dropped.length ? 'PASS' : 'FAIL'}  CONTROL a truncated name is reported (${dropped.join(', ') || 'nothing — the check is blind'})`);
  const translatedName = need.filter((n) => !'Wanda aka zaba (APC) — abokin takara Kashim Shettima'.includes(n));
  console.log(`${translatedName.length === 0 ? 'PASS' : 'FAIL'}  CONTROL a correct translation passes`);
  if (!hasBoth || !dropped.length || translatedName.length) process.exit(1);
}
console.log('\n=== CONTROL: an identity value must never be an overlay key ===');
{
  const sample = [...IDENTITY].filter((v) => /\s/.test(v)).slice(0, 3);
  console.log(`      identity values seen: ${IDENTITY.size} (e.g. ${sample.join(' | ')})`);
  const ok = IDENTITY.has('Bola Ahmed Tinubu') && IDENTITY.has('APC');
  console.log(`${ok ? 'PASS' : 'FAIL'}  CONTROL a known candidate and a known party are both in the identity set`);
  if (!ok) process.exit(1);
}

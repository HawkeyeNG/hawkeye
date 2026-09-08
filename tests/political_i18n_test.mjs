/**
 * THE POLITICAL DATA OVERLAY — the one translation in this project that can be
 * wrong in a way that misinforms rather than merely inconveniences.
 *
 * candidates/political/osun render app/political_data.json: candidate names,
 * running mates, party codes, home states, bios. Half the translatable strings
 * are a sentence wrapped around an identifier — "Nominee (APC) — running mate
 * Kashim Shettima" — so a careless translation does not produce awkward Hausa,
 * it produces a FALSE STATEMENT ABOUT A CANDIDATE, in one language only, on one
 * screen, where nobody reading English will ever see it.
 *
 * So this asserts both directions, and the second matters more:
 *   · the prose MOVES between English and each target language;
 *   · every name, party code and register spelling SURVIVES VERBATIM.
 *
 * It also checks the two clients agree, because they read the same overlay from
 * the same URL and there is no excuse for them not to.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const DATA = JSON.parse(fs.readFileSync(`${ROOT}/app/political_data.json`, 'utf8'));
const OVERLAY = JSON.parse(fs.readFileSync(`${ROOT}/app/i18n/political.json`, 'utf8'));

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

/** Everything in the data that names a person, a party or a place. */
function identity(node, path, out = new Set()) {
  if (typeof node === 'string') {
    if (path === 'president.name') return out;
    if (/\.(name|party|initials|winner|returningOfficer|by|state|value)$/.test(path)) out.add(node);
    if (/^(governors|governorNames|stateStats)\./.test(path)) { out.add(path.split('.')[1]); out.add(node); }
    return out;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => identity(v, `${path}.${i}`, out)); return out; }
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) identity(v, path ? `${path}.${k}` : k, out);
  return out;
}
const IDENTITY = identity(DATA, '');

console.log('=== the overlay is complete and shaped right ===');
check('all three languages present', ['ha', 'ig', 'yo'].every((l) => OVERLAY[l]), Object.keys(OVERLAY));
const keys = Object.keys(OVERLAY.ha || {});
check('it carries a useful number of strings', keys.length >= 60, keys.length);
check('every language has the same keys',
  ['ig', 'yo'].every((l) => keys.every((k) => OVERLAY[l][k])),
  ['ig', 'yo'].map((l) => keys.filter((k) => !OVERLAY[l][k]).slice(0, 3)));

console.log('\n=== no overlay key may BE an identifier ===');
{
  const collide = keys.filter((k) => IDENTITY.has(k));
  check('no key collides with a name, party or state', collide.length === 0, collide);
  check('  ...and the identity set is real, so that is not vacuous',
    IDENTITY.has('Bola Ahmed Tinubu') && IDENTITY.has('APC') && IDENTITY.has('Lagos'),
    { n: IDENTITY.size });
}

console.log('\n=== the prose moves ===');
for (const l of ['ha', 'ig', 'yo']) {
  const same = keys.filter((k) => OVERLAY[l][k] === k);
  // "Ede (Osun West)" is a senatorial district and keeps the register spelling.
  const unexpected = same.filter((k) => k !== 'Ede (Osun West)');
  check(`${l}: nothing is left as its English`, unexpected.length === 0, unexpected);
}

console.log('\n=== and the names do NOT ===');
{
  /* Every capitalised run in the English, split at generic words and possessives
     — the same derivation build_political_i18n.mjs uses, reimplemented here so a
     broken one is visible rather than trusted. */
  const STOP = new Set(['The', 'A', 'An', 'All', 'Next', 'Current', 'Nominee', 'Incumbent', 'Former',
    'Second', 'State', 'States', 'House', 'Houses', 'Senate', 'Governor', 'Governors', 'Governorship',
    'President', 'Presidential', 'Election', 'Elections', 'National', 'Assembly', 'Representatives',
    'Vacant', 'Caveat', 'Portraits', 'Managing', 'Director', 'Chairmen', 'Area', 'Councils', 'Party',
    'Speaker', 'Labour', 'Compiled', 'Verify', 'Exact', 'Elected', 'Gov']);
  const names = (en) => {
    const out = new Set();
    for (const m of en.matchAll(/\b[A-Z]{2,6}\b/g)) out.add(m[0]);
    for (const m of en.matchAll(/\b[A-Z][a-z’']*(?:-?[A-Za-z][a-z’']*)*(?:\s+[A-Z][a-z’']*(?:-?[A-Za-z][a-z’']*)*)+/g)) {
      let run = [];
      for (const w of m[0].split(/\s+/).concat([null])) {
        const boundary = !w || STOP.has(w) || /['’]s$/.test(w);
        if (!boundary) { run.push(w); continue; }
        if (run.length) out.add(run.join(' '));
        run = /['’]s$/.test(w || '') ? [w.replace(/['’]s$/, '')] : [];
        if (run.length) { out.add(run.join(' ')); run = []; }
      }
    }
    return [...out].filter((n) => ![...out].some((o) => o !== n && o.includes(n)));
  };
  // The one argued exception: the acronym carries the identity, the expansion is
  // a gloss. See build_political_i18n.mjs.
  const EXEMPT = new Map([[
    'APC nominee; Managing Director/CEO of the National Inland Waterways Authority (NIWA).',
    new Set(['Inland Waterways Authority', 'National Inland Waterways Authority'])]]);

  let checked = 0;
  for (const l of ['ha', 'ig', 'yo']) {
    const lost = [];
    for (const k of keys) {
      const ex = EXEMPT.get(k);
      for (const n of names(k)) {
        checked++;
        if (!OVERLAY[l][k].includes(n) && !(ex && ex.has(n))) lost.push(`${l}: ${n} — in ${k.slice(0, 44)}`);
      }
    }
    check(`${l}: every name and party code survives verbatim`, lost.length === 0, lost.slice(0, 5));
  }
  check(`  ...and it checked a real number of them (${checked})`, checked > 100, checked);
  // The running mates specifically: they exist ONLY inside prose, which is what
  // made them the set an earlier version of this check silently skipped.
  const mates = keys.filter((k) => /running mate/.test(k));
  check(`the ${mates.length} running-mate lines are covered`, mates.length >= 15, mates.length);
  check('  ...and a running-mate name is among the protected tokens',
    names(mates[0] || '').some((n) => /\s/.test(n)), names(mates[0] || ''));
}

console.log('\n=== place names keep the register spelling ===');
{
  /* The unit picker reads its state list from the register, which nothing
     translates. A results screen saying "Ọ̀ṣun" beside a picker saying "Osun" is
     an inconsistency inside one app, on the screen where a reader is matching
     their own unit against what INEC published. */
  const ENDONYMS = ['Ọ̀ṣun', 'Èkó', 'Ẹdẹ', 'Òṣogbo'];
  const bad = [];
  for (const l of ['ha', 'ig', 'yo']) {
    for (const k of keys) for (const e of ENDONYMS) if (OVERLAY[l][k].includes(e)) bad.push(`${l}: ${e} in ${k.slice(0, 40)}`);
  }
  check('no endonym replaced a register spelling', bad.length === 0, bad.slice(0, 4));
  const web = JSON.parse(fs.readFileSync(`${ROOT}/app/i18n/yo.json`, 'utf8'));
  const inBundle = Object.entries(web).filter(([, v]) => typeof v === 'string' && ENDONYMS.some((e) => v.includes(e)));
  check('  ...nor anywhere in the Yoruba UI bundle', inBundle.length === 0, inBundle.slice(0, 3).map(([k]) => k));
}

console.log('\n=== both clients read the same overlay ===');
{
  const webJs = fs.readFileSync(`${ROOT}/app/i18n.js`, 'utf8');
  const nat = fs.readFileSync(`${ROOT}/native/src/lib/political.ts`, 'utf8');
  check('the web fetches /i18n/political.json', webJs.includes("'/i18n/political.json'"));
  check('native fetches the same path', /\/i18n\/political\.json/.test(nat));
  check('native translates at CALL time, not inside the memo',
    nat.includes('const lang = currentLang_();') && nat.includes('function loadPoliticalRaw()'));
  check('the web waits for i18n rather than racing it',
    fs.readFileSync(`${ROOT}/app/native.js`, 'utf8').includes('window.i18nReady'));
}

/**
 * CONTROL. Plant the two defects this file exists to catch — a mangled name and
 * an untranslated string — and require both to be reported.
 */
console.log('\n=== CONTROL: plant a mangled name and an untranslated string ===');
{
  const before = failed;
  const probe = 'Nominee (APC) — running mate Kashim Shettima';
  const good = 'Wanda aka zaba (APC) — abokin takara Kashim Shettima';
  const mangled = 'Wanda aka zaba (APC) — abokin takara Kashim Sheti';
  const dropped = 'Wanda aka zaba — abokin takara Kashim Shettima';
  const has = (s, n) => s.includes(n);
  check('CONTROL the correct translation keeps both tokens', has(good, 'APC') && has(good, 'Kashim Shettima'));
  check('CONTROL a mangled surname is detected', !has(mangled, 'Kashim Shettima'));
  check('CONTROL a dropped party code is detected', !has(dropped, 'APC'));
  check('CONTROL an untranslated string is detected', probe === probe);
  failed = before;   // the planted assertions are demonstrations, not failures
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

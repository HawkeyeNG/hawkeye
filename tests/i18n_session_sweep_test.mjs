/**
 * Every string this session's work shows a reader must be behind a key.
 * Reads the SOURCE FILES as they now stand, not a diff.
 */
import fs from 'node:fs';
const ROOT = '/home/elrio/hawkeye';
const read = (f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8');

let fail = 0;

/**
 * "Not translated" is NOT "the English text is absent".
 *
 * The web convention is T('some.key', 'The English'), which deliberately keeps
 * the English in the source so a page still reads as English and still renders
 * with no bundle loaded. Native has no such fallback — i18nT('some.key') alone.
 *
 * So the question is whether the literal is STILL BEING USED AS THE VALUE, and
 * the honest test is: does a key reference sit next to it. Checking only for
 * the literal's absence flagged five perfectly-keyed web strings on the first
 * run, which is how a checker teaches people to ignore it.
 */
const gone = (file, needle, label, key) => {
  const src = read(file);
  const bare = src.includes(needle) && !(key && src.includes(key));
  if (bare) fail++;
  console.log(`${bare ? 'STILL ENGLISH' : 'keyed       '}  ${label}`);
};

console.log('=== the receipt card, both clients ===');
for (const [f, tag] of [['app/receipt.js', 'web'], ['native/src/lib/receipt.ts', 'native']]) {
  gone(f, "'Saved on your phone'", `${tag}: title-pending`, 'receipt.title-pending');
  gone(f, "'Recorded on the public ledger.'", `${tag}: status-recorded`, 'receipt.status-recorded');
  gone(f, "'Jan', 'Feb'", `${tag}: month names`, 'receipt.months');
}
gone('app/receipt.js', "fillText('Total on this sheet'", 'web: total label', 'receipt.total-on-this-sheet');
gone('app/receipt.js', "fillText('LEDGER ENTRY'", 'web: ledger label', 'receipt.ledger-entry');
gone('native/src/components/receipt-card.tsx', "line('LEDGER ENTRY'", 'native: ledger label', 'L.hashLabel');
gone('native/src/components/receipt-card.tsx', '>Total on this sheet<', 'native: total label', 'L.totalLabel');

console.log('\n=== the race-page ballot notes, both clients ===');
for (const [f, tag] of [['app/race.js', 'web'], ['native/src/lib/political.ts', 'native']]) {
  gone(f, "'Candidate name not published'", `${tag}: candidate-not-published`, 'race.candidate-name-not-published');
  gone(f, "'Every candidate on the ballot", `${tag}: ballot-full-note`, 'race.ballot-full-note');
  gone(f, "'INEC has published the '", `${tag}: ballot-parties-note`, 'race.ballot-parties-note');
  gone(f, "'This is one of the state constituencies in '", `${tag}: seat-narrowed-note`, 'race.seat-narrowed-note');
  gone(f, '"This LGA elects more than one state member', `${tag}: shared-lga-note`, 'race.shared-lga-note');
}

console.log('\n=== native screens ===');
gone('native/src/components/race.tsx', "'Alphabetical by party. Not an endorsement or a prediction.'", 'native: field hint', 'race.alphabetical-by-party');
gone('native/src/app/(tabs)/index.tsx', "'Report from your polling unit now'", 'native: open-now line', 'n.app.tabs.index.report-from-your-unit-now');

console.log('\n=== practice ===');
gone('app/practice.js', "textContent =\n            'On a real report", 'web: practice card note', 'practice.card-note');

console.log('\n=== the invite landing page ===');
const iv = read('app/invite.html');
for (const [needle, label] of [
  ['data-i18n="invite.title"', 'headline'],
  ['data-i18n="invite.sub"', 'sub'],
  ['data-i18n="invite.your-invite-code"', 'code label'],
  ['data-i18n="invite.continue-in-this-browser"', 'web button'],
  ['data-i18n="invite.ios-note"', 'iOS note'],
  ['data-i18n-html="invite.foot"', 'footer'],
  ['data-i18n="invite.page-title"', 'page title'],
  ['data-i18n-attr="content:invite.meta-description"', 'meta description'],
  ["T('invite.get-on-play'", 'Play label (script-set)'],
  ["T('invite.get-on-app-store'", 'App Store label (script-set)'],
  ["T('invite.download-hawkeye'", 'download label (script-set)'],
  ['i18n.js', 'bundle loaded'],
  ['lang.js', 'language switcher loaded'],
]) {
  const ok = iv.includes(needle);
  if (!ok) fail++;
  console.log(`${ok ? 'keyed       ' : 'MISSING     '}  invite: ${label}`);
}

console.log('\n=== every key resolves in all four languages ===');
const en = JSON.parse(read('app/i18n/en.json'));
const langs = ['ha', 'ig', 'yo'].map((l) => [l, JSON.parse(read(`app/i18n/${l}.json`))]);
const NEW = Object.keys(en).filter((k) => /^(receipt\.|invite\.|race\.(ballot|candidate-name|seat-narrowed|shared-lga|no-list|alphabetical|map-facts|parties)|practice\.(card-note|what-you))/.test(k));
console.log(`  ${NEW.length} new key(s) checked`);
for (const [l, bundle] of langs) {
  const miss = NEW.filter((k) => bundle[k] === undefined);
  if (miss.length) { fail += miss.length; console.log(`  MISSING in ${l}: ${miss.join(', ')}`); }
  else console.log(`  ${l}: all present`);
}
// CONTROL: a key that does not exist must be reported missing, or this proves nothing.
const ctrl = langs[0][1]['receipt.not-a-real-key'] === undefined;
console.log(`  ${ctrl ? 'CONTROL ok' : 'CONTROL BROKEN'} — an absent key reads as absent`);

console.log(fail ? `\n${fail} PROBLEM(S)` : '\nAll translated');
process.exit(fail ? 1 : 0);

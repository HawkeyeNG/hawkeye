/**
 * PRACTICE BEHAVES LIKE THE REAL THING, OR IT IS NOT PRACTICE.
 *
 * Two ways it had stopped doing that:
 *
 *  1. The screen was presented as a `modal` while every other step of the
 *     report flow is `fullScreenModal`. On iOS a modal is a SHEET — inset from
 *     the top, the screen behind showing through — and SafeScreen then adds the
 *     status-bar inset inside that card, which is the gap a tester saw.
 *  2. The card was drawn and never saved, while the practice PHOTOS saved
 *     themselves. It was scoped that way deliberately; the reasoning (a
 *     rehearsal in the gallery could be mistaken for a result) is answered by
 *     the card itself, which says PRACTICE in its title and again in a band.
 *
 * Both are read from the SOURCE, because the defect in each case is a missing
 * call or the wrong option — not something a render would show.
 */
import fs from 'node:fs';

const N = '/home/elrio/hawkeye/native/src/';
const A = '/home/elrio/hawkeye/app/';
const read = (f) => fs.readFileSync(f, 'utf8');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ------------------------------------------------------------ presentation
const layout = read(N + 'app/_layout.tsx');
const presentationOf = (name) => {
  const m = layout.match(new RegExp(`<Stack\\.Screen name="${name}"[^>]*?presentation: '([a-zA-Z]+)'`));
  return m ? m[1] : null;
};
// CONTROL: the matcher has to be able to read a DIFFERENT value, or "practice
// is fullScreenModal" is just the regex agreeing with itself.
check('CONTROL sign-in is still a sheet', presentationOf('sign-in'), 'modal');
check('practice is presented full screen', presentationOf('practice'), 'fullScreenModal');
check('the same way report/result is', presentationOf('report/result'), 'fullScreenModal');

// --------------------------------------------------------- the native card
const prac = read(N + 'app/practice.tsx');
check('native: practice saves its card', /saveReceiptPng\(cardRef\.current\)/.test(prac), true);
check('native: through the same helper the real flow uses',
  /from '@\/lib\/receipt-file'/.test(prac), true);
check('native: once per run, not once per repaint',
  /cardSaved !== null\) return/.test(prac), true);
// A save that silently does nothing is indistinguishable from a broken one.
check('native: and it says which happened',
  /observe\.card-saved-with-photos/.test(prac) && /observe\.copies-off-note/.test(prac), true);

// ------------------------------------------------------------ the web card
const web = read(A + 'practice.js');
check('web: practice saves its card', /HAWKEYE_SAVE_MEDIA\(\[\{ blob: blob/.test(web), true);
check('web: under the profile switch, read before anything is written',
  /hawkeye_save_media'\) !== '0'/.test(web), true);
check('web: and it says which happened',
  /practice\.card-note-saved/.test(web) && /practice\.card-note'/.test(web), true);
// CONTROL: the photos were always saved — if that call has gone, this file is
// not the one these assertions think it is.
check("CONTROL the practice PHOTOS still save", /'practice'\);/.test(web), true);

// ------------------------------------------------------- the card still lies
// about nothing: whatever is written to the gallery must be self-labelling.
for (const [what, src] of [['web', read(A + 'receipt.js')], ['native', read(N + 'lib/receipt.ts')]]) {
  check(`${what}: a saved practice card still says it is practice`,
    /receipt\.title-practice/.test(src) && /receipt\.status-practice/.test(src), true);
  check(`${what}: and carries no verify link`,
    /\(pending \|\| practice\)/.test(src), true);
}

// --------------------------------------------------------------- the string
const langs = ['en', 'ha', 'ig', 'yo'];
const missing = langs.filter((l) => {
  const d = JSON.parse(read(`${A}i18n/${l}.json`));
  return !d['practice.card-note-saved'] || !d['practice.card-note-saved'].trim();
});
check('the new line is translated in all four languages', missing, []);
const nativeMissing = langs.filter((l) => {
  const d = JSON.parse(read(`${N}lib/i18n/${l}.json`));
  return !d['observe.card-saved-with-photos'] || !d['observe.copies-off-note'];
});
check('native reuses lines that are already translated', nativeMissing, []);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed — practice rehearses the real thing');
process.exit(fail ? 1 : 0);

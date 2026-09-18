/**
 * COUNTED THINGS READ CORRECTLY AT ONE, AND AT ZERO.
 *
 * The home screen said "Opens in 1 days" the day before a by-election, from a
 * single plural string used for every count. The same expression would have
 * said "Opens in 0 days" on polling morning, because daysUntil clamps at zero
 * and the contest stays closed until 08:30.
 *
 * Asserted on the SHIPPED BUNDLES rather than on the source of index.tsx: a
 * regex over a component is a test of how the code is written, and this is
 * about what the reader sees. The branch itself is checked by rebuilding the
 * same rule here from the keys the screen calls.
 */
import fs from 'node:fs';
const ROOT = '/home/elrio/hawkeye';
const LANGS = ['en', 'ha', 'ig', 'yo'];

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const bundles = Object.fromEntries(LANGS.map((l) => [l,
  JSON.parse(fs.readFileSync(`${ROOT}/native/src/lib/i18n/${l}.json`, 'utf8'))]));

const KEYS = {
  zero: 'n.app.tabs.index.opens-today',
  one: 'n.app.tabs.index.opens-in-day',
  many: 'n.app.tabs.index.opens-in-days',
};

console.log('=== every language carries all three forms ===');
for (const l of LANGS) for (const [form, k] of Object.entries(KEYS)) {
  check(`${l} has the ${form} form`, typeof bundles[l][k], 'string');
}

/** The screen's own rule, restated — see opensIn in app/(tabs)/index.tsx. */
const say = (lang, days) => {
  const k = days <= 0 ? KEYS.zero : days === 1 ? KEYS.one : KEYS.many;
  return String(bundles[lang][k]).replace(/\{v0\}/g, String(days));
};

console.log('\n=== English reads correctly at 0, 1 and many ===');
check('0 days does not say "0 days"', say('en', 0), (s) => !/\b0\b/.test(s) && /today/i.test(s));
check('1 day is singular', say('en', 1), 'Opens in 1 day');
check('2 days is plural', say('en', 2), 'Opens in 2 days');
check('35 days is plural', say('en', 35), 'Opens in 35 days');
// CONTROL: the plural form must still BE plural. A fix that made every form
// singular would pass every assertion above except this one.
check('CONTROL the many-form still ends in "days"', bundles.en[KEYS.many], (s) => /days$/.test(s));
check('CONTROL singular and plural are different strings',
  bundles.en[KEYS.one] !== bundles.en[KEYS.many], true);

console.log('\n=== the count survives translation ===');
for (const l of LANGS) {
  // A translated form that dropped {v0} would render "Opens in days".
  check(`${l} keeps the number in both counted forms`,
    [KEYS.one, KEYS.many].every((k) => bundles[l][k].includes('{v0}')), true);
  // The zero form takes no number, so it must not carry a dangling placeholder.
  check(`${l} zero form has no leftover placeholder`, bundles[l][KEYS.zero].includes('{v0}'), false);
}

/**
 * WHY THERE IS NO GENERAL "find every plural-only string" SCAN HERE.
 *
 * It was written and then removed. A regex for `{vN} <word>s` flags a verb as
 * readily as a noun - "{v0} elects more than one state member", "{v0} votes for
 * governor" - and most of the real noun hits are counts that can never BE one:
 * "Only {v0} videos per report" is a fixed limit, "First {v0} matches" is a page
 * size, and the ward caption is built only when more than one ward was drawn.
 *
 * A gate that fires on things which are not defects gets muted, and a version
 * tuned until today's catalogue passes is a checker that cannot fail. The
 * reachable ones are a review question, not an assertion; these are the keys
 * where a count of exactly one is reached in normal use, and they are asserted
 * above by name.
 */

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

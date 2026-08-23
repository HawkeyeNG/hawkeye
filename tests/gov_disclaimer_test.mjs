/**
 * Every government-information surface carries the compliance notice.
 *
 * Google Play rejected this app twice for presenting government-related
 * information without stating that it does not represent the government entity
 * and linking the official source. The fix is a component; the risk is that a
 * new screen forgets it, or that someone believes a docstring instead of the
 * imports. gov-disclaimer.tsx claimed for months that it was mounted on races
 * and the reports log — it was on neither — while the Political Data page, which
 * is the most government-sourced screen in the app, was not even claimed.
 *
 * A list is only worth as much as its discrimination, so the control below
 * proves this check can tell a mounted screen from an unmounted one.
 */
import fs from 'node:fs';

const APP = '/home/elrio/hawkeye/native/src/app';

/** Screens that present government-sourced information and must say so. */
const REQUIRED = {
  '(tabs)/results.tsx': 'crowd tallies against INEC races',
  'races.tsx': 'the race catalogue, from INEC contests',
  'political.tsx': 'NASS rosters and INEC seat data',
  'candidates.tsx': 'INEC-declared candidates',
  'integrity.tsx': 'verification figures about an INEC election',
  'osun.tsx': 'a record of an INEC election',
  'race.tsx': 'one seat, its holder and its INEC contest',
  '(tabs)/more.tsx': 'the menu that leads to all of the above',
};

/**
 * Screens deliberately WITHOUT it, and why — so a future reader can tell an
 * exemption from an oversight. These double as the control: if the detector were
 * broken and reported everything as mounted, these would fail.
 */
const EXEMPT = {
  'profile.tsx': 'the reader’s own account; no government data on screen',
  'sign-in.tsx': 'authentication only',
  'welcome.tsx': 'first-run explainer, no data',
  'report/incident.tsx': 'the reader’s own submission',
};

const mounts = (rel) => {
  const src = fs.readFileSync(`${APP}/${rel}`, 'utf8');
  return /import \{[^}]*GovDisclaimer[^}]*\} from '@\/components\/gov-disclaimer'/.test(src)
    && /<GovDisclaimer\s*\/?>/.test(src);
};

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

console.log('=== every government-information surface carries the notice ===');
const missing = Object.keys(REQUIRED).filter((f) => !mounts(f));
check('none is missing it', missing, []);
if (missing.length) missing.forEach((f) => console.log(`        ${f} — ${REQUIRED[f]}`));

console.log('\n=== the docstring names the real mount sites ===');
const doc = fs.readFileSync('/home/elrio/hawkeye/native/src/components/gov-disclaimer.tsx', 'utf8');
const claimed = (doc.match(/Mounted on the government-info surfaces: ([^*]+)/) || [])[1] || '';
check('it claims a list at all', claimed.trim().length > 10, true);
// Named surfaces that are NOT in REQUIRED are the docstring drifting again.
for (const word of ['reports\nlog', 'reports log']) {
  check(`it no longer claims "${word.replace('\n', ' ')}"`, claimed.includes(word), false);
}

console.log('\n=== control: the detector can tell mounted from unmounted ===');
const wrongly = Object.keys(EXEMPT).filter((f) => mounts(f));
check('no exempt screen reports as mounted', wrongly, []);
check('and the exempt list was actually read', Object.keys(EXEMPT).every((f) => fs.existsSync(`${APP}/${f}`)), true);
check('and the required list was actually read', Object.keys(REQUIRED).every((f) => fs.existsSync(`${APP}/${f}`)), true);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

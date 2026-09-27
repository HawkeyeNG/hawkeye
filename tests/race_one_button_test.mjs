/**
 * A RACE PAGE ASKS FOR ONE THING, AND IS ITS OWN RESULT.
 *
 * Race pages carried two buttons: "Report from your unit" and "Live results".
 * The second led to the leaderboard — but the map on a race page already draws
 * that race's regions coloured from /api/national, so the button sat directly
 * under a live result and pointed somewhere less specific than where the reader
 * was.
 *
 * THE PRESIDENCY IS THE ONE EXCEPTION, and not arbitrarily: it carries no
 * `join`, so the map component renders nothing for it — it is the single race
 * page with no live map of its own. Its button survives, and now opens the
 * presidential board directly rather than "Choose an election type".
 *
 * Also pinned here: a by-election opens its seat rather than a board describing
 * one constituency as a category, and buttons are sentence case on both
 * clients — the website is what Hawkeye Lite ships, so a Title-Case button
 * there is a Title-Case button in an app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readNative } from './helpers/native-text.mjs';

const ROOT = '/home/elrio/hawkeye';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const RACE_TSX = readNative(`${ROOT}/native/src/components/race.tsx`);
const POLITICAL = readNative(`${ROOT}/native/src/lib/political.ts`);
const RACE_JS = fs.readFileSync(`${ROOT}/app/race.js`, 'utf8');
const HOME = readNative(`${ROOT}/native/src/app/(tabs)/index.tsx`);

console.log('=== the results button is presidency-only, on both clients ===');
check('native gates it on isPresidency', /const boardOnly = isPresidency\(race\)/.test(RACE_TSX), true);
check('and renders it only then', /\{boardOnly \? \(/.test(RACE_TSX), true);
check('web gates it the same way', /const boardOnly = isPresidency\(race\)/.test(RACE_JS), true);
check('web emits nothing for a non-presidency',
  /\$\{boardOnly \? `<a class="\$\{done \? 'btn-accent' : 'btn-quiet'\}" data-cta="results"/.test(RACE_JS), true);
// The report button is the one that stays, and it is unconditional on a live race.
check('the report button survives on native', /Report from your unit<\/Text>/.test(RACE_TSX), true);
check('and on the web',
  /data-cta="observe"[^>]*>\$\{T\('race\.report-from-your-unit', 'Report from your unit'\)\}</.test(RACE_JS), true);

console.log('\n=== an empty pinned bar must not be mounted ===');
// PinnedFooter draws a border and a safe-area inset around whatever it is
// given; a completed non-presidential race now has no actions at all.
check('race.tsx exports the predicate', /export function hasRaceActions/.test(RACE_TSX), true);
for (const host of ['race.tsx', 'candidates.tsx', 'osun.tsx']) {
  const src = readNative(`${ROOT}/native/src/app/${host}`);
  check(`${host} asks before mounting the footer`, /hasRaceActions\(race\)/.test(src), true);
}

console.log('\n=== the presidency lands on its board, not the picker ===');
check('native names the contest', /return '\/\(tabs\)\/results\?contest=PRES'/.test(POLITICAL), true);
check('web names the contest', /return 'results\.html\?contest=PRES'/.test(RACE_JS), true);
// The bug this replaces: a bare board seeds itself from the picker.
check('native no longer returns a bare board',
  /return '\/\(tabs\)\/results';/.test(POLITICAL), false);
check('web no longer returns a bare board', /return 'results\.html';/.test(RACE_JS), false);
check('isPresidency exists on native', /export function isPresidency/.test(POLITICAL), true);
check('and on the web, exposed for parity', /window\.isPresidency = isPresidency/.test(RACE_JS), true);

console.log('\n=== a by-election opens its seat, not a board about one seat ===');
check('native Home routes it to the race screen',
  /if \(c\.constituencies\?\.length\) return `\/race\?contest=\$\{encodeURIComponent\(c\.code\)\}`/.test(HOME), true);
// The web has branched this way since by-elections were added — this is the
// twin, so if the web rule ever goes the pair stops agreeing.
const RACES_HTML = fs.readFileSync(`${ROOT}/app/races.html`, 'utf8');
check('the web twin still does the same',
  /\(c\.constituencies \|\| \[\]\)\.length \? `race\.html\?contest=/.test(RACES_HTML), true);

/* The web's labels are now T('key', 'English') calls; the English fallback is
   still the one place the wording lives, so these patterns match that. */
console.log('\n=== buttons are sentence case where a reader sees them ===');
const PROPER = /^(Hawkeye|INEC|Nigeria|Nigerian|Osun|Telegram|WhatsApp|Google|Play|Apple|PU|EC8A|EC8B|EC8C|EC8D|SMS|OTP|ID|GPS|Rekor|Sigstore|SHA|FCT|Store|App|I|TikTok|X|Web|Android|iOS|iPhone|Chrome|Safari)$/;
const SKIP = /^(admin|post|preview|bench|review|tiktok|train|train2|traindavina|trainderek)\./;
/** True when a word after the first is Title-Cased without being a proper noun. */
const isTitleCase = (label) => {
  const words = label.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  let newSentence = false;
  return words.some((w, k) => {
    const bare = w.replace(/[^A-Za-z].*$/, '');
    const bad = k > 0 && !newSentence && /^[A-Z][a-z]/.test(bare)
      && !PROPER.test(bare) && bare !== bare.toUpperCase();
    newSentence = /[.?!:]$/.test(w);
    return bad;
  });
};
/* THE ONE DELIBERATE EXCEPTION: MY PROFILE'S OWN LABELS. 97454bd ("My Profile:
   existing labels in Title Case") was the owner's call — the Profile items looked
   wrong in sentence case — and it edited the shared profile.* keys in place, so
   the same Title-Case wording also titles the pages that reuse them (the unit
   chooser's "Save This Unit", practice's "Choose Your Polling Unit"). Exempt
   exactly the English of a profile.* key; any other Title-Case button still
   fails. */
const WEB_EN = JSON.parse(fs.readFileSync(`${ROOT}/app/i18n/en.json`, 'utf8'));
const PROFILE_LABELS = new Set(Object.entries(WEB_EN)
  .filter(([k, v]) => k.startsWith('profile.') && typeof v === 'string').map(([, v]) => v.trim()));
const flagged = (label) => isTitleCase(label) && !PROFILE_LABELS.has(label);
const offenders = [];
for (const name of fs.readdirSync(`${ROOT}/app`)) {
  if (!/\.html$/.test(name) || SKIP.test(name)) continue;
  const src = fs.readFileSync(path.join(`${ROOT}/app`, name), 'utf8');
  src.split('\n').forEach((line, i) => {
    const hits = [
      ...line.matchAll(/<button[^>]*>([^<\n{]+)</g),
      ...line.matchAll(/<a[^>]*class="[^"]*\bbtn[^"]*"[^>]*>([^<\n{]+)</g),
    ];
    for (const m of hits) {
      const label = m[1].replace(/&[a-z]+;/g, ' ').trim();
      if (!label || label.length > 42) continue;
      if (flagged(label)) offenders.push(`${name}:${i + 1} "${label}"`);
    }
  });
}
check('no Title-Case buttons remain on user-facing pages', offenders.slice(0, 6), []);
check('the web CTA row is sentence case',
  /T\('race\.review-the-results', 'Review the results'\) : T\('race\.live-results', 'Live results'\)/.test(RACE_JS), true);
check('and so is the ledger link',
  /T\('race\.verify-the-record', 'Verify the record'\)\}<\/a>/.test(RACE_JS), true);

/**
 * A TOGGLE IS LABELLED WITH WHAT IT DOES.
 *
 * "Following this race" states how things are and leaves the action to be
 * guessed at — someone wanting out had no reason to think the label announcing
 * the subscription was also the way to end it. The state is still carried, by
 * the icon, the detail line and aria/accessibilityState.
 */
console.log('\n=== the follow control names the action, and is findable ===');
const FOLLOW_TSX = readNative(`${ROOT}/native/src/components/follow-race.tsx`);
const FOLLOW_JS = fs.readFileSync(`${ROOT}/app/follow.js`, 'utf8');
/* Since 00fe7e8 (native tranche 4 batch B) the words live in
   native/src/lib/i18n/en.json behind i18nT('key', { v0: subject }) — a form
   readNative() does not resolve — so resolve the keys here and keep asking what
   the control SAYS. Every `following ? A : B` pair is read, label and a11y label. */
const NATIVE_EN = JSON.parse(fs.readFileSync(`${ROOT}/native/src/lib/i18n/en.json`, 'utf8'));
const FOLLOW_RAW = fs.readFileSync(`${ROOT}/native/src/components/follow-race.tsx`, 'utf8');
const followPairs = [...FOLLOW_RAW.matchAll(
  /following\s*\?\s*i18nT\('([^']+)',\s*\{\s*v0: subject\s*\}\)\s*:\s*i18nT\('([^']+)',\s*\{\s*v0: subject\s*\}\)/g,
)].map((m) => [NATIVE_EN[m[1]], NATIVE_EN[m[2]]]);
check('native says Unfollow once subscribed',
  followPairs.some(([on, off]) => on === 'Unfollow {v0}' && off === 'Follow {v0}'), true);
check('web says Unfollow once subscribed',
  /followed \? '🔕 Unfollow ' : '🔔 Follow '/.test(FOLLOW_JS), true);
check('native no longer says Following in the label',
  followPairs.map(([on]) => /^Following\b/.test(on ?? '')),
  (got) => got.length > 0 && got.every((x) => !x));
// The BUTTON's textContent only. The confirmation message below it still reads
// "🔔 Following this race. You will be alerted…" — that is prose stating a
// state, which is exactly what a message is for, and it is not a control.
check('web no longer writes Following into the button',
  /btn\.textContent = .*Following/.test(FOLLOW_JS), false);
// State is not lost, it moves to where a state belongs.
check('native still reports state to assistive tech',
  /accessibilityState=\{\{ selected: following/.test(FOLLOW_TSX), true);
check('web still sets aria-pressed', /aria-pressed/.test(FOLLOW_JS), true);
const detailKey = (FOLLOW_RAW.match(/const detail = following \? i18nT\('([^']+)'\)/) || [])[1];
check('the detail line still says alerts are on', NATIVE_EN[detailKey], 'Alerts on');
// Visibility: a bare bg-card made the only way out look like a status panel.
check('native gives the subscribed state a border',
  /border border-good-ink bg-card/.test(FOLLOW_TSX), true);
check('web marks the subscribed state', /btn-following/.test(FOLLOW_JS), true);
check('and styles it', /\.race-cta \.btn-quiet\.btn-following/.test(
  fs.readFileSync(`${ROOT}/app/styles.css`, 'utf8')), true);

console.log('\n=== control: this scan can actually find one ===');
// Run through the SAME predicate the scan uses, exemption included, so a
// detector (or an exemption) that swallowed everything would show here.
check('a Title-Case label is detected', flagged('Report Another Unit'), true);
check('a sentence-case one is not', flagged('Report another unit'), false);
check('and a proper noun is left alone', flagged('Install Web App'), false);
check('a Profile label is Title Case and exempt (97454bd)',
  [isTitleCase('Sign Out on This Device'), PROFILE_LABELS.has('Sign Out on This Device'), flagged('Sign Out on This Device')],
  [true, true, false]);
check('the exemption is Profile wording only, not Title Case in general',
  flagged('Save This Report'), true);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

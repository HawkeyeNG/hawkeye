/**
 * PICKING A SEAT OPENS THAT SEAT. It does not re-rank the board.
 *
 * Reported from the app: choosing "Bauchi Federal Constituency" on the
 * Leaderboard produced a board about that one seat — a NATIONAL map with one
 * outline picked out, over a card explaining that this constituency is what the
 * board ranks, over a button offering to go and look at the race the reader had
 * just named. "Should have taken me directly to the race page."
 *
 * It was a native-only divergence, and that is what made it a bug rather than a
 * design question: the WEBSITE has always navigated (race-picker.js:targetUrl),
 * and so has this screen's OWN header picker (components/race-picker.tsx:target).
 * Two affordances on one screen disagreed about what picking a seat means, and
 * the "Rank a single seat instead" panel was the one disagreeing with everything
 * else — including with the by-election rule a few lines below it, which already
 * skips the board for exactly this reason.
 *
 * THE TRAP THIS FILE EXISTS TO GUARD, and the reason the fix is narrow: the
 * board is also where "See live results" ON a race page lands
 * (political.ts:resultsHrefFor -> ?contest=&scope=, handled by applyLink). If
 * that path were routed to the race page too, a reader tapping "See live
 * results" would be bounced straight back to the race they came from — a loop,
 * and a worse bug than the one being fixed. applyLink's scope branch and the
 * map's "Rank X instead" button must both keep calling selectRace.
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const RESULTS = fs.readFileSync(`${ROOT}/native/src/app/(tabs)/results.tsx`, 'utf8');
const RACES = fs.readFileSync(`${ROOT}/native/src/lib/races.ts`, 'utf8');
const PICKER = fs.readFileSync(`${ROOT}/native/src/components/race-picker.tsx`, 'utf8');
const WEB_PICKER = fs.readFileSync(`${ROOT}/app/race-picker.js`, 'utf8');

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

console.log('=== the seat picker navigates ===');
check('results.tsx asks raceHrefFor where the seat lives',
  /onSelect=\{\(r\) => \{[\s\S]{0,200}raceHrefFor\(r, contests\)/.test(RESULTS));
check('  ...and pushes it', /router\.push\(href as never\)/.test(RESULTS));
check('  ...and no longer hands the pick straight to selectRace',
  !/<ContestPicker[^>]*onSelect=\{selectRace\}/.test(RESULTS),
  (RESULTS.match(/onSelect=\{selectRace\}/g) || []).length);
check('a race with no page of its own still ranks, rather than refusing to move',
  /if \(!href\) \{ selectRace\(r\); return; \}/.test(RESULTS));

console.log('\n=== and the two paths that must NOT navigate still do not ===');
/* If either of these were routed, "See live results" would bounce the reader
   back to the race page they pressed it on. */
check('applyLink still scopes the board for a ?scope= link',
  /const r = deepLinkRace\(linkContest, linkScope\);[\s\S]{0,120}setRace\(r\);/.test(RESULTS));
check('the map’s "Rank X instead" button still re-ranks in place',
  /onPress=\{\(\) => selectRace\(jump\)\}/.test(RESULTS));
check('resultsHrefFor still points a race page AT the board',
  /\/\(tabs\)\/results\?\$\{q\.toString\(\)\}/.test(fs.readFileSync(`${ROOT}/native/src/lib/political.ts`, 'utf8')));

console.log('\n=== raceHrefFor answers per contest, and refuses to guess ===');
check('GOV names the state, not a seat', /case 'GOV':[\s\S]{0,120}contest=GOV&state=/.test(RACES));
check('SEN names the district', /case 'SEN':[\s\S]{0,120}contest=SEN&seat=\$\{e\(race\.district\)\}/.test(RACES));
check('REP names the constituency', /case 'REP':[\s\S]{0,120}contest=REP&seat=\$\{e\(race\.constituency\)\}/.test(RACES));
check('SHA carries its state, because seat names repeat across states',
  /case 'SHA':[\s\S]{0,200}contest=SHA&state=\$\{e\(race\.state\)\}&seat=/.test(RACES));
check('a by-election is addressed by its contest code alone',
  /constituencies \?\? \[\]\)\.length\) \{[\s\S]{0,80}\/race\?contest=\$\{e\(def!\.code\)\}/.test(RACES));
check('PRES returns null — one national race, whose board IS the destination',
  /default:\n {6}return null;/.test(RACES));
check('every branch can return null rather than a guessed seat',
  (RACES.match(/: null;/g) || []).length >= 4);

console.log('\n=== the three callers now agree ===');
check('this screen’s header picker navigates (it always did)',
  /router\.push\(target\(code, state, r\.name\) as never\)/.test(PICKER));
check('the website navigates (it always did)',
  /return 'race\.html\?' \+ q/.test(WEB_PICKER));
check('and the Leaderboard seat picker now does too',
  RESULTS.includes('raceHrefFor(r, contests)'));

/**
 * CONTROL. The greps above are patterns over source, and a pattern that stops
 * matching reads exactly like a passing test unless something proves it can
 * fail. Plant both directions.
 */
console.log('\n=== CONTROL: the checks must fail on the code they replaced ===');
{
  const before = failed;
  const old = RESULTS.replace(
    /onSelect=\{\(r\) => \{[\s\S]*?\n {16}\}\}/,
    'onSelect={selectRace}',
  );
  const caught = /<ContestPicker[^>]*onSelect=\{selectRace\}/.test(old) || /onSelect=\{selectRace\}/.test(old);
  console.log(`${caught ? 'PASS' : 'FAIL'}  CONTROL the old onSelect={selectRace} is detectable`);
  if (!caught) failed++;
  const loopy = RESULTS.replace(/const r = deepLinkRace\(linkContest, linkScope\);/, 'router.push("/race");');
  const loopCaught = !/const r = deepLinkRace\(linkContest, linkScope\);[\s\S]{0,120}setRace\(r\);/.test(loopy);
  console.log(`${loopCaught ? 'PASS' : 'FAIL'}  CONTROL routing applyLink's scope branch WOULD be caught (that is the loop)`);
  if (!loopCaught) failed++;
  failed = before + (caught ? 0 : 1) + (loopCaught ? 0 : 1);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

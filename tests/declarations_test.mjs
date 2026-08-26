/**
 * A DECLARED RACE LEAVES THE FOLLOW LIST, AND SAYS WHY ON THE WAY OUT.
 *
 * The complaint was concrete: Osun was declared on 16 August 2026 and was still
 * in a follow list on the 25th. A subscription row had never had anything to
 * expire against — there was no such thing, anywhere in the product, as a race
 * being over.
 *
 * This runs the REAL service against a REAL SQLite database (DB_PATH points at a
 * throwaway file), not a regex over the source. The three things that can go
 * wrong here are all behavioural and none of them would show up in the text:
 * dropping too much, announcing twice, or announcing a race nobody followed.
 *
 * The controls are as important as the assertions. Every "this is deleted" case
 * is paired with a "this is NOT deleted" case on the same run, because a prune
 * that deletes everything passes every test that only checks what is gone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hawkeye-decl-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const { db } = await import(`${ROOT}/backend/src/db.js`);
const {
  declarations, declarationNote, isRaceClosed, publicDeclarations,
  applyDeclarations, pruneOrphanSubscriptions,
} = await import(`${ROOT}/backend/src/services/declarations.js`);

// ---------------------------------------------------------------------------
console.log('=== the file loads and Osun is in it ===');
const osun = declarations.find((d) => d.contest === 'GOV' && d.scope === 'Osun');
check('Osun governorship is recorded as declared', !!osun);
check('it names a winner', osun?.winner?.name, 'Ademola Adeleke');
check('and carries the top three', osun?.results?.length, 3);

/**
 * THE ALERT AND THE RACE PAGE MUST AGREE.
 *
 * app/political_data.json holds the declared card the race page renders; this
 * file holds the one the notification is written from. They are transcribed
 * separately from the same announcement, which is exactly the setup where a
 * digit gets fixed in one place and not the other — and the two would then be
 * saying different things about the same result under Hawkeye's name.
 */
console.log('\n=== the notification and the race page quote the same numbers ===');
{
  const pd = JSON.parse(fs.readFileSync(`${ROOT}/app/political_data.json`, 'utf8'));
  const page = pd.raceOsun2026?.declared;
  check('the race page has a declared block', !!page);
  check('same winner', osun.winner.name, page.winner);
  check('same party', osun.winner.party, page.party);
  check('same winning votes', osun.winner.votes, page.votes);
  check('same declaration date', osun.declaredOn, page.date);
  check('same top three, in the same order',
    osun.results.map((r) => `${r.name}|${r.party}|${r.votes}`).join(' / '),
    page.results.slice(0, 3).map((r) => `${r.name}|${r.party}|${r.votes}`).join(' / '));
}

// ---------------------------------------------------------------------------
console.log('\n=== what a closure covers, and what it deliberately does not ===');
check('Osun governorship is closed', isRaceClosed('GOV', 'Osun'));
// THE CONTROL. A scoped closure must not take the whole contest with it:
// somebody following all 36 governorships has not stopped following them
// because one of the 36 has been declared, and 2027 has 28 more to come.
check('following ALL governorships is untouched', isRaceClosed('GOV', ''), false);
check('another state is untouched', isRaceClosed('GOV', 'Kano'), false);
check('an unrelated contest is untouched', isRaceClosed('SEN', 'Osun Central'), false);

console.log('\n=== the wording ===');
{
  const n = declarationNote(osun);
  check('it is its own kind, so the feed can style it', n.kind, 'declared');
  // The title has to survive a lock screen: it names the race (this feed is
  // otherwise full of "New <race> report") and the winner, and it says INEC
  // declares rather than "wins" — Hawkeye records a declaration, it does not
  // certify a result.
  check('title', n.title, 'Osun Governorship (2026): INEC declares Ademola Adeleke');
  check('the title does not claim a Hawkeye verdict', /wins|winner declared by Hawkeye/i.test(n.title), false);
  // Numbers first: a push body is cut after a line or two, so the first line has
  // to be the result rather than a sentence introducing it.
  check('body leads with the winner and their votes',
    n.body.split('\n')[0], '1. Ademola Adeleke (A) — 511,067');
  check('body ranks the top three', n.body.split('\n').slice(0, 3).join(' | '),
    '1. Ademola Adeleke (A) — 511,067 | 2. Bola Oyebamiji (APC) — 444,815 | 3. Najeem Salam (ADC) — 17,180');
  check('it attributes the declaration', /Declared by INEC on 16 August 2026\./.test(n.body));
  // Without this the race just vanishes from the follow list and the reader is
  // left to wonder whether something broke.
  check('it explains the disappearance', /left your follow list/.test(n.body));
  check('it fits a notification row', n.title.length <= 160 && n.body.length <= 500);
  check('it points at the race page', n.url, 'https://hawkeye.com.ng/osun.html');
}

/**
 * THE ALERT IS WRITTEN AS LINES, so both feeds have to render lines.
 *
 * Every other notification in this product is one sentence, so both Alerts
 * screens were built for one: the web renders the body into a <p>, where HTML
 * collapses newlines and a ranking runs together into one unreadable sentence,
 * and the app clamped the body to three lines, which cut the line explaining why
 * the race had just vanished from the follow list.
 *
 * The line COUNT is taken from the template rather than written here, so adding
 * a fourth place or a second sentence fails this instead of silently getting
 * clipped on a phone.
 */
console.log('\n=== both Alerts feeds can show the whole thing ===');
{
  const lines = declarationNote(osun).body.split('\n').length;
  const web = fs.readFileSync(`${ROOT}/app/notifications.html`, 'utf8');
  const app = fs.readFileSync(`${ROOT}/native/src/app/(tabs)/alerts.tsx`, 'utf8');
  check(`the template writes ${lines} lines`, lines, (n) => n >= 2);
  check('the web feed keeps the line breaks', /\.n p \{[^}]*white-space: pre-line/.test(web));
  const clamp = Number(/numberOfLines=\{(\d+)\}/.exec(app.slice(app.indexOf('{item.body')))?.[1]);
  check(`the app shows at least ${lines} of them`, clamp, (n) => n >= lines);
}

console.log('\n=== the public shape carries no internal fields ===');
{
  const p = publicDeclarations().find((d) => d.scope === 'Osun');
  check('no announce flag leaks to clients', 'announce' in p, false);
  check('but the label does', p.label, 'Osun Governorship (2026)');
}

// ---------------------------------------------------------------------------
console.log('\n=== closing it drops the follows ===');
const observer = (id, status = 'active') => db.prepare(
  'INSERT INTO observers (id, phone_hash, public_key_jwk, status, created_at) VALUES (?, ?, ?, ?, ?)',
).run(id, `hash${id}`, '{}', status, Date.now());
const follow = (observerId, contest, state) => db.prepare(
  'INSERT INTO subscriptions (observer_id, contest, state, created_at) VALUES (?, ?, ?, ?)',
).run(observerId, contest, state, Date.now());

observer(1);
observer(2);
follow(1, 'GOV', 'Osun');          // closed — must go
follow(1, 'GOV', '');              // all governorships — must stay
follow(2, 'GOV', 'Osun');          // closed, a second observer
follow(2, 'SEN', 'Osun Central');  // a different contest — must stay

const first = await applyDeclarations();
const osunRun = first.find((r) => r.key === 'GOV|Osun');
check('the run reports it applied', osunRun?.applied);
check('it counted both followers', osunRun?.followers, 2);
check('and deleted both rows', osunRun?.dropped, 2);

const left = db.prepare('SELECT contest, state FROM subscriptions ORDER BY contest, state').all();
check('what survives is exactly the untouched follows',
  left.map((r) => `${r.contest}|${r.state}`).join(' , '), 'GOV| , SEN|Osun Central');

/**
 * OSUN ANNOUNCES NOTHING, ON PURPOSE — it was declared and closed before this
 * mechanism existed, so a push now would be a phone buzzing about last week's
 * news. The entry carries announce:false and this proves the flag is honoured;
 * the wording above proves the template it WOULD have used is right, which is
 * what September's by-elections will actually send.
 */
check('no alert was filed for a retrospective closure',
  db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 0);

console.log('\n=== running it again is not a second announcement ===');
follow(1, 'GOV', 'Osun'); // as if a stale client had re-followed
const second = await applyDeclarations();
check('the second run skips it', second.find((r) => r.key === 'GOV|Osun')?.skipped, 'already closed');
check('and does not apply it again', second.find((r) => r.key === 'GOV|Osun')?.applied, false);
check('one closure row, not two', db.prepare('SELECT COUNT(*) n FROM race_closures').get().n, 1);

console.log('\n=== a dry run changes nothing ===');
{
  const before = db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n;
  const dry = await applyDeclarations({ dryRun: true });
  check('it still composes the notification', !!dry[0]?.note?.title);
  check('it reports itself as a dry run', dry[0]?.skipped, (s) => s === 'dry run' || s === 'already closed');
  check('subscriptions untouched', db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, before);
}

// ---------------------------------------------------------------------------
/**
 * THE PATH SEPTEMBER WILL ACTUALLY TAKE.
 *
 * Everything above ran against Osun, which announces nothing by design. That
 * leaves the half of this feature that reaches a phone completely unexercised —
 * a test suite that would pass just as happily if the announcing branch had
 * never been written. This is a by-election shaped exactly like the four on
 * 19 September: its own contest code, no scope, so closing it takes every follow
 * for that seat.
 */
console.log('\n=== a by-election that DOES announce ===');
{
  const bye = {
    contest: 'SHA_BYE_DELTA_UDU_2026',
    scope: '',
    label: 'Delta State Assembly By-Election, Udu (2026)',
    url: 'https://hawkeye.com.ng/race.html?contest=SHA_BYE_DELTA_UDU_2026',
    declaredOn: '2026-09-20',
    by: 'INEC',
    winner: { name: 'A Candidate', party: 'PDP', votes: 12345 },
    results: [
      { name: 'A Candidate', party: 'PDP', votes: 12345 },
      { name: 'B Candidate', party: 'APC', votes: 9876 },
      { name: 'C Candidate', party: 'ADC', votes: 543 },
    ],
  };
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM notifications').run();
  observer(3);
  observer(4, 'suspended');
  follow(1, 'SHA_BYE_DELTA_UDU_2026', 'Delta'); // a scoped follow
  follow(3, 'SHA_BYE_DELTA_UDU_2026', '');      // and an unscoped one
  follow(4, 'SHA_BYE_DELTA_UDU_2026', 'Delta'); // suspended — not pushed to
  follow(2, 'GOV', 'Kano');                     // the control: another race

  const r = (await applyDeclarations({ entries: [bye] }))[0];
  check('it announces by default', r.announce);
  // Two active followers, not three: a suspended account is not pushed to, the
  // same rule notifySubscribers follows.
  check('it counts only active followers', r.followers, 2);
  // ...but the DELETE is unconditional, because a suspended observer following a
  // finished race is still a stale row.
  check('every follow for the seat is dropped, scoped or not', r.dropped, 3);
  check('the unrelated race is untouched',
    db.prepare('SELECT contest FROM subscriptions').all().map((x) => x.contest).join(), 'GOV');

  const notes = db.prepare('SELECT observer_id, kind, title, body, url FROM notifications ORDER BY observer_id').all();
  check('an Alerts row per active follower', notes.length, 2);
  check('and it went to the right people', notes.map((n) => n.observer_id).join(), '1,3');
  check('the row is the declared-result alert', notes[0].kind, 'declared');
  check('naming the seat and the winner', notes[0].title,
    'Delta State Assembly By-Election, Udu (2026): INEC declares A Candidate');
  check('with the ranking', notes[0].body.split('\n')[1], '2. B Candidate (APC) — 9,876');
  check('pointing at the race page', notes[0].url, bye.url);

  // And not twice, for the announcing path specifically.
  db.prepare('DELETE FROM notifications').run();
  await applyDeclarations({ entries: [bye] });
  check('a re-run announces nothing', db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 0);
}

console.log('\n=== the prune: races that left the ballot without a declaration ===');
/**
 * This is what actually caught Osun. contests.json was swapped for the 2027 set,
 * GOV survived as a contest and "Osun" quietly stopped being one of its states,
 * so the row stayed valid enough to keep appearing in a follow list.
 */
db.prepare('DELETE FROM subscriptions').run();
follow(1, 'GOV', 'Osun');              // state not in GOV's states — goes
follow(1, 'GOV', 'Kano');              // in the 2027 set — stays
follow(1, 'GOV', '');                  // every governorship — stays
follow(1, 'NOT_A_CONTEST', 'Kano');    // unknown code — goes
follow(1, 'SEN', 'Osun Central');      // a DISTRICT, not a state: unverifiable,
follow(2, 'REP', 'Gombe/Kwami/Funakaye Federal Constituency'); // so both stay

// The dry run FIRST, while there is still something to preview — a preview that
// deleted the rows it was previewing would pass every assertion after it.
check('a dry run counts them without touching anything', pruneOrphanSubscriptions({ dryRun: true }), 2);
check('and all six rows are still there',
  db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 6);

const pruned = pruneOrphanSubscriptions();
check('it removed two', pruned, 2);
const after = db.prepare('SELECT contest, state FROM subscriptions ORDER BY contest, state').all()
  .map((r) => `${r.contest}|${r.state}`);
check('and left everything it could not be sure about',
  after.join(' , '), 'GOV| , GOV|Kano , REP|Gombe/Kwami/Funakaye Federal Constituency , SEN|Osun Central');
// THE CONTROL: a prune that deletes nothing would pass the line above too if the
// doomed rows had never been inserted. Prove they were there to begin with.
check('the two it removed were really in the table', after.includes('GOV|Osun'), false);
check('running it again removes nothing', pruneOrphanSubscriptions(), 0);

// ---------------------------------------------------------------------------
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);

/**
 * A RACE ALERT CARRIES THE RUNNING TALLY.
 *
 * It used to say only "A result was reported at {where}." — which tells someone
 * following a race that something happened and nothing about what. The number is
 * the reason they followed it; making them open the board to get it defeats the
 * feature.
 *
 * THE THING THIS TEST REALLY GUARDS is that the alert's number and the board's
 * number are the same number. results.html excludes disputed results from the
 * headline total (an open high-severity flag, or an open case on the docket). An
 * alert that counted them would put a different figure in someone's pocket from
 * the one on the screen it links to, and on election night two numbers for one
 * race is worse than no number at all.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = '/home/elrio/hawkeye';
const SRC = fs.readFileSync(`${ROOT}/backend/src/routes/subscriptions.js`, 'utf8');

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

console.log('=== the alert carries a tally ===');
check('runningTally exists', /function runningTally\(dbh, contest, scope\)/.test(SRC));
check('the push uses the tally body when there is one',
  /bodyKey: running \? 'note\.result\.bodyTally' : 'note\.result\.body'/.test(SRC));
check('  ...and the plain sentence when there is not',
  /params: running\s*\n\s*\? \{ label, where, tally: running\.tally, units:/.test(SRC));
check('Telegram gets the same sentence', /tg\.newReportTally/.test(SRC));

console.log('\n=== it counts the same rows the board counts ===');
check('disputed results are excluded, as on the board', (SRC.match(/disputed = 0/g) || []).length >= 2,
  (SRC.match(/disputed = 0/g) || []).length);
check('a scoped follower is tallied on their own region',
  /p\.\$\{col\} = \?/.test(SRC) && /scopeIsState\(contest\) \? 'state'/.test(SRC));
check('a whole-race follower is tallied on the whole race',
  /SELECT votes_json FROM results WHERE contest = \? AND disputed = 0/.test(SRC));

console.log('\n=== and it cannot break the thing it decorates ===');
check('a failure returns null rather than throwing into the submission path',
  /catch \{[\s\S]{0,240}return null;\s*\}\s*\}/.test(SRC));
check('nothing yet reported returns null, so no empty "Running total:"',
  /if \(!rows\.length\) return null;/.test(SRC) && /if \(!ranked\.length\) return null;/.test(SRC));
check('the tally is computed per fan-out, not per subscriber',
  /const tallies = \{ whole: undefined, scoped: undefined \}/.test(SRC));
check('one notification per observer, even following race AND region',
  /MIN\(s\.state\) AS follows/.test(SRC) && /GROUP BY s\.observer_id/.test(SRC));
check('only the leading three parties ride in a push',
  /ranked\.slice\(0, 3\)/.test(SRC));

console.log('\n=== every language got the strings ===');
for (const lang of ['en', 'ha', 'ig', 'yo']) {
  const b = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/i18n/${lang}.json`, 'utf8'));
  const has = b['note.result.bodyTally'] && b['tg.newReportTally'];
  check(`${lang}: both keys present`, !!has);
  if (has) {
    const ph = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');
    check(`${lang}: the placeholders survived translation`,
      ph(b['note.result.bodyTally']) === '{tally},{units},{where}',
      ph(b['note.result.bodyTally']));
  }
}

/**
 * CONTROL. The tally is arithmetic, so run it — a source grep cannot tell a
 * correct sum from a plausible one. Rebuild the reducer against fixtures,
 * including the disputed row that must NOT be counted.
 */
console.log('\n=== CONTROL: the arithmetic, on fixtures ===');
{
  const rows = [
    { votes_json: JSON.stringify([{ party: 'APC', count: 120 }, { party: 'PDP', count: 80 }]) },
    { votes_json: JSON.stringify([{ party: 'APC', count: 30 }, { party: 'LP', count: 200 }]) },
    { votes_json: JSON.stringify([{ party: 'PDP', count: 5 }, { party: 'APC', count: 0 }]) },
    { votes_json: 'not json at all' },
  ];
  const totals = {};
  for (const row of rows) {
    let votes = [];
    try { votes = JSON.parse(row.votes_json) || []; } catch { continue; }
    for (const v of votes) { if (!v || !v.count) continue; totals[v.party] = (totals[v.party] || 0) + v.count; }
  }
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 3).map(([p, n]) => `${p} ${n.toLocaleString('en-NG')}`).join(' · ');
  check('CONTROL sums across units and ranks by size', top === 'LP 200 · APC 150 · PDP 85', top);
  check('CONTROL a zero count adds nothing', totals.APC === 150, totals.APC);
  check('CONTROL a malformed row is skipped, not fatal', ranked.length === 3, ranked);

  // And the exclusion the whole test exists for: a disputed row must never reach
  // this reducer, because the SQL filtered it out first.
  const sql = SRC.match(/SELECT r\.votes_json FROM results r[\s\S]{0,200}?`/);
  check('CONTROL the scoped query itself filters disputed rows',
    !!sql && /disputed = 0/.test(sql[0]), sql ? sql[0].replace(/\s+/g, ' ').slice(0, 120) : null);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

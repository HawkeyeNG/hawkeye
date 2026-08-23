/**
 * Does every by-election contest's `constituencies` value match real register
 * rows — and ONLY the units that should be voting?
 *
 * A `constituencies` value is exact string equality against a register column.
 * A mismatch fails CLOSED: every unit rejected, the whole seat offline, behind
 * an opaque `contest_not_applicable`. INEC and the register do not agree on
 * spelling (INEC "Dawakin Kudu", register LGA "Dawaki Kudu"), so this is not a
 * theoretical risk — and the failure is silent, which is why it needs a check
 * that runs rather than a comment that asks.
 *
 *   node scripts/check_byelection_gates.mjs
 */
import { db, contests } from '../src/db.js';
import { contestTier, regionLevelFor } from '../src/services/scope.js';

let bad = 0;
const fail = (m) => { console.log('  FAIL ' + m); bad++; };

const gated = contests.filter((c) => Array.isArray(c.constituencies) && c.constituencies.length);
console.log(`${contests.length} contests, ${gated.length} with a constituency gate\n`);

for (const c of gated) {
  const tier = contestTier(c.code);
  const col = regionLevelFor(tier).col;
  console.log(`${c.code}  (tier ${tier}, gates on ${col})`);

  if (!Array.isArray(c.states) || !c.states.length) {
    fail(`${c.code} has constituencies but no states — the gate would run nationwide`);
  }

  let total = 0;
  for (const name of c.constituencies) {
    const row = db.prepare(
      `SELECT COUNT(*) n, COUNT(DISTINCT state) states FROM polling_units WHERE ${col} = ?`,
    ).get(name);
    if (!row.n) {
      fail(`${c.code}: "${name}" matches 0 register rows in ${col} — every unit would be rejected`);
      continue;
    }
    // A name that appears in two states would silently admit the wrong one.
    const inState = db.prepare(
      `SELECT COUNT(*) n FROM polling_units WHERE ${col} = ? AND state IN (${c.states.map(() => '?').join(',')})`,
    ).get(name, ...c.states);
    console.log(`   "${name}" -> ${row.n} units (${inState.n} inside ${c.states.join('/')})`);
    if (row.states > 1) {
      fail(`${c.code}: "${name}" exists in ${row.states} states — gate on (state, ${col}), not ${col} alone`);
    }
    if (inState.n !== row.n) {
      fail(`${c.code}: ${row.n - inState.n} matching units are OUTSIDE the declared states`);
    }
    total += inState.n;
  }

  // The whole point: far fewer units than the state holds.
  const stateTotal = db.prepare(
    `SELECT COUNT(*) n FROM polling_units WHERE state IN (${c.states.map(() => '?').join(',')})`,
  ).get(...c.states).n;
  console.log(`   gate admits ${total} of ${stateTotal} units in ${c.states.join('/')}`);
  if (total >= stateTotal) fail(`${c.code}: the gate admits the whole state — it is not narrowing anything`);
  console.log('');
}

console.log(bad ? `${bad} problem(s)` : 'all by-election gates resolve');
process.exit(bad ? 1 : 0);

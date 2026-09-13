/**
 * WHO MAY APPOINT WHOM, checked against the real register.
 *
 * The rule this guards is not "a manager can promote people" — it is that
 * delegation only ever goes DOWNWARD and never leaves the delegator's own
 * ground. Both halves fail silently: a coordinator who could appoint a peer
 * over their own area would simply be overruled in it one day, and a state
 * coordinator who could scope somebody to an identically-named ward in the next
 * state would hand a stranger authority over units nobody meant to give away.
 * Neither produces an error anyone would see.
 *
 * Ward names repeat nationally, so the containment cases below are drawn from
 * the register at run time: a real ward, and a DIFFERENT state that also has a
 * ward of that name. If the register ever stops containing such a pair the test
 * says so rather than quietly checking nothing.
 *
 *   node tests/role_ladder_test.mjs
 */
import { db } from '../backend/src/db.js';
import { rankOf, scopeInside, canGrant, canActOn, scopeClause } from '../backend/src/routes/groups.js';

let fail = 0;
const ok = (cond, what) => {
  if (!cond) { fail += 1; console.log('FAIL  ' + what); } else console.log('ok    ' + what);
};

const OWNER = { role: 'owner', scope_kind: '', scope_value: '' };
const MANAGER = { role: 'manager', scope_kind: '', scope_value: '' };
const co = (k, v) => ({ role: 'coordinator', scope_kind: k, scope_value: v });

/* --- the ladder itself ------------------------------------------------- */
ok(rankOf(OWNER) === 0 && rankOf(MANAGER) === 1, 'owner outranks manager');
ok(rankOf(co('zone', 'x')) < rankOf(co('state', 'x')), 'zone outranks state');
ok(rankOf(co('state', 'x')) < rankOf(co('lga', 'x')), 'state outranks lga');
ok(rankOf(co('lga', 'x')) < rankOf(co('ward', 'x')), 'lga outranks ward');
ok(rankOf({ role: 'observer', scope_kind: '', scope_value: '' }) > 5, 'a plain observer is below every role');

/* --- who may appoint a MANAGER ----------------------------------------- */
ok(canGrant(OWNER, 'manager', '', '') === true, 'the owner appoints managers');
ok(canGrant(MANAGER, 'manager', '', '') === false, 'a manager cannot appoint another manager');
ok(canGrant(co('zone', 'North West'), 'manager', '', '') === false, 'a coordinator cannot appoint a manager');

/* --- real geography for the containment cases -------------------------- */
const seed = db.prepare(`
  SELECT a.state, a.lga, a.ward FROM polling_units a
   WHERE EXISTS (SELECT 1 FROM polling_units b WHERE b.ward = a.ward AND b.state != a.state)
   LIMIT 1`).get();
if (!seed) { console.log('FAIL  register has no ward name shared across two states — containment is untested'); fail += 1; }
const other = seed && db.prepare('SELECT state, lga FROM polling_units WHERE ward = ? AND state != ? LIMIT 1')
  .get(seed.ward, seed.state);
if (seed) console.log('      using ward "' + seed.ward + '" in ' + seed.state + ' and ' + other.state);

/* --- a manager may appoint every coordinator, anywhere ----------------- */
ok(canGrant(MANAGER, 'coordinator', 'state', seed.state) === true, 'a manager appoints a state coordinator');
ok(canGrant(MANAGER, 'coordinator', 'ward', seed.ward) === true, 'a manager appoints a ward coordinator');

/* --- downward only ------------------------------------------------------ */
const ST = co('state', seed.state);
ok(canGrant(ST, 'coordinator', 'lga', seed.lga) === true, 'a state coordinator appoints an LGA coordinator in their state');
ok(canGrant(ST, 'coordinator', 'ward', seed.ward) === true, 'a state coordinator appoints a ward coordinator in their state');
ok(canGrant(ST, 'coordinator', 'state', seed.state) === false, 'a state coordinator cannot appoint a peer over their own state');
ok(canGrant(ST, 'coordinator', 'zone', 'North West') === false, 'a state coordinator cannot appoint above themselves');
ok(canGrant(co('ward', seed.ward), 'coordinator', 'ward', seed.ward) === false, 'a ward coordinator appoints nobody');

/* --- and never outside your own ground --------------------------------- */
ok(scopeInside(ST, 'ward', seed.ward) === true, 'the ward in my state is inside my state');
ok(canGrant(co('state', other.state), 'coordinator', 'lga', seed.lga) === false,
  'a coordinator in ' + other.state + ' cannot scope anyone to an LGA of ' + seed.state);
/* THE CONTROL for the whole containment half: the SAME ward name, one state
   over. A rule written on names instead of units would pass every check above
   and fail only this one. */
ok(canGrant(co('state', other.state), 'coordinator', 'ward', seed.ward) === true,
  'that state has its own ward of the same name, so the name alone proves nothing');
ok(scopeInside(co('lga', seed.lga), 'ward', seed.ward) === true, 'the ward is inside its own LGA');
ok(scopeInside(co('lga', other.lga), 'ward', seed.ward) === true, 'and inside the OTHER LGA of the same ward name');

/* --- acting on someone who already holds a role ------------------------ */
ok(canActOn(OWNER, MANAGER) === true, 'the owner may demote a manager');
ok(canActOn(MANAGER, OWNER) === false, 'a manager may not touch the owner');
ok(canActOn(OWNER, OWNER) === false, 'not even the owner may remove the owner');
ok(canActOn(MANAGER, MANAGER) === false, 'a manager may not demote a peer');
ok(canActOn(MANAGER, ST) === true, 'a manager may demote a coordinator');
ok(canActOn(ST, co('ward', seed.ward)) === true, 'a state coordinator may demote a ward coordinator in their state');
ok(canActOn(co('state', other.state), co('lga', seed.lga)) === false,
  'a coordinator may not demote one in another state');
ok(canActOn(ST, null) === true, 'anyone with a role may act on a plain member (canGrant decides the rest)');

/* --- the unplaced belong to everyone ------------------------------------- */
/* An observer nobody has assigned yet has no area, so a scope test on their
   (absent) unit excluded them from EVERY coordinator's roster at once. They
   were invisible to all of them and were precisely the people who needed
   placing. The roster passes orNullCol for that reason; nothing else does,
   because a NULL unit on a SUBMISSION is not the same claim. */
{
  const roster = scopeClause(ST, 'apu', 'm.assigned_pu');
  const plain = scopeClause(ST, 'apu');
  ok(/m\.assigned_pu IS NULL OR/.test(roster.sql), 'the roster lets an unassigned member through');
  ok(!/IS NULL/.test(plain.sql), 'CONTROL: nothing else does — the default clause is unchanged');
  ok(JSON.stringify(roster.params) === JSON.stringify(plain.params),
    'and the widening adds no parameters, so the bound values still line up');
  const zone = scopeClause(co('zone', 'South South'), 'apu', 'm.assigned_pu');
  ok(zone.params.length > 1 && /IN \(/.test(zone.sql) && /IS NULL OR/.test(zone.sql),
    'a zone scope keeps its IN-list when widened');
  ok(scopeClause(OWNER, 'apu', 'm.assigned_pu').sql === '',
    'an unscoped reader still gets no clause at all, widened or not');
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall role-ladder checks passed');
process.exit(fail ? 1 : 0);

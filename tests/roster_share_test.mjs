/**
 * COPYING A ROSTER MUST NOT COPY CONSENT.
 *
 * A campaign manager can now lift a roster from another campaign they own, or
 * from a CSV a sister campaign sent them. The thing that must hold is that
 * nobody arrives as a member: joining a group is what tells a campaign which
 * published reports are yours, and consent given to the presidential campaign
 * in January is not consent given to the governorship one in February.
 *
 * So this drives the REAL routes over the REAL router — express, a real JWT, a
 * real database — and asserts the boundary from the outside, the way the room
 * sees it. Everything it writes is rolled back at the end, including on a
 * failure, so it can be run against the working database.
 *
 *   node tests/roster_share_test.mjs
 */
/* express and jsonwebtoken live in backend/node_modules, not the repo root. */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/backend/');
const express = require_('express');
const jwt = require_('jsonwebtoken');
import { db } from '../backend/src/db.js';
import { config } from '../backend/src/config.js';
import { groupsRouter } from '../backend/src/routes/groups.js';

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

/* --- a throwaway world, inside one transaction ---------------------------- */
db.exec('BEGIN');
let server;
const cleanup = () => {
  try { db.exec('ROLLBACK'); } catch { /* already closed */ }
  if (server) server.close();
};
process.on('exit', cleanup);

const t0 = Date.now();
const mkObserver = (name) => {
  const info = db.prepare(
    "INSERT INTO observers (phone_hash, public_key_jwk, status, created_at) VALUES (?, '{}', 'active', ?)",
  ).run('test-' + name + '-' + t0, t0);
  return Number(info.lastInsertRowid);
};
const OWNER = mkObserver('owner');
const A = mkObserver('a');
const B = mkObserver('b');
const OUTSIDER = mkObserver('outsider');

const mkGroup = (name) => {
  const info = db.prepare(
    "INSERT INTO campaign_groups (name, kind, contest, scope, slug, created_by, created_at) VALUES (?, 'campaign', 'PRES', '', ?, ?, ?)",
  ).run(name, name.toLowerCase() + '-' + t0, OWNER, t0);
  const id = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO group_managers (group_id, observer_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(id, OWNER, t0);
  return id;
};
const OLD = mkGroup('PresRoom' + t0);
const NEW = mkGroup('GovRoom' + t0);

const join = (gid, obs) => db.prepare(
  "INSERT INTO group_members (group_id, observer_id, assign_state, member_state, joined_at) VALUES (?, ?, '', '', ?)",
).run(gid, obs, t0);
join(OLD, OWNER); join(OLD, A); join(OLD, B);
join(NEW, OWNER); join(NEW, B);   // B is in both already — must not be asked twice

/* --- the real router, on a real port -------------------------------------- */
const app = express();
app.use(express.json());
app.use('/api', groupsRouter);
server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const tok = (id) => jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: '10m' });
const call = async (who, path, init = {}) => {
  const r = await fetch(base + path, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok(who), ...(init.headers || {}) },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

try {
  /* --- who can be copied from ------------------------------------------- */
  const src = await call(OWNER, `/api/groups/${NEW}/sources`);
  const row = (src.body.sources || []).find((x) => x.id === OLD);
  check('the other campaign is offered as a source', !!row, true);
  /* OWNER and B are already on the new roster, so only A is copyable. */
  check('and it counts only the people not already here', row && row.copyable, 1);
  check('an outsider cannot read the source list', (await call(OUTSIDER, `/api/groups/${NEW}/sources`)).status, 403);

  /* --- the copy ---------------------------------------------------------- */
  const cp = await call(OWNER, `/api/groups/${NEW}/copy-members`, {
    method: 'POST', body: JSON.stringify({ from_group_id: OLD }),
  });
  check('copying reports how many were asked', cp.body.invited, 1);
  const second = await call(OWNER, `/api/groups/${NEW}/copy-members`, {
    method: 'POST', body: JSON.stringify({ from_group_id: OLD }),
  });
  check('running it again asks nobody twice', second.body.invited, 0);

  /* --- THE BOUNDARY ------------------------------------------------------ */
  const teamBefore = await call(OWNER, `/api/groups/${NEW}/team`);
  const ids = (teamBefore.body.members || []).map((m) => m.observer_id);
  check('the copied observer is NOT on the roster before answering', ids.includes(A), false);
  check('CONTROL: someone who did join IS on it', ids.includes(B), true);
  const detail = await call(OWNER, `/api/groups/${NEW}/detail-probe`).catch(() => null);
  void detail;
  const g = await call(OWNER, `/api/groups/${NEW}`);
  check('the campaign is told only a COUNT of who is pending', g.body.pending, 1);
  check('and the member total does not include them', g.body.members, 2);

  /* --- the answer -------------------------------------------------------- */
  check('a stranger cannot accept on their behalf', (await call(OUTSIDER, `/api/groups/${NEW}/accept`, { method: 'POST' })).status, 404);
  check('the copied observer accepts', (await call(A, `/api/groups/${NEW}/accept`, { method: 'POST' })).status, 200);
  const after = (await call(OWNER, `/api/groups/${NEW}/team`)).body.members.map((m) => m.observer_id);
  check('and only then do they appear', after.includes(A), true);
  check('accepting twice is not a thing', (await call(A, `/api/groups/${NEW}/accept`, { method: 'POST' })).status, 404);

  /* joined_at must be the moment of CONSENT, not of the copy — the feed shows
     a member's reports from joined_at forward, so leaving it at the copy date
     would hand the new campaign reports filed before anyone agreed. */
  const jat = db.prepare('SELECT joined_at FROM group_members WHERE group_id = ? AND observer_id = ?').get(NEW, A).joined_at;
  check('joined_at is stamped at acceptance, not at the copy', jat > t0, true);

  /* --- the CSV ----------------------------------------------------------- */
  const csv = await call(OWNER, `/api/groups/${OLD}/roster.csv`);
  const lines = String(csv.body).split('\n');
  const header = lines.find((l) => l.startsWith('share_code'));
  const data = lines.filter((l) => l && !l.startsWith('#') && !l.startsWith('share_code'));
  check('the roster exports a share_code column', header, 'share_code,label');
  check('with a row per member', data.length, 3);
  const codes = data.map((l) => l.split(',')[0]);
  check('codes are 12 unambiguous base32 characters', codes,
    (c) => c.every((x) => /^[0-9A-HJKMNP-TV-Z]{12}$/.test(x)));
  check('a code is not the observer id', codes, (c) => !c.some((x) => String(Number(x)) === x));
  /* WHAT IS NOT IN IT. A unit is where a person will be standing on election
     day; one campaign does not hand that to another about someone who has not
     agreed to it. */
  /* The DATA, not the commentary. The header block says in words that a unit
     and a phone number are deliberately absent, and the first version of this
     check read those very words as evidence that they were present — it failed
     on the sentence promising the thing it was checking for. */
  check("no phone number, unit or assignment travels with it", [header, ...data].join("\n"),
    (t) => !/phone|pu_code|assigned|[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}/.test(t));
  check('the file explains that importing it only ASKS', String(csv.body), (t) => /INVITES|invites/.test(t));
  check('a non-owner cannot export the roster', (await call(OUTSIDER, `/api/groups/${OLD}/roster.csv`)).status, 403);

  /* --- and back in again -------------------------------------------------- */
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND observer_id = ?').run(NEW, A);
  const imp = await call(OWNER, `/api/groups/${NEW}/import-roster`, {
    method: 'POST', body: JSON.stringify({ codes: [...codes, 'ZZZZZZZZZZZZ'] }),
  });
  check('importing a roster asks the ones it recognises', imp.body.invited, 1);
  check('and REPORTS the rows it did not recognise', imp.body.unknown, 1);
  const teamAfterImport = (await call(OWNER, `/api/groups/${NEW}/team`)).body.members.map((m) => m.observer_id);
  check('an imported observer is invisible until they answer too', teamAfterImport.includes(A), false);
  /* A hand-made file cannot reach anybody: the codes are an HMAC under the
     server's secret, so guessing one is the whole point of not using ids. */
  const forged = await call(OWNER, `/api/groups/${NEW}/import-roster`, {
    method: 'POST', body: JSON.stringify({ codes: ['00000000000A', '00000000000B', String(OUTSIDER)] }),
  });
  check('CONTROL: invented codes reach nobody', forged.body.invited, 0);
  check('and an observer id typed in as a code is not a code', forged.body.unknown, 3);
} finally {
  cleanup();
  process.removeAllListeners('exit');
}

console.log(fail ? `\n${fail} FAILED` : '\nall roster-sharing checks passed');
process.exit(fail ? 1 : 0);

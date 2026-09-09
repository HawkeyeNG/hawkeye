/**
 * Situation-room API: the flow end to end — create, invite, preview, join,
 * drill the coverage tree, and the two refusals that matter (a non-manager
 * reading the team, a revoked invite).
 *
 * Runs against the REAL dev database and the real 176k-unit register, in
 * process, on an ephemeral port. Every row it makes it deletes on the way out;
 * a mock register would not have caught the tree-level bugs this one did.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { groupsRouter } from '../src/routes/groups.js';

const now = Date.now();
const mkObs = (tag) => {
  const r = db.prepare('INSERT INTO observers (phone_hash, public_key_jwk, created_at) VALUES (?, ?, ?)')
    .run('e2e-' + tag + '-' + now, '{}', now);
  return Number(r.lastInsertRowid);
};
const mgr = mkObs('mgr'), a1 = mkObs('a1'), a2 = mkObs('a2');
const tok = (id) => jwt.sign({ sub: String(id) }, config.jwtSecret, { expiresIn: '1h' });

const pu = db.prepare('SELECT pu_code, state, lga, ward FROM polling_units WHERE state IS NOT NULL LIMIT 1').get();
console.log('sample unit:', pu ? pu.pu_code + ' / ' + pu.state + ' / ' + pu.lga : 'REGISTER NOT LOADED');
if (pu) db.prepare('INSERT OR REPLACE INTO saved_units (observer_id, pu_code, created_at) VALUES (?, ?, ?)').run(a1, pu.pu_code, now);

const app = express();
app.use(express.json());
app.use('/api', groupsRouter);
const srv = app.listen(0);
const base = 'http://127.0.0.1:' + srv.address().port + '/api';

const call = async (m, p, who, body) => {
  const r = await fetch(base + p, {
    method: m,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: 'Bearer ' + tok(who) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j; try { j = await r.json(); } catch { j = '<no json>'; }
  console.log('  ' + m + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 260));
  return { status: r.status, j };
};

console.log('\n1. create + list');
const g = (await call('POST', '/groups', mgr, { name: 'E2E Campaign', kind: 'campaign', contest: 'PRES', scope: pu ? pu.state : '' })).j;
await call('GET', '/groups', mgr);

console.log('\n2. invite + preview + join');
const inv = (await call('POST', '/groups/' + g.id + '/invites', mgr)).j;
await call('GET', '/join/' + inv.token, null);
await call('POST', '/join/' + inv.token, a1);
await call('POST', '/join/' + inv.token, a2);
await call('POST', '/join/' + inv.token, a2);
await call('GET', '/join/nonsense', null);

console.log('\n3. detail / team / coverage');
await call('GET', '/groups/' + g.id, mgr);
await call('GET', '/groups/' + g.id + '/team', mgr);
await call('GET', '/groups/' + g.id + '/coverage', mgr);
if (pu) {
  await call('GET', '/groups/' + g.id + '/coverage?state=' + encodeURIComponent(pu.state), mgr);
  await call('GET', '/groups/' + g.id + '/coverage?state=' + encodeURIComponent(pu.state) + '&lga=' + encodeURIComponent(pu.lga), mgr);
  await call('GET', '/groups/' + g.id + '/coverage?state=' + encodeURIComponent(pu.state) + '&lga=' + encodeURIComponent(pu.lga) + '&ward=' + encodeURIComponent(pu.ward), mgr);
}

console.log('\n4. a non-manager must be refused');
await call('GET', '/groups/' + g.id + '/team', a1);
await call('GET', '/groups/' + g.id, a2);

console.log('\n5. revoke kills the invite');
await call('DELETE', '/groups/' + g.id + '/invites/' + inv.token, mgr);
await call('GET', '/join/' + inv.token, null);

srv.close();
db.prepare('DELETE FROM group_tokens WHERE group_id = ?').run(g.id);
db.prepare('DELETE FROM group_members WHERE group_id = ?').run(g.id);
db.prepare('DELETE FROM group_managers WHERE group_id = ?').run(g.id);
db.prepare('DELETE FROM campaign_groups WHERE id = ?').run(g.id);
for (const id of [mgr, a1, a2]) {
  db.prepare('DELETE FROM saved_units WHERE observer_id = ?').run(id);
  db.prepare('DELETE FROM observers WHERE id = ?').run(id);
}
console.log('\ncleaned up.');

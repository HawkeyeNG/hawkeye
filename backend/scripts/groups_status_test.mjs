/**
 * Situation-room API: the four states, and the rule that only reports going
 * FORWARD are revealed.
 *
 * Seeds four agents — one who filed from their assigned unit, one who filed
 * from a different one, one silent, and one whose only report predates joining
 * — then asserts both the per-agent status and the coverage overlay counted
 * from both ends. The mismatch case is the point: an early version credited the
 * ASSIGNED unit for a report filed elsewhere, painting an empty unit green.
 */
import express from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../src/db.js';
import { config } from '../src/config.js';
import { groupsRouter } from '../src/routes/groups.js';

/* Clear any debris from a run that died before its cleanup. A crashed test
   leaves a group nothing ever removes, and the next run then measures a
   database that is not the one it set up. */
for (const g of db.prepare("SELECT id FROM campaign_groups WHERE name = 'Status Test'").all()) {
  for (const t of ['group_tokens', 'group_members', 'group_managers']) db.prepare('DELETE FROM ' + t + ' WHERE group_id = ?').run(g.id);
  db.prepare('DELETE FROM campaign_groups WHERE id = ?').run(g.id);
}

const now = Date.now();
const mkObs = (t) => Number(db.prepare('INSERT INTO observers (phone_hash, public_key_jwk, created_at) VALUES (?, ?, ?)').run('st-' + t + '-' + now, '{}', now).lastInsertRowid);
const mgr = mkObs('m'), onUnit = mkObs('on'), mism = mkObs('mm'), silent = mkObs('si'), past = mkObs('pa'), outsider = mkObs('ou');
const tok = (id) => jwt.sign({ sub: String(id) }, config.jwtSecret, { expiresIn: '1h' });

const units = db.prepare("SELECT pu_code, state, lga, ward FROM polling_units WHERE lga = 'Lagos Island' AND ward IS NOT NULL LIMIT 3").all();
const [U1, U2, U3] = units;
// A fourth unit in the same ward, saved only by the MANAGER — must not read as
// watched. It must start clean: the seed's demo observers save real units, and
// one already watching U4 would fail this for the right reason.
const U4 = db.prepare(`SELECT pu_code FROM polling_units WHERE lga = 'Lagos Island' AND ward = ? AND pu_code NOT IN (?, ?, ?)
    AND pu_code NOT IN (SELECT pu_code FROM saved_units) AND pu_code NOT IN (SELECT pu_code FROM submissions WHERE contest = 'PRES') LIMIT 1`)
  .get(U1.ward, U1.pu_code, U2.pu_code, U3.pu_code);
console.log('units: ' + units.map(u => u.pu_code).join(' '));

let n = 0;
const sub = (obs, pu, createdAt) => {
  n++;
  db.prepare("INSERT INTO submissions (pu_code, observer_id, contest, votes_json, image_sha256, image_dhash, image_path, venue_image_sha256, venue_image_dhash, venue_image_path, lat, lng, location_verified, captured_at, venue_captured_at, location_proof, client_sig, ledger_payload, prev_hash, entry_hash, created_at) VALUES (?, ?, 'PRES', '[]', ?, 'd', 'p', ?, 'd', 'p', 6.4, 3.4, 0, ?, ?, 'x', 'x', 'x', 'x', ?, ?)")
    .run(pu, obs, 'sha' + n + now, 'vsha' + n + now, createdAt, createdAt, 'eh' + n + now, createdAt);
};

const app = express();
app.use(express.json());
app.use('/api', groupsRouter);
const srv = app.listen(0);
const base = 'http://127.0.0.1:' + srv.address().port + '/api';
const call = async (m, p, who, body) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(who ? { authorization: 'Bearer ' + tok(who) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json() };
};

const g = (await call('POST', '/groups', mgr, { name: 'Status Test', contest: 'PRES', scope: 'Lagos' })).j;
const inv = (await call('POST', '/groups/' + g.id + '/invites', mgr)).j;

for (const [obs, pu] of [[onUnit, U1.pu_code], [mism, U2.pu_code], [silent, U3.pu_code], [past, U1.pu_code]]) {
  db.prepare('INSERT OR REPLACE INTO saved_units (observer_id, pu_code, created_at) VALUES (?, ?, ?)').run(obs, pu, now);
  await call('POST', '/join/' + inv.token, obs);
}
// watched: a non-member saving unreported U2 counts; saving reported U1 does not;
// the members' own saves (U1-U3) and the manager's (U4) never do.
const save = (obs, pu) => db.prepare('INSERT OR REPLACE INTO saved_units (observer_id, pu_code, created_at) VALUES (?, ?, ?)').run(obs, pu, now);
save(outsider, U2.pu_code);
save(outsider, U1.pu_code);
if (U4) save(mgr, U4.pu_code);
const joinedAt = db.prepare('SELECT joined_at FROM group_members WHERE group_id = ? AND observer_id = ?').get(g.id, onUnit).joined_at;

sub(onUnit, U1.pu_code, joinedAt + 1000);          // reported from assigned unit
sub(mism, U3.pu_code, joinedAt + 1000);            // assigned U2, reported U3
sub(past, U1.pu_code, joinedAt - 86400000);        // reported YESTERDAY, before joining

const team = (await call('GET', '/groups/' + g.id + '/team', mgr)).j;
const label = { [onUnit]: 'on-unit', [mism]: 'mismatch', [silent]: 'silent', [past]: 'reported-before-joining' };
console.log('\nTEAM');
let fail = 0;
const expect = { [onUnit]: 'on_unit', [mism]: 'mismatch', [silent]: 'silent', [past]: 'silent' };
for (const m of team.members) {
  const ok = m.status === expect[m.observer_id];
  if (!ok) fail++;
  console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + label[m.observer_id].padEnd(24) + ' status=' + m.status.padEnd(10) +
    ' assigned=' + (m.assigned ? m.assigned.pu_code : '-') + ' reported=' + (m.reported ? m.reported.pu_code : '-') +
    (ok ? '' : '  EXPECTED ' + expect[m.observer_id]));
}

const cov = (await call('GET', '/groups/' + g.id + '/coverage?state=Lagos&lga=Lagos%20Island&ward=' + encodeURIComponent(U1.ward), mgr)).j;
console.log('\nCOVERAGE overlay for ward ' + U1.ward);
for (const node of cov.nodes.filter(x => units.some(u => u.pu_code === x.key))) {
  console.log('  ' + node.key + '  reported=' + node.reported + ' assigned=' + node.assigned +
    ' on_unit=' + node.on_unit + ' mismatched=' + node.mismatched + ' member_reported=' + node.member_reported + ' watched=' + node.watched);
}
const want = {
  [U1.pu_code]: { assigned: 2, on_unit: 1, mismatched: 0, member_reported: 1, watched: 0 },
  [U2.pu_code]: { assigned: 1, on_unit: 0, mismatched: 1, member_reported: 0, watched: 1 },
  [U3.pu_code]: { assigned: 1, on_unit: 0, mismatched: 0, member_reported: 1, watched: 0 },
  ...(U4 ? { [U4.pu_code]: { watched: 0 } } : {}),
};
for (const [code, w] of Object.entries(want)) {
  const node = cov.nodes.find(x => x.key === code);
  for (const [k, v] of Object.entries(w)) {
    if (!node || node[k] !== v) { console.log('  FAIL ' + code + '.' + k + ' expected ' + v + ' got ' + (node && node[k])); fail++; }
  }
}

srv.close();
for (const t of ['group_tokens', 'group_members', 'group_managers']) db.prepare('DELETE FROM ' + t + ' WHERE group_id = ?').run(g.id);
db.prepare('DELETE FROM campaign_groups WHERE id = ?').run(g.id);
for (const id of [mgr, onUnit, mism, silent, past, outsider]) {
  db.prepare('DELETE FROM submissions WHERE observer_id = ?').run(id);
  db.prepare('DELETE FROM saved_units WHERE observer_id = ?').run(id);
  db.prepare('DELETE FROM observers WHERE id = ?').run(id);
}
console.log('\n' + (fail ? fail + ' FAILURES' : 'all assertions passed') + ' · cleaned up');
process.exit(fail ? 1 : 0);

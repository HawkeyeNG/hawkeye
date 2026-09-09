/**
 * Seed a demo situation room in the DEV database and print a sign-in token.
 *
 * Leaves the data in place (unlike scripts/groups_status_test.mjs, which cleans
 * up) so the console can be looked at with all four states on screen at once.
 * Run with --clean to remove everything it made.
 */
import jwt from 'jsonwebtoken';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

const TAG = 'seed-situation-room';
const clean = process.argv.includes('--clean');

const olds = db.prepare("SELECT id FROM observers WHERE phone_hash LIKE ?").all(TAG + '%').map(r => r.id);
for (const g of db.prepare('SELECT id FROM campaign_groups WHERE name = ?').all('Demo Campaign 2027')) {
  for (const t of ['group_tokens', 'group_members', 'group_managers']) db.prepare('DELETE FROM ' + t + ' WHERE group_id = ?').run(g.id);
  db.prepare('DELETE FROM campaign_groups WHERE id = ?').run(g.id);
}
for (const id of olds) {
  db.prepare('DELETE FROM submissions WHERE observer_id = ?').run(id);
  db.prepare('DELETE FROM saved_units WHERE observer_id = ?').run(id);
  db.prepare('DELETE FROM observers WHERE id = ?').run(id);
}
if (clean) { console.log('removed ' + olds.length + ' seeded observers and their group'); process.exit(0); }

const now = Date.now();
const mk = (t) => Number(db.prepare('INSERT INTO observers (phone_hash, public_key_jwk, created_at) VALUES (?, ?, ?)').run(TAG + '-' + t, '{}', now).lastInsertRowid);
const mgr = mk('mgr');
const gid = Number(db.prepare('INSERT INTO campaign_groups (name, kind, contest, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run('Demo Campaign 2027', 'campaign', 'PRES', 'Lagos', mgr, now).lastInsertRowid);
db.prepare('INSERT INTO group_managers (group_id, observer_id, role, created_at) VALUES (?, ?, ?, ?)').run(gid, mgr, 'owner', now);
db.prepare('INSERT INTO group_tokens (token, group_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('demo-invite-token', gid, mgr, now + 2592000000, now);

const units = db.prepare("SELECT pu_code, name, ward, lga FROM polling_units WHERE lga = 'Lagos Island' AND ward IS NOT NULL ORDER BY pu_code LIMIT 9").all();
const joined = now - 7200000;
let sn = 0;
const SQL = 'INSERT INTO submissions (pu_code, observer_id, contest, votes_json, image_sha256, image_dhash, image_path, venue_image_sha256, venue_image_dhash, venue_image_path, lat, lng, location_verified, captured_at, venue_captured_at, location_proof, client_sig, ledger_payload, prev_hash, entry_hash, created_at) VALUES (?, ?, 0, 0, ?, 0, 0, ?, 0, 0, 6.4, 3.4, 0, ?, ?, 0, 0, 0, 0, ?, ?)'
  .replace(/, 0,/g, ", 'x',").replace('contest, 0', "contest, '[]'");
const sub = (obs, pu, at) => { sn++; db.prepare(SQL.replace("VALUES (?, ?, 'x'", "VALUES (?, ?, 'PRES'")).run(pu, obs, 'sh' + sn + now, 'vs' + sn + now, at, at, 'eh' + sn + now, at); };

const roster = [
  ['Chidi Okeke',    0, 'on'],       // filed from the unit they were given
  ['Aisha Bello',    1, 'on'],
  ['Tunde Adeyemi',  2, 'off', 6],   // filed from unit 6 instead
  ['Ngozi Eze',      3, 'silent'],
  ['Musa Ibrahim',   4, 'silent'],
  ['Bisi Lawal',     5, 'on'],
  ['Emeka Nwosu',    7, 'silent'],
  ['Fatima Sani',    8, 'off', 6],
];
for (const [label, idx, kind, other] of roster) {
  const o = mk(label.toLowerCase().replace(/ /g, '-'));
  const pu = units[idx].pu_code;
  db.prepare('INSERT INTO saved_units (observer_id, pu_code, created_at) VALUES (?, ?, ?)').run(o, pu, now);
  db.prepare('INSERT INTO group_members (group_id, observer_id, assigned_pu, assign_state, joined_at, label) VALUES (?, ?, ?, ?, ?, ?)')
    .run(gid, o, pu, 'proposed', joined, label);
  if (kind === 'on') sub(o, pu, joined + 600000);
  if (kind === 'off') sub(o, units[other].pu_code, joined + 900000);
}
// A unit reported by somebody outside the group — public coverage this group did
// not produce, which is exactly the contrast the console has to show honestly.
const outsider = mk('outsider');
sub(outsider, units[6].pu_code, joined + 300000);

console.log('group ' + gid + ' seeded: 8 observers (3 on unit, 2 elsewhere, 3 silent) + 1 outside report');
console.log('invite:  /join.html?t=demo-invite-token');
console.log('TOKEN=' + jwt.sign({ sub: String(mgr) }, config.jwtSecret, { expiresIn: '2d' }));

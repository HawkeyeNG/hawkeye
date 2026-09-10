/**
 * Seed a demo situation room in the DEV database and print a sign-in token.
 *
 * Leaves the data in place (unlike scripts/groups_status_test.mjs, which cleans
 * up) so the console can be looked at with all four states on screen at once.
 * Run with --clean to remove the group and its rows.
 *
 * IDEMPOTENT BY PHONE HASH, and that is the point. The first version deleted
 * its observers and made them again, which worked exactly until the assignment
 * notifications shipped: `notifications` references `observers`, so the delete
 * hit a FOREIGN KEY constraint — AFTER it had already removed the group. A
 * cleanup that runs in FK order until it throws leaves the database in a state
 * neither the old run nor the new one expects, and the failure looks like "the
 * seed did nothing" rather than "the seed half-worked". Reusing the observer
 * rows means there is no delete to get wrong, and every re-run converges on the
 * same demo instead of accumulating another copy of it.
 */
import jwt from 'jsonwebtoken';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

const TAG = 'seed-situation-room';
const GROUP = 'Demo Campaign 2027';
const now = Date.now();

/** Observer rows are REUSED, never recreated — see the header. */
const mk = (t) => {
  const hash = TAG + '-' + t;
  const row = db.prepare('SELECT id FROM observers WHERE phone_hash = ?').get(hash);
  if (row) return row.id;
  return Number(db.prepare('INSERT INTO observers (phone_hash, public_key_jwk, created_at) VALUES (?, ?, ?)')
    .run(hash, '{}', now).lastInsertRowid);
};

/** Everything the seed itself creates, in an order the foreign keys allow. */
function purge() {
  const ids = db.prepare('SELECT id FROM observers WHERE phone_hash LIKE ?').all(TAG + '%').map((r) => r.id);
  for (const g of db.prepare('SELECT id FROM campaign_groups WHERE name = ?').all(GROUP)) {
    for (const t of ['group_tokens', 'group_members', 'group_managers']) {
      db.prepare('DELETE FROM ' + t + ' WHERE group_id = ?').run(g.id);
    }
    db.prepare('DELETE FROM campaign_groups WHERE id = ?').run(g.id);
  }
  {
    db.prepare("DELETE FROM results WHERE pu_code IN (SELECT pu_code FROM polling_units WHERE lga = 'Lagos Island')").run();
  }
  for (const id of ids) {
    db.prepare('DELETE FROM group_members WHERE observer_id = ?').run(id);
    db.prepare('DELETE FROM submissions WHERE observer_id = ?').run(id);
    db.prepare('DELETE FROM saved_units WHERE observer_id = ?').run(id);
    db.prepare('DELETE FROM notifications WHERE observer_id = ?').run(id);
    db.prepare('DELETE FROM incidents WHERE observer_id = ?').run(id);
  }
  return ids.length;
}

if (process.argv.includes('--clean')) {
  const n = purge();
  // The observer rows stay. They are inert without a group, they cost four
  // bytes, and deleting them is the exact thing that broke.
  console.log('cleared the demo group and the rows for ' + n + ' seeded observers');
  process.exit(0);
}

purge();

const mgr = mk('mgr');
const gid = Number(db.prepare('INSERT INTO campaign_groups (name, kind, contest, scope, party, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(GROUP, 'campaign', 'PRES', 'Lagos', 'PDP', mgr, now).lastInsertRowid);
db.prepare('INSERT INTO group_managers (group_id, observer_id, role, created_at) VALUES (?, ?, ?, ?)').run(gid, mgr, 'owner', now);
db.prepare('INSERT INTO group_tokens (token, group_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
  .run('demo-invite-token', gid, mgr, now + 2592000000, now);

const units = db.prepare("SELECT pu_code, name FROM polling_units WHERE lga = 'Lagos Island' AND ward IS NOT NULL ORDER BY pu_code LIMIT 9").all();
const joined = now - 7200000;

// A parseable 16-hex dhash, not a placeholder: the boot-time dhash_bands
// backfill reads this column as a BigInt, and a letter outside [0-9a-f] throws
// on every restart from then on. Dev-only noise that outlives the session.
const DHASH = 'a1b2c3d4e5f60718';
const SUB_SQL = 'INSERT INTO submissions (pu_code, observer_id, contest, votes_json, image_sha256, image_dhash,'
  + ' image_path, venue_image_sha256, venue_image_dhash, venue_image_path, lat, lng, location_verified,'
  + ' captured_at, venue_captured_at, location_proof, client_sig, ledger_payload, prev_hash, entry_hash, created_at)'
  + " VALUES (?, ?, 'PRES', '[]', ?, ?, 'p', ?, ?, 'p', 6.4, 3.4, 0, ?, ?, 'x', 'x', 'x', 'x', ?, ?)";
let sn = 0;
const sub = (obs, pu, at) => {
  sn += 1;
  db.prepare(SUB_SQL).run(pu, obs, 'sh' + sn + now, DHASH, 'vs' + sn + now, DHASH, at, at, 'eh' + sn + now, at);
};

const roster = [
  ['Chidi Okeke', 0, 'on'],        // filed from the unit they were given
  ['Aisha Bello', 1, 'on'],
  ['Tunde Adeyemi', 2, 'off', 6],  // filed from unit 6 instead
  ['Ngozi Eze', 3, 'silent'],
  ['Musa Ibrahim', 4, 'silent'],
  ['Bisi Lawal', 5, 'on'],
  ['Emeka Nwosu', 7, 'silent'],
  ['Fatima Sani', 8, 'off', 6],
];
for (const [label, idx, kind, other] of roster) {
  const o = mk(label.toLowerCase().replace(/ /g, '-'));
  const pu = units[idx].pu_code;
  db.prepare('INSERT OR REPLACE INTO saved_units (observer_id, pu_code, created_at) VALUES (?, ?, ?)').run(o, pu, now);
  db.prepare('INSERT INTO group_members (group_id, observer_id, assigned_pu, assign_state, joined_at, label) VALUES (?, ?, ?, ?, ?, ?)')
    .run(gid, o, pu, 'proposed', joined, label);
  if (kind === 'on') sub(o, pu, joined + 600000);
  if (kind === 'off') sub(o, units[other].pu_code, joined + 900000);
}

// A unit reported by somebody OUTSIDE the group — public coverage this group did
// not produce, which is the contrast the console has to show honestly.
sub(mk('outsider'), units[6].pu_code, joined + 300000);

// Published incidents: one from a member, one from a stranger, one with no unit
// given. The tab has to show all three the same way the public feed does, and
// only mark the first as one of ours.
db.prepare("DELETE FROM incidents WHERE description LIKE 'SEED:%'").run();
const inc = db.prepare('INSERT INTO incidents (observer_id, kind, description, pu_code, state, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
inc.run(mk('chidi-okeke'), 'voter_intimidation', 'SEED: Group of men turning voters away at the gate.', units[0].pu_code, 'Lagos', 'published', joined + 1200000);
inc.run(mk('outsider'), 'late_start', 'SEED: Materials arrived after 11am, accreditation only just started.', units[4].pu_code, 'Lagos', 'published', joined + 1500000);
inc.run(mk('outsider'), 'other', 'SEED: Reported from the LGA collation centre, no unit given.', null, 'Lagos', 'published', joined + 1800000);
inc.run(mk('outsider'), 'other', 'SEED: Still under review, must never appear in the room.', units[1].pu_code, 'Lagos', 'pending', joined + 1900000);

// Per-unit results, so the party table has something to total. One is marked
// DISPUTED: the public board leaves those out of the headline tally, and the
// room shows the board's own response, so a disputed row that changed the
// totals here would mean the two had drifted apart.
db.prepare("DELETE FROM results WHERE pu_code IN (SELECT pu_code FROM polling_units WHERE lga = 'Lagos Island')").run();
const res = db.prepare('INSERT OR REPLACE INTO results (pu_code, contest, votes_json, confidence,'
  + ' matching_reports, total_reports, status, location_status, venue_matches, updated_at, disputed)'
  + " VALUES (?, 'PRES', ?, 0.9, 2, 2, 'verified', 'verified', 1, ?, ?)");
const tally = [
  [0, { APC: 210, PDP: 305, LP: 142, NNPP: 27 }, 0],
  [1, { APC: 188, PDP: 260, LP: 175, NNPP: 19 }, 0],
  [5, { APC: 240, PDP: 198, LP: 121, NNPP: 33 }, 0],
  [6, { APC: 176, PDP: 221, LP: 160, NNPP: 22 }, 0],
  [2, { APC: 999, PDP: 12, LP: 8, NNPP: 3 }, 1],   // disputed: must not count
];
for (const [idx, votes, disputed] of tally) {
  const json = JSON.stringify(Object.entries(votes).map(([party, count]) => ({ party, count })));
  res.run(units[idx].pu_code, json, now, disputed);
}

console.log('group ' + gid + ' seeded: 8 observers (3 on unit, 2 elsewhere, 3 silent) + 1 outside report');
console.log('invite:  /join/demo-invite-token');
console.log('TOKEN=' + jwt.sign({ sub: String(mgr) }, config.jwtSecret, { expiresIn: '2d' }));

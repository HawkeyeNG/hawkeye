/**
 * Situation room: campaign / CSO groups.
 *
 * THE INVARIANT THIS FILE EXISTS TO PRESERVE: a group never gains visibility
 * into the count. Every number below is derived from the SAME public submission
 * stream everybody else already reads — the group layer only says WHICH of those
 * public reports came from ITS OWN members. There is no early access, no
 * unpublished figure, and no read path to another group's members.
 *
 * Nothing here writes to `submissions`, `results` or the ledger. That is not a
 * convention, it is the reason the neutrality claim survives a rival campaign
 * asking what this dashboard can see: the feature is structurally incapable of
 * privileging the record, because it only ever JOINs against it.
 *
 * Two rules the read queries enforce rather than document:
 *   1. ONLY REPORTS GOING FORWARD. Every join against `submissions` carries
 *      `created_at >= joined_at`. An observer's past work is not the campaign's
 *      to see, and joining must never retroactively hand it over.
 *   2. AN ASSIGNMENT NEVER GATES REPORTING. Assignment lives here and is read
 *      here; the submission path does not import this file and must not. An
 *      agent who ends up somewhere else still files from where they stand — a
 *      clerical error that silenced a real observer at a real unit would be far
 *      worse than an inaccurate coverage number.
 */
import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, contests, scopeIsState } from '../db.js';
import { config } from '../config.js';
import { notifyMaster, notifyObserverId } from '../services/notify.js';
import { pushNote } from '../services/notifications.js';
import { requireObserver } from './observers.js';

export const groupsRouter = Router();

const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_NAME = 80;

const now = () => Date.now();
const newToken = () => crypto.randomBytes(16).toString('base64url');

// --- membership helpers -------------------------------------------------------

const managerRow = (groupId, observerId) =>
  db.prepare('SELECT * FROM group_managers WHERE group_id = ? AND observer_id = ?').get(groupId, observerId);

/**
 * Manager gate. Attaches `req.group` and `req.manager` so the scope on the
 * manager row is available to every read below — a coordinator scoped to one
 * state must not be able to read another state by editing the query string.
 */
function requireManager(req, res, next) {
  const id = Number(req.params.id);
  const group = db.prepare('SELECT * FROM campaign_groups WHERE id = ?').get(id);
  if (!group) return res.status(404).json({ error: 'no_such_group' });
  const m = managerRow(id, req.observer.id);
  if (!m) return res.status(403).json({ error: 'not_a_manager' });
  req.group = group;
  req.manager = m;
  next();
}

const isOwner = (m) => m.role === 'owner';

/**
 * The room's address: a slug of its name, numbered when the name repeats.
 *
 * URLS NAME THE ROOM, NOT THE VIEWER. A room has several managers and a
 * coordinator or two, and keying the address to whoever is looking would give
 * each of them a different link to the same screen — so "open the room" could
 * not be pasted into the group chat they already use. Who you are decides what
 * you see; sign-in decides whether you see it at all.
 *
 * Numbered from 2, and the counter is per NAME, because two campaigns really
 * can be called the same thing and the second one should not have to be told to
 * rename itself.
 */
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'room';

function uniqueSlug(name, exceptId = 0) {
  const base = slugify(name);
  const taken = db.prepare('SELECT 1 FROM campaign_groups WHERE slug = ? AND id != ?');
  if (!taken.get(base, exceptId)) return base;
  for (let i = 2; i < 500; i += 1) {
    const s = `${base}-${i}`;
    if (!taken.get(s, exceptId)) return s;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/* Rooms created before slugs existed have none, and a room without an address
   cannot be reached by anyone who did not create it. Cheap: only touches NULLs,
   so it is a no-op on every boot after the first. */
for (const row of db.prepare('SELECT id, name FROM campaign_groups WHERE slug IS NULL').all()) {
  db.prepare('UPDATE campaign_groups SET slug = ? WHERE id = ?').run(uniqueSlug(row.name, row.id), row.id);
}

/**
 * Which register column a group's scope names — DERIVED from the contest, never
 * stored.
 *
 * A GROUP WATCHES ONE RACE, and a race is not always a state. The Senate seat
 * for Kaduna South is a senatorial district; a House of Reps seat is a federal
 * constituency; a governorship IS its state. Storing the column alongside the
 * contest would create two facts that can disagree, and the one that disagreed
 * would silently scope a district-level group to a whole state.
 *
 * `scopeIsState` in db.js is the single authority — the same one the follow
 * alerts and the subscription prune already read, so a Senate group here and a
 * Senate follow there cannot mean different regions.
 */
const scopeColumn = (contest) =>
  (scopeIsState(contest) ? 'state' : contest === 'SEN' ? 'senatorial' : 'federal_constituency');

/**
 * A sub-state scope is pinned to the state it actually belongs to.
 *
 * THE DEFECT THIS WAS WRITTEN FOR IS FIXED — see the nine-LGA senatorial repair
 * in db.js. Two of those nine put Kano units in a Kaduna district and vice
 * versa, and this pinned a district to the state holding most of its units so
 * the coverage denominator could not be quietly inflated.
 *
 * KEPT ANYWAY, and cheap: one indexed lookup per coverage request. The register
 * is reloaded from an external CSV that has been wrong before, and the failure
 * it prevents is the silent kind — every percentage in the room off by a few
 * per cent with nothing on screen saying so. It should now be a no-op on every
 * district; if it ever starts excluding rows again, the register has drifted.
 */
const homeState = (col, value) => db
  .prepare(`SELECT state FROM polling_units WHERE ${col} = ? GROUP BY state ORDER BY COUNT(*) DESC LIMIT 1`)
  .get(value)?.state || null;

/**
 * Every seat in a contest, with the state that actually holds it.
 *
 * ONE GROUPED PASS, not a correlated subquery. The obvious
 * `WHERE state = ? AND seat = (SELECT majority state FOR THIS ROW)` re-runs the
 * inner query once per row of a 176,846-row table and does not return — I hung
 * a request on exactly that. Grouping once and deciding the winner in JS is a
 * single scan over ~500 aggregate rows.
 */
const seatCache = {};
function seatsByState(col) {
  if (seatCache[col]) return seatCache[col];
  const rows = db
    .prepare(`SELECT ${col} AS seat, state, COUNT(*) n FROM polling_units WHERE ${col} IS NOT NULL GROUP BY ${col}, state`)
    .all();
  const best = new Map();
  for (const r of rows) {
    const cur = best.get(r.seat);
    if (!cur || r.n > cur.n) best.set(r.seat, { state: r.state, n: r.n });
  }
  const out = new Map();
  for (const [seat, { state }] of best) {
    if (!out.has(state)) out.set(state, []);
    out.get(state).push(seat);
  }
  for (const list of out.values()) list.sort();
  // Memoised for the process: the register is loaded at boot and does not
  // change under a running server, and this is a full pass over 176,846 rows
  // on a form that fires it on every contest change.
  seatCache[col] = out;
  return out;
}

/**
 * Nigeria's six geopolitical zones. Not an INEC level — no seat is contested at
 * zone level and the register has no zone column — but it is how a presidential
 * campaign actually divides the country, so a coordinator can be scoped to one.
 * Expands to the states it contains rather than comparing a column.
 */
const ZONES = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'zones.json'), 'utf8'));
const ZONE_NAMES = Object.keys(ZONES).filter((k) => !k.startsWith('_'));
const zoneStates = (zone) => ZONES[zone] || [];

/**
 * A coordinator's scope, as SQL against `polling_units pu`.
 *
 * WHAT A SCOPE NARROWS: PEOPLE AND ACTIONS, NOT AGGREGATES. This clause is
 * applied to the team list, the activity feed and the incident feed — every
 * read that names a person — and to assignment writes. It is deliberately NOT
 * applied to the coverage tree.
 *
 * That is a correction, not an omission. Scoping the aggregates too meant a
 * coordinator saw "12% covered" with nothing to compare it against, and a
 * number with no denominator a person recognises is not information. They now
 * see every area's totals and the campaign's, and still see and act on only
 * their own area's observers — which is the half that actually needed fencing,
 * because one coordinator reading another state's silent-agent list is the
 * discipline problem the mismatch rule exists to prevent.
 */
function scopeClause(manager, alias = 'pu') {
  if (!manager.scope_kind || !manager.scope_value) return { sql: '', params: [] };
  if (manager.scope_kind === 'zone') {
    const states = zoneStates(manager.scope_value);
    if (!states.length) return { sql: '', params: [] };
    return { sql: ` AND ${alias}.state IN (${states.map(() => '?').join(',')})`, params: states };
  }
  const col = { state: 'state', lga: 'lga', ward: 'ward' }[manager.scope_kind];
  if (!col) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.${col} = ?`, params: [manager.scope_value] };
}

/**
 * Coordinator name by area key, for the level being listed.
 *
 * A zone coordinator is credited against each of its states, because at state
 * level that is the row a reader is looking at — the alternative is a standings
 * table where the zone people appear nowhere and their states look unowned.
 */
function coordinatorsAt(groupId, level) {
  const rows = db
    .prepare(
      `SELECT gm.observer_id, gm.role, gm.scope_kind, gm.scope_value, m.label
         FROM group_managers gm
         LEFT JOIN group_members m ON m.group_id = gm.group_id AND m.observer_id = gm.observer_id
        WHERE gm.group_id = ? AND gm.scope_kind != '' AND gm.scope_value != ''`,
    )
    .all(groupId);
  const out = {};
  const put = (key, r) => {
    if (!out[key]) out[key] = [];
    out[key].push({ observer_id: r.observer_id, label: r.label || null, role: r.role });
  };
  for (const r of rows) {
    if (r.scope_kind === level) put(r.scope_value, r);
    else if (r.scope_kind === 'zone' && level === 'state') for (const st of zoneStates(r.scope_value)) put(st, r);
  }
  return out;
}

/**
 * Which coverage node a coordinator's scope falls in, at the level being
 * listed — so their own row can be marked without the client re-deriving it.
 */
function scopeKeyAt(manager, level) {
  const kind = manager.scope_kind;
  if (!kind || !manager.scope_value) return null;
  if (kind === level) return manager.scope_value;
  // A zone owns states, so at state level it marks each of its own.
  if (kind === 'zone' && level === 'state') return zoneStates(manager.scope_value);
  return null;
}

/**
 * The races inside a contest, so the setup form can land on exactly ONE.
 *
 * "Governorship" is not a race — twenty-eight of them are held that day. Asking
 * a manager to pick a contest and then type a state is asking them to name the
 * race in two halves, in free text, with no way to be told they got it wrong;
 * the coverage tree would simply come back empty and look like an election
 * nobody had reported yet.
 *
 * The shape of the answer follows the contest, because the register is what
 * decides it: a governorship IS its state, a Senate seat is a senatorial
 * district, a Reps seat is a federal constituency, and the presidency is one
 * race over the whole country. Read from `polling_units` rather than a list
 * kept beside it — the register is the same source the coverage tree counts
 * against, so a race offered here cannot be one the tree cannot find.
 *
 * Open to any signed-in observer: it is the public map of the election.
 */
groupsRouter.get('/group-races', requireObserver, (req, res) => {
  const contest = String(req.query.contest || 'PRES');
  const c = contests.find((x) => x.code === contest);
  if (!c) return res.status(400).json({ error: 'unknown_contest' });

  const col = scopeColumn(contest);
  if (contest === 'PRES') return res.json({ kind: 'national', column: '', states: [], races: [] });

  // A by-election, or a contest that names its own states, is confined to them.
  const only = Array.isArray(c.states) && c.states.length ? c.states : null;
  const state = String(req.query.state || '').trim();

  if (col === 'state') {
    const rows = db.prepare('SELECT DISTINCT state AS v FROM polling_units WHERE state IS NOT NULL ORDER BY state').all();
    const races = rows.map((r) => r.v).filter((v) => !only || only.includes(v));
    return res.json({ kind: 'state', column: col, states: races, races });
  }

  // Two steps: the state narrows a 109-seat or 360-seat list to a readable one.
  const states = db.prepare('SELECT DISTINCT state AS v FROM polling_units WHERE state IS NOT NULL ORDER BY state')
    .all().map((r) => r.v).filter((v) => !only || only.includes(v));
  if (!state) return res.json({ kind: col, column: col, states, races: [] });
  /* Only the seats this state actually holds. A plain DISTINCT would offer
     Kaduna a "Kano South" seat, because 337 Kaduna units carry that label —
     see homeState. */
  return res.json({ kind: col, column: col, states, races: seatsByState(col).get(state) || [] });
});

// --- groups -------------------------------------------------------------------

groupsRouter.post('/groups', requireObserver, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, MAX_NAME);
  const kind = req.body?.kind === 'cso' ? 'cso' : 'campaign';
  const contest = String(req.body?.contest || 'PRES');
  const scope = String(req.body?.scope || '').trim();
  // Acronym only, and only for a campaign — a civil-society group carrying a
  // party emblem would misrepresent it to its own observers.
  const party = kind === 'campaign' ? String(req.body?.party || '').trim().toUpperCase().slice(0, 12) : '';
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!contests.some((c) => c.code === contest)) return res.status(400).json({ error: 'unknown_contest' });
  // A named scope has to be a region that actually exists in the register for
  // this contest, or the coverage tree silently returns nothing and the console
  // reports a real election as empty.
  if (scope) {
    const col = scopeColumn(contest);
    const hit = db.prepare(`SELECT 1 FROM polling_units WHERE ${col} = ? LIMIT 1`).get(scope);
    if (!hit) return res.status(400).json({ error: 'unknown_scope' });
  }

  const t = now();
  const info = db
    .prepare('INSERT INTO campaign_groups (name, kind, contest, scope, party, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(name, kind, contest, scope, party || null, uniqueSlug(name), req.observer.id, t);
  db.prepare('INSERT INTO group_managers (group_id, observer_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(info.lastInsertRowid, req.observer.id, 'owner', t);

  notifyMaster(`situation room · new ${kind} "${name}" (${contest}${scope ? ' · ' + scope : ''}) · observer #${req.observer.id}`);
  res.status(201).json({ id: info.lastInsertRowid, name, kind, contest, scope, party: party || null,
    slug: db.prepare('SELECT slug FROM campaign_groups WHERE id = ?').get(info.lastInsertRowid).slug });
});

/**
 * Everything this observer is part of, in both directions. Memberships are
 * returned to the observer THEMSELVES as well as to their managers — an agent
 * can always see which campaigns can see their reports, which is what makes the
 * disclosure at join time honest rather than a one-time notice.
 */
groupsRouter.get('/groups', requireObserver, (req, res) => {
  const managing = db
    .prepare(
      `SELECT g.id, g.name, g.kind, g.contest, g.scope, g.party, g.slug, gm.role, gm.scope_kind, gm.scope_value,
              (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS members
         FROM group_managers gm JOIN campaign_groups g ON g.id = gm.group_id
        WHERE gm.observer_id = ? ORDER BY g.created_at DESC`,
    )
    .all(req.observer.id);
  const member = db
    .prepare(
      `SELECT g.id, g.name, g.kind, g.contest, g.scope, g.party, g.slug,
              (SELECT role FROM group_managers WHERE group_id = g.id AND observer_id = m.observer_id) AS manages,
              m.assigned_pu, m.assign_state, m.joined_at,
              pu.name AS assigned_name, pu.ward AS assigned_ward, pu.lga AS assigned_lga, pu.state AS assigned_state
         FROM group_members m JOIN campaign_groups g ON g.id = m.group_id
         LEFT JOIN polling_units pu ON pu.pu_code = m.assigned_pu
        WHERE m.observer_id = ? ORDER BY m.joined_at DESC`,
    )
    .all(req.observer.id);
  res.json({ managing, member });
});

groupsRouter.get('/groups/:id', requireObserver, requireManager, (req, res) => {
  const g = req.group;
  const members = db.prepare('SELECT COUNT(*) n FROM group_members WHERE group_id = ?').get(g.id).n;
  const assigned = db.prepare("SELECT COUNT(*) n FROM group_members WHERE group_id = ? AND assigned_pu IS NOT NULL AND assign_state != 'declined'").get(g.id).n;
  res.json({
    id: g.id, name: g.name, kind: g.kind, contest: g.contest, scope: g.scope, party: g.party || null,
    slug: g.slug || null,
    scope_kind: g.scope ? scopeColumn(g.contest) : '',
    members, assigned,
    // Shipped with the detail rather than a second endpoint: the console
    // already fetches this, and the list changes only if the constitution does.
    zones: ZONE_NAMES,
    me_id: req.observer.id,
    me: { role: req.manager.role, scope_kind: req.manager.scope_kind, scope_value: req.manager.scope_value },
    managers: db
      .prepare('SELECT observer_id, role, scope_kind, scope_value FROM group_managers WHERE group_id = ? ORDER BY created_at')
      .all(g.id),
  });
});

/**
 * Delete a room. OWNER ONLY, and it takes the group layer with it — nothing
 * else.
 *
 * WHAT THIS CANNOT DESTROY is the point. Members' reports live in the public
 * submission stream and the ledger; this removes the roster, the assignments
 * and the invites, and every report those observers filed stays exactly where
 * it was, still counted, still public. A campaign folding cannot take the
 * record of an election with it.
 *
 * The client asks harder when there is something to lose (see the member and
 * report counts returned here), but the gate is the owner check: a manager who
 * could delete the room could erase every other manager's work in one tap.
 */
groupsRouter.delete('/groups/:id', requireObserver, requireManager, (req, res) => {
  if (!isOwner(req.manager)) return res.status(403).json({ error: 'owner_only' });
  const id = req.group.id;
  const members = db.prepare('SELECT COUNT(*) n FROM group_members WHERE group_id = ?').get(id).n;
  const wipe = db.transaction(() => {
    for (const t of ['group_tokens', 'group_members', 'group_managers']) {
      db.prepare('DELETE FROM ' + t + ' WHERE group_id = ?').run(id);
    }
    db.prepare('DELETE FROM campaign_groups WHERE id = ?').run(id);
  });
  wipe();
  notifyMaster(`situation room · deleted "${req.group.name}" (${members} member(s)) · observer #${req.observer.id}`);
  res.json({ ok: true, removed_members: members });
});

// --- invites ------------------------------------------------------------------

groupsRouter.post('/groups/:id/invites', requireObserver, requireManager, (req, res) => {
  const t = now();
  const token = newToken();
  db.prepare('INSERT INTO group_tokens (token, group_id, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, req.group.id, req.observer.id, t + INVITE_TTL_MS, t);
  res.status(201).json({ token, expires_at: t + INVITE_TTL_MS });
});

groupsRouter.get('/groups/:id/invites', requireObserver, requireManager, (req, res) => {
  res.json(
    db.prepare('SELECT token, uses, expires_at, revoked, created_at FROM group_tokens WHERE group_id = ? ORDER BY created_at DESC')
      .all(req.group.id),
  );
});

groupsRouter.delete('/groups/:id/invites/:token', requireObserver, requireManager, (req, res) => {
  db.prepare('UPDATE group_tokens SET revoked = 1 WHERE group_id = ? AND token = ?').run(req.group.id, req.params.token);
  res.json({ ok: true });
});

/**
 * Invite preview — deliberately UNAUTHENTICATED.
 *
 * The /join page has to name the campaign and state what joining discloses
 * BEFORE asking anyone to sign in; a disclosure nobody can read until after
 * they have authenticated is not a disclosure. Whoever holds the link was sent
 * it, and all this returns is the group's own name.
 */
groupsRouter.get('/join/:token', (req, res) => {
  const row = db
    .prepare(
      `SELECT t.token, t.expires_at, t.revoked, g.id, g.name, g.kind, g.contest, g.scope
         FROM group_tokens t JOIN campaign_groups g ON g.id = t.group_id WHERE t.token = ?`,
    )
    .get(req.params.token);
  if (!row) return res.status(404).json({ error: 'no_such_invite' });
  if (row.revoked) return res.status(410).json({ error: 'invite_revoked' });
  if (row.expires_at < now()) return res.status(410).json({ error: 'invite_expired' });
  res.json({ group_id: row.id, name: row.name, kind: row.kind, contest: row.contest, scope: row.scope });
});

/**
 * Join. NEVER automatic on visit — a link forwarded into a party WhatsApp group
 * must not silently enrol whoever opens it, and the deliberate tap is where the
 * disclosure actually gets read.
 */
groupsRouter.post('/join/:token', requireObserver, (req, res) => {
  const row = db
    .prepare('SELECT t.*, g.name FROM group_tokens t JOIN campaign_groups g ON g.id = t.group_id WHERE t.token = ?')
    .get(req.params.token);
  if (!row) return res.status(404).json({ error: 'no_such_invite' });
  if (row.revoked) return res.status(410).json({ error: 'invite_revoked' });
  if (row.expires_at < now()) return res.status(410).json({ error: 'invite_expired' });

  const existing = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND observer_id = ?').get(row.group_id, req.observer.id);
  if (existing) return res.json({ ok: true, already: true, group_id: row.group_id, name: row.name });

  const t = now();
  // The saved unit auto-PROPOSES the assignment. 176,846 units means manual
  // assignment is not a workflow, it is an impossibility — so the agent's own
  // saved unit does the first pass and the manager works the exceptions.
  const saved = db.prepare('SELECT pu_code FROM saved_units WHERE observer_id = ?').get(req.observer.id);
  db.prepare(
    `INSERT INTO group_members (group_id, observer_id, assigned_pu, assign_state, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.group_id, req.observer.id, saved?.pu_code || null, saved?.pu_code ? 'proposed' : '', t);
  db.prepare('UPDATE group_tokens SET uses = uses + 1 WHERE token = ?').run(row.token);
  res.status(201).json({ ok: true, group_id: row.group_id, name: row.name, proposed_pu: saved?.pu_code || null });
});

/**
 * Promote a member to manager, or demote one back.
 *
 * PROMOTION IS FROM THE ROSTER, not from a box you type an id into. A manager
 * already sees their own people on the Team tab; asking them to transcribe an
 * observer id would be asking them to get it wrong silently, and a mistyped id
 * hands another campaign's observer the keys to this one.
 *
 * OWNER ONLY. Delegation is downward, and a manager who could appoint peers
 * could appoint their way around the owner. The owner cannot be demoted here
 * either — a group with no owner has no one who can fix it.
 */
groupsRouter.post('/groups/:id/managers/:observerId', requireObserver, requireManager, (req, res) => {
  if (!isOwner(req.manager)) return res.status(403).json({ error: 'owner_only' });
  const observerId = Number(req.params.observerId);
  const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND observer_id = ?').get(req.group.id, observerId);
  if (!member) return res.status(404).json({ error: 'not_a_member' });

  const role = req.body?.role === 'coordinator' ? 'coordinator' : 'manager';
  const scopeKind = role === 'coordinator' ? String(req.body?.scope_kind || '') : '';
  const scopeValue = role === 'coordinator' ? String(req.body?.scope_value || '').trim() : '';
  if (role === 'coordinator' && !['zone', 'state', 'lga', 'ward'].includes(scopeKind)) {
    return res.status(400).json({ error: 'bad_scope' });
  }
  db.prepare(
    `INSERT INTO group_managers (group_id, observer_id, role, scope_kind, scope_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, observer_id) DO UPDATE SET role = excluded.role,
       scope_kind = excluded.scope_kind, scope_value = excluded.scope_value`,
  ).run(req.group.id, observerId, role, scopeKind, scopeValue, now());

  notifyObserverId(observerId, 'tg.made-manager', { group: req.group.name });
  pushNote(observerId, {
    kind: 'group_role',
    titleKey: 'note.made-manager.title',
    bodyKey: 'note.made-manager.body',
    params: { group: req.group.name },
    url: 'https://hawkeye.com.ng/situation-room.html',
  });
  res.json({ ok: true, role });
});

groupsRouter.delete('/groups/:id/managers/:observerId', requireObserver, requireManager, (req, res) => {
  if (!isOwner(req.manager)) return res.status(403).json({ error: 'owner_only' });
  const observerId = Number(req.params.observerId);
  if (observerId === req.observer.id) return res.status(400).json({ error: 'cannot_demote_owner' });
  db.prepare("DELETE FROM group_managers WHERE group_id = ? AND observer_id = ? AND role != 'owner'")
    .run(req.group.id, observerId);
  res.json({ ok: true });
});

/**
 * Rename a member on this group's roster. Manager-only, and the write is
 * confined to this group's row — a label never leaves the group that wrote it.
 */
groupsRouter.patch('/groups/:id/members/:observerId', requireObserver, requireManager, (req, res) => {
  const label = String(req.body?.label ?? '').trim().slice(0, MAX_NAME);
  const r = db.prepare('UPDATE group_members SET label = ? WHERE group_id = ? AND observer_id = ?')
    .run(label || null, req.group.id, Number(req.params.observerId));
  if (!r.changes) return res.status(404).json({ error: 'not_a_member' });
  res.json({ ok: true, label: label || null });
});

/**
 * Assign a member to a polling unit, or clear the assignment.
 *
 * THE ASSIGNMENT IS A LABEL ON THE BOARD, NOT A PERMISSION. Nothing in the
 * submission path reads it. An observer whose party moved them, who was turned
 * away, or who was simply assigned wrongly still files from where they stand —
 * a clerical error that silenced a real observer at a real unit would be far
 * worse than an inaccurate coverage number.
 *
 * A COORDINATOR CANNOT ASSIGN OUTSIDE THEIR OWN AREA. This is the half of a
 * scope that has to hold: they may read every area's totals (see scopeClause),
 * but the people they can move are their own. A scope that narrows nothing a
 * person can DO is decoration.
 */
groupsRouter.patch('/groups/:id/members/:observerId/assignment', requireObserver, requireManager, (req, res) => {
  const observerId = Number(req.params.observerId);
  const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND observer_id = ?').get(req.group.id, observerId);
  if (!member) return res.status(404).json({ error: 'not_a_member' });

  const puCode = req.body?.pu_code ? String(req.body.pu_code).trim() : null;
  if (!puCode) {
    db.prepare("UPDATE group_members SET assigned_pu = NULL, assign_state = '', assigned_by = ?, assigned_at = ? WHERE group_id = ? AND observer_id = ?")
      .run(req.observer.id, now(), req.group.id, observerId);
    return res.json({ ok: true, assigned: null });
  }

  const pu = db.prepare('SELECT pu_code, name, ward, lga, state FROM polling_units WHERE pu_code = ?').get(puCode);
  if (!pu) return res.status(404).json({ error: 'no_such_unit' });
  // A zone has no column on the unit — it is a set of states — so the check is
  // membership, not equality. Comparing pu['zone'] would read undefined and let
  // every assignment through.
  const mk = req.manager.scope_kind;
  const mv = req.manager.scope_value;
  const outside = mk && mv && (mk === 'zone' ? !zoneStates(mv).includes(pu.state) : pu[mk] !== mv);
  if (outside) {
    return res.status(403).json({ error: 'outside_your_scope' });
  }

  db.prepare("UPDATE group_members SET assigned_pu = ?, assign_state = 'confirmed', assigned_by = ?, assigned_at = ? WHERE group_id = ? AND observer_id = ?")
    .run(pu.pu_code, req.observer.id, now(), req.group.id, observerId);

  // In-app + push, and Telegram where it is linked. NEVER WhatsApp — race and
  // assignment alerts go to free channels only (in-app or Telegram).
  const where = `${pu.name} (${pu.pu_code})`;
  pushNote(observerId, {
    kind: 'assignment',
    titleKey: 'note.assigned.title',
    bodyKey: 'note.assigned.body',
    params: { group: req.group.name, unit: where },
    // The screen ABOUT the assignment, not the generic report funnel — this is
    // also where they decline it, and a notification that cannot reach its own
    // correction route is how a wrong assignment survives to election day.
    url: 'https://hawkeye.com.ng/my-groups.html',
  });
  notifyObserverId(observerId, 'tg.assigned', { group: req.group.name, unit: where });

  res.json({ ok: true, assigned: pu });
});

/**
 * Accept every auto-proposed assignment at once.
 *
 * DELIBERATELY SILENT. A proposal is the observer's OWN saved unit — confirming
 * it moves nobody, and telling several hundred people they have been assigned
 * to the unit they themselves chose is a notification that teaches them to
 * ignore the next one, which will be the one that actually moved them.
 */
groupsRouter.post('/groups/:id/assignments/confirm-proposed', requireObserver, requireManager, (req, res) => {
  const r = db.prepare("UPDATE group_members SET assign_state = 'confirmed', assigned_by = ?, assigned_at = ? WHERE group_id = ? AND assign_state = 'proposed'")
    .run(req.observer.id, now(), req.group.id);
  res.json({ ok: true, confirmed: r.changes });
});

/**
 * The observer's own way out of a wrong assignment.
 *
 * Without a correction route a wrong assignment sits on the board looking
 * correct, and the manager spends election night chasing someone who was never
 * going to be there. A declined member drops back into the exception queue as a
 * KNOWN case rather than reading as a silent no-show.
 */
groupsRouter.post('/groups/:id/decline', requireObserver, (req, res) => {
  const r = db.prepare("UPDATE group_members SET assign_state = 'declined' WHERE group_id = ? AND observer_id = ? AND assigned_pu IS NOT NULL")
    .run(Number(req.params.id), req.observer.id);
  if (!r.changes) return res.status(404).json({ error: 'nothing_to_decline' });
  res.json({ ok: true });
});

groupsRouter.delete('/groups/:id/membership', requireObserver, (req, res) => {
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND observer_id = ?').run(Number(req.params.id), req.observer.id);
  res.json({ ok: true });
});

// --- coverage -----------------------------------------------------------------

const LEVELS = { state: 'state', lga: 'lga', ward: 'ward' };

/**
 * One level of the LGA -> Ward -> Unit tree, loaded lazily.
 *
 * Lazy is not only the cheaper query, it is the correct screen: a national
 * presidential group covers 176,846 units and no manager reads that as a list.
 * They drill from where the gap is.
 *
 * Every node carries coverage AND count, because a percentage alone hides the
 * difference between 8/10 and 8,000/10,000 — and the second is the one that
 * needs people moved.
 */
groupsRouter.get('/groups/:id/coverage', requireObserver, requireManager, (req, res) => {
  const g = req.group;
  const where = [];
  const params = [];
  // The group's OWN race, scoped by whichever column that race is drawn on —
  // a Senate group covers a senatorial district, not the whole state — and
  // pinned to that district's own state, because a few register rows are not
  // (see majorityStateSql).
  if (g.scope) {
    const col = scopeColumn(g.contest);
    where.push(`pu.${col} = ?`);
    params.push(g.scope);
    if (col !== 'state') {
      const home = homeState(col, g.scope);
      if (home) { where.push('pu.state = ?'); params.push(home); }
    }
  }
  for (const k of ['state', 'lga', 'ward']) {
    const v = req.query[k] ? String(req.query[k]) : '';
    if (v) { where.push(`pu.${LEVELS[k]} = ?`); params.push(v); }
  }
  /**
   * A COORDINATOR'S TREE IS THEIR AREA. Reversed from the earlier design, which
   * left coverage unfiltered so a coordinator could measure themselves against
   * the whole race. That reads well and works badly: a ward coordinator was
   * handed 13,325 polling units and a national manager's list of every LGA in
   * Lagos, none of which is theirs to do anything about. The place they work is
   * the place they should be looking at.
   *
   * The comparison that motivated the old choice is not lost — it belongs in a
   * headline figure beside their own ("your ward 34%, campaign 28%"), not in
   * the tree they drill. A number to be measured against is one row; a list you
   * cannot act on is noise.
   *
   * The team, activity and incident feeds were narrowed all along, because
   * those name people.
   */
  const sc = scopeClause(req.manager);
  const whereSql = (where.length ? 'WHERE ' + where.join(' AND ') : 'WHERE 1=1') + sc.sql;
  const all = [...params, ...sc.params];

  /**
   * Which level are we listing? The deepest filter present decides — and a
   * coordinator's own scope is a filter, so the tree ROOTS at their area.
   *
   * The rows above narrow to their area; this decides what those rows ARE. The
   * list a coordinator needs is the level BELOW the thing they run — a ward
   * coordinator manages polling units, a state coordinator manages LGAs — so
   * without this a ward coordinator opened on "local governments" and saw one
   * row: their own LGA, containing their one ward.
   *
   * Drilling still works from there, because the query filters below still win.
   */
  const BELOW = { zone: 'state', state: 'lga', lga: 'ward', ward: 'unit' };
  const mine = BELOW[req.manager.scope_kind] || null;
  const level = req.query.ward ? 'unit'
    : req.query.lga ? 'ward'
      : req.query.state ? 'lga'
        : mine || (g.scope ? 'lga' : 'state');
  const col = level === 'unit' ? 'pu.pu_code' : `pu.${level}`;

  const rows = db
    .prepare(
      `SELECT ${col} AS key, ${level === 'unit' ? 'pu.name' : col} AS name, COUNT(*) AS units,
              COUNT(DISTINCT s.pu_code) AS reported
         FROM polling_units pu
         LEFT JOIN submissions s ON s.pu_code = pu.pu_code AND s.contest = ?
         ${whereSql}
        GROUP BY ${col} ORDER BY name`,
    )
    .all(g.contest, ...all);

  /**
   * The group overlay, read from BOTH ENDS — and it has to be both.
   *
   * The obvious single query joins members to submissions on observer_id alone,
   * which quietly answers "did this unit's agent file ANYTHING, anywhere" and
   * then paints the unit covered. An agent assigned to unit A who files from
   * unit B would mark A green while A sits empty — the exact failure the four
   * states exist to prevent, hidden inside a plausible number.
   *
   * So: `assigned`/`on_unit`/`mismatched` are grouped by the ASSIGNED unit's
   * node, and `member_reported` by the REPORTED unit's node. An assigned unit
   * going silent and an unassigned unit gaining coverage are frequently the
   * same agent making one move, and a manager can only see that if the two ends
   * are counted separately.
   *
   * Kept out of the coverage aggregate above: one JOIN of members against
   * submissions there would multiply the unit counts, and a wrong denominator
   * is worse than a second query.
   */
  const byAssigned = db
    .prepare(
      `SELECT ${col} AS key,
              COUNT(DISTINCT m.observer_id) AS assigned,
              COUNT(DISTINCT CASE WHEN s.pu_code = m.assigned_pu THEN m.observer_id END) AS on_unit,
              COUNT(DISTINCT CASE WHEN s.id IS NOT NULL AND s.pu_code != m.assigned_pu THEN m.observer_id END) AS mismatched
         FROM group_members m
         JOIN polling_units pu ON pu.pu_code = m.assigned_pu
         LEFT JOIN submissions s ON s.observer_id = m.observer_id AND s.contest = ? AND s.created_at >= m.joined_at
         ${whereSql} AND m.group_id = ? AND m.assign_state != 'declined'
        GROUP BY ${col}`,
    )
    .all(g.contest, ...all, g.id);

  // Declined members are NOT excluded here. They are still members, and a unit
  // they actually reported from is genuinely covered by this group — declining
  // an assignment is not the same as not turning up.
  const byReported = db
    .prepare(
      `SELECT ${col} AS key, COUNT(DISTINCT s.pu_code) AS member_reported
         FROM group_members m
         JOIN submissions s ON s.observer_id = m.observer_id AND s.contest = ? AND s.created_at >= m.joined_at
         JOIN polling_units pu ON pu.pu_code = s.pu_code
         ${whereSql} AND m.group_id = ?
        GROUP BY ${col}`,
    )
    .all(g.contest, ...all, g.id);

  const aMap = new Map(byAssigned.map((o) => [o.key, o]));
  const rMap = new Map(byReported.map((o) => [o.key, o.member_reported]));

  res.json({
    level,
    contest: g.contest,
    // Who covers each area, so the tree doubles as the standings table rather
    // than a second screen holding the same numbers.
    coordinators: coordinatorsAt(g.id, level),
    // The reader's own patch, marked server-side so the client never has to
    // re-derive which row is theirs.
    mine: scopeKeyAt(req.manager, level),
    my_scope: req.manager.scope_kind
      ? { kind: req.manager.scope_kind, value: req.manager.scope_value }
      : null,
    nodes: rows.map((r) => ({
      key: r.key,
      name: r.name,
      units: r.units,
      reported: r.reported,                              // public: any unit with a report
      assigned: aMap.get(r.key)?.assigned || 0,
      on_unit: aMap.get(r.key)?.on_unit || 0,            // green: assigned here AND filed here
      mismatched: aMap.get(r.key)?.mismatched || 0,      // assigned here, filed elsewhere
      member_reported: rMap.get(r.key) || 0,             // units here a member actually filed from
    })),
  });
});

/**
 * What this group's people have filed lately, newest first.
 *
 * The "what changed" half of the overview. Reads the same public stream as
 * everything else, from each member's joined_at forward, and says whether each
 * report came from the unit that member was down for — the mismatch is most
 * legible at the moment it happens, while the manager can still ring someone.
 */
groupsRouter.get('/groups/:id/activity', requireObserver, requireManager, (req, res) => {
  const sc = scopeClause(req.manager);
  const rows = db
    .prepare(
      `SELECT s.pu_code, s.created_at, m.observer_id, m.label, m.assigned_pu,
              pu.name, pu.ward, pu.lga
         FROM group_members m
         JOIN submissions s ON s.observer_id = m.observer_id AND s.contest = ? AND s.created_at >= m.joined_at
         JOIN polling_units pu ON pu.pu_code = s.pu_code
        WHERE m.group_id = ?${sc.sql}
        ORDER BY s.created_at DESC LIMIT 25`,
    )
    .all(req.group.contest, req.group.id, ...sc.params);
  res.json({
    reports: rows.map((r) => ({
      observer_id: r.observer_id,
      label: r.label || null,
      role: r.role || null,
      at: r.created_at,
      pu_code: r.pu_code,
      name: r.name,
      ward: r.ward,
      lga: r.lga,
      // null when they had no assignment at all — which is not a mismatch, and
      // must not be shown as one.
      on_unit: r.assigned_pu ? r.pu_code === r.assigned_pu : null,
      assigned_pu: r.assigned_pu || null,
    })),
  });
});

/**
 * Published incidents inside this group's race.
 *
 * `status = 'published'` is the SAME GATE the public incident feed uses, and it
 * is the whole reason this tab is allowed to exist. A group seeing a pending
 * incident would be seeing something the public cannot, which is the one thing
 * this feature promises never to do — so the filter is copied from
 * routes/incidents.js rather than reasoned about again here.
 *
 * Whether the reporter is one of the group's own observers is shown, from their
 * joined_at forward like everything else. That is the only thing the group
 * layer adds: the same public incident, with "this was one of ours" attached.
 */
groupsRouter.get('/groups/:id/incidents', requireObserver, requireManager, (req, res) => {
  const g = req.group;
  const where = ["i.status = 'published'"];
  const params = [];
  if (g.scope) {
    const col = scopeColumn(g.contest);
    if (col === 'state') {
      // An incident can be filed without a unit — those carry only a state, and
      // dropping them would hide exactly the reports too chaotic to pin down.
      where.push('(pu.state = ? OR (i.pu_code IS NULL AND i.state = ?))');
      params.push(g.scope, g.scope);
    } else {
      where.push(`pu.${col} = ?`);
      params.push(g.scope);
      const home = homeState(col, g.scope);
      if (home) { where.push('pu.state = ?'); params.push(home); }
    }
  }
  const sc = scopeClause(req.manager);

  const rows = db
    .prepare(
      `SELECT i.id, i.kind, i.description, i.pu_code, i.state, i.created_at, i.observer_id,
              pu.name, pu.ward, pu.lga,
              m.label AS member_label, m.observer_id AS member_id
         FROM incidents i
         LEFT JOIN polling_units pu ON pu.pu_code = i.pu_code
         LEFT JOIN group_members m
           ON m.observer_id = i.observer_id AND m.group_id = ? AND i.created_at >= m.joined_at
        WHERE ${where.join(' AND ')}${sc.sql}
        ORDER BY i.created_at DESC LIMIT 40`,
    )
    .all(g.id, ...params, ...sc.params);

  res.json({
    incidents: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      // Free text written by a member of the public. It is already published,
      // but it is data — the client escapes it and never renders it as markup.
      description: r.description ? String(r.description).slice(0, 400) : null,
      at: r.created_at,
      pu_code: r.pu_code || null,
      name: r.name || null,
      ward: r.ward || null,
      lga: r.lga || null,
      state: r.state || null,
      ours: r.member_id ? { label: r.member_label || null, observer_id: r.member_id } : null,
    })),
  });
});

// --- team ---------------------------------------------------------------------

/**
 * The same gap, indexed by person.
 *
 * FOUR STATES, NOT TWO. Green means reported FROM THE ASSIGNED UNIT and nothing
 * else earns it; `mismatch` means they reported, but somewhere else, and names
 * where; `silent` is the actionable one; `unassigned` is nobody's fault yet.
 * Red is reserved for something genuinely wrong, because red-for-not-yet means
 * the whole screen is red at 08:00, managers learn that red means nothing, and
 * then it cannot warn them when it matters.
 *
 * A MISMATCH IS A DISCREPANCY TO EXPLAIN, NOT A VERDICT. Agents get moved by
 * their own party, turned away, or sent to a merged unit. The field is named for
 * the fact, never for the accusation.
 */
groupsRouter.get('/groups/:id/team', requireObserver, requireManager, (req, res) => {
  const sc = scopeClause(req.manager, 'apu');
  const rows = db
    .prepare(
      `SELECT m.observer_id, m.label, m.assigned_pu, m.assign_state, m.joined_at, gm.role,
              apu.name AS assigned_name, apu.ward AS assigned_ward, apu.lga AS assigned_lga, apu.state AS assigned_state,
              s.pu_code AS reported_pu, s.created_at AS reported_at,
              rpu.name AS reported_name, rpu.ward AS reported_ward, rpu.lga AS reported_lga
         FROM group_members m
         LEFT JOIN group_managers gm ON gm.group_id = m.group_id AND gm.observer_id = m.observer_id
         LEFT JOIN polling_units apu ON apu.pu_code = m.assigned_pu
         LEFT JOIN submissions s ON s.observer_id = m.observer_id AND s.contest = ? AND s.created_at >= m.joined_at
         LEFT JOIN polling_units rpu ON rpu.pu_code = s.pu_code
        WHERE m.group_id = ?${sc.sql}
        ORDER BY m.joined_at`,
    )
    .all(req.group.contest, req.group.id, ...sc.params);

  res.json({
    contest: req.group.contest,
    members: rows.map((r) => ({
      observer_id: r.observer_id,
      label: r.label || null,
      role: r.role || null,
      joined_at: r.joined_at,
      assign_state: r.assign_state,
      assigned: r.assigned_pu ? { pu_code: r.assigned_pu, name: r.assigned_name, ward: r.assigned_ward, lga: r.assigned_lga, state: r.assigned_state } : null,
      reported: r.reported_pu ? { pu_code: r.reported_pu, name: r.reported_name, ward: r.reported_ward, lga: r.reported_lga, at: r.reported_at } : null,
      status: memberStatus(r),
    })),
  });
});

function memberStatus(r) {
  if (r.assign_state === 'declined') return 'declined';
  if (r.reported_pu && r.assigned_pu) return r.reported_pu === r.assigned_pu ? 'on_unit' : 'mismatch';
  if (r.reported_pu) return 'reported_unassigned';
  if (r.assigned_pu) return 'silent';
  return 'unassigned';
}

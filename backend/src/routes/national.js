import { Router } from 'express';
import { db, contests, contestCodes } from '../db.js';
import { LEVEL_COLS, boardLevelFor, contestGate, reportingOpen, reportingOpensAt } from '../services/scope.js';

export const nationalRouter = Router();

// `open`/`opensAt` are computed per request so the client can grey out result
// reporting for a scheduled election that hasn't reached poll-open yet.
nationalRouter.get('/contests', (_req, res) => res.json(
  contests.map((c) => ({ ...c, open: reportingOpen(c), opensAt: reportingOpensAt(c) })),
));

// The level tables MOVED to services/scope.js. They were duplicated here only,
// so /api/coverage/gaps could not use them and counted states for a Senate
// election. See scope.js:regionLevelFor.

// A contest that runs in exactly ONE state is not a national contest, and a board
// showing all 36 other states is answering a question nobody asked. Crop to that
// state and subdivide one level finer: a governorship becomes its LGAs.
//
// LGA is the floor. Ward polygons exist (nga_wards.geojson) but their names do
// not join to the register — 225 of Osun's 332 wards have no match, because the
// two sources use different naming systems entirely. A ward map would be
// two-thirds blank or, worse, confidently wrong.

/**
 * The single state a contest is confined to, or null.
 *
 * This CROPS the board — one state, subdivided one level finer. It is not the
 * contest's scope: a contest naming 28 of the 36 states is confined to those 28
 * and cannot be cropped to any one of them. That narrowing is contestGate's job,
 * and the absence of it is what drew a 37-state board for a 28-state election.
 */
const soleState = (code) => {
  const c = contests.find((x) => x.code === code);
  return Array.isArray(c?.states) && c.states.length === 1 ? c.states[0] : null;
};

/**
 * A caller-supplied state to crop to, resolved to the REGISTER'S OWN SPELLING,
 * or null if it names nothing.
 *
 * Needed because a race page is about one seat: a Kano governorship page wants
 * Kano's LGAs, but the 2027 GOV contest runs in 28 states, so soleState() is
 * null and the nationwide branch would hand back 28 state totals — a board for a
 * page that is not asking about the other 27.
 *
 * RESOLVED, NOT TRUSTED. The value reaches the SQL as a bound parameter either
 * way, but matching it against the register first means an unknown state
 * produces a 404 rather than an empty board that looks like "no reports yet" —
 * the difference between a wrong answer and no answer.
 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
let stateNames = null;
const resolveState = (q) => {
  if (!q) return null;
  stateNames ??= db.prepare(
    "SELECT DISTINCT state FROM polling_units WHERE state IS NOT NULL AND state != ''").all().map((r) => r.state);
  return stateNames.find((s) => norm(s) === norm(q)) ?? null;
};

// Tentative national tally for the leaderboard/map. Sums each unit's leading
// (most-corroborated) vote set into regions: states for president/governor,
// senatorial districts for Senate, federal constituencies for House of Reps.
// Explicitly UNOFFICIAL — labelled as such in the UI.
nationalRouter.get('/national/:contest', (req, res) => {
  const contest = String(req.params.contest);
  if (!contestCodes.has(contest)) return res.status(404).json({ error: 'unknown_contest' });
  // ?state= crops a nationwide contest to one state and subdivides it one level
  // finer, exactly as a single-state contest is already treated — so a race page
  // for one seat gets that seat's sub-units instead of the whole federation.
  let asked = null;
  if (req.query.state != null) {
    asked = resolveState(req.query.state);
    if (!asked) return res.status(404).json({ error: 'unknown_state' });
  }
  const contestDef = contests.find((c) => c.code === contest);
  const state = asked ?? soleState(contest);
  // boardLevelFor, not regionLevelFor: a contest held in ONE constituency drops a
  // level, because bucketing it by its own level gives a board of one bucket and
  // a map of one undivided block. See services/scope.js.
  let { level, col } = boardLevelFor(contestDef, contest, state);
  // ?level= asks for a finer breakdown than the contest's default. A senatorial
  // race page draws its district as LGAs — every district is a union of whole
  // LGAs — so it needs LGA-keyed tallies, which SCOPED.SEN ('senatorial') does
  // not give. The column is taken from THIS TABLE and never from the query, so
  // the only strings that can reach the SQL are the four written here.
  if (req.query.level && Object.hasOwn(LEVEL_COLS, req.query.level)) {
    level = req.query.level;
    col = LEVEL_COLS[level];
  }

  /**
   * A contest is narrowed to its own scope HERE as well as on the write path.
   *
   * The write path has always gated correctly — only a unit inside
   * Gombe/Kwami/Funakaye can file into that by-election, and no FCT unit can
   * file into a governorship — but this endpoint read straight off the register.
   * So a by-election board listed every federal constituency in the state ("0 of
   * 6 reporting" for an election held in one), and the 2027 governorship listed
   * all 37 states for a race held in 28.
   *
   * `cropped` because a state crop already answers the question the state
   * allowlist would. The constituency allowlist is NOT level-dependent: it
   * narrows the units, and the board then buckets them by whatever `?level=`
   * asked for — so a one-seat REP board drawn at `?level=lga` gets that seat's
   * member LGAs. See services/scope.js contestGate.
   */
  const gate = contestGate(contestDef, { cropped: Boolean(state) });

  const rows = state
    ? db.prepare(`
        SELECT r.votes_json, r.status, r.disputed, p.${col} AS region
        FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
        WHERE r.contest = ? AND p.state = ?${gate.sql}`).all(contest, state, ...gate.params)
    : db.prepare(`
        SELECT r.votes_json, r.status, r.disputed, p.${col} AS region
        FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
        WHERE r.contest = ?${gate.sql}`).all(contest, ...gate.params);

  // Every sub-unit in scope, reported or not. The clients draw the map from THIS,
  // not from `regions` — otherwise a board with no reports yet (the normal state
  // before election day) would render an empty frame instead of the state's
  // outline. It also spares them guessing which districts belong to a state,
  // which the geo files cannot answer: district/constituency shapes carry no
  // state property.
  const subunits = (state
    ? db.prepare(`SELECT DISTINCT ${col} AS r FROM polling_units WHERE state = ? AND ${col} IS NOT NULL AND ${col} != ''${gate.sqlBare} ORDER BY r`).all(state, ...gate.params)
    : db.prepare(`SELECT DISTINCT ${col} AS r FROM polling_units WHERE ${col} IS NOT NULL AND ${col} != ''${gate.sqlBare} ORDER BY r`).all(...gate.params)
  ).map((x) => x.r);

  const national = {};
  const regions = {};
  let inDispute = 0;
  for (const row of rows) {
    // Disputed results (open high-severity flag / open or upheld case) are
    // excluded from the headline tally — shown separately and judged by the
    // crowd on the public docket (docs/CROWD-ARBITRATION.md).
    if (row.disputed) { inDispute++; continue; }
    const key = row.region || 'Unknown';
    regions[key] ??= { votes: {}, unitsReporting: 0, unitsVerified: 0 };
    regions[key].unitsReporting++;
    if (row.status === 'verified') regions[key].unitsVerified++;
    for (const v of JSON.parse(row.votes_json)) {
      if (!v.count) continue;
      national[v.party] = (national[v.party] || 0) + v.count;
      regions[key].votes[v.party] = (regions[key].votes[v.party] || 0) + v.count;
    }
  }

  res.json({
    contest,
    level,
    // The geographic crop, or null for a nationwide contest. Clients draw only
    // this state's sub-units and zoom to them.
    scope: state ? { state } : null,
    subunits,
    updatedAt: Date.now(),
    unitsReporting: rows.length - inDispute,
    inDispute,
    national: Object.entries(national).map(([party, votes]) => ({ party, votes })).sort((a, b) => b.votes - a.votes),
    regions: Object.entries(regions).map(([region, s]) => {
      const ranked = Object.entries(s.votes).sort((a, b) => b[1] - a[1]);
      const top = ranked[0]?.[1];
      // every party tied at the top (usually 1; >1 = exact tie — the map splits the shape)
      const leaders = top === undefined ? [] : ranked.filter(([, v]) => v === top).map(([p]) => p);
      return {
        region,
        leader: leaders[0] ?? null,
        leaders,
        votes: s.votes,
        unitsReporting: s.unitsReporting,
        unitsVerified: s.unitsVerified,
      };
    }),
  });
});

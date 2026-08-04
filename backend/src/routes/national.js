import { Router } from 'express';
import { db, contests, contestCodes } from '../db.js';
import { reportingOpen, reportingOpensAt } from '../services/scope.js';

export const nationalRouter = Router();

// `open`/`opensAt` are computed per request so the client can grey out result
// reporting for a scheduled election that hasn't reached poll-open yet.
nationalRouter.get('/contests', (_req, res) => res.json(
  contests.map((c) => ({ ...c, open: reportingOpen(c), opensAt: reportingOpensAt(c) })),
));

// Which region a contest divides into, and the polling_units column that keys it.
// This is the NATIONWIDE shape — used when a contest is not confined to one state.
const LEVEL = {
  PRES: { level: 'state', col: 'state' },
  GOV: { level: 'state', col: 'state' },
  // Was `col: 'state'` while claiming level 'lga' — it labelled the level LGA but
  // bucketed by STATE, which is why the map painted every LGA in a state one flat
  // colour. State-assembly constituencies are genuinely absent from the register
  // (services/scope.js says so), so LGA is the honest finest grain for SHA.
  SHA: { level: 'lga', col: 'lga' },
  SEN: { level: 'senatorial', col: 'senatorial' },
  REP: { level: 'federal', col: 'federal_constituency' },
};

// A contest that runs in exactly ONE state is not a national contest, and a board
// showing all 36 other states is answering a question nobody asked. Crop to that
// state and subdivide one level finer: a governorship becomes its LGAs.
//
// LGA is the floor. Ward polygons exist (nga_wards.geojson) but their names do
// not join to the register — 225 of Osun's 332 wards have no match, because the
// two sources use different naming systems entirely. A ward map would be
// two-thirds blank or, worse, confidently wrong.
const SCOPED = {
  PRES: { level: 'lga', col: 'lga' },
  GOV: { level: 'lga', col: 'lga' },
  SHA: { level: 'lga', col: 'lga' },
  SEN: { level: 'senatorial', col: 'senatorial' },
  REP: { level: 'federal', col: 'federal_constituency' },
};

/** The single state a contest is confined to, or null if it is nationwide. */
const soleState = (code) => {
  const c = contests.find((x) => x.code === code);
  return Array.isArray(c?.states) && c.states.length === 1 ? c.states[0] : null;
};

// Tentative national tally for the leaderboard/map. Sums each unit's leading
// (most-corroborated) vote set into regions: states for president/governor,
// senatorial districts for Senate, federal constituencies for House of Reps.
// Explicitly UNOFFICIAL — labelled as such in the UI.
nationalRouter.get('/national/:contest', (req, res) => {
  const contest = String(req.params.contest);
  if (!contestCodes.has(contest)) return res.status(404).json({ error: 'unknown_contest' });
  const state = soleState(contest);
  const { level, col } = (state ? SCOPED[contest] : LEVEL[contest]) || LEVEL.PRES;

  const rows = state
    ? db.prepare(`
        SELECT r.votes_json, r.status, r.disputed, p.${col} AS region
        FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
        WHERE r.contest = ? AND p.state = ?`).all(contest, state)
    : db.prepare(`
        SELECT r.votes_json, r.status, r.disputed, p.${col} AS region
        FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
        WHERE r.contest = ?`).all(contest);

  // Every sub-unit in scope, reported or not. The clients draw the map from THIS,
  // not from `regions` — otherwise a board with no reports yet (the normal state
  // before election day) would render an empty frame instead of the state's
  // outline. It also spares them guessing which districts belong to a state,
  // which the geo files cannot answer: district/constituency shapes carry no
  // state property.
  const subunits = (state
    ? db.prepare(`SELECT DISTINCT ${col} AS r FROM polling_units WHERE state = ? AND ${col} IS NOT NULL AND ${col} != '' ORDER BY r`).all(state)
    : db.prepare(`SELECT DISTINCT ${col} AS r FROM polling_units WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY r`).all()
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

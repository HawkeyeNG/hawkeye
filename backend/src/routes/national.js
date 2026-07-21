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
const LEVEL = {
  PRES: { level: 'state', col: 'state' },
  GOV: { level: 'state', col: 'state' },
  SHA: { level: 'lga', col: 'state' },
  SEN: { level: 'senatorial', col: 'senatorial' },
  REP: { level: 'federal', col: 'federal_constituency' },
};

// Tentative national tally for the leaderboard/map. Sums each unit's leading
// (most-corroborated) vote set into regions: states for president/governor,
// senatorial districts for Senate, federal constituencies for House of Reps.
// Explicitly UNOFFICIAL — labelled as such in the UI.
nationalRouter.get('/national/:contest', (req, res) => {
  const contest = String(req.params.contest);
  if (!contestCodes.has(contest)) return res.status(404).json({ error: 'unknown_contest' });
  const { level, col } = LEVEL[contest] || LEVEL.PRES;

  const rows = db.prepare(`
    SELECT r.votes_json, r.status, r.disputed, p.${col} AS region
    FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
    WHERE r.contest = ?`).all(contest);

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

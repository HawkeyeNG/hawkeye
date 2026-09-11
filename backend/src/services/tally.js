/**
 * The headline tally, in ONE place.
 *
 * The public board (routes/national.js) and the situation room
 * (routes/groups.js) both count through this, so a campaign console cannot
 * drift from what the public sees — including the rule that is easiest to miss:
 * disputed results (open high-severity flag / open or upheld case) are excluded
 * from the headline tally, shown separately and judged by the crowd on the
 * public docket (docs/CROWD-ARBITRATION.md).
 *
 * rows: [{ votes_json, status, disputed, region? }] — region only matters to
 * callers that read `regions`.
 */
export function tallyResults(rows) {
  const national = {};
  const regions = {};
  let inDispute = 0;
  for (const row of rows) {
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
  return {
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
  };
}

import { config } from '../config.js';
import { haversineM, locationCluster } from './geo.js';

// Confidence-based aggregation, two independent axes:
//
//  VOTES    — group submissions by identical canonical vote vectors, weight each by
//             the reporting observer's reputation, surface the heaviest group.
//  LOCATION — 'verified' when the unit has verified coordinates (every submission
//             already passed the geofence). Otherwise crowd consensus: if enough
//             independent observers reported from within clusterRadiusM of their
//             common median point, the location is 'provisional' and the median
//             becomes the unit's crowd coordinate (bootstrapping the geofence for
//             later observers). Too few / too scattered -> 'unverified'.
//
// A unit can only be fully 'verified' when BOTH axes hold: matching votes from a
// location that is itself verified or provisional. Matching votes reported from
// scattered, unverifiable locations stay capped at 'reported'.
export function recomputeResult(db, puCode, contest = 'PRES') {
  const pu = db
    .prepare('SELECT lat, lng, approx_lat, approx_lng, approx_radius_m FROM polling_units WHERE pu_code = ?')
    .get(puCode);
  // Votes are per contest; the LOCATION axis uses every submission at the unit
  // regardless of contest — where the unit physically is doesn't depend on which
  // election is being counted.
  const rows = db
    .prepare(`
      SELECT s.votes_json, s.lat, s.lng, o.reputation
      FROM submissions s
      JOIN observers o ON o.id = s.observer_id
      WHERE s.pu_code = ? AND s.contest = ?`)
    .all(puCode, contest);
  if (rows.length === 0) return null;
  const locRows = db
    .prepare('SELECT lat, lng FROM submissions WHERE pu_code = ?')
    .all(puCode);

  // --- votes axis ---
  const groups = new Map();
  let totalWeight = 0;
  for (const r of rows) {
    const w = r.reputation > 0 ? r.reputation : 0;
    totalWeight += w;
    const g = groups.get(r.votes_json) || { weight: 0, count: 0 };
    g.weight += w;
    g.count += 1;
    groups.set(r.votes_json, g);
  }
  let top = null;
  for (const [votesJson, g] of groups) {
    if (!top || g.weight > top.weight) top = { votesJson, ...g };
  }
  const confidence = totalWeight > 0 ? Math.round((top.weight / totalWeight) * 1000) / 10 : 0;

  // --- location axis ---
  let locationStatus = 'verified';
  let locationConfidence = 100;
  let locationPlausibility = null;
  let cluster = null;
  if (pu.lat == null) {
    cluster = locationCluster(
      locRows.map((r) => ({ lat: r.lat, lng: r.lng })),
      config.clusterRadiusM,
    );
    locationConfidence = Math.round(cluster.share * 1000) / 10;
    if (cluster.inCluster >= config.minLocationReports && cluster.share >= 2 / 3) {
      // Cross-check the crowd cluster against the approximate envelope (GRID3
      // ward/school data): a coherent cluster planted far from where the unit can
      // plausibly be is exactly what a colluding group would produce.
      if (pu.approx_lat != null) {
        const d = haversineM(cluster.centerLat, cluster.centerLng, pu.approx_lat, pu.approx_lng);
        locationPlausibility = d <= pu.approx_radius_m * 1.5 + 1000 ? 'consistent' : 'inconsistent';
      }
      if (locationPlausibility === 'inconsistent') {
        locationStatus = 'unverified';
      } else {
        locationStatus = 'provisional';
        db.prepare(
          'UPDATE polling_units SET crowd_lat = ?, crowd_lng = ?, crowd_reports = ? WHERE pu_code = ?',
        ).run(cluster.centerLat, cluster.centerLng, cluster.inCluster, puCode);
      }
    } else {
      locationStatus = 'unverified';
    }
  }

  // --- venue-photo corroboration (ORB-confirmed same-place pairs) ---
  const venueMatches = db
    .prepare('SELECT COUNT(*) AS c FROM venue_matches WHERE pu_code = ? AND confirmed = 1')
    .get(puCode).c;

  // --- location evidence score (0–100) — fuses the independent signals ---
  // verified geofence = 100. Tier-2 combines: how tightly observers cluster (GPS),
  // how many independent reporters, whether the cluster sits where open data says
  // the unit plausibly is (landmark envelope beats ward envelope), and how many
  // venue-photo pairs ORB-confirmed as the same physical place. Capped at 95 —
  // only field-verified coordinates earn 100. Inconsistent cluster = 0.
  let locationScore = 100;
  if (pu.lat == null) {
    if (locationPlausibility === 'inconsistent') {
      locationScore = 0;
    } else {
      const gps = cluster ? cluster.share * 30 + (Math.min(cluster.inCluster, 5) / 5) * 25 : 0;
      const approxPts =
        locationPlausibility === 'consistent' ? (pu.approx_radius_m <= 1000 ? 25 : 15) : 5;
      const venuePts = (Math.min(venueMatches, 4) / 4) * 20;
      locationScore = Math.min(95, Math.round(gps + approxPts + venuePts));
    }
  }

  // --- combined status ---
  let status = 'reported';
  if (top.count >= config.minReportsForVerified && confidence >= config.minConfidenceForVerified) {
    status = 'verified';
  } else if (groups.size > 1) {
    status = 'disputed';
  }
  if (status === 'verified' && locationStatus === 'unverified') status = 'reported';

  // --- crowd-arbitration dispute axis (docs/CROWD-ARBITRATION.md) ---
  // An open high-severity flag, an open case, or a crowd-UPHELD case marks the
  // result disputed: badged everywhere, excluded from headline tallies, barred
  // from 'verified'. A crowd-CLEARED case lifts it (its flags get resolved).
  const disputed =
    db.prepare(`
      SELECT 1 FROM discrepancies
      WHERE pu_code = ? AND contest = ? AND severity = 'high' AND status = 'open' LIMIT 1`)
      .get(puCode, contest)
    || db.prepare(
      "SELECT 1 FROM cases WHERE pu_code = ? AND contest = ? AND status IN ('open','upheld','unresolved') LIMIT 1")
      .get(puCode, contest)
      ? 1 : 0;
  if (disputed && status === 'verified') status = 'reported';

  db.prepare(`
    INSERT INTO results
      (pu_code, contest, votes_json, confidence, matching_reports, total_reports, status,
       location_status, location_confidence, location_plausibility, location_score, venue_matches, disputed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pu_code, contest) DO UPDATE SET
      votes_json = excluded.votes_json,
      confidence = excluded.confidence,
      matching_reports = excluded.matching_reports,
      total_reports = excluded.total_reports,
      status = excluded.status,
      location_status = excluded.location_status,
      location_confidence = excluded.location_confidence,
      location_plausibility = excluded.location_plausibility,
      location_score = excluded.location_score,
      venue_matches = excluded.venue_matches,
      disputed = excluded.disputed,
      updated_at = excluded.updated_at`)
    .run(
      puCode, contest, top.votesJson, confidence, top.count, rows.length, status,
      locationStatus, locationConfidence, locationPlausibility, locationScore, venueMatches, disputed, Date.now(),
    );

  return {
    puCode,
    contest,
    votes: JSON.parse(top.votesJson),
    confidence,
    matchingReports: top.count,
    totalReports: rows.length,
    status,
    locationStatus,
    locationConfidence,
    locationPlausibility,
    locationScore,
    venueMatches,
    disputed: Boolean(disputed),
  };
}

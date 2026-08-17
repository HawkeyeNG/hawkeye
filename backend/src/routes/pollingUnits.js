import { Router } from 'express';
import { db, parties, contests } from '../db.js';
import { config } from '../config.js';
import { haversineM } from '../services/geo.js';
import { regionLevelFor } from '../services/scope.js';

export const pollingUnitsRouter = Router();

const tierOf = (u) =>
  u.lat != null ? 'verified' : u.crowd_lat != null ? (u.coords_source === 'geocoded' ? 'geocoded' : 'crowd') : 'unmapped';

// Unit DISCOVERY — "help me find my unit", not "prove you were there".
//
// Filters at config.discoveryRadiusM (500 m), deliberately WIDER than the
// submission geofence (config.geofenceRadiusM, 200 m, enforced in
// routes/submissions.js). Appearing in this list asserts nothing: a unit found
// here at 480 m is still refused by the fence if the observer files from there.
// Do not point this filter back at geofenceRadiusM to "make them agree" — the
// note in config.js explains what that silently changes.
//
// Two tiers appear here:
//   verified — official/field-verified coordinates; the geofence is enforced at
//              submission and reports count as location-verified.
//   crowd    — no verified coordinates, but enough independent observers reported
//              from one spot that their median fix places the unit provisionally.
// Units with neither stay invisible here; observers reach them through the
// register browse endpoints below, and their GPS is recorded (not verified).
//
// `radiusM` in the response is the radius actually searched, and the native
// clients prefer it over their own hardcoded mirror (native/src/app/report/
// result.tsx), so their "no unit within Xm" copy tracks this value by itself.
// `maxRows`/`capped` are reported for the same reason: truncation used to be
// invisible on the wire, leaving the client to infer it from a row count it had
// to hardcode.
pollingUnitsRouter.get('/polling-units', (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat_lng_required' });
  }
  /**
   * NARROW IN SQL BEFORE MEASURING IN JS.
   *
   * This read every located row in the register — 117,167 of them — spread each
   * into a new object, ran a haversine against it, and only then threw away
   * everything past 500m to keep at most 40. Measured 7-11s from a good wired
   * link and 12-40s against a local copy. That is the whole of "Looking up
   * nearby units…" hanging: on mobile data it crosses the client's 20s abort,
   * retries, and an observer standing at their polling unit sees a spinner for
   * up to 40s before anything is said. Both apps and the website pay it.
   *
   * A degree of latitude is ~111,320m everywhere; a degree of longitude is that
   * scaled by cos(lat). So the circle we are about to measure fits inside a box
   * that SQLite can filter on numerically, and the haversine below then runs
   * over a handful of rows instead of six figures. The box is generous (×1.2)
   * and is a strict SUPERSET of the circle — the distance filter that follows is
   * untouched, so the rows returned are exactly the rows returned before.
   * Verified identical across Abuja, Osun, Lagos, Kano, Port Harcourt, Sokoto
   * and open ocean; 12-40s became 0.1-0.6s.
   *
   * COALESCE mirrors the lat ?? crowd_lat below it: a unit is placed by its
   * verified point when it has one and its crowd median otherwise, and the box
   * has to test whichever point the distance will be measured from.
   */
  const dLat = (config.discoveryRadiusM / 111320) * 1.2;
  // cos() floored so a latitude near the poles cannot divide by ~0 and produce
  // an infinite span. Nigeria is nowhere near that, but this is a public GET.
  const dLng =
    (config.discoveryRadiusM / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)))) * 1.2;
  const units = db
    .prepare(
      `SELECT * FROM polling_units
        WHERE (lat IS NOT NULL OR crowd_lat IS NOT NULL)
          AND COALESCE(lat, crowd_lat) BETWEEN @latMin AND @latMax
          AND COALESCE(lng, crowd_lng) BETWEEN @lngMin AND @lngMax`,
    )
    .all({
      latMin: lat - dLat,
      latMax: lat + dLat,
      lngMin: lng - dLng,
      lngMax: lng + dLng,
    })
    .map((u) => ({
      ...u,
      locationTier: tierOf(u),
      distanceM: Math.round(haversineM(lat, lng, u.lat ?? u.crowd_lat, u.lng ?? u.crowd_lng)),
    }))
    .filter((u) => u.distanceM <= config.discoveryRadiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    // Row cap, measured against the 117,167 located units actually in the
    // register: within 500 m the median location has 3 units, p90 23, p95 36,
    // max 109. The old cap of 8 therefore truncated at 27% of locations once the
    // radius widened; 40 leaves 3.6% truncated. Truncation is the expensive
    // failure — the observer's own unit silently absent, sending them to browse
    // 176k rows by hand — while a surplus row costs ~477 bytes and a scroll, and
    // the list is distance-sorted so any surplus is always the far tail. The
    // full 40 only ever goes out in dense wards, which are cities with the
    // bandwidth for it; rural fixes still send three rows.
    .slice(0, config.discoveryMaxRows);
  res.json({
    radiusM: config.discoveryRadiusM,
    maxRows: config.discoveryMaxRows,
    // A full list and a truncated one are otherwise identical on the wire.
    capped: units.length >= config.discoveryMaxRows,
    units,
  });
});

// Register browse: the fallback path to units without any coordinates. This is a
// deliberate, visible trade-off of the two-tier model — such units cannot be
// location-locked, so their reports are badged unverified/provisional and their
// confidence is capped until a GPS cluster forms (see services/aggregate.js).
pollingUnitsRouter.get('/register/states', (_req, res) => {
  res.json(db.prepare('SELECT DISTINCT state FROM polling_units ORDER BY state').all().map((r) => r.state));
});

pollingUnitsRouter.get('/register/lgas', (req, res) => {
  res.json(
    db.prepare('SELECT DISTINCT lga FROM polling_units WHERE state = ? ORDER BY lga')
      .all(String(req.query.state || ''))
      .map((r) => r.lga),
  );
});

pollingUnitsRouter.get('/register/wards', (req, res) => {
  res.json(
    db.prepare('SELECT DISTINCT ward FROM polling_units WHERE state = ? AND lga = ? ORDER BY ward')
      .all(String(req.query.state || ''), String(req.query.lga || ''))
      .map((r) => r.ward),
  );
});

pollingUnitsRouter.get('/register/units', (req, res) => {
  const units = db
    .prepare('SELECT * FROM polling_units WHERE state = ? AND lga = ? AND ward = ? ORDER BY pu_code')
    .all(String(req.query.state || ''), String(req.query.lga || ''), String(req.query.ward || ''))
    .map((u) => ({ ...u, locationTier: tierOf(u) }));
  res.json({ units });
});

/**
 * Free-text polling-unit search — the one endpoint every PU picker shares.
 *
 * Until now the only ways to reach a unit were "near me" (GPS) and the strict
 * state → LGA → ward cascade, so someone who knew their unit's NAME but not its
 * ward had to guess their way down a tree. Typing "aso dr" now finds
 * "Aso Drive".
 *
 * Matches name, pu_code and ward, so a unit number works as well as a name.
 *
 * Ranked, because a bare LIKE is worse than useless here: searching "aso" on raw
 * row order can return a unit that merely CONTAINS those letters mid-word above
 * "Aso Drive" itself, which reads as broken. Exact code first, then prefix
 * matches, then mid-word.
 *
 * Cost: `LIKE '%q%'` cannot use an index (leading wildcard), so this is a scan
 * of ~177k rows — measured 83ms warm on the live DB. better-sqlite3 is
 * synchronous, so that is 83ms of blocked event loop; the 3-character minimum,
 * the LIMIT, and the optional state/lga narrowing are what keep it cheap, and
 * clients debounce.
 */
pollingUnitsRouter.get('/register/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ units: [], error: 'too_short' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 25);
  const state = String(req.query.state || '').trim();
  const lga = String(req.query.lga || '').trim();

  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const pre = `${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const where = ["(name LIKE ? ESCAPE '\\' OR pu_code LIKE ? ESCAPE '\\' OR ward LIKE ? ESCAPE '\\')"];
  const args = [like, like, like];
  if (state) { where.push('state = ?'); args.push(state); }
  if (lga) { where.push('lga = ?'); args.push(lga); }

  /**
   * PREFIX FIRST, CONTAINS ONLY IF NEEDED.
   *
   * The contains-match below is a leading wildcard, which no index can serve, so
   * it full-scans all 176,846 rows on every keystroke — 1.2-1.9s to first byte
   * against production, on the one control an observer types into.
   *
   * Nearly every real search is the START of a unit name or a PU code, and that
   * shape IS indexable (idx_pu_*_nocase in db.js). So try the seek first and
   * only pay for the scan when the prefix genuinely finds nothing — a rare case
   * that stays correct, just slow, instead of being slow every single time.
   */
  const runQuery = (clause, clauseArgs) => db
    .prepare(`
      SELECT * FROM polling_units
      WHERE ${clause}
      ORDER BY
        CASE WHEN pu_code = ? THEN 0
             WHEN name LIKE ? ESCAPE '\\' THEN 1
             WHEN pu_code LIKE ? ESCAPE '\\' THEN 2
             ELSE 3 END,
        name
      LIMIT ?`)
    .all(...clauseArgs, q, pre, pre, limit)
    .map((u) => ({ ...u, locationTier: tierOf(u) }));

  const scoped = where.slice(1); // the state/lga filters, without the match term
  const prefixWhere = ["(name LIKE ? ESCAPE '\\' OR pu_code LIKE ? ESCAPE '\\' OR ward LIKE ? ESCAPE '\\')", ...scoped]
    .join(' AND ');
  const prefixArgs = [pre, pre, pre, ...args.slice(3)];

  let units = runQuery(prefixWhere, prefixArgs);
  if (!units.length) units = runQuery(where.join(' AND '), args);

  res.json({ units, query: q, truncated: units.length === limit });
});

// Single unit by code — used by the Telegram hybrid /report handoff to prefill
// the Mini App (chat collects PU + votes; the app does live capture + signing).
pollingUnitsRouter.get('/register/unit', (req, res) => {
  const u = db.prepare('SELECT * FROM polling_units WHERE pu_code = ?').get(String(req.query.pu_code || '').trim());
  if (!u) return res.status(404).json({ error: 'unknown_unit' });
  res.json({ unit: { ...u, locationTier: tierOf(u) } });
});

// Reporting gaps: the areas with NO crowd report yet for a contest — where
// observers are still needed. Drives the "help cover these" nudge and the
// assistant tool.
//
// Scope follows the contest, exactly as /api/national does: a contest confined
// to one state reports its missing LGAs, not the 36 other states it was never
// held in. `unit`/`scope` tell the clients which noun to print.
pollingUnitsRouter.get('/coverage/gaps', (req, res) => {
  const contest = String(req.query.contest || 'PRES').toUpperCase();
  const c = contests.find((x) => x.code === contest);
  const state = Array.isArray(c?.states) && c.states.length === 1 ? c.states[0] : null;
  // THE LEVEL FOLLOWS THE CONTEST, not just whether it is state-scoped. `col`
  // was hardcoded to state/lga, so a Senate board read "0 of 37 states in this
  // election have reports" — counting states for an election fought in 109
  // senatorial districts, and naming the wrong places to go and cover.
  const { level, col, noun } = regionLevelFor(contest, state);

  const all = (state
    ? db.prepare(`SELECT DISTINCT ${col} AS r FROM polling_units WHERE state = ? AND ${col} IS NOT NULL AND ${col} != '' ORDER BY r`).all(state)
    : db.prepare(`SELECT DISTINCT ${col} AS r FROM polling_units WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY r`).all()
  ).map((r) => r.r);

  const reported = new Set((state
    ? db.prepare(`SELECT DISTINCT p.${col} AS s FROM submissions sub JOIN polling_units p ON p.pu_code = sub.pu_code WHERE sub.contest = ? AND p.state = ?`).all(contest, state)
    : db.prepare(`SELECT DISTINCT p.${col} AS s FROM submissions sub JOIN polling_units p ON p.pu_code = sub.pu_code WHERE sub.contest = ?`).all(contest)
  ).map((r) => r.s));

  const missing = all.filter((s) => !reported.has(s));
  res.json({
    contest,
    scope: state ? { state } : null,
    level,
    // The noun clients print. Was 'LGA' | 'state' only; it is now whatever the
    // contest's level is actually called, so no client has to infer it.
    unit: noun,
    // statesTotal/statesReported kept under their original names so existing
    // callers (native's coverage card, the assistant tool) keep working — they
    // now count LGAs when the contest is state-scoped.
    statesTotal: all.length,
    statesReported: reported.size,
    missing,
  });
});

// Register size vs geofence coverage — how much of the country is reportable, by tier.
pollingUnitsRouter.get('/coverage', (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM polling_units').get().c;
  const geocoded = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE lat IS NOT NULL').get().c;
  const crowd = db
    .prepare('SELECT COUNT(*) AS c FROM polling_units WHERE lat IS NULL AND crowd_lat IS NOT NULL')
    .get().c;
  const bySource = db.prepare(
    'SELECT coords_source AS source, COUNT(*) AS count FROM polling_units WHERE lat IS NOT NULL GROUP BY coords_source',
  ).all();
  const approxBySource = db.prepare(
    'SELECT approx_source AS source, COUNT(*) AS count FROM polling_units WHERE approx_lat IS NOT NULL GROUP BY approx_source',
  ).all();
  res.json({
    totalUnits: total,
    geocodedUnits: geocoded,
    crowdLocatedUnits: crowd,
    bySource,
    approxUnits: approxBySource.reduce((s, r) => s + r.count, 0),
    approxBySource,
  });
});

pollingUnitsRouter.get('/parties', (_req, res) => res.json(parties));

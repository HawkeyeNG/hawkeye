import { Router } from 'express';
import { db, parties } from '../db.js';
import { config } from '../config.js';
import { haversineM } from '../services/geo.js';

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
  const units = db
    .prepare('SELECT * FROM polling_units WHERE lat IS NOT NULL OR crowd_lat IS NOT NULL')
    .all()
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

// Single unit by code — used by the Telegram hybrid /report handoff to prefill
// the Mini App (chat collects PU + votes; the app does live capture + signing).
pollingUnitsRouter.get('/register/unit', (req, res) => {
  const u = db.prepare('SELECT * FROM polling_units WHERE pu_code = ?').get(String(req.query.pu_code || '').trim());
  if (!u) return res.status(404).json({ error: 'unknown_unit' });
  res.json({ unit: { ...u, locationTier: tierOf(u) } });
});

// Reporting gaps: states with NO crowd report yet for a contest — where observers
// are still needed. Drives the "help cover these" nudge and the assistant tool.
pollingUnitsRouter.get('/coverage/gaps', (req, res) => {
  const contest = String(req.query.contest || 'PRES').toUpperCase();
  const all = db.prepare('SELECT DISTINCT state FROM polling_units ORDER BY state').all().map((r) => r.state);
  const reported = new Set(
    db.prepare(`SELECT DISTINCT p.state AS s FROM submissions sub JOIN polling_units p ON p.pu_code = sub.pu_code WHERE sub.contest = ?`)
      .all(contest).map((r) => r.s),
  );
  const missing = all.filter((s) => !reported.has(s));
  res.json({ contest, statesTotal: all.length, statesReported: reported.size, missing });
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

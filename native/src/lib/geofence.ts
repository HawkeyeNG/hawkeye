/**
 * The client's half of the polling-unit geofence.
 *
 * WHY THIS IS A MODULE AND NOT A BLOCK INSIDE report/result.tsx, which is where
 * every line below was born: these numbers mirror
 * `backend/src/routes/submissions.js`, and the screen's only job is to warn
 * before two photos and a full tally have been spent on a submission the server
 * is going to refuse. A mirror that exists twice drifts — and the second copy
 * was about to be pasted into practice.tsx, which is the rehearsal and must
 * teach the fence the real flow enforces, not an approximation of it
 * (docs/REPORT-FLOW-CAPTURE-FIRST.md §2: practice "must move in lockstep, it is
 * the rehearsal").
 *
 * So there is one definition, both flows import it, and a threshold that changes
 * on the server changes in exactly one place here.
 *
 * NOTHING IN THIS MODULE DECIDES ANYTHING. The server owns every actual
 * rejection; these functions only pick the moment to speak.
 */
import type { UnitTier } from '@/components/unit-map';

/**
 * The coordinate columns a register row can carry, and the only thing the
 * geofence needs of a unit.
 *
 * Structural on purpose: report/result.tsx and practice.tsx each declare their
 * own local `Unit` (they select different subsets of the row), and neither
 * should have to adopt the other's to be measured. Every field is optional, so
 * a row that carries none of them is simply unplaced — see `unitPoint`.
 */
export type Placed = {
  lat?: number | null;
  lng?: number | null;
  crowd_lat?: number | null;
  crowd_lng?: number | null;
  approx_lat?: number | null;
  approx_lng?: number | null;
};

/**
 * The best position the register offers for a unit, in the same order of
 * confidence the server uses: verified pin, then crowd/geocoded median, then
 * the GRID3 envelope centre. Null when the register places it nowhere at all —
 * 14,464 units — in which case NOTHING is claimed about distance. Unknown must
 * never be rendered as far.
 */
export const unitPoint = (u: Placed): { lat: number; lng: number } | null => {
  if (u.lat != null && u.lng != null) return { lat: u.lat, lng: u.lng };
  if (u.crowd_lat != null && u.crowd_lng != null) return { lat: u.crowd_lat, lng: u.crowd_lng };
  if (u.approx_lat != null && u.approx_lng != null) return { lat: u.approx_lat, lng: u.approx_lng };
  return null;
};

/**
 * Metres between two positions — the same arithmetic as
 * backend/src/services/geo.js (same earth radius, same formula), because this
 * one number decides whether the screen contradicts the server about a
 * threshold the server is about to enforce.
 */
export const haversineM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * The distance at which selecting a unit is REFUSED outright, rather than
 * warned about.
 *
 * Chosen so that refusing here can never refuse a report the server would have
 * accepted. The widest distance any server branch can accept is the approx
 * envelope's `approx_radius_m * 1.5 + 2000`; the largest radius in the register
 * is 20,000m, giving 32km. The ward-centroid fallback added to submissions.js
 * alongside this change is 15km. 50km clears both.
 *
 * BELOW THIS, THE SCREEN STILL ONLY WARNS, and that is deliberate. Eight of
 * 176,846 units have an officially verified coordinate; 117,159 carry geocodes
 * recorded as roughly a third wrong. Blocking at the fence itself would turn
 * away observers standing exactly where they should be — the failure that
 * caused the 200m -> 500m raise recorded at config.js:242. A thousand-kilometre
 * mismatch carries no such doubt.
 */
export const GROSS_MISMATCH_M = 50_000;

/**
 * Where the screen starts saying out loud that a located unit is far away.
 *
 * Discovery reaches 800m, the submission geofence does not — so a unit can be
 * listed here and still be too far to file from. These mirror
 * backend/src/routes/submissions.js: the fence widens for crowd-mapped
 * coordinates, because the booth can stand anywhere inside the area observers
 * mapped, and warning at 500m there would talk observers out of submissions the
 * server would have accepted.
 *
 * `approx` is INFINITY here and that is not "no gate" — it is "no gate measured
 * from this point". submissions.js fences on distance to `pu.lat` and only runs
 * that branch when `pu.lat` is set, which an approx unit's is not by
 * definition. Its gate is a circle round a DIFFERENT centre and is checked
 * separately, against `fenceEnvelope`, by `envelopeHardLimitM` below.
 *
 * The server still owns the actual decision; these numbers only pick the moment
 * to warn, before two photos and a full tally have been spent.
 */
export const FAR_ENOUGH_TO_WARN_M: Record<UnitTier, number> = {
  verified: 500, // config.geofenceRadiusM — raised from 200 on 2026-08-31
  crowd: 750, // config.crowdGeofenceRadiusM
  approx: Number.POSITIVE_INFINITY,
};

/**
 * The fence to warn at when the tier was never confirmed — i.e. the row came
 * only from /api/polling-units, because /api/mapping/nearby failed.
 *
 * That lookup is wrapped in a catch and is ALLOWED to fail; on election day, on
 * one overloaded mast, it is the likelier of the two to. Without it every row
 * carries `verified`, since /api/polling-units tiers on which column is filled
 * and a crowd-mapped median lives in `lat` — so the 500m fence would have been
 * asserted over units the server accepts to 750m, and an observer standing 400m
 * from their own polling unit would be told to move for no reason.
 *
 * So the widest fence the server states in metres is used instead
 * (config.crowdGeofenceRadiusM). It is the widest any row this endpoint can
 * return is subject to: submissions.js fences only when `pu.lat` is set, at 500m
 * or 750m, and applies a far looser envelope check to everything else. Warning
 * late is recoverable — the server refuses and says the real distance. Warning
 * early on a guess talks an observer out of a submission that would have stood.
 */
export const UNCONFIRMED_FENCE_M = 750;

/**
 * The gate an approx unit really has, copied from
 * backend/src/routes/submissions.js:143-150:
 *
 *   } else if (pu.approx_lat != null) {
 *     const approxDist = haversineM(lat, lng, pu.approx_lat, pu.approx_lng);
 *     if (approxDist > pu.approx_radius_m * 1.5 + 2000) {
 *       return res.status(403).json({ error: 'too_far_from_unit' });
 *
 * A hard 403, not a flag — the flag is the second, 1000m-and-accuracy test one
 * line further down, which only downgrades `locationPlausible` and is none of
 * this screen's business. Roughly the top decile of the 109,507 geocoded units
 * are far enough out to cross this, and crossing it costs the observer two
 * photos and a full tally before the server says no.
 */
export const envelopeHardLimitM = (radiusM: number) => radiusM * 1.5 + 2000;

/**
 * The fence to warn at for one picked row, given whether its tier was actually
 * confirmed by /api/mapping/nearby.
 *
 * Both flows had to compose `tierConfirmed ? FAR_ENOUGH_TO_WARN_M[tier] :
 * UNCONFIRMED_FENCE_M` at the call site to ask the same question; that
 * composition is the rule, so it lives with the numbers.
 */
export const warnRadiusM = (tier: UnitTier, tierConfirmed: boolean) =>
  tierConfirmed ? FAR_ENOUGH_TO_WARN_M[tier] : UNCONFIRMED_FENCE_M;

/**
 * NEAR-ME ASKS WITH A ROUNDED POSITION (native review 2026-10-19, web L9).
 *
 * GET /api/polling-units and /api/mapping/nearby carry the position in the
 * URL, and URLs are written to the server's and the edge's access logs. A fix
 * there at full precision (7 decimals, ~1 cm) is a home address — and these
 * lookups fire by themselves, the moment a near-me screen opens.
 *
 * So the URL states the fix rounded to NEAR_DECIMALS (3: never more than 79 m
 * from the real one anywhere in Nigeria) and says so with `slackM`, which
 * widens the server's search by that much (backend services/geo.js
 * nearSlackM). The exact fix never leaves the phone: lib/nearby-offline.ts
 * re-measures every row from it (exactBody below) and drops rows outside the
 * radius the screen meant, so lists, distances and the pre-capture geofence
 * warnings are what they were at full precision.
 *
 * Why 3 and not 2: at 2 decimals the stated point can be 787 m from the
 * observer — further than the 500 m register radius — and the server's row
 * caps (40 / 200) are applied around the stated point. On a copy of the
 * production register (570 unit positions, jittered 0-15 m) 2 decimals lost
 * the observer's own unit from 1 register lookup in 10; at 3 it was listed,
 * at the same rank, every time.
 *
 * Import-free on purpose, so tests/near_me_query_precision_test.mjs can load
 * it alone. The web twin is app/register-store.js nearQuery/nearExact.
 */

export const NEAR_DECIMALS = 3;
/** Worst case at 3 decimals, half a cell corner to centre, rounded up. */
export const NEAR_SLACK_M = 80;

const coord = (v: number) => Number(v).toFixed(NEAR_DECIMALS);

/** `lat=7.772&lng=4.557&slackM=80` — the query string for either lookup. */
export function nearQuery(lat: number, lng: number): string {
  return `lat=${coord(lat)}&lng=${coord(lng)}&slackM=${NEAR_SLACK_M}`;
}

const RAD = Math.PI / 180;
const haversineM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const dLat = (bLat - aLat) * RAD, dLng = (bLng - aLng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

type Row = {
  lat?: number | null;
  lng?: number | null;
  crowd_lat?: number | null;
  crowd_lng?: number | null;
  distanceM?: number;
  [k: string]: unknown;
};

/**
 * A near-me answer re-measured from the EXACT fix.
 *
 * `body` is what either lookup answered — `{ units: [...] }`, or a bare array
 * from a server old enough to send one; anything else comes back untouched.
 * Each row is measured from the point the server measured it from: `lat ??
 * crowd_lat` (publicUnit has already withheld a rejected pin, so this IS
 * trustedPin ?? trustedCrowd), and a mapping row's lat/lng is its drawn point.
 * Rows beyond `maxM` — the register's own `radiusM` when not given — are
 * dropped, and the list comes back nearest-first.
 */
export function exactBody(body: unknown, lat: number, lng: number, maxM?: number): unknown {
  const env = body && typeof body === 'object' && !Array.isArray(body) ? (body as { units?: unknown; radiusM?: unknown }) : null;
  const list = Array.isArray(body) ? (body as Row[]) : Array.isArray(env?.units) ? (env!.units as Row[]) : null;
  if (!list) return body;
  let limit = Number(maxM);
  if (!(limit > 0) && env) limit = Number(env.radiusM);
  const out: Row[] = [];
  for (const u of list) {
    if (!u) continue;
    const la = u.lat ?? u.crowd_lat;
    const ln = u.lng ?? u.crowd_lng;
    if (la == null || ln == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      out.push(u);
      continue;
    }
    const d = Math.round(haversineM(lat, lng, Number(la), Number(ln)));
    if (limit > 0 && d > limit) continue;
    out.push({ ...u, distanceM: d });
  }
  out.sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
  return Array.isArray(body) ? out : { ...env, units: out };
}

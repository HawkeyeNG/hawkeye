/**
 * OFFLINE NEAR-ME: the per-state coordinates file, and the two server answers
 * rebuilt from it.
 *
 * PURE (no React Native, no storage, no fetch) so Node can test it against the
 * builder — native/scripts/verify_register_coords_ts.mjs. Format and rationale:
 * backend/scripts/build_register_packs.mjs (buildCoords). In short: unit i here
 * is unit i of the state pack named in the header, and which point may be
 * trusted was decided on the server when the file was built, by the same
 * publicUnit() the API uses. Nothing here re-judges a pin.
 *
 * nearbyFromPacks() returns the SAME two JSON shapes the near-me screens already
 * merge — GET /api/polling-units and GET /api/mapping/nearby — so the offline
 * path feeds the existing merge code instead of growing a second one.
 */
import { materialise, type RegisterRow, type StatePack } from './register-pack';

export const COORDS_MAGIC = 0x4f434b48; // 'HKCO'
export const COORDS_VERSION = 1;
const HEADER_BYTES = 32;
const F_PIN = 1, F_PIN_CROWD_MAPPED = 2, F_CROWD = 4, F_ENV = 64;
const TIERS = ['verified', 'crowd', 'geocoded', 'unverified', 'unmapped'] as const;
export type LocationTier = (typeof TIERS)[number];

/** Server constants this mirrors (backend/src/config.js, routes/mapping.js). */
export const REGISTER_RADIUS_M = 500;
export const REGISTER_MAX_ROWS = 40;
export const MAPPING_MAX_ROWS = 200;

export type CoordsPack = {
  stateCode: number;
  /** 8-hex content hash of the state pack these records are positional against. */
  pack: string;
  unitCount: number;
  flags: Uint8Array;
  /** NaN where the unit has no such point. */
  pinLat: Float64Array; pinLng: Float64Array;
  crowdLat: Float64Array; crowdLng: Float64Array;
  envLat: Float64Array; envLng: Float64Array;
  envRadius: Uint16Array;
};

export function decodeCoords(bytes: Uint8Array): CoordsPack {
  if (bytes.length < HEADER_BYTES) throw new Error('coords file is truncated');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== COORDS_MAGIC) throw new Error('not a coords file');
  const version = dv.getUint16(4, true);
  if (version !== COORDS_VERSION) throw new Error(`unsupported coords format v${version}`);
  const n = dv.getUint32(8, true), nPin = dv.getUint32(12, true), nCrowd = dv.getUint32(16, true), nEnv = dv.getUint32(20, true);
  if (HEADER_BYTES + n + 8 * nPin + 8 * nCrowd + 10 * nEnv !== bytes.length) throw new Error('coords length mismatch');
  let pack = '';
  for (let i = 24; i < 32; i++) pack += String.fromCharCode(bytes[i]);

  let o = HEADER_BYTES;
  const flags = bytes.subarray(o, o + n); o += n;
  const col = (count: number) => {
    const a = new Float64Array(count);
    for (let i = 0; i < count; i++, o += 4) a[i] = dv.getInt32(o, true) / 1e6;
    return a;
  };
  const pLat = col(nPin), pLng = col(nPin), cLat = col(nCrowd), cLng = col(nCrowd), eLat = col(nEnv), eLng = col(nEnv);
  const eR = new Uint16Array(nEnv);
  for (let i = 0; i < nEnv; i++, o += 2) eR[i] = dv.getUint16(o, true);

  // Spread the packed columns to one slot per unit: a distance scan then needs
  // no running cursors, and 13k units (Lagos) is ~0.7 MB.
  const out: CoordsPack = {
    stateCode: dv.getUint8(6), pack, unitCount: n, flags,
    pinLat: new Float64Array(n).fill(NaN), pinLng: new Float64Array(n).fill(NaN),
    crowdLat: new Float64Array(n).fill(NaN), crowdLng: new Float64Array(n).fill(NaN),
    envLat: new Float64Array(n).fill(NaN), envLng: new Float64Array(n).fill(NaN),
    envRadius: new Uint16Array(n),
  };
  let ip = 0, ic = 0, ie = 0;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f & F_PIN) { out.pinLat[i] = pLat[ip]; out.pinLng[i] = pLng[ip]; ip++; }
    if (f & F_CROWD) { out.crowdLat[i] = cLat[ic]; out.crowdLng[i] = cLng[ic]; ic++; }
    if (f & F_ENV) { out.envLat[i] = eLat[ie]; out.envLng[i] = eLng[ie]; out.envRadius[i] = eR[ie]; ie++; }
  }
  if (ip !== nPin || ic !== nCrowd || ie !== nEnv) throw new Error('coords columns do not match the flags');
  return out;
}

const RAD = Math.PI / 180;
const haversineM = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const dLat = (bLat - aLat) * RAD, dLng = (bLng - aLng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

/** A register row as GET /api/polling-units returns it (publicUnit + distanceM). */
export type OfflineRegisterUnit = RegisterRow & {
  lat: number | null; lng: number | null;
  crowd_lat: number | null; crowd_lng: number | null;
  coords_source: string | null;
  approx_lat: number | null; approx_lng: number | null; approx_radius_m: number | null;
  pin_unverified?: boolean;
  locationTier: LocationTier;
  distanceM: number;
};
/** A row as GET /api/mapping/nearby returns it. */
export type OfflineMappingUnit = {
  puCode: string; name: string; ward: string; lat: number; lng: number; distanceM: number;
  status: 'verified' | 'crowd' | 'approx'; approxRadiusM: number | null; fixes: number;
};
export type OfflineNearby = {
  register: { radiusM: number; maxRows: number; capped: boolean; units: OfflineRegisterUnit[] };
  mapping: { units: OfflineMappingUnit[] };
};

/** The full API row for unit i: the pack's names plus this file's location. */
export function unitWithLocation(p: StatePack, c: CoordsPack, i: number, distanceM: number): OfflineRegisterUnit {
  const f = c.flags[i];
  const tier = TIERS[(f >> 3) & 7] ?? 'unmapped';
  const num = (v: number) => (Number.isNaN(v) ? null : v);
  const hasPin = !!(f & F_PIN);
  return {
    ...materialise(p, i),
    lat: num(c.pinLat[i]), lng: num(c.pinLng[i]),
    crowd_lat: num(c.crowdLat[i]), crowd_lng: num(c.crowdLng[i]),
    // Only what the client reads off it: 'crowd_mapped' (a promoted crowd pin)
    // and 'geocoded' (a bulk point, not observers'). The exact locator label is
    // not shipped and nothing on the phone branches on it.
    coords_source: hasPin ? (f & F_PIN_CROWD_MAPPED ? 'crowd_mapped' : 'inec_locator') : tier === 'geocoded' ? 'geocoded' : null,
    approx_lat: num(c.envLat[i]), approx_lng: num(c.envLng[i]),
    approx_radius_m: f & F_ENV ? c.envRadius[i] : null,
    ...(tier === 'unverified' ? { pin_unverified: true } : null),
    locationTier: tier,
    distanceM,
  };
}

/**
 * Both near-me answers for one fix, from the packs held on the phone.
 * `mappingRadiusM` is the radius the screen would have sent to /mapping/nearby.
 * Unlike the server's nearby query this sorts EVERY candidate before cutting,
 * so a dense area cannot lose the closest unit to a row limit.
 */
export function nearbyFromPacks(
  held: { state: StatePack; coords: CoordsPack }[],
  lat: number,
  lng: number,
  mappingRadiusM: number,
): OfflineNearby {
  const radius = Math.min(Number(mappingRadiusM) || 5000, 20000);
  const reach = Math.max(radius, REGISTER_RADIUS_M);
  // A cheap box before the haversine. 2% wider than the radius: 111,320 m per
  // degree is not what the haversine's sphere uses (111,195), and a tight box
  // silently drops the last few metres to the north and south.
  const dLat = (reach * 1.02) / 111320;
  const dLng = (reach * 1.02) / (111320 * Math.max(Math.cos(lat * RAD), 0.2));
  const inBox = (la: number, ln: number) => Math.abs(la - lat) <= dLat && Math.abs(ln - lng) <= dLng; // false for NaN

  const reg: OfflineRegisterUnit[] = [];
  const map: OfflineMappingUnit[] = [];
  for (const { state: p, coords: c } of held) {
    if (c.unitCount !== p.unitCount) continue; // not this pack's file: positions would lie
    for (let i = 0; i < c.unitCount; i++) {
      const f = c.flags[i];
      if (!(f & (F_PIN | F_CROWD | F_ENV))) continue;
      const hasPin = !!(f & F_PIN);
      // /api/polling-units: the trusted pin, else the trusted crowd point.
      const rLat = hasPin ? c.pinLat[i] : c.crowdLat[i], rLng = hasPin ? c.pinLng[i] : c.crowdLng[i];
      // /api/mapping/nearby: the trusted pin, else the envelope's centre.
      const mLat = hasPin ? c.pinLat[i] : c.envLat[i], mLng = hasPin ? c.pinLng[i] : c.envLng[i];
      const rIn = inBox(rLat, rLng), mIn = inBox(mLat, mLng);
      if (!rIn && !mIn) continue;
      if (rIn) {
        const d = Math.round(haversineM(lat, lng, rLat, rLng));
        if (d <= REGISTER_RADIUS_M) reg.push(unitWithLocation(p, c, i, d));
      }
      if (mIn) {
        const d = Math.round(haversineM(lat, lng, mLat, mLng));
        if (d <= radius) {
          const row = materialise(p, i);
          map.push({
            puCode: row.pu_code, name: row.name, ward: row.ward ?? '', lat: mLat, lng: mLng, distanceM: d,
            status: hasPin ? (f & F_PIN_CROWD_MAPPED ? 'crowd' : 'verified') : 'approx',
            approxRadiusM: hasPin ? null : c.envRadius[i],
            fixes: 0, // live count of observer fixes: not known offline
          });
        }
      }
    }
  }
  reg.sort((a, b) => a.distanceM - b.distanceM);
  map.sort((a, b) => a.distanceM - b.distanceM);
  const units = reg.slice(0, REGISTER_MAX_ROWS);
  return {
    register: { radiusM: REGISTER_RADIUS_M, maxRows: REGISTER_MAX_ROWS, capped: units.length >= REGISTER_MAX_ROWS, units },
    mapping: { units: map.slice(0, MAPPING_MAX_ROWS) },
  };
}

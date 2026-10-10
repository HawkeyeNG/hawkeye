/**
 * Near-me that still answers when the server does not.
 *
 * Every near-me screen makes the same two requests — /api/polling-units and
 * /api/mapping/nearby — and merges them. This wraps that pair: if neither has
 * answered usefully within a few seconds (no signal, or the stalled link a
 * polling unit usually has), the same two answers are computed from the unit
 * and coordinates files already on the phone (lib/register.ts offlineNearby)
 * and handed back in the same shape, so the screen's merge code runs unchanged.
 *
 * The offline answer equals the server's by construction — it is built from the
 * server's own trust decisions and gated against them
 * (native/scripts/verify_register_coords_ts.mjs) — so preferring it over a slow
 * request loses nothing but the live count of observer fixes.
 */
import { offlineNearby, unitFromPacks } from '@/lib/register';

type Res = Response | null;
export type NearbyPair = [located: Res, envelope: Res, offline: boolean];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Just enough of a Response for the callers: `.ok`, `.status`, `.json()`. */
const asResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/**
 * @param online   the screen's own Promise.all of the two requests
 * @param graceMs  how long the server gets before the phone answers instead
 * @param capMs    with nothing held offline, the longest any screen waits at all
 */
export async function nearbyOrOffline(
  lat: number,
  lng: number,
  mappingRadiusM: number,
  online: Promise<[Res, Res]>,
  graceMs = 8000,
  capMs = 45000,
): Promise<NearbyPair> {
  const box: { v: [Res, Res] | null } = { v: null };
  const tracked = online
    .then((r) => { box.v = r; return r; })
    .catch((): [Res, Res] => { box.v = [null, null]; return box.v; });
  const good = () => !!(box.v && (box.v[0]?.ok || box.v[1]?.ok));

  await Promise.race([tracked, sleep(graceMs)]);
  if (good()) return [box.v![0], box.v![1], false];

  const off = await offlineNearby(lat, lng, mappingRadiusM);
  if (good()) return [box.v![0], box.v![1], false]; // the server answered meanwhile
  // An EMPTY offline answer is not trusted over a server that has not spoken:
  // the phone may simply hold another state's files.
  if (off && (off.register.units.length || off.mapping.units.length)) {
    return [asResponse(off.register), asResponse(off.mapping), true];
  }
  if (!box.v) await Promise.race([tracked, sleep(Math.max(0, capMs - graceMs))]);
  return box.v ? [box.v[0], box.v[1], false] : [null, null, false];
}

/**
 * GET /api/register/unit?pu_code=… that still answers offline. A nearby row the
 * register lookup did not return carries no unit record, so choosing it asks the
 * server for one — which is exactly the request that cannot be made at a polling
 * unit with no signal. If that unit is in a state held on the phone, the server
 * gets a few seconds and then the phone's own copy is returned instead.
 */
export async function unitFetch(url: string, init?: RequestInit, graceMs = 4000): Promise<Response> {
  const code = decodeURIComponent((/[?&]pu_code=([^&]+)/.exec(url) || [])[1] || '');
  const local = code ? await unitFromPacks(code) : null;
  if (!local) return fetch(url, init);
  try {
    const r = await Promise.race([fetch(url, init), sleep(graceMs).then(() => null)]);
    if (r && r.ok) return r;
  } catch { /* offline: the phone's copy below */ }
  return asResponse({ unit: local });
}

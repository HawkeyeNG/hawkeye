/**
 * A drop-in `fetch` for the register endpoints that answers offline first.
 *
 * The browse screens (report/result, report/incident, report/collation,
 * map-unit, practice) each hard-coded `fetch(`${REG}/states`)` and friends, so
 * picking a polling unit by browsing was network-only on native — the one flow
 * an observer standing at a polling unit with no bars actually needs.
 *
 * Same signature and same JSON shape as the endpoints, so a call site changes
 * by one word. states / LGAs / wards come from the ~56 KB index pack, which
 * means browse now works with no signal ANYWHERE in the country; units come
 * from that state's pack when it is held. Anything the packs cannot answer
 * falls through to the real request unchanged.
 *
 * See docs/PU-SEARCH-2027.md.
 */
import {
  loadIndex, statesOffline, lgasOffline, wardsOffline, unitsOffline,
} from '@/lib/register';

/** A Response-shaped object, so callers keep using `.json()` and `.ok`. */
function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function paramsOf(url: string): { path: string; get: (k: string) => string | null } {
  const qIx = url.indexOf('?');
  const path = qIx === -1 ? url : url.slice(0, qIx);
  const qs = qIx === -1 ? '' : url.slice(qIx + 1);
  const map: Record<string, string> = {};
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    map[k] = decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1));
  }
  return { path, get: (k) => (k in map ? map[k] : null) };
}

export async function regFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const { path, get } = paramsOf(url);
    // Only the browse endpoints are served locally; /unit and /search are not
    // (a single code is cheap online, and search has its own offline path).
    if (/\/api\/register\/(states|lgas|wards|units)$/.test(path)) {
      await loadIndex();
      const state = get('state');
      const lga = get('lga');
      const ward = get('ward');

      if (path.endsWith('/states')) {
        const v = statesOffline();
        if (v && v.length) return jsonResponse(v);
      } else if (path.endsWith('/lgas') && state) {
        const v = lgasOffline(state);
        if (v && v.length) return jsonResponse(v);
      } else if (path.endsWith('/wards') && state && lga) {
        const v = wardsOffline(state, lga);
        if (v && v.length) return jsonResponse(v);
      } else if (path.endsWith('/units') && state && lga && ward) {
        const v = unitsOffline(state, lga, ward);
        if (v && v.length) return jsonResponse({ units: v });
      }
    }
  } catch {
    // Never let the offline path break a request that would have worked.
  }
  return fetch(url, init);
}

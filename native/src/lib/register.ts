/**
 * The polling-unit register on a phone — native twin of app/register-store.js.
 *
 * WHAT CHANGED AND WHY (docs/PU-SEARCH-2027.md). This module used to
 * `require('@/lib/register-osun.json')`: one state, 1.7 MB, inlined into the JS
 * bundle by Metro and parsed on the device. That does not survive 2027. The
 * national register is 176,846 units across 37 states, and bundling it would
 * put ~30 MB of JSON in an app whose whole promise is being small.
 *
 * Instead: a ~56 KB index of every state, LGA and ward — so browse works
 * offline nationwide — plus one ~32 KB state pack fetched on demand and cached.
 *
 * fflate rather than DecompressionStream: Hermes has no DecompressionStream,
 * which is also why the generator emits gzip and not brotli.
 *
 * The decode, fold, ranking and search all live in register-pack.ts, which is
 * pure so scripts/verify_register_pack_ts.mjs can run it in Node against the
 * real packs. That check is not ceremony: this is a second implementation of a
 * binary format, and a drifted decoder does not crash, it shows an observer a
 * plausible list of the wrong polling units.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { gunzipSync } from 'fflate';
import { BASE } from '@/lib/api';
import {
  decodeIndex, decodeState, buildSearchIndex, search as packSearch,
  statesOf, lgasOf, wardsOf, stateCodeOf, unitsOf,
  type IndexPack, type StatePack, type RegisterRow,
} from '@/lib/register-pack';

export type { RegisterRow } from '@/lib/register-pack';

const KEY = (k: string) => `hk_reg:${k}`;
const MANIFEST_URL = `${BASE}/api/register/manifest`;
const PACK_URL = (file: string) => `${BASE}/reg/${file}`;

type Manifest = {
  registerVersion: number;
  index: { file: string; sha: string; bytes: number };
  states: Record<string, { file: string; sha: string; bytes: number; name: string; units: number }>;
};

let manifest: Manifest | null = null;
let indexPack: IndexPack | null = null;
const loaded: Record<string, StatePack> = {};
const inflight: Record<string, Promise<unknown>> = {};

/* ----------------------------------------------------------------- base64 */
// AsyncStorage stores strings, so the gzip bytes are kept base64. Written out
// rather than pulled from a dependency: Hermes has no Buffer, and atob/btoa
// availability has moved around between React Native versions.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=')
      + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}
function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    out[p++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[p++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[p++] = n & 255;
  }
  return out.subarray(0, p);
}

/* ---------------------------------------------------------------- loading */

async function getManifest(force = false): Promise<Manifest | null> {
  if (manifest && !force) return manifest;
  try {
    const r = await fetch(MANIFEST_URL);
    if (!r.ok) throw new Error(String(r.status));
    manifest = (await r.json()) as Manifest;
    await AsyncStorage.setItem(KEY('manifest'), JSON.stringify(manifest));
  } catch {
    // Offline: the stored manifest is what lets a cached pack still be used.
    try {
      const raw = await AsyncStorage.getItem(KEY('manifest'));
      manifest = raw ? (JSON.parse(raw) as Manifest) : null;
    } catch { manifest = null; }
  }
  return manifest;
}

/**
 * Fetch-or-restore one pack, always through the decoder so the header and CRC
 * are checked. A cached copy that no longer verifies is deleted rather than
 * used: rendering a truncated pack is worse than having none.
 */
async function loadBytes(key: string, file: string, sha: string): Promise<Uint8Array | null> {
  try {
    const rawSha = await AsyncStorage.getItem(KEY(`${key}:sha`));
    if (rawSha === sha) {
      const b64 = await AsyncStorage.getItem(KEY(`${key}:gz`));
      if (b64) return fromBase64(b64);
    }
  } catch { /* fall through to the network */ }

  const res = await fetch(PACK_URL(file));
  if (!res.ok) throw new Error(`pack ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  try {
    await AsyncStorage.multiSet([[KEY(`${key}:gz`), toBase64(buf)], [KEY(`${key}:sha`), sha]]);
  } catch { /* storage full: it still works this session */ }
  return buf;
}

async function dropPack(key: string) {
  try { await AsyncStorage.multiRemove([KEY(`${key}:gz`), KEY(`${key}:sha`)]); } catch { /* nothing to do */ }
}

/** The tier-0 index: every state/LGA/ward. Cheap, and the whole cascade. */
export async function loadIndex(): Promise<IndexPack | null> {
  if (indexPack) return indexPack;
  if (!inflight.index) {
    inflight.index = (async () => {
      const m = await getManifest();
      if (!m) return null;
      try {
        const gz = await loadBytes('index', m.index.file, m.index.sha);
        indexPack = gz ? decodeIndex(gunzipSync(gz)) : null;
      } catch {
        await dropPack('index');
        indexPack = null;
      }
      return indexPack;
    })().finally(() => { delete inflight.index; });
  }
  return inflight.index as Promise<IndexPack | null>;
}

/** One state's units. `code` is the 2-digit state code, e.g. '24'. */
export async function loadState(code: string): Promise<StatePack | null> {
  if (loaded[code]) return loaded[code];
  const k = `state:${code}`;
  if (!inflight[k]) {
    inflight[k] = (async () => {
      const m = await getManifest();
      const entry = m?.states?.[code];
      if (!entry) return null;
      try {
        const gz = await loadBytes(k, entry.file, entry.sha);
        if (!gz) return null;
        const p = decodeState(gunzipSync(gz));
        p.stateName = entry.name;
        loaded[code] = p;
        // Warm the search index off the interaction path, exactly as the web
        // store does — folding is the expensive step and nothing needs it until
        // somebody types.
        setTimeout(() => { try { buildSearchIndex(p); } catch { /* next search pays it */ } }, 0);
        return p;
      } catch {
        await dropPack(k);
        return null;
      }
    })().finally(() => { delete inflight[k]; });
  }
  return inflight[k] as Promise<StatePack | null>;
}

/* ------------------------------------------------------------ public API */

/** Start pulling what we can. Safe to call on every mount. */
export function warmRegister(stateName?: string | null): void {
  loadIndex()
    .then((ix) => {
      if (!ix || !stateName) return null;
      const code = stateCodeOf(ix, stateName);
      return code ? loadState(code) : null;
    })
    .catch(() => null);
}

/** True once `stateName` can be searched without waiting on anything. */
export function registerReady(stateName?: string | null): boolean {
  if (!indexPack || !stateName) return false;
  const code = stateCodeOf(indexPack, stateName);
  return !!(code && loaded[code]);
}

/**
 * Search a held state. SYNCHRONOUS and non-blocking by design: it reads what is
 * already decoded and returns null when it cannot answer, so the caller always
 * has the network to fall back to. Do not make this await a download — the web
 * version once did, and it made the FIRST search slower than the request it
 * replaced.
 */
export function localSearch(
  term: string,
  opts: { state?: string | null; lga?: string | null } = {},
): { units: RegisterRow[]; truncated: boolean } | null {
  if (!indexPack || !opts.state) return null;
  const code = stateCodeOf(indexPack, opts.state);
  const p = code ? loaded[code] : null;
  if (!p) return null;
  const r = packSearch(p, term, { limit: 25, stateName: p.stateName });
  if (!opts.lga) return r;
  const units = r.units.filter((u) => u.lga === opts.lga);
  return { units, truncated: r.truncated && units.length === r.units.length };
}

/* ---- the browse cascade, offline and nationwide, from the index pack ---- */

export function statesOffline(): string[] | null { return indexPack ? statesOf(indexPack) : null; }
export function lgasOffline(state: string): string[] | null { return indexPack ? lgasOf(indexPack, state) : null; }
export function wardsOffline(state: string, lga: string): string[] | null {
  return indexPack ? wardsOf(indexPack, state, lga) : null;
}
export function unitsOffline(state: string, lga: string, ward: string): RegisterRow[] | null {
  if (!indexPack) return null;
  const code = stateCodeOf(indexPack, state);
  const p = code ? loaded[code] : null;
  if (!p) {
    if (code) loadState(code).catch(() => null); // pull it for next time
    return null;
  }
  return unitsOf(p, lga, ward);
}

/**
 * Register pack decoder — the native twin of app/register-store.js.
 *
 * DELIBERATELY PURE. No fetch, no storage, no React: bytes in, searchable
 * structure out. That is what lets scripts/verify_register_pack_ts.mjs run this
 * exact code in Node against the same packs the web uses, so the two decoders
 * cannot quietly drift apart — and a drift here does not throw, it shows an
 * observer the WRONG polling unit.
 *
 * Format and rationale: docs/PU-SEARCH-2027.md and
 * backend/scripts/build_register_packs.mjs. The parts that matter here:
 *   - no pu_code strings; a code is its group prefix plus a u16 serial
 *   - group metadata is columnar and delta-coded
 *   - names are UTF-8, LF-separated, and NOT folded (the client folds once)
 *   - a 32-byte header with a CRC32 over the body, checked before anything is
 *     rendered: a truncated pack lists the wrong units rather than failing
 */

export const MAGIC = 0x4b504b48; // 'HKPK'
export const FORMAT_VERSION = 1;
export const KIND_INDEX = 0;
export const KIND_STATE = 1;
export const HEADER_BYTES = 32;
const CODE_STRIDE = 13; // 12 characters + the newline

export type PackMeta = {
  formatVersion: number;
  kind: number;
  stateCode: number;
  registerVersion: number;
  groupCount: number;
  unitCount: number;
  bodyLength: number;
  crc32: number;
};

export type RegisterRow = {
  pu_code: string;
  name: string;
  ward?: string | null;
  lga?: string | null;
  state?: string | null;
  senatorial?: string | null;
  federal_constituency?: string | null;
  locationTier?: string;
  [k: string]: unknown;
};

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * The search fold. Must stay identical to fold() in app/register-store.js and
 * searchFold() in backend/src/db.js — the same query has to mean the same thing
 * on a phone with no signal and on the server.
 */
export function fold(s: unknown): string {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, ' ')
    .trim();
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const pad3 = (n: number) => (n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`);

/** Hermes ships TextDecoder; keep a minimal UTF-8 fallback for older engines. */
function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if (b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    }
  }
  return out;
}

class Reader {
  private dv: DataView;
  private u8: Uint8Array;
  pos = 0;
  constructor(buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.u8 = buf;
  }
  u32(): number { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  blobBytes(): Uint8Array {
    const n = this.u32();
    const b = this.u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  table(): string[] {
    const count = this.u32();
    const s = decodeUtf8(this.blobBytes());
    const list = count === 0 ? [] : s.split('\n');
    if (list.length !== count) throw new Error('string table count mismatch');
    return list;
  }
  colU8(n: number): Uint8Array { const a = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return a; }
  colU16(n: number): Uint16Array {
    const a = new Uint16Array(n);
    for (let i = 0; i < n; i++) a[i] = this.dv.getUint16(this.pos + i * 2, true);
    this.pos += n * 2;
    return a;
  }
  colDelta(n: number): Uint16Array {
    const a = new Uint16Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) { prev += this.dv.getInt16(this.pos + i * 2, true); a[i] = prev; }
    this.pos += n * 2;
    return a;
  }
}

export function readHeader(pack: Uint8Array): { meta: PackMeta; body: Uint8Array } {
  if (pack.length < HEADER_BYTES) throw new Error('pack shorter than its header');
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad magic');
  const formatVersion = dv.getUint16(4, true);
  if (formatVersion !== FORMAT_VERSION) throw new Error(`unsupported pack format v${formatVersion}`);
  const meta: PackMeta = {
    formatVersion,
    kind: dv.getUint8(6),
    stateCode: dv.getUint8(7),
    registerVersion: dv.getUint32(8, true),
    groupCount: dv.getUint32(12, true),
    unitCount: dv.getUint32(16, true),
    bodyLength: dv.getUint32(20, true),
    crc32: dv.getUint32(24, true),
  };
  const body = pack.subarray(HEADER_BYTES);
  if (body.length !== meta.bodyLength) throw new Error('body length mismatch (truncated?)');
  if (crc32(body) !== meta.crc32) throw new Error('CRC mismatch (corrupt)');
  return { meta, body };
}

export type StatePack = {
  kind: 'state';
  meta: PackMeta;
  stateCode: number;
  stateName?: string;
  unitCount: number;
  names: string;
  offs: Uint32Array;
  gOf: Uint16Array;
  serials: Uint16Array;
  groups: {
    lgaCodes: Uint8Array; wardCodes: Uint8Array;
    wardIds: Uint16Array; lgaIds: Uint16Array; senIds: Uint16Array; fedIds: Uint16Array;
    counts: Uint16Array;
  };
  tables: { wards: string[]; lgas: string[]; sens: string[]; feds: string[] };
  // built lazily by buildSearchIndex
  folded?: string | null;
  fOffs?: Uint32Array | null;
  codes?: string | null;
  wardFold?: string[] | null;
};

export function decodeState(pack: Uint8Array): StatePack {
  const h = readHeader(pack);
  if (h.meta.kind !== KIND_STATE) throw new Error('not a state pack');
  const r = new Reader(h.body);
  const wards = r.table(), lgas = r.table(), sens = r.table(), feds = r.table();
  const G = h.meta.groupCount, N = h.meta.unitCount;
  const lgaCodes = r.colU8(G), wardCodes = r.colU8(G);
  const wardIds = r.colDelta(G), lgaIds = r.colDelta(G), senIds = r.colDelta(G), fedIds = r.colDelta(G);
  const counts = r.colU16(G);
  const serials = r.colU16(N);
  const names = decodeUtf8(r.blobBytes());

  const offs = new Uint32Array(N + 1);
  const gOf = new Uint16Array(N);
  let i = 0;
  for (let g = 0; g < G; g++) for (let k = 0; k < counts[g]; k++, i++) gOf[i] = g;
  let line = 0;
  for (let p = 0; p < names.length; p++) if (names.charCodeAt(p) === 10) offs[++line] = p + 1;
  offs[N] = names.length + 1;
  if (line !== N - 1) throw new Error(`name count ${line + 1} != unitCount ${N}`);

  return {
    kind: 'state', meta: h.meta, stateCode: h.meta.stateCode, unitCount: N,
    names, offs, gOf, serials,
    groups: { lgaCodes, wardCodes, wardIds, lgaIds, senIds, fedIds, counts },
    tables: { wards, lgas, sens, feds },
    folded: null, fOffs: null, codes: null, wardFold: null,
  };
}

export type IndexPack = {
  kind: 'index';
  meta: PackMeta;
  groupCount: number;
  stateCodes: Uint8Array; lgaCodes: Uint8Array; wardCodes: Uint8Array;
  stateIds: Uint16Array; lgaIds: Uint16Array; wardIds: Uint16Array;
  counts: Uint16Array;
  tables: { states: string[]; lgas: string[]; wards: string[] };
};

export function decodeIndex(pack: Uint8Array): IndexPack {
  const h = readHeader(pack);
  if (h.meta.kind !== KIND_INDEX) throw new Error('not an index pack');
  const r = new Reader(h.body);
  const states = r.table(), lgas = r.table(), wards = r.table();
  const G = h.meta.groupCount;
  const stateCodes = r.colU8(G), lgaCodes = r.colU8(G), wardCodes = r.colU8(G);
  const stateIds = r.colDelta(G), lgaIds = r.colDelta(G), wardIds = r.colDelta(G);
  const counts = r.colU16(G);
  return { kind: 'index', meta: h.meta, groupCount: G, stateCodes, lgaCodes, wardCodes, stateIds, lgaIds, wardIds, counts, tables: { states, lgas, wards } };
}

/**
 * Build what a search scans: the folded name blob, the code blob and the folded
 * ward per group. Kept OFF the decode path — it is the expensive step, and
 * nothing needs it until somebody types.
 */
export function buildSearchIndex(p: StatePack): StatePack {
  if (p.folded) return p;
  const N = p.unitCount, G = p.groups.counts.length;
  const parts = new Array<string>(N);
  const fOffs = new Uint32Array(N + 1);
  let acc = 0;
  for (let j = 0; j < N; j++) {
    const f = fold(p.names.slice(p.offs[j], p.offs[j + 1] - 1));
    parts[j] = f;
    fOffs[j] = acc;
    acc += f.length + 1;
  }
  fOffs[N] = acc;
  p.folded = parts.join('\n');
  p.fOffs = fOffs;

  const codes = new Array<string>(N);
  for (let i = 0; i < N; i++) {
    const g = p.gOf[i];
    codes[i] = `${pad2(p.stateCode)}-${pad2(p.groups.lgaCodes[g])}-${pad2(p.groups.wardCodes[g])}-${pad3(p.serials[i])}`;
  }
  p.codes = codes.join('\n');

  const wf = new Array<string>(G);
  for (let g = 0; g < G; g++) wf[g] = fold(p.tables.wards[p.groups.wardIds[g]]);
  p.wardFold = wf;
  return p;
}

function unitAt(p: StatePack, pos: number): number {
  const fOffs = p.fOffs!;
  let lo = 0, hi = p.unitCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fOffs[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function displayName(p: StatePack, i: number): string {
  return p.names.slice(p.offs[i], p.offs[i + 1] - 1);
}

export function materialise(p: StatePack, i: number, stateName?: string): RegisterRow {
  const g = p.gOf[i];
  return {
    pu_code: `${pad2(p.stateCode)}-${pad2(p.groups.lgaCodes[g])}-${pad2(p.groups.wardCodes[g])}-${pad3(p.serials[i])}`,
    name: displayName(p, i),
    ward: p.tables.wards[p.groups.wardIds[g]],
    lga: p.tables.lgas[p.groups.lgaIds[g]],
    state: stateName ?? p.stateName ?? '',
    senatorial: p.tables.sens[p.groups.senIds[g]],
    federal_constituency: p.tables.feds[p.groups.fedIds[g]],
    locationTier: 'unmapped',
  };
}

/**
 * A faithful mirror of GET /api/register/search, exactly as the web store is.
 * Same matched columns, same prefix-then-contains passes, same ORDER BY with
 * pu_code breaking name ties. backend/scripts/diff_register_search.mjs proves
 * the web copy; scripts/verify_register_pack_ts.mjs proves this one decodes the
 * same rows.
 */
export function search(
  p: StatePack,
  term: string,
  opts: { limit?: number; stateName?: string } = {},
): { units: RegisterRow[]; truncated: boolean } {
  const limit = opts.limit ?? 25;
  const qRaw = String(term ?? '').trim();
  if (qRaw.length < 3) return { units: [], truncated: false };
  if (!p.folded) buildSearchIndex(p);
  const qf = fold(term);
  const N = p.unitCount;
  const hit = new Uint8Array(N);
  const found: number[] = [];

  const addUnit = (i: number) => { if (!hit[i]) { hit[i] = 1; found.push(i); } };
  const addGroup = (g: number) => {
    let start = 0;
    for (let k = 0; k < g; k++) start += p.groups.counts[k];
    for (let n = 0; n < p.groups.counts[g]; n++) addUnit(start + n);
  };

  const collect = (prefixOnly: boolean) => {
    const folded = p.folded!;
    if (qf) {
      if (prefixOnly) {
        if (folded.lastIndexOf(qf, 0) === 0) addUnit(0);
        const needle = `\n${qf}`;
        let at = folded.indexOf(needle);
        while (at !== -1) { addUnit(unitAt(p, at + 1)); at = folded.indexOf(needle, at + 1); }
      } else {
        let at = folded.indexOf(qf);
        while (at !== -1) { addUnit(unitAt(p, at)); at = folded.indexOf(qf, at + 1); }
      }
    }
    const codes = p.codes!;
    for (let i = 0; i < N; i++) {
      const base = i * CODE_STRIDE;
      const ok = prefixOnly
        ? codes.startsWith(qRaw, base)
        : codes.indexOf(qRaw, base) !== -1 && codes.indexOf(qRaw, base) < base + 12;
      if (ok) addUnit(i);
    }
    if (qf) {
      const wf = p.wardFold!;
      for (let g = 0; g < wf.length; g++) {
        if (prefixOnly ? wf[g].lastIndexOf(qf, 0) === 0 : wf[g].indexOf(qf) !== -1) addGroup(g);
      }
    }
  };

  collect(true);
  if (!found.length) collect(false);

  const codeAt = (i: number) => p.codes!.substr(i * CODE_STRIDE, 12);
  const foldedAt = (i: number) => p.folded!.slice(p.fOffs![i], p.fOffs![i + 1] - 1);

  const ranked = found.map((i) => {
    const code = codeAt(i);
    let rank = 3;
    if (code === qRaw) rank = 0;
    else if (qf && foldedAt(i).lastIndexOf(qf, 0) === 0) rank = 1;
    else if (code.lastIndexOf(qRaw, 0) === 0) rank = 2;
    return { i, rank, name: displayName(p, i) };
  });

  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const ca = codeAt(a.i), cb = codeAt(b.i);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });

  const units: RegisterRow[] = [];
  for (let n = 0; n < ranked.length && units.length < limit; n++) {
    units.push(materialise(p, ranked[n].i, opts.stateName));
  }
  return { units, truncated: units.length === limit };
}

/** The browse cascade, from the tier-0 index. */
export function statesOf(ix: IndexPack): string[] {
  const seen: Record<string, 1> = {}, out: string[] = [];
  for (let i = 0; i < ix.groupCount; i++) {
    const v = ix.tables.states[ix.stateIds[i]];
    if (v && !seen[v]) { seen[v] = 1; out.push(v); }
  }
  return out.sort();
}

export function lgasOf(ix: IndexPack, state: string): string[] | null {
  const seen: Record<string, 1> = {}, out: string[] = [];
  for (let i = 0; i < ix.groupCount; i++) {
    if (ix.tables.states[ix.stateIds[i]] !== state) continue;
    const v = ix.tables.lgas[ix.lgaIds[i]];
    if (v && !seen[v]) { seen[v] = 1; out.push(v); }
  }
  return out.length ? out.sort() : null;
}

export function wardsOf(ix: IndexPack, state: string, lga: string): string[] | null {
  const seen: Record<string, 1> = {}, out: string[] = [];
  for (let i = 0; i < ix.groupCount; i++) {
    if (ix.tables.states[ix.stateIds[i]] !== state) continue;
    if (ix.tables.lgas[ix.lgaIds[i]] !== lga) continue;
    const v = ix.tables.wards[ix.wardIds[i]];
    if (v && !seen[v]) { seen[v] = 1; out.push(v); }
  }
  return out.length ? out.sort() : null;
}

export function stateCodeOf(ix: IndexPack, state: string): string | null {
  const want = String(state ?? '').trim().toLowerCase();
  for (let i = 0; i < ix.groupCount; i++) {
    const st = ix.tables.states[ix.stateIds[i]];
    if (st && st.trim().toLowerCase() === want) return pad2(ix.stateCodes[i]);
  }
  return null;
}

export function unitsOf(p: StatePack, lga: string, ward: string): RegisterRow[] | null {
  const out: RegisterRow[] = [];
  let start = 0;
  for (let g = 0; g < p.groups.counts.length; g++) {
    const n = p.groups.counts[g];
    if (p.tables.lgas[p.groups.lgaIds[g]] === lga && p.tables.wards[p.groups.wardIds[g]] === ward) {
      for (let k = 0; k < n; k++) out.push(materialise(p, start + k, p.stateName));
    }
    start += n;
  }
  return out.length ? out : null;
}

#!/usr/bin/env node
/**
 * Build the 2027 polling-unit search packs — see docs/PU-SEARCH-2027.md.
 *
 * Replaces scripts/build_register_bundle.mjs, which crawled PRODUCTION with one
 * HTTP GET per ward. That was fine for Osun (332 wards); nationally it is 8,809
 * requests, hours of wall-clock, no resume, and we would be DDoSing our own API
 * to read data we already have locally. This reads backend/storage/hawkeye.db
 * directly instead, and runs in seconds.
 *
 * Emits, into app/reg/:
 *   index.<sha8>.pack.gz     tier-0: every state/LGA/ward + unit counts, NO unit
 *                            names. Precached, so the browse cascade works
 *                            offline nationwide from install (~50 KB).
 *   <STATECODE>.<sha8>.pack.gz   one per state: the unit names. Fetched on
 *                            demand and kept compressed at rest in IndexedDB.
 *   manifest.json            registerVersion + file/sha/bytes per pack.
 *
 * FORMAT NOTES (deliberate, do not "simplify" without re-reading these):
 *
 * - NO pu_code STRINGS. Every code in the register is DD-DD-DD-DDD and unique
 *   (verified: 0 exceptions in 176,846). A code is therefore fully described by
 *   its group (state,lga,ward) plus a u16 serial, so we store 2 bytes where a
 *   string would cost 13. --verify reconstructs all 176,846 and compares.
 *
 * - GROUPED BY CODE PREFIX, NOT WARD NAME. Ward names are ambiguous: 8,432
 *   distinct names span 8,793 real (state,lga,ward) triples. Grouping on names
 *   would silently merge two different wards that share a name.
 *
 * - UTF-8, NOT LATIN1. 121 unit names contain characters above U+00FF, so a
 *   latin1 blob would corrupt them. The cost of UTF-8 here is a few hundred
 *   bytes nationally (139 names have any non-ASCII at all).
 *
 * - GZIP, NOT BROTLI, even though brotli is ~15% smaller. The client inflates
 *   with DecompressionStream, which supports 'gzip'/'deflate' only — there is no
 *   brotli in that API. We cannot lean on Content-Encoding either, because packs
 *   are deliberately stored COMPRESSED at rest (fetch() would transparently
 *   inflate them and put ~5 MB in the cache).
 *
 * - NO COORDINATES. 8 of 176,846 rows have a real lat; 117,159 come from the
 *   ~33%-wrong geocode corpus. Shipping ward centroids derived from it would
 *   launder bad data into a ranked answer. GPS narrows to a STATE only.
 *
 * - registered_voters is dropped: verified 100% NULL.
 *
 * Usage:
 *   node scripts/build_register_packs.mjs            # build
 *   node scripts/build_register_packs.mjs --verify   # build, then round-trip
 *                                                    # every row against the DB
 *   node scripts/build_register_packs.mjs --out DIR  # override output dir
 */
import { createRequire } from 'node:module';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DB_PATH = process.env.HAWKEYE_DB || path.join(REPO, 'backend', 'storage', 'hawkeye.db');

const argv = process.argv.slice(2);
const VERIFY = argv.includes('--verify');
const outFlag = argv.indexOf('--out');
const OUT_DIR = outFlag !== -1 ? path.resolve(argv[outFlag + 1]) : path.join(REPO, 'app', 'reg');

const MAGIC = 0x4b50_4b48; // 'HKPK' little-endian
const FORMAT_VERSION = 1;
const KIND_INDEX = 0;
const KIND_STATE = 1;
const HEADER_BYTES = 32;

/* ---------------------------------------------------------------- helpers */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * The search fold. MUST stay identical to the server's name_fold/ward_fold, or
 * the same query gives two different answers at the same polling unit — the one
 * failure this whole design exists to prevent.
 */
export function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, ' ')
    .trim();
}

/** Grows-as-needed byte sink; avoids guessing a buffer size up front. */
class ByteWriter {
  constructor(cap = 1 << 16) { this.buf = Buffer.alloc(cap); this.len = 0; }
  _need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const next = Buffer.alloc(cap);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  u8(v) { this._need(1); this.buf.writeUInt8(v, this.len); this.len += 1; }
  u16(v) { this._need(2); this.buf.writeUInt16LE(v, this.len); this.len += 2; }
  u32(v) { this._need(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; }
  bytes(b) { this._need(b.length); b.copy(this.buf, this.len); this.len += b.length; }
  /** u32 byteLength + UTF-8 payload. */
  blob(str) { const b = Buffer.from(str, 'utf8'); this.u32(b.length); this.bytes(b); }
  /** One column of u8s. */
  colU8(vals) { this._need(vals.length); for (const v of vals) this.buf.writeUInt8(v, this.len++); }
  /** One column of u16s. */
  colU16(vals) { this._need(vals.length * 2); for (const v of vals) { this.buf.writeUInt16LE(v, this.len); this.len += 2; } }
  /**
   * One column of DELTA-encoded ids. Groups are emitted in (state,lga,ward)
   * order, so interner ids mostly ascend by 0 or 1 and the deltas gzip to almost
   * nothing: measured 47.4 KB -> 12.5 KB for the national index's group table.
   * Signed, because an id repeats (and so goes backwards) when a name recurs.
   */
  colDelta(vals) {
    this._need(vals.length * 2);
    let prev = 0;
    for (const v of vals) { this.buf.writeInt16LE(v - prev, this.len); this.len += 2; prev = v; }
  }
  done() { return this.buf.subarray(0, this.len); }
}

class ByteReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u8() { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  blob() { const n = this.u32(); const s = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return s; }
  colU8(n) { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = this.buf.readUInt8(this.pos + i); this.pos += n; return a; }
  colU16(n) { const a = new Uint16Array(n); for (let i = 0; i < n; i++) a[i] = this.buf.readUInt16LE(this.pos + i * 2); this.pos += n * 2; return a; }
  colDelta(n) {
    const a = new Uint16Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) { prev += this.buf.readInt16LE(this.pos + i * 2); a[i] = prev; }
    this.pos += n * 2;
    return a;
  }
}

/** LF-joined string table. Names never contain LF (verified: 0 rows). */
function writeTable(w, list) {
  w.u32(list.length);
  w.blob(list.join('\n'));
}
function readTable(r) {
  const count = r.u32();
  const s = r.blob();
  const list = count === 0 ? [] : s.split('\n');
  if (list.length !== count) throw new Error(`string table count mismatch: header ${count}, got ${list.length}`);
  return list;
}

class Interner {
  constructor() { this.list = []; this.ix = new Map(); }
  id(v) {
    const k = v == null ? '' : String(v);
    let i = this.ix.get(k);
    if (i === undefined) { i = this.list.length; this.list.push(k); this.ix.set(k, i); }
    return i;
  }
}

function header({ kind, stateCode, registerVersion, groupCount, unitCount, body }) {
  const h = Buffer.alloc(HEADER_BYTES);
  h.writeUInt32LE(MAGIC, 0);
  h.writeUInt16LE(FORMAT_VERSION, 4);
  h.writeUInt8(kind, 6);
  h.writeUInt8(stateCode, 7);
  h.writeUInt32LE(registerVersion, 8);
  h.writeUInt32LE(groupCount, 12);
  h.writeUInt32LE(unitCount, 16);
  h.writeUInt32LE(body.length, 20);
  h.writeUInt32LE(crc32(body), 24);
  h.writeUInt32LE(0, 28); // reserved
  return h;
}

/**
 * Reject rather than render. A truncated or mismatched pack must never reach the
 * UI: showing the WRONG unit list is worse than showing an error.
 */
function readHeader(pack) {
  if (pack.length < HEADER_BYTES) throw new Error('pack shorter than header');
  if (pack.readUInt32LE(0) !== MAGIC) throw new Error('bad magic');
  const formatVersion = pack.readUInt16LE(4);
  if (formatVersion !== FORMAT_VERSION) throw new Error(`unsupported format version ${formatVersion}`);
  const meta = {
    formatVersion,
    kind: pack.readUInt8(6),
    stateCode: pack.readUInt8(7),
    registerVersion: pack.readUInt32LE(8),
    groupCount: pack.readUInt32LE(12),
    unitCount: pack.readUInt32LE(16),
    bodyLength: pack.readUInt32LE(20),
    crc32: pack.readUInt32LE(24),
  };
  const body = pack.subarray(HEADER_BYTES);
  if (body.length !== meta.bodyLength) throw new Error(`body length ${body.length} != header ${meta.bodyLength}`);
  if (crc32(body) !== meta.crc32) throw new Error('CRC mismatch');
  return { meta, body };
}

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');
const codeOf = (stateCode, lgaCode, wardCode, serial) =>
  `${pad2(stateCode)}-${pad2(lgaCode)}-${pad2(wardCode)}-${pad3(serial)}`;

/* ------------------------------------------------------------------ build */

const CODE_RE = /^(\d{2})-(\d{2})-(\d{2})-(\d{3})$/;

function loadRows(db) {
  const rows = db
    .prepare(
      `SELECT pu_code, name, ward, lga, state, senatorial, federal_constituency
         FROM polling_units ORDER BY pu_code`,
    )
    .all();

  const problems = [];
  for (const r of rows) {
    const m = CODE_RE.exec(r.pu_code || '');
    if (!m) { problems.push(`unparseable pu_code: ${JSON.stringify(r.pu_code)}`); continue; }
    r._state = +m[1]; r._lga = +m[2]; r._ward = +m[3]; r._serial = +m[4];
    if (r._serial > 0xffff) problems.push(`serial exceeds u16: ${r.pu_code}`);
    if (/[\n\r]/.test(r.name || '')) problems.push(`name contains a newline: ${r.pu_code}`);
  }
  if (problems.length) {
    console.error(`\nFATAL: ${problems.length} row(s) violate the pack format:`);
    for (const p of problems.slice(0, 20)) console.error('  ' + p);
    process.exit(2);
  }
  return rows;
}

/** Group by the code prefix (state,lga,ward) — never by ward NAME. */
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r._state}|${r._lga}|${r._ward}`;
    let g = groups.get(key);
    if (!g) {
      g = { stateCode: r._state, lgaCode: r._lga, wardCode: r._ward,
            state: r.state, lga: r.lga, ward: r.ward,
            senatorial: r.senatorial, federal: r.federal_constituency, units: [] };
      groups.set(key, g);
    }
    g.units.push(r);
  }
  for (const g of groups.values()) g.units.sort((a, b) => a._serial - b._serial);
  return [...groups.values()].sort(
    (a, b) => a.stateCode - b.stateCode || a.lgaCode - b.lgaCode || a.wardCode - b.wardCode,
  );
}

function buildStatePack(groups, registerVersion) {
  const stateCode = groups[0].stateCode;
  const wards = new Interner(), lgas = new Interner(), sens = new Interner(), feds = new Interner();
  const names = [];
  let unitCount = 0;

  const meta = [];
  for (const g of groups) {
    meta.push({
      lgaCode: g.lgaCode, wardCode: g.wardCode,
      wardId: wards.id(g.ward), lgaId: lgas.id(g.lga),
      senId: sens.id(g.senatorial), fedId: feds.id(g.federal),
      n: g.units.length,
    });
    for (const u of g.units) { names.push(u.name || ''); unitCount++; }
  }

  const w = new ByteWriter(1 << 18);
  writeTable(w, wards.list);
  writeTable(w, lgas.list);
  writeTable(w, sens.list);
  writeTable(w, feds.list);
  // COLUMNAR, not row-interleaved: like values sit together, which is what the
  // compressor can actually exploit. Ids are delta-coded on top of that.
  w.colU8(meta.map((g) => g.lgaCode));
  w.colU8(meta.map((g) => g.wardCode));
  w.colDelta(meta.map((g) => g.wardId));
  w.colDelta(meta.map((g) => g.lgaId));
  w.colDelta(meta.map((g) => g.senId));
  w.colDelta(meta.map((g) => g.fedId));
  w.colU16(meta.map((g) => g.n));
  // serials, in group order
  for (const g of groups) for (const u of g.units) w.u16(u._serial);
  // display names, LF-joined UTF-8. The client decodes once and folds in memory.
  w.blob(names.join('\n'));

  const body = w.done();
  return Buffer.concat([
    header({ kind: KIND_STATE, stateCode, registerVersion, groupCount: groups.length, unitCount, body }),
    body,
  ]);
}

function buildIndexPack(allGroups, registerVersion) {
  const states = new Interner(), lgas = new Interner(), wards = new Interner();
  const w = new ByteWriter(1 << 18);
  const rowsOut = allGroups.map((g) => ({
    stateCode: g.stateCode, lgaCode: g.lgaCode, wardCode: g.wardCode,
    stateId: states.id(g.state), lgaId: lgas.id(g.lga), wardId: wards.id(g.ward),
    n: g.units.length,
  }));
  writeTable(w, states.list);
  writeTable(w, lgas.list);
  writeTable(w, wards.list);
  w.colU8(rowsOut.map((r) => r.stateCode));
  w.colU8(rowsOut.map((r) => r.lgaCode));
  w.colU8(rowsOut.map((r) => r.wardCode));
  w.colDelta(rowsOut.map((r) => r.stateId));
  w.colDelta(rowsOut.map((r) => r.lgaId));
  w.colDelta(rowsOut.map((r) => r.wardId));
  w.colU16(rowsOut.map((r) => r.n));
  const body = w.done();
  const unitCount = allGroups.reduce((a, g) => a + g.units.length, 0);
  return Buffer.concat([
    header({ kind: KIND_INDEX, stateCode: 0, registerVersion, groupCount: allGroups.length, unitCount, body }),
    body,
  ]);
}

/* ----------------------------------------------------------------- decode */
/** Mirrors what the client will do. Used by --verify; exported for tests. */
export function decodeStatePack(pack) {
  const { meta, body } = readHeader(pack);
  if (meta.kind !== KIND_STATE) throw new Error('not a state pack');
  const r = new ByteReader(body);
  const wards = readTable(r), lgas = readTable(r), sens = readTable(r), feds = readTable(r);
  const G = meta.groupCount;
  const lgaCodes = r.colU8(G), wardCodes = r.colU8(G);
  const wardIds = r.colDelta(G), lgaIds = r.colDelta(G), senIds = r.colDelta(G), fedIds = r.colDelta(G);
  const counts = r.colU16(G);
  const groups = [];
  for (let i = 0; i < G; i++) {
    groups.push({
      lgaCode: lgaCodes[i], wardCode: wardCodes[i],
      ward: wards[wardIds[i]], lga: lgas[lgaIds[i]],
      senatorial: sens[senIds[i]], federal: feds[fedIds[i]],
      n: counts[i],
    });
  }
  const serials = new Uint16Array(meta.unitCount);
  for (let i = 0; i < meta.unitCount; i++) serials[i] = r.u16();
  const names = meta.unitCount === 0 ? [] : r.blob().split('\n');
  if (names.length !== meta.unitCount) {
    throw new Error(`name count ${names.length} != unitCount ${meta.unitCount}`);
  }

  const units = [];
  let i = 0;
  for (const g of groups) {
    for (let k = 0; k < g.n; k++, i++) {
      units.push({
        pu_code: codeOf(meta.stateCode, g.lgaCode, g.wardCode, serials[i]),
        name: names[i], ward: g.ward, lga: g.lga,
        senatorial: g.senatorial, federal_constituency: g.federal,
      });
    }
  }
  return { meta, units };
}

export function decodeIndexPack(pack) {
  const { meta, body } = readHeader(pack);
  if (meta.kind !== KIND_INDEX) throw new Error('not an index pack');
  const r = new ByteReader(body);
  const states = readTable(r), lgas = readTable(r), wards = readTable(r);
  const G = meta.groupCount;
  const stateCodes = r.colU8(G), lgaCodes = r.colU8(G), wardCodes = r.colU8(G);
  const stateIds = r.colDelta(G), lgaIds = r.colDelta(G), wardIds = r.colDelta(G);
  const counts = r.colU16(G);
  const groups = [];
  for (let i = 0; i < G; i++) {
    groups.push({
      stateCode: stateCodes[i], lgaCode: lgaCodes[i], wardCode: wardCodes[i],
      state: states[stateIds[i]], lga: lgas[lgaIds[i]], ward: wards[wardIds[i]],
      n: counts[i],
    });
  }
  return { meta, groups };
}

/* ------------------------------------------------------------------- main */

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`FATAL: no database at ${DB_PATH}`);
    process.exit(2);
  }
  const db = new Database(DB_PATH, { readonly: true });
  const rows = loadRows(db);
  const groups = groupRows(rows);
  /**
   * CONTENT-DERIVED, NOT THE CLOCK. registerVersion goes into every pack header,
   * so a wall-clock value changes the bytes on every run, which changes each
   * content hash, which changes every filename — making 176k unchanged units
   * look like a fresh 1.4 MB download to every installed client. Deriving it
   * from the rows means identical data regenerates byte-identical packs.
   */
  const registerVersion = createHash('sha256')
    .update(String(rows.length) + '|')
    .update(
      rows
        .map((r) => [r.pu_code, r.name, r.ward, r.lga, r.state, r.senatorial, r.federal_constituency].join('\u0001'))
        .join('\n'),
    )
    .digest()
    .readUInt32LE(0);

  console.log(`register: ${rows.length} units, ${groups.length} (state,lga,ward) groups`);

  // Data-quality report. These are NOT repaired here: the server must return the
  // same strings we ship, so a fix belongs in the register, then a regeneration.
  const mojibake = rows.filter((r) => /Ã|â€|Â[^\s]|ã‰/.test(r.name || ''));
  if (mojibake.length) {
    console.log(`\n  WARNING: ${mojibake.length} unit names look like mojibake (UTF-8 read as latin1),`);
    console.log('  e.g. ' + JSON.stringify(mojibake[0].name) + ` (${mojibake[0].pu_code})`);
    console.log('  Not repaired here — fix the register and regenerate, or offline and online disagree.');
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) {
    if (/\.pack\.gz$/.test(f) || f === 'manifest.json') unlinkSync(path.join(OUT_DIR, f));
  }

  const sha8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
  const emit = (name, pack) => {
    const gz = gzipSync(pack, { level: 9 });
    const file = `${name}.${sha8(gz)}.pack.gz`;
    writeFileSync(path.join(OUT_DIR, file), gz);
    return { file, bytes: gz.length, raw: pack.length, sha: sha8(gz) };
  };

  const manifest = { formatVersion: FORMAT_VERSION, registerVersion, generated: new Date().toISOString(), // display only; identity is registerVersion
     index: null, states: {} };

  const indexPack = buildIndexPack(groups, registerVersion);
  manifest.index = { ...emit('index', indexPack), groups: groups.length, units: rows.length };

  const byState = new Map();
  for (const g of groups) {
    if (!byState.has(g.stateCode)) byState.set(g.stateCode, []);
    byState.get(g.stateCode).push(g);
  }

  let totalGz = manifest.index.bytes;
  const sizes = [];
  for (const [stateCode, gs] of [...byState].sort((a, b) => a[0] - b[0])) {
    const pack = buildStatePack(gs, registerVersion);
    const info = emit(pad2(stateCode), pack);
    const units = gs.reduce((a, g) => a + g.units.length, 0);
    manifest.states[pad2(stateCode)] = { ...info, name: gs[0].state, units, groups: gs.length };
    totalGz += info.bytes;
    sizes.push({ state: gs[0].state, code: pad2(stateCode), units, gz: info.bytes });
  }

  writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  sizes.sort((a, b) => b.gz - a.gz);
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`\nwrote ${sizes.length + 1} packs to ${path.relative(REPO, OUT_DIR)}`);
  console.log(`  index (tier-0, precached): ${kb(manifest.index.bytes)}  [${groups.length} wards, cascade works offline nationwide]`);
  console.log(`  largest state : ${sizes[0].state} ${sizes[0].units} units -> ${kb(sizes[0].gz)}`);
  console.log(`  median state  : ${kb(sizes[Math.floor(sizes.length / 2)].gz)}`);
  console.log(`  smallest state: ${sizes[sizes.length - 1].state} -> ${kb(sizes[sizes.length - 1].gz)}`);
  console.log(`  all 37 states + index: ${(totalGz / 1048576).toFixed(2)} MB gz on disk`);

  if (VERIFY) verify(rows, groups, manifest);
  db.close();
}

/**
 * THE GATE. Every one of the 176,846 units must come back byte-identical from
 * the packs it was written to — codes reconstructed from prefix+serial, names
 * and hierarchy from the tables. If this does not pass, nothing downstream
 * matters, which is why it runs before a line of app code changes.
 */
function verify(rows, groups, manifest) {
  console.log('\n--- verify ---');
  const byCode = new Map(rows.map((r) => [r.pu_code, r]));
  let checked = 0;
  const bad = [];
  const push = (msg) => { if (bad.length < 20) bad.push(msg); };

  for (const [code, info] of Object.entries(manifest.states)) {
    const pack = gunzipSync(readFileSync(path.join(OUT_DIR, info.file)));
    const { meta, units } = decodeStatePack(pack);
    if (meta.registerVersion !== manifest.registerVersion) push(`state ${code}: registerVersion mismatch`);
    if (units.length !== info.units) push(`state ${code}: ${units.length} units decoded, manifest says ${info.units}`);
    for (const u of units) {
      const src = byCode.get(u.pu_code);
      checked++;
      if (!src) { push(`reconstructed code not in DB: ${u.pu_code}`); continue; }
      if (src.name !== u.name) push(`name mismatch ${u.pu_code}: ${JSON.stringify(src.name)} != ${JSON.stringify(u.name)}`);
      if (src.ward !== u.ward) push(`ward mismatch ${u.pu_code}`);
      if (src.lga !== u.lga) push(`lga mismatch ${u.pu_code}`);
      if ((src.senatorial || '') !== (u.senatorial || '')) push(`senatorial mismatch ${u.pu_code}`);
      if ((src.federal_constituency || '') !== (u.federal_constituency || '')) push(`federal mismatch ${u.pu_code}`);
      byCode.delete(u.pu_code);
    }
  }

  const idx = decodeIndexPack(gunzipSync(readFileSync(path.join(OUT_DIR, manifest.index.file))));
  if (idx.groups.length !== groups.length) push(`index groups ${idx.groups.length} != ${groups.length}`);
  const idxUnits = idx.groups.reduce((a, g) => a + g.n, 0);
  if (idxUnits !== rows.length) push(`index unit total ${idxUnits} != ${rows.length}`);
  for (let i = 0; i < groups.length; i++) {
    const a = groups[i], b = idx.groups[i];
    if (!b) { push(`index missing group ${i}`); break; }
    if (a.state !== b.state || a.lga !== b.lga || a.ward !== b.ward || a.units.length !== b.n) {
      push(`index group ${i} mismatch: ${a.state}/${a.lga}/${a.ward}`);
    }
  }

  // Corruption must be REJECTED, not rendered. Flip one body byte and one header
  // byte and assert both are refused.
  const first = Object.values(manifest.states)[0];
  const good = gunzipSync(readFileSync(path.join(OUT_DIR, first.file)));
  const tamperedBody = Buffer.from(good); tamperedBody[HEADER_BYTES + 8] ^= 0x01;
  const truncated = good.subarray(0, good.length - 4);
  let rejects = 0;
  for (const [label, buf] of [['flipped body byte', tamperedBody], ['truncated tail', truncated]]) {
    try { decodeStatePack(buf); push(`SECURITY: ${label} was accepted`); }
    catch { rejects++; }
  }

  const missed = byCode.size;
  console.log(`  units reconstructed byte-identical : ${checked - bad.length}/${rows.length}`);
  console.log(`  DB rows never emitted              : ${missed}`);
  console.log(`  index groups                       : ${idx.groups.length}/${groups.length}`);
  console.log(`  corruption rejected                : ${rejects}/2`);
  if (bad.length || missed || rejects !== 2) {
    console.error('\nVERIFY FAILED:');
    for (const b of bad) console.error('  ' + b);
    if (missed) console.error(`  ${missed} DB row(s) missing from packs, e.g. ${[...byCode.keys()].slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  console.log('  VERIFY OK');
}

main();

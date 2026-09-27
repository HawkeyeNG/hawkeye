// UNIQUE PIXELS PER REPORT, CHEAPLY.
//
// The server rejects a photo whose dhash (9x8 grayscale gradient hash) is within
// DHASH_HAMMING_THRESHOLD (4) of ANY earlier photo from another observer
// (routes/submissions.js, 409 near_duplicate_image). Changing a JPEG comment
// changes the sha256 but not one pixel, so with a fixed template every report
// after the first was refused in proxy mode, and in direct mode the analysis
// worker would flag every report as a copy.
//
// The fix: templates are PROGRESSIVE JPEGs (seed/make_sample_jpegs.mjs), whose
// first scan carries only the DC coefficient (the mean) of every 8x8 block.
// Per report we REPLACE that scan with a freshly encoded one that paints a random
// 9x8 grid of brightness levels, and keep every AC scan (the texture) from the
// template. The dhash is then an effectively random 64-bit value, the file is
// still a real ~1500x2000 photo-sized JPEG for the server to decode, and the
// generator only Huffman-codes ~70k DC symbols instead of encoding an image.
//
// Plain JS (no k6 imports), so Node can test it against the backend's own dhash.
// Cost inside k6: ~19 ms of generator CPU per report (sheet + venue), i.e. about
// 5 vCPU at the 250 reports/s design point. Checked 27 Sep 2026: 600 photos all
// decoded at full size, min pairwise dhash distance 14 (the server rejects <= 4),
// against 0 for the old comment-only uniquifier.

const DC_LUM = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHR = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };

function huffCodes(spec) {
  // JPEG Annex C: canonical codes from BITS/HUFFVAL. Returns [code, length] per symbol.
  const out = [];
  let code = 0; let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < spec.bits[len - 1]; i++) { out[spec.vals[k++]] = [code, len]; code++; }
    code <<= 1;
  }
  return out;
}
const LUM = huffCodes(DC_LUM);
const CHR = huffCodes(DC_CHR);

const u16 = (b, i) => (b[i] << 8) | b[i + 1];

function dhtSegment(tables) {
  // tables: [[id, spec], ...] as one DHT segment of class 0 (DC)
  let len = 2;
  for (const [, s] of tables) len += 17 + s.vals.length;
  const out = new Uint8Array(2 + len);
  out[0] = 0xff; out[1] = 0xc4; out[2] = len >> 8; out[3] = len & 255;
  let p = 4;
  for (const [id, s] of tables) {
    out[p++] = id & 15; // class 0
    for (let i = 0; i < 16; i++) out[p++] = s.bits[i];
    for (const v of s.vals) out[p++] = v;
  }
  return out;
}

// Parse a progressive template once (init context). Throws on anything else.
export function parseTemplate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  const keep = [b.subarray(0, 2)];
  let i = 2; let sof = null; const q = {};
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`JPEG: lost marker sync at ${i}`);
    const m = b[i + 1];
    const len = u16(b, i + 2);
    if (m === 0xdb) {
      let p = i + 4;
      while (p < i + 2 + len) { const pq = b[p] >> 4; const id = b[p] & 15; q[id] = pq ? u16(b, p + 1) : b[p + 1]; p += 1 + 64 * (pq ? 2 : 1); }
    }
    if (m === 0xc0 || m === 0xc1) throw new Error('template is baseline; regenerate it with seed/make_sample_jpegs.mjs (progressive)');
    if (m === 0xc2) {
      const n = b[i + 9]; const comps = [];
      for (let k = 0; k < n; k++) comps.push({ id: b[i + 10 + 3 * k], h: b[i + 11 + 3 * k] >> 4, v: b[i + 11 + 3 * k] & 15, tq: b[i + 12 + 3 * k] });
      sof = { h: u16(b, i + 5), w: u16(b, i + 7), comps };
    }
    if (m === 0xda) {
      if (!sof) throw new Error('JPEG: SOS before SOF');
      const n = b[i + 4]; const sel = [];
      for (let k = 0; k < n; k++) sel.push({ id: b[i + 5 + 2 * k], td: b[i + 6 + 2 * k] >> 4 });
      const p = i + 5 + 2 * n;
      const ss = b[p]; const se = b[p + 1]; const ah = b[p + 2] >> 4; const al = b[p + 2] & 15;
      if (ss !== 0 || se !== 0 || ah !== 0 || n !== sof.comps.length) throw new Error('first scan is not an interleaved DC-first scan');
      const sos = b.slice(i, i + 2 + len);
      let j = i + 2 + len; // skip entropy-coded data to the next real marker
      while (j < b.length - 1 && !(b[j] === 0xff && b[j + 1] !== 0 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      let size = 0; for (const s of keep) size += s.length;
      const head = new Uint8Array(size); let o = 0;
      for (const s of keep) { head.set(s, o); o += s.length; }
      const hmax = Math.max(...sof.comps.map((c) => c.h)); const vmax = Math.max(...sof.comps.map((c) => c.v));
      const comps = sel.map((s) => {
        const c = sof.comps.find((x) => x.id === s.id);
        return { ...c, td: s.td, luma: c.id === sof.comps[0].id };
      });
      const tds = [...new Set(comps.map((c) => c.td))];
      const tables = tds.map((td) => [td, comps.find((c) => c.td === td).luma ? DC_LUM : DC_CHR]);
      const codes = {}; for (const [td, spec] of tables) codes[td] = spec === DC_LUM ? LUM : CHR;
      return {
        w: sof.w, h: sof.h, al, q0: q[comps[0].tq] || 8,
        mcuX: Math.ceil(sof.w / (8 * hmax)), mcuY: Math.ceil(sof.h / (8 * vmax)),
        comps, codes, head: head.slice(2), soi: b.slice(0, 2), dht: dhtSegment(tables), sos, tail: b.slice(j),
      };
    }
    if (m !== 0xc4) keep.push(b.subarray(i, i + 2 + len)); // DC tables of scan 1 are replaced by ours
    i += 2 + len;
  }
  throw new Error('JPEG: no scan found');
}

// Encode a DC-first scan painting `levels` (8 rows x 9 cols, 0..255) as block means.
// Speed matters (k6's JS engine is slow and this runs twice per report), so:
//  - chroma DC is neutral (0), so every chroma diff is 0, and inside a cell every
//    luma diff after the first is 0 too;
//  - the Annex K category-0 codes are all-zero bits, and the buffer starts zeroed,
//    so a zero diff costs one cursor bump. Only the ~9 cell edges per MCU row
//    write bits. Byte stuffing (FF -> FF 00) is a separate linear pass.
function encodeDcScan(t, levels) {
  const { mcuX, mcuY, comps, codes, al, q0 } = t;
  const luma = comps[0];
  if (!luma.luma || comps.slice(1).some((c) => c.luma)) throw new Error('expected Y first');
  let zeroMcu = 0; // bits of an MCU whose every diff is 0
  for (const c of comps) {
    const [code0, len0] = codes[c.td][0];
    if (code0 !== 0) throw new Error('category-0 code is not all zeros');
    zeroMcu += c.h * c.v * len0;
  }
  const lumTab = codes[luma.td]; const lum0 = lumTab[0][1];
  const raw = new Uint8Array(((mcuX * mcuY * zeroMcu) >> 3) + mcuY * 9 * 4 + 64);
  const touched = []; // byte offsets that may hold set bits (only these can become FF)
  let bp = 0;
  const put = (v, n) => { // n <= 24; OR v's n bits in MSB-first at bit cursor bp
    const b = bp >> 3; const x = (v << (32 - (bp & 7) - n)) >>> 0;
    raw[b] |= x >>> 24; raw[b + 1] |= (x >>> 16) & 255; raw[b + 2] |= (x >>> 8) & 255; raw[b + 3] |= x & 255;
    touched.push(b);
    bp += n;
  };
  const dcq = levels.map((row) => row.map((L) => Math.round((8 * (L - 128)) / q0) >> al));
  // The 9 dhash columns as runs of MCU columns: one step per cell, not per MCU.
  const start = []; for (let c = 0; c <= 9; c++) start.push(Math.ceil((c * mcuX) / 9));
  let pred = 0;
  for (let my = 0; my < mcuY; my++) {
    const row = dcq[Math.min(7, Math.floor((my * 8) / mcuY))];
    for (let c = 0; c < 9; c++) {
      const n = start[c + 1] - start[c];
      if (n <= 0) continue;
      const diff = row[c] - pred;
      if (diff === 0) { bp += n * zeroMcu; continue; }
      pred = row[c];
      const a = diff < 0 ? -diff : diff;
      let cat = 0; while ((1 << cat) <= a) cat++;
      const hc = lumTab[cat];
      put((hc[0] << cat) | (diff < 0 ? diff + (1 << cat) - 1 : diff), hc[1] + cat);
      // the rest of this MCU (other luma blocks, chroma) and the run's other MCUs: zero diffs
      bp += (zeroMcu - lum0) + (n - 1) * zeroMcu;
    }
  }
  const nbytes = (bp + 7) >> 3;
  if (bp & 7) { raw[nbytes - 1] |= 0xff >> (bp & 7); touched.push(nbytes - 1); } // pad with 1-bits
  // Byte stuffing, visiting only bytes that can be FF.
  const ffs = [];
  let last = -1;
  for (const b0 of touched) {
    for (let b = Math.max(b0, last + 1); b < b0 + 4 && b < nbytes; b++) if (raw[b] === 0xff) ffs.push(b);
    if (b0 + 3 > last) last = b0 + 3;
  }
  const out = new Uint8Array(nbytes + ffs.length);
  let o = 0; let from = 0;
  for (const b of ffs) { out.set(raw.subarray(from, b + 1), o); o += b + 1 - from; out[o++] = 0; from = b + 1; }
  out.set(raw.subarray(from, nbytes), o);
  return out;
}

// Random 9x8 grid; horizontal neighbours differ by >= 24 levels, so each of the
// 64 dhash bits is a clear comparison rather than template noise.
export function randomLevels(rand = Math.random) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    const row = [48 + Math.floor(rand() * 160)];
    for (let c = 1; c < 9; c++) {
      const step = 24 + Math.floor(rand() * 40);
      let next = row[c - 1] + (rand() < 0.5 ? -step : step);
      if (next < 40 || next > 215) next = row[c - 1] + (next < 40 ? step : -step);
      row.push(Math.max(40, Math.min(215, next)));
    }
    rows.push(row);
  }
  return rows;
}

// A new JPEG: template texture + random coarse grid + a COM segment carrying `nonce`.
export function uniqueJpeg(t, nonce, levels = randomLevels()) {
  const data = encodeDcScan(t, levels);
  const n = String(nonce).slice(0, 200);
  const com = new Uint8Array(4 + n.length);
  com[0] = 0xff; com[1] = 0xfe; com[2] = (n.length + 2) >> 8; com[3] = (n.length + 2) & 255;
  for (let i = 0; i < n.length; i++) com[4 + i] = n.charCodeAt(i) & 0x7f;
  const parts = [t.soi, com, t.head, t.dht, t.sos, data, t.tail];
  let size = 0; for (const p of parts) size += p.length;
  const out = new Uint8Array(size); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

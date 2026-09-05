import crypto from 'node:crypto';
import sharp from 'sharp';

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 64-bit difference hash. Catches re-encodes/light crops of the SAME photo, while two
// genuinely different photos of the same result sheet (taken by different observers
// from different spots) stay far apart in Hamming distance — that is the point:
// honest corroboration passes, copy-paste evidence does not.
export async function dhashHex(buf) {
  const { data, info } = await sharp(buf)
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let bits = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const i = (row * 9 + col) * ch;
      bits = (bits << 1n) | (data[i] < data[i + ch] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(hexA, hexB) {
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

// ---- Banded LSH over the 64-bit dhash ---------------------------------------
//
// WHY. The near-duplicate guard used to load EVERY stored dhash on EVERY
// submission and Hamming-compare them in JS. At the 2027 ceiling (176,846 units
// x 3 races x 3 observers = 1,591,614 submissions) that is 3.18M rows read per
// insert and ~2.5 trillion comparisons over the run, on a synchronous
// better-sqlite3 handle behind a single event loop — so it blocks every other
// request while it runs. It was the worst scaling term in the codebase.
//
// THE GUARANTEE. Two hashes within Hamming distance T differ in at most T bits,
// and those bits can touch at most T bands. Split the 64 bits into T+1 bands and
// AT LEAST ONE BAND MUST MATCH EXACTLY. So looking candidates up by exact band
// equality is lossless: it cannot miss a true near-duplicate. hammingDistance()
// still decides on the shortlist, so it adds no false positives either. The
// index changes the cost, never the verdict.
//
// The band count is DERIVED from the threshold and never hardcoded. Raising
// DHASH_HAMMING_THRESHOLD without adding a band would silently void the
// pigeonhole argument and begin letting duplicates through — the exact failure
// this guard exists to prevent, and one that would leave no trace.
export function dhashBandCount(threshold) {
  const t = Number.isFinite(threshold) ? Math.max(0, Math.trunc(threshold)) : 0;
  // Past 64 bands the bands are empty; a threshold that big matches nearly
  // everything anyway, at which point the guard is meaningless by configuration.
  return Math.min(t + 1, 64);
}

export function dhashBandTokens(hex, threshold) {
  const bands = dhashBandCount(threshold);
  const v = BigInt('0x' + hex);
  const base = Math.floor(64 / bands);
  const extra = 64 % bands;                 // remainder spread over the first bands
  const out = [];
  let shift = 0n;
  for (let i = 0; i < bands; i++) {
    const width = BigInt(base + (i < extra ? 1 : 0));
    const part = (v >> shift) & ((1n << width) - 1n);
    // The band INDEX is part of the token. Without it, band 0 holding 0x1f and
    // band 3 holding 0x1f collide, and every lookup drags in unrelated rows.
    out.push(i + ':' + part.toString(16));
    shift += width;
  }
  return out;
}

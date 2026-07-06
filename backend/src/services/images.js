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

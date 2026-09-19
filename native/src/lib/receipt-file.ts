/**
 * Turn the drawn card into a file on the phone.
 *
 * NO CAPTURE LIBRARY. react-native-svg is already a dependency and its <Svg>
 * exposes toDataURL(), so the PNG comes out of the element already on screen.
 * Adding react-native-view-shot for one screen would be a new native module in
 * a build that has crashed at launch over exactly that kind of addition — see
 * the precompiled-module note in memory.
 *
 * RESPECTS THE COPIES SWITCH. saveReportMedia already reads
 * "Save Report Media to Phone" and does nothing when it is off, which is
 * correct and is also indistinguishable from a broken button — so this reports
 * whether it actually saved, and the screen says which happened. The card stays
 * visible either way, so there is always a screenshot.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { isSaveToDeviceEnabled, saveReportMedia } from '@/lib/save-to-device';

type CardHandle = { toPng: () => Promise<string | null> } | null;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decoded by hand because React Native has no Buffer and atob is not universal
 * across the engines this ships on. File.write() takes a string OR a Uint8Array, and bytes
 * keep this off the string-encoding options, which differ between the legacy
 * and current expo-file-system APIs.
 */
function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1]);
    const c = B64.indexOf(clean[i + 2]);
    const d = B64.indexOf(clean[i + 3]);
    const n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
    out[o++] = (n >> 16) & 255;
    if (c >= 0) out[o++] = (n >> 8) & 255;
    if (d >= 0) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

/** true when a file actually reached the gallery. */
export async function saveReceiptPng(card: CardHandle): Promise<boolean> {
  try {
    if (!card) return false;
    // Asked BEFORE drawing: if copies are off there is nothing to write and no
    // reason to spend a bridge round-trip rasterising a card to throw away.
    if (!(await isSaveToDeviceEnabled())) return false;

    const b64 = await card.toPng();
    if (!b64) return false;

    const dir = new Directory(Paths.cache, 'hawkeye-receipts');
    try { dir.create({ intermediates: true, idempotent: true }); } catch { /* already there */ }
    // Stamped, so two reports from one unit do not overwrite each other.
    const f = new File(dir, `hawkeye-receipt-${Date.now()}.png`);
    try { f.create({ overwrite: true }); } catch { /* already there */ }
    f.write(bytesFromBase64(b64));

    saveReportMedia([f.uri]);
    return true;
  } catch {
    // A receipt is the nicest thing on that screen and the least important.
    return false;
  }
}

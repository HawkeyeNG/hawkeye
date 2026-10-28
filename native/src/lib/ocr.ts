/**
 * On-device document recognition for the EC8A result sheet.
 *
 * Runs Google ML Kit's text recogniser over the sheet photo the observer just
 * took, entirely on the phone — no upload, no network, and nothing leaves the
 * device if the read fails. Two jobs:
 *
 *  1. Tell the observer AT CAPTURE TIME whether the sheet is legible. A blurry
 *     EC8A is worthless evidence, and finding that out after submitting is too
 *     late — the photo is already chained on the ledger.
 *  2. Offer the figures it read as a starting point for the vote entry, so the
 *     observer verifies numbers instead of typing them from scratch.
 *
 * The server runs its own OCR cross-check on the uploaded sheet regardless
 * (routes/submissions.js → ocrMatchCounts), so this never becomes the source of
 * truth — it is a helper and a warning, and every value it proposes is editable.
 *
 * TWO READERS, ONE PER PLATFORM.
 *
 *   iOS      Apple Vision, via the local modules/hawkeye-vision module. Vision
 *            ships with the OS, so nothing is bundled. Hawkeye Lite has read
 *            EC8A sheets this way in production.
 *   Android  Google ML Kit, which has no system-provided equivalent there.
 *
 * They were both ML Kit until the iOS binary was measured: the ML Kit pod pulls
 * five recognition models (Latin, Chinese, Devanagari, Japanese, Korean) into
 * the app, and observers download that over Nigerian mobile data. The two
 * return the same shape, so everything below this point is platform-agnostic.
 *
 * Both are native modules: they exist in a dev/production build and NOT in Expo
 * Go, so each is probed rather than imported, exactly like the video compressor.
 */
import { Platform } from 'react-native';

import { recognize as visionRecognize, visionAvailable } from '@/modules/hawkeye-vision';
import { parseCounts, type OcrLine } from './sheet-counts';
import { parseSerial } from './sheet-serial';

/**
 * Both readers return lines inside blocks, each with a box, in pixels with the
 * origin top-left — Vision as `boundingBox` (converted in HawkeyeVisionModule),
 * ML Kit as `frame`. The boxes are what pair a party with its count on a ruled
 * sheet (see sheet-counts.ts), so they are kept, not just the text.
 */
type ReaderLine = {
  text: string;
  boundingBox?: { left: number; right: number; top: number; bottom: number };
  frame?: { left: number; top: number; width: number; height: number };
};
type ReaderResult = { text: string; blocks?: { lines?: ReaderLine[] }[] };
type Recogniser = { recognize: (uri: string) => Promise<ReaderResult> };

let TextRecognition: Recogniser | null = null;
if (Platform.OS !== 'ios') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-ml-kit/text-recognition');
    TextRecognition = (mod?.default ?? mod) as Recogniser;
  } catch {
    TextRecognition = null;
  }
}

/** Read the sheet with whichever recogniser this platform has. */
async function recogniseText(uri: string): Promise<ReaderResult | null> {
  if (Platform.OS === 'ios') {
    return (await visionRecognize(uri)) ?? null;
  }
  if (!TextRecognition) return null;
  return (await TextRecognition.recognize(uri)) ?? { text: '' };
}

/** Every line that came back with a box, in the one shape the pairing reads. */
function linesOf(res: ReaderResult): OcrLine[] {
  const out: OcrLine[] = [];
  for (const block of res.blocks ?? []) {
    for (const l of block.lines ?? []) {
      const b = l.boundingBox
        ?? (l.frame ? { left: l.frame.left, right: l.frame.left + l.frame.width, top: l.frame.top, bottom: l.frame.top + l.frame.height } : null);
      if (b && l.text) out.push({ text: l.text, left: b.left, right: b.right, top: b.top, bottom: b.bottom });
    }
  }
  return out;
}

export { parseCounts } from './sheet-counts';
export { parseSerial } from './sheet-serial';

export const ocrAvailable = () => (Platform.OS === 'ios' ? visionAvailable() : TextRecognition != null);

export type SheetRead = {
  /** Raw recognised text, newline separated. */
  text: string;
  /** How many lines carried a number — the practical "is this readable" signal. */
  numericLines: number;
  /** Party code (exactly as passed in) → the count read beside it. See sheet-counts.ts. */
  counts: Record<string, number>;
  /**
   * The sheet's printed serial, when one was found. NEVER authoritative — the
   * observer confirms it before it is sent, because of what it feeds (see
   * parseSerial).
   */
  serial: string | null;
};

/** Recognise a sheet photo. Returns null when no recogniser is available or it fails. */
export async function readSheet(uri: string, partyCodes: string[] = []): Promise<SheetRead | null> {
  if (!ocrAvailable()) return null;
  try {
    const res = await recogniseText(uri);
    if (res == null) return null;
    const text = res.text ?? '';
    if (!text.trim()) return { text: '', numericLines: 0, counts: {}, serial: null };
    const numericLines = text.split(/\r?\n/).filter((l) => /\d/.test(l)).length;
    return {
      text,
      numericLines,
      counts: parseCounts(text, partyCodes, linesOf(res)),
      serial: parseSerial(text),
    };
  } catch {
    return null;
  }
}

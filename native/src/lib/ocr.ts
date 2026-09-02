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

type MlkitResult = { text: string; blocks?: { text: string }[] };
type Recogniser = { recognize: (uri: string) => Promise<MlkitResult> };

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
async function recogniseText(uri: string): Promise<string | null> {
  if (Platform.OS === 'ios') {
    const res = await visionRecognize(uri);
    return res?.text ?? null;
  }
  if (!TextRecognition) return null;
  const res = await TextRecognition.recognize(uri);
  return res?.text ?? '';
}

export const ocrAvailable = () => (Platform.OS === 'ios' ? visionAvailable() : TextRecognition != null);

export type SheetRead = {
  /** Raw recognised text, newline separated. */
  text: string;
  /** How many lines carried a number — the practical "is this readable" signal. */
  numericLines: number;
  /** Party code → count, for codes that appear on the same line as a number. */
  counts: Record<string, number>;
};

/**
 * Party codes are short and collide with ordinary words on the form ("A" is a
 * party AND a column letter), so a code only counts when it stands alone as a
 * token on the line — not as a fragment of a longer word.
 */
function tokenised(line: string) {
  return line
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/**
 * Pull "PARTY … 123" pairs out of recognised text.
 *
 * EC8A rows read as `<party> <accreted> <score>`; the count we want is the LAST
 * number on the row. Numbers with separators ("1,204") are joined back up, and
 * anything longer than six digits is discarded as a serial or form number
 * rather than a tally.
 */
export function parseCounts(text: string, partyCodes: string[]): Record<string, number> {
  const codes = new Set(partyCodes.map((c) => c.toUpperCase()));
  const out: Record<string, number> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(\d)[.,](?=\d{3}\b)/g, '$1'); // 1,204 -> 1204
    const tokens = tokenised(line);
    const code = tokens.find((t) => codes.has(t));
    if (!code) continue;
    const numbers = tokens.filter((t) => /^\d{1,6}$/.test(t)).map(Number);
    if (!numbers.length) continue;
    // Last number on the row is the score column; keep the first read per party
    // so a repeated header row cannot overwrite a real one.
    if (out[code] === undefined) out[code] = numbers[numbers.length - 1];
  }
  return out;
}

/** Recognise a sheet photo. Returns null when no recogniser is available or it fails. */
export async function readSheet(uri: string, partyCodes: string[] = []): Promise<SheetRead | null> {
  if (!ocrAvailable()) return null;
  try {
    const text = await recogniseText(uri);
    if (text == null) return null;
    if (!text.trim()) return { text: '', numericLines: 0, counts: {} };
    const numericLines = text.split(/\r?\n/).filter((l) => /\d/.test(l)).length;
    return { text, numericLines, counts: parseCounts(text, partyCodes) };
  } catch {
    return null;
  }
}

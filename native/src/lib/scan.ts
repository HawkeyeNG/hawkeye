/**
 * Document scanning — the native answer to the PWA's OpenCV edge detection
 * (app/scan.js + scan-worker.js).
 *
 * Backed by Google's ML Kit Document Scanner, which is the same class of tool
 * as Adobe Scan: it finds the sheet's edges live, lets the observer drag the
 * corners, and returns a deskewed, perspective-corrected crop. That crop is
 * worth more than a prettier photo — a flattened sheet with the background cut
 * away is what makes the on-device OCR (lib/ocr.ts) read reliably, so edge
 * detection and prefill accuracy are the same problem.
 *
 * Native module, so it exists in a dev/production build and NOT in Expo Go —
 * probed like the compressor and the recogniser. Callers fall back to the
 * in-app camera when it is missing, and the flow is otherwise identical:
 * the same GPS stamp, the same preview-confirm, the same OCR verdict.
 */

type ScanResult = { scannedImages?: string[]; status?: string };
type Scanner = {
  scanDocument: (opts: {
    croppedImageQuality?: number;
    maxNumDocuments?: number;
    responseType?: string;
  }) => Promise<ScanResult>;
};

let DocumentScanner: Scanner | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('react-native-document-scanner-plugin');
  DocumentScanner = (mod?.default ?? mod) as Scanner;
  if (typeof DocumentScanner?.scanDocument !== 'function') DocumentScanner = null;
} catch {
  DocumentScanner = null;
}

export const scannerAvailable = () => DocumentScanner != null;

export type ScanOutcome =
  | { ok: true; uri: string }
  | { ok: false; reason: 'cancelled' | 'unavailable' | 'failed' };

/**
 * Scan exactly one sheet.
 *
 * Quality is 92 rather than 100: the sheet is uploaded over Nigerian mobile
 * data and the server caps bodies, and the difference is invisible on a form
 * whose only job is to be readable. One document only — an EC8A is one page,
 * and a multi-page return would silently drop everything after the first.
 */
export async function scanSheet(): Promise<ScanOutcome> {
  if (!DocumentScanner) return { ok: false, reason: 'unavailable' };
  try {
    const res = await DocumentScanner.scanDocument({
      croppedImageQuality: 92,
      maxNumDocuments: 1,
      responseType: 'imageFilePath',
    });
    const uri = res?.scannedImages?.[0];
    if (!uri) return { ok: false, reason: 'cancelled' };
    return { ok: true, uri: uri.startsWith('file://') ? uri : `file://${uri}` };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

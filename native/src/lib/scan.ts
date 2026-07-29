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
 *
 * WHY A SCAN CAN FAIL — the honest answer, because "the scanner failed" is
 * otherwise indistinguishable from blaming the observer's photography.
 *
 * We do not ship the scanner. `GmsDocumentScanner` is an `OptionalModuleApi`:
 * its UI, its edge-detection models and its cropping logic all live in Google
 * Play services and are fetched ON DEMAND the first time an app asks for them.
 * `getStartScanIntent()` therefore rejects on a phone with no Play services, on
 * one whose Play services is too old to serve the module, and on genuine first
 * use with no connection — the module simply is not on the device yet. None of
 * those are about the sheet, the lighting or the lens, and a retry once the
 * phone is online is the actual fix.
 *
 * And it cannot be pre-fetched at install time, which is the obvious fix and
 * does not exist here. ML Kit's install-time hint
 * (`<meta-data android:name="com.google.mlkit.vision.DEPENDENCIES">`) only
 * accepts the tokens `OptionalModuleUtils` in com.google.mlkit:common maps, and
 * that table — barcode, barcode_ui, ocr, ica, custom_ica, face, langid,
 * nlclassifier, smart_reply, tflite_dynamite — has no entry for the document
 * scanner, even though the modules it would name (mlkit.docscan.*) are in the
 * same class. So the runtime retry below IS the mitigation, not a placeholder
 * for one. Re-check that table before adding a manifest token: guessing one
 * would also collide with the barcode_ui value expo-camera already declares.
 */

type ScanResult = { scannedImages?: string[]; status?: 'success' | 'cancel' | string };
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
    // Backing out reports itself explicitly, so read the status rather than
    // inferring a cancel from an empty array: a 'success' that carried no image
    // is a genuine failure, and callers treat cancel as "leave the step", so
    // guessing wrong closes the whole capture instead of offering the camera.
    if (res?.status === 'cancel') return { ok: false, reason: 'cancelled' };
    const uri = res?.scannedImages?.[0];
    if (!uri) return { ok: false, reason: 'failed' };
    return { ok: true, uri: uri.startsWith('file://') ? uri : `file://${uri}` };
  } catch {
    // getStartScanIntent() rejected: the Play services module is absent or
    // could not be fetched — see the failure note at the top of this file.
    return { ok: false, reason: 'failed' };
  }
}

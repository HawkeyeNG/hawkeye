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
 *
 * WHAT IS TUNABLE HERE — the whole list, read off the installed module
 * (react-native-document-scanner-plugin 2.0.4: android/src/main/java/com/
 * documentscanner/DocumentScannerModule.kt and ios/DocScanner/DocScanner.swift):
 *
 *   croppedImageQuality  0-100 JPEG quality. iOS only in practice — see below.
 *   maxNumDocuments      Android only; maps to setPageLimit().
 *   responseType         'imageFilePath' | 'base64'.
 *
 * Those three are everything the native side reads. The scanner's APPEARANCE is
 * fixed and not ours: its camera preview, viewport, edge-detection overlay,
 * corner handles, retake/crop/rotate controls and shutter all live in a Play
 * services activity (Android) or VNDocumentCameraViewController (iOS) running
 * OUTSIDE our process. Both are already full-screen, so there is no small
 * viewport here to enlarge — and no prop, style or option that could enlarge one
 * if there were. The module also hardcodes SCANNER_MODE_FULL and
 * RESULT_FORMAT_JPEG and never calls setGalleryImportAllowed, so scanner mode,
 * PDF output and gallery import are equally unreachable from JS. Anything past
 * those three options needs a patch to the module, not an argument.
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

/**
 * Has the Play services module ever actually produced a scan on this device?
 *
 * The module is fetched on demand, and when that fetch stalls the observer sits
 * on Google's own "Downloading updates to Google Play services…" screen with
 * nothing but a Cancel button. Cancelling there reports the SAME 'cancel' status
 * as deliberately backing out of a working scanner — so the two are
 * indistinguishable from the status alone, and treating both as "leave the step"
 * strands a reporter who never got a scanner at all.
 *
 * Until a scan has succeeded once, assume a cancel is that stall and offer the
 * plain camera instead of closing the step.
 */
let proven = false;
export const scannerProven = () => proven;

export type ScanOutcome =
  | { ok: true; uri: string }
  | { ok: false; reason: 'cancelled' | 'unavailable' | 'failed' };

/**
 * Scan exactly one sheet.
 *
 * One document only — an EC8A is one page, and a multi-page return would
 * silently drop everything after the first.
 *
 * croppedImageQuality is iOS-only and a NO-OP on Android — worth knowing before
 * anyone tunes it hoping to sharpen the OCR. The Android module only applies it
 * inside its base64 branch (getImageInBase64 → bitmap.compress); with
 * responseType 'imageFilePath', which is what we ask for, it hands back ML Kit's
 * own JPEG URI untouched. So on Android the sheet we read and upload is ML Kit's
 * full-quality crop and nothing here re-compresses it — the better outcome, and
 * the reason not to "fix" this by switching to base64.
 *
 * On iOS the value is real: DocScanner.swift calls
 * jpegData(compressionQuality:) on every response type, so it is the only thing
 * standing between VNDocumentCameraScan's crop and what gets read. It is 98
 * rather than the 92 it started at because the scanner is the PRIMARY sheet
 * path and was the more compressed of the two — the fallback camera shoots
 * documents at q95 (capture-camera.tsx) — and q92 is where JPEG starts smearing
 * the thin strokes of a handwritten tally, which is the one thing OCR needs
 * intact. A deskewed single sheet is a few MB at q98, nowhere near the edge's
 * 33MB body limit even with the venue photo alongside it. Not 100: that stops
 * buying detail and only costs bytes on Nigerian mobile data.
 */
export async function scanSheet(): Promise<ScanOutcome> {
  if (!DocumentScanner) return { ok: false, reason: 'unavailable' };
  try {
    const res = await DocumentScanner.scanDocument({
      croppedImageQuality: 98,
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
    proven = true; // the module is on the device and works; a later cancel is a real cancel
    return { ok: true, uri: uri.startsWith('file://') ? uri : `file://${uri}` };
  } catch {
    // getStartScanIntent() rejected: the Play services module is absent or
    // could not be fetched — see the failure note at the top of this file.
    return { ok: false, reason: 'failed' };
  }
}

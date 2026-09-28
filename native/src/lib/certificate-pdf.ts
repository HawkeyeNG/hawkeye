/**
 * The certificate as a PDF, made ON THE PHONE with expo-print.
 *
 * EXPO-PRINT IS NEW IN 1.0.9, AND 1.0.8 PHONES RUN THIS JS TOO (OTA updates
 * reach them). expo-print's JS entry calls requireNativeModule('ExpoPrint') the
 * moment it is imported, which THROWS in a binary built without it — a static
 * `import * as Print from 'expo-print'` anywhere in the certificate screen's
 * import graph would crash that screen on every 1.0.8 phone. So:
 *   - nothing imports 'expo-print' statically (tests/certificate_pdf_guard_test.mjs
 *     fails the build if anything does);
 *   - printModule() first asks requireOptionalNativeModule('ExpoPrint'), which
 *     returns null instead of throwing, and only then require()s the package —
 *     Metro bundles it, but its body only RUNS on a binary that has the module;
 *   - canMakePdf() is false on 1.0.8, and the screen hides the button.
 *
 * THE NAME: the HTML (lib/certificate-layout.ts) is rendered by the phone's own
 * print engine under a CSP that forbids every fetch; the PDF is written to this
 * app's cache and handed to the system share sheet (iOS) or print dialog
 * (Android, which offers "Save as PDF"). No network request carries it.
 */
import { requireOptionalNativeModule } from 'expo';
import { File, Paths } from 'expo-file-system';
import { Platform, Share } from 'react-native';

import { type Cert } from '@/lib/certificate';
import { certificateHtml, PDF_PAGE } from '@/lib/certificate-layout';

type PrintModule = {
  printToFileAsync: (o: { html: string; width: number; height: number; margins?: Record<string, number> }) => Promise<{ uri: string }>;
  printAsync: (o: { uri: string }) => Promise<void>;
};

let cached: PrintModule | null | undefined;

/** expo-print, or null on a binary without it (1.0.8). Never throws. */
export function printModule(): PrintModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    if (requireOptionalNativeModule('ExpoPrint')) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('expo-print') as PrintModule;
    }
  } catch {
    cached = null;
  }
  return cached;
}

export const canMakePdf = () => printModule() !== null;

const FILE = 'hawkeye-observer-certificate.pdf';

/**
 * Make the PDF and offer it. Resolves 'shown' when the share sheet / print
 * dialog opened, 'unavailable' on a binary without expo-print, 'failed'
 * otherwise. The caller shows its own message.
 */
export async function shareCertificatePdf(cert: Cert, name: string, lang: string, dialogTitle: string): Promise<'shown' | 'unavailable' | 'failed'> {
  const Print = printModule();
  if (!Print) return 'unavailable';
  try {
    const { uri } = await Print.printToFileAsync({
      html: certificateHtml(cert, name, lang),
      width: PDF_PAGE.width,
      height: PDF_PAGE.height,
      margins: { left: 0, top: 0, right: 0, bottom: 0 },
    });
    // A readable name in the share sheet and the Files app instead of a UUID.
    let out = uri;
    try {
      const dest = new File(Paths.cache, FILE);
      await new File(uri).copy(dest, { overwrite: true });
      out = dest.uri;
    } catch { /* keep the print engine's own file name */ }

    if (Platform.OS === 'ios') {
      // The share sheet: Save to Files, Print, AirDrop, Mail, WhatsApp…
      await Share.share({ url: out }, { subject: dialogTitle });
    } else {
      // React Native's Share cannot send a file on Android. The system print
      // dialog can: its destinations include "Save as PDF" and any printer.
      await Print.printAsync({ uri: out });
    }
    return 'shown';
  } catch {
    return 'failed';
  }
}

/**
 * Apple Vision text recognition, iOS only.
 *
 * The native module is declared `platforms: ["apple"]`, so on Android it does
 * not exist and `available` is false — callers fall back to ML Kit there. The
 * returned shape deliberately matches what the ML Kit binding produces, so the
 * two are interchangeable at the call site.
 */
import { requireOptionalNativeModule } from 'expo';

export type VisionLine = {
  text: string;
  /** Pixels, origin top-left — converted from Vision's bottom-left normalised space. */
  boundingBox: { left: number; right: number; top: number; bottom: number };
};

export type VisionResult = {
  /** Every recognised line, newline separated. */
  text: string;
  blocks: { lines: VisionLine[] }[];
};

type HawkeyeVisionModule = {
  recognize(uri: string): Promise<VisionResult>;
};

// Optional: absent on Android, and absent in Expo Go on iOS (no custom native
// code there), so this must never throw at import time.
const native = requireOptionalNativeModule<HawkeyeVisionModule>('HawkeyeVision');

export const visionAvailable = () => native != null;

export async function recognize(uri: string): Promise<VisionResult | null> {
  if (!native) return null;
  return native.recognize(uri);
}

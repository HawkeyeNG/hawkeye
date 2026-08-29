export interface ScannedImage { path: string; }
export interface ScanDocumentResult { scannedImages: ScannedImage[]; }
export interface TextLine {
  text: string;
  /** Pixels, origin top-left — matching ML Kit and Tesseract, not Vision's own
   *  normalised bottom-left space. */
  boundingBox: { left: number; right: number; top: number; bottom: number };
}
export interface ProcessImageResult { text: string; blocks: { lines: TextLine[] }[]; }
export interface AvailabilityResult { scanner: boolean; ocr: boolean; }
export interface HawkeyeVisionPlugin {
  isAvailable(): Promise<AvailabilityResult>;
  scanDocument(): Promise<ScanDocumentResult>;
  processImage(options: { path: string }): Promise<ProcessImageResult>;
  /** Set the number on the app icon; 0 clears it. iOS only — see the Swift
   *  side for why the badge lives in this plugin rather than a new dependency. */
  setBadge(options: { count: number }): Promise<void>;
}
export declare const HawkeyeVision: HawkeyeVisionPlugin;

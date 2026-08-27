/**
 * Shrink evidence BEFORE it leaves the phone.
 *
 * WHY THIS MATTERS MORE THAN SERVER STORAGE. The server re-encodes incident
 * video to 720p H.264 and gets ~13-20x, but that happens after the bytes have
 * already crossed the observer's mobile data — which they paid for, on election
 * day, on a congested cell at a polling unit. A 30 MB upload at a realistic
 * 1 Mbps uplink is four minutes; four of them is a quarter of an hour, and an
 * upload that long mostly does not finish. Compressing here is what makes the
 * report actually arrive, and it is the observer's airtime we are spending.
 *
 * CAMERA CAPTURE WAS ALREADY DOING THIS; LIBRARY PICKS WERE NOT.
 * capture-camera.tsx has compressed recordings since the dev-build era, but
 * incident.tsx's "attach from library" path sent files exactly as they sat on
 * the phone. Evidence filmed before Hawkeye was opened — which the library path
 * exists to support — went up raw. That is the gap this closes, and both paths
 * now share one implementation instead of two probes that could drift.
 *
 * BOTH DEPENDENCIES ARE PROBED, NEVER IMPORTED AT THE TOP.
 * `react-native-compressor` and `expo-image-manipulator` are native modules:
 * present in a dev/release build, absent in Expo Go. A static import would make
 * the whole screen fail to load there. Probed, they simply no-op — the file is
 * still attached, just uncompressed, which is the correct trade for evidence.
 */

/**
 * ONE PLACE FOR THE MEDIA POLICY.
 *
 * The duration cap used to live in two files that did not know about each
 * other: incident.tsx hard-coded "up to 90s" in a hint, while capture-camera
 * computed `VideoCompressor ? 180 : 90`. So the camera screen promised 90s, the
 * recorder promised 180s, and it really did record 180. Whichever number was
 * right, showing two was the bug — a limit the app contradicts itself about is
 * not a limit.
 *
 * 45s, and it is the SAME number wherever it appears. Seconds rather than
 * megabytes because it is the one an observer can act on while pointing a
 * phone at something.
 *
 * Was briefly 60s. A real 60s recording still came out over the 15 MB limit,
 * so the number is set by what actually fits rather than by what sounds
 * generous.
 */
export const MAX_VIDEO_SECONDS = 45;
export const MAX_VIDEOS = 2;
/**
 * 25 MB, RAISED FROM 15 — because the duration cap has to be the real gate.
 *
 * A 45s recording came in at 15.1 MB and was refused against a 15 MB line: the
 * app stopped the camera at its own limit and then rejected the result, leaving
 * the observer no move at all. The ceiling now sits above what this app can
 * itself produce in 45s (13-16 MB uncompressed, a few MB once re-encoded), so
 * a recording made under the rule always fits.
 *
 * It still bounds a GALLERY file, which carries no such guarantee and can be an
 * hour of 4K — that is the case a size limit exists for. Matches
 * capture-camera's VIDEO_MAX_BYTES and the server's own cap; all three must
 * agree or the strictest one silently becomes the rule.
 */
export const VIDEO_BYTES = 25 * 1024 * 1024;
export const PHOTO_BYTES = 8 * 1024 * 1024;

/**
 * Size of a local file, or null when it cannot be read.
 *
 * NULL IS NOT ZERO AND MUST NOT REJECT. If the size cannot be determined, the
 * attachment goes through — refusing evidence because we failed to measure it
 * would be the worst possible failure mode for this screen.
 */
export async function fileSize(uri: string): Promise<number | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File } = require('expo-file-system') as typeof import('expo-file-system');
    const n = new File(uri).size;
    return typeof n === 'number' && n > 0 ? n : null;
  } catch {
    return null;
  }
}

let VideoCompressor: { compress: (uri: string, opts: object) => Promise<string> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  VideoCompressor = (require('react-native-compressor') as typeof import('react-native-compressor')).Video;
} catch {
  VideoCompressor = null;
}

let ImageManipulator: {
  manipulateAsync: (uri: string, actions: object[], opts?: object) => Promise<{ uri: string }>;
  SaveFormat: { JPEG: string };
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ImageManipulator = require('expo-image-manipulator');
} catch {
  ImageManipulator = null;
}

/** True when this build can actually re-encode video (dev/release, not Expo Go). */
export const canCompressVideo = () => VideoCompressor !== null;

export type CompressOutcome = {
  uri: string;
  /** false when the original came back untouched. */
  compressed: boolean;
  /** why not, when it did not. */
  reason?: 'unavailable' | 'failed' | 'no_smaller';
};

/**
 * Re-encode a video to something an observer can actually upload.
 *
 * NEVER THROWS AND NEVER LOSES THE RECORDING. A failed compression returns the
 * original URI and the report still files — losing a clip someone took during
 * an incident would be the worst possible outcome.
 *
 * BUT IT NO LONGER FAILS QUIETLY, and that distinction cost a day. This used to
 * `catch { return uri }`, so a compression that never happened was
 * indistinguishable from one that did. The consequence was visible only much
 * later, in the admin console: a 45s recording arrived as 13 MB of HEVC instead
 * of a few MB of H.264 — over the size limit AND undecodable in a desktop
 * browser — because the library re-encodes to `video/avc` and it had simply not
 * run. Exactly the same shape as the server's silent remux fallback.
 *
 * On this codebase the compressor is also the ONLY thing producing a
 * browser-playable codec: ffmpeg is absent on the production host, so whatever
 * leaves the phone is what a reviewer has to watch.
 */
export async function compressVideo(uri: string): Promise<CompressOutcome> {
  if (!VideoCompressor) return { uri, compressed: false, reason: 'unavailable' };
  try {
    const out = await VideoCompressor.compress(uri, { compressionMethod: 'auto' });
    if (!out || out === uri) return { uri, compressed: false, reason: 'no_smaller' };
    return { uri: out, compressed: true };
  } catch {
    return { uri, compressed: false, reason: 'failed' };
  }
}

/**
 * Downscale a photo to the same targets the web client uses in
 * `app/app.js:compressCapture`, so a report looks the same size whichever
 * client filed it. 1280 px / q0.72 is the venue-photo setting: incident photos
 * are read for what is happening, not for counting digits off a form.
 *
 * NOT for EC8A result sheets. Those are hashed and signed on the client, so
 * they are compressed before hashing on their own path; re-encoding one here
 * would break content-addressing.
 */
export async function compressImage(uri: string, maxDim = 1280, quality = 0.72): Promise<string> {
  if (!ImageManipulator) return uri;
  try {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: maxDim } }],
      { compress: quality, format: ImageManipulator.SaveFormat.JPEG },
    );
    return out.uri || uri;
  } catch {
    return uri;
  }
}

/** Compress whichever kind this is, reporting whether it actually happened. */
export async function compressMedia(uri: string, type: 'image' | 'video'): Promise<CompressOutcome> {
  if (type === 'video') return compressVideo(uri);
  const out = await compressImage(uri);
  return { uri: out, compressed: out !== uri, reason: out === uri ? 'failed' : undefined };
}

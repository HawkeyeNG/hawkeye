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

/**
 * Re-encode a video to something an observer can actually upload.
 *
 * NEVER THROWS AND NEVER RETURNS NOTHING. A failed compression must not lose
 * the recording — the original URI comes back and the report still files. That
 * rule is copied deliberately from capture-camera.tsx, where losing a clip
 * someone recorded during an incident would be the worst possible outcome.
 */
export async function compressVideo(uri: string): Promise<string> {
  if (!VideoCompressor) return uri;
  try {
    return await VideoCompressor.compress(uri, { compressionMethod: 'auto' });
  } catch {
    return uri;
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

/** Compress whichever kind this is; unknown kinds pass through untouched. */
export async function compressMedia(uri: string, type: 'image' | 'video'): Promise<string> {
  return type === 'video' ? compressVideo(uri) : compressImage(uri);
}

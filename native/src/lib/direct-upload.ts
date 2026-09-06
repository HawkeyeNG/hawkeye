/**
 * Direct-to-bucket uploads — the native twin of app/direct-upload.js.
 *
 * WHY. GO54 counts INBOUND bytes against the 150 GB monthly allowance, and at a
 * measured 369 KB per observer the submission request IS the bandwidth ceiling.
 * When the server offers it, the phone PUTs its photos straight to R2 and the
 * origin handles a few hundred bytes of JSON. See docs/DIRECT-UPLOAD.md.
 *
 * IT ALWAYS DEGRADES TO MULTIPART. Every failure here — proxy mode, a presign
 * refusal, a dead bucket, a flaky link — returns null, and the caller posts
 * multipart exactly as it always has. An observer standing at a polling unit
 * must never lose a report because a storage optimisation was unavailable, and
 * the server accepts multipart in either mode precisely so this can be true.
 *
 * NO CORS HERE. React Native is not a browser, so the bucket's CORS policy is
 * irrelevant to this path — unlike the web client, which is preflighted.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: compute a perceptual hash. A client-side
 * dhash was measured against the server's sharp pipeline and cannot match
 * (0/24 exact over real sheets, median 10 bits apart, threshold 4), so the
 * server computes it from the stored bytes instead, moments later.
 */
import { File } from 'expo-file-system';

const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

export type DirectSlot = { field: string; uri: string };

type PresignSlot = {
  url?: string;
  headers?: Record<string, string>;
  alreadyStored?: boolean;
  key?: string;
};

/** Bytes of a captured photo, read the same way submit.ts reads them. */
async function bytesOf(uri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(uri).arrayBuffer());
}

/**
 * Presign, then PUT both photos to the bucket.
 *
 * @returns true when both photos are in the bucket and the caller should submit
 *   hashes as JSON; null when the caller should fall back to multipart.
 */
export async function uploadDirect(args: {
  token: string;
  deviceId: string;
  sheetUri: string;
  venueUri: string;
  sheetSha256: string;
  venueSha256: string;
}): Promise<true | null> {
  const { token, deviceId, sheetUri, venueUri, sheetSha256, venueSha256 } = args;
  if (!token || !sheetSha256 || !venueSha256) return null;

  let sheetBytes: Uint8Array;
  let venueBytes: Uint8Array;
  try {
    [sheetBytes, venueBytes] = await Promise.all([bytesOf(sheetUri), bytesOf(venueUri)]);
  } catch {
    return null; // unreadable here means unreadable for multipart too; let that path report it
  }

  let plan: { mode?: string; sheet?: PresignSlot; venue?: PresignSlot };
  try {
    const res = await fetch(`${BASE}/api/uploads/presign`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-device-id': deviceId,
        'content-type': 'application/json',
      },
      // The byte counts are signed into the URL, so the bucket refuses a body of
      // any other length. Direct mode would otherwise have no size cap at all,
      // where multipart has multer's 8 MB.
      body: JSON.stringify({
        sheetSha256,
        venueSha256,
        sheetBytes: sheetBytes.length,
        venueBytes: venueBytes.length,
      }),
    });
    // 409 is the server saying "I am in proxy mode" — an answer, not a fault.
    if (res.status === 409 || !res.ok) return null;
    plan = (await res.json()) as typeof plan;
  } catch {
    return null;
  }
  if (!plan || plan.mode !== 'direct') return null;

  try {
    for (const [slot, body] of [
      [plan.sheet, sheetBytes],
      [plan.venue, venueBytes],
    ] as [PresignSlot | undefined, Uint8Array][]) {
      if (!slot) return null;
      // Content-addressed storage: already there means a second upload is a
      // no-op, so skip it and save the observer their mobile data.
      if (slot.alreadyStored) continue;
      if (!slot.url) return null;
      const put = await fetch(slot.url, {
        method: 'PUT',
        headers: slot.headers ?? {},
        // A real Blob, not the Uint8Array: Expo SDK 54+ ships a spec-compliant
        // fetch whose BodyInit does not include typed arrays. Same bytes, same
        // length — and the length is what the signature pins.
        body: new Blob([body as unknown as BlobPart]),
      });
      // The bucket verifies the body against the signed checksum and length, so
      // a rejection here means the bytes are not what we said they were.
      // Falling back is right: the origin will hash them itself and decide.
      if (!put.ok) return null;
    }
  } catch {
    return null;
  }
  return true;
}

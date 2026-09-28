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
 * EXCEPT "BUSY". A presign answered 429 (this observer is rate-limited) or 503
 * (the origin is shedding load) means "not now", not "direct upload is
 * unavailable". Falling back to multipart there pushes the photo bytes THROUGH
 * the origin at exactly the moment it asked for less (ELECTION-NIGHT-HOSTING.md
 * §2.4, the CGNAT finding). That case returns a DirectBusy instead, and the
 * caller parks the signed report in the outbox until Retry-After. 409
 * `direct_upload_disabled` (proxy mode) still falls back, as before.
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

/** Presign refused as 429/503: hold the report, do not post multipart. */
export type DirectBusy = { busy: true; status: number; retryAfter: string | null };

export const isDirectBusy = (x: unknown): x is DirectBusy =>
  !!x && typeof x === 'object' && (x as DirectBusy).busy === true;

/**
 * D1 PHOTO QUORUM: the sheet already holds its quorum of agreeing photo-backed
 * reports for these figures, and `keep` has put both photos somewhere durable
 * on this phone. Nothing was uploaded; submit the hashes as JSON with
 * hashOnly:'1'. The server re-checks the quorum on the SIGNED figures.
 */
export type DirectHashOnly = { hashOnly: true };

export const isHashOnly = (x: unknown): x is DirectHashOnly =>
  !!x && typeof x === 'object' && (x as DirectHashOnly).hashOnly === true;

/** What the presign may be told so it can answer "hash-only" (D1). */
export type ReportFigures = { puCode: string; contest: string; votes: unknown };

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
 * `figures` + `keep` are optional and go together (D1). Given both, the presign
 * carries the figures and may answer "hash-only"; then `keep()` must put both
 * photos somewhere durable on the phone and resolve true, or this asks again
 * WITHOUT the figures and carries on exactly as before.
 *
 * @returns true when both photos are in the bucket and the caller should submit
 *   hashes as JSON; a DirectHashOnly when the photos were kept on the phone and
 *   the caller should submit hashes as JSON with hashOnly:'1'; null when the
 *   caller should fall back to multipart; a DirectBusy when the presign was
 *   refused 429/503 — the caller must NOT post multipart, but queue the report
 *   until `retryAfter` (the Retry-After header, else the body's retryAfterS;
 *   null if neither).
 */
export async function uploadDirect(args: {
  token: string;
  deviceId: string;
  sheetUri: string;
  venueUri: string;
  sheetSha256: string;
  venueSha256: string;
  figures?: ReportFigures;
  keep?: () => Promise<boolean>;
}): Promise<true | null | DirectBusy | DirectHashOnly> {
  const { token, deviceId, sheetUri, venueUri, sheetSha256, venueSha256, figures, keep } = args;
  if (!token || !sheetSha256 || !venueSha256) return null;
  // The figures go only from a caller that can keep the photos.
  const offer = !!(figures && figures.puCode && figures.contest && figures.votes && keep);

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
        ...(offer && figures ? { puCode: figures.puCode, contest: figures.contest, votes: figures.votes } : {}),
      }),
    });
    // 409 is the server saying "I am in proxy mode" — an answer, not a fault.
    if (res.status === 409) return null;
    if (res.status === 429 || res.status === 503) {
      let retryAfter = res.headers.get('retry-after');
      if (!retryAfter) {
        const b = (await res.json().catch(() => null)) as { retryAfterS?: number } | null;
        if (b && b.retryAfterS != null) retryAfter = String(b.retryAfterS);
      }
      return { busy: true, status: res.status, retryAfter };
    }
    if (!res.ok) return null;
    plan = (await res.json()) as typeof plan;
  } catch {
    return null;
  }
  // D1: nothing to upload once the photos are safe on the phone. If they could
  // not be kept, ask again without the figures: the ordinary answer follows.
  if (plan && plan.mode === 'hash-only') {
    const kept = offer && keep ? await keep().catch(() => false) : false;
    if (kept) return { hashOnly: true };
    return uploadDirect({ token, deviceId, sheetUri, venueUri, sheetSha256, venueSha256 });
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

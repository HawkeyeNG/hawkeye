/**
 * Result submission — the native twin of app.js's submit path.
 *
 * canonicalVotes/canonicalPayload MUST stay byte-identical to
 * backend/src/services/signatures.js (and app/app.js): the observer signs the
 * client-built string and the server verifies against its own reconstruction.
 * Same key order, same code-unit sort, plain JSON.stringify.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { File } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import { getIdentity } from '@/lib/identity';

const BASE = 'https://hawkeye.com.ng';

export type Vote = { party: string; count: number };

export type CollationLevel = 'ward' | 'lga' | 'state';

export function canonicalVotes(votes: Vote[]): Vote[] {
  return votes
    .map((v) => ({ party: String(v.party), count: Number(v.count) }))
    .sort((a, b) => (a.party < b.party ? -1 : a.party > b.party ? 1 : 0));
}

export function canonicalPayload(p: {
  puCode: string;
  contest: string;
  votes: Vote[];
  imageSha256: string;
  venueImageSha256: string;
  capturedAt: number;
  venueCapturedAt: number;
  lat: number;
  lng: number;
  sheetLat: number;
  sheetLng: number;
  venueLat: number;
  venueLng: number;
}): string {
  return JSON.stringify({
    puCode: p.puCode,
    contest: p.contest,
    votes: canonicalVotes(p.votes),
    imageSha256: p.imageSha256,
    venueImageSha256: p.venueImageSha256,
    capturedAt: p.capturedAt,
    venueCapturedAt: p.venueCapturedAt,
    lat: p.lat,
    lng: p.lng,
    sheetLat: p.sheetLat,
    sheetLng: p.sheetLng,
    venueLat: p.venueLat,
    venueLng: p.venueLng,
  });
}

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * sha256 of a photo file's bytes, hex — matches the server's sha256Hex(buffer).
 *
 * Reads through expo-file-system, NOT fetch(). On Android, fetch() against a
 * file:// URI rejects with "Network request failed" — which is exactly how this
 * surfaced: the throw happened here, before any upload, and the caller's catch
 * reported a network error for a submission that never left the device.
 */
export async function sha256HexOfFile(uri: string): Promise<string> {
  const buf = await new File(uri).arrayBuffer();
  return toHex(sha256(new Uint8Array(buf)));
}

/**
 * A multipart part that Expo's fetch actually accepts.
 *
 * SDK 54+ replaced RN's FormData handling with a spec-compliant converter
 * (expo/src/winter/fetch/convertFormData.ts). It takes a string, a real Blob,
 * or an object exposing bytes() — and throws "Unsupported FormDataPart
 * implementation" for the legacy React Native {uri, name, type} shape that
 * every older tutorial still teaches. name/type here become the part's
 * filename and content-type headers.
 */
export function filePart(uri: string, name: string, type: string) {
  return {
    name,
    type,
    bytes: async (): Promise<Uint8Array> => new Uint8Array(await new File(uri).arrayBuffer()),
  } as unknown as Blob;
}

/**
 * Collation payload — mirrors backend canonicalCollationPayload.
 * lga/ward fall back to '' (not null/undefined): the server writes
 * `lga: lga || ''`, so a state-level report must sign empty strings or the
 * signature will not reconstruct. Verified byte-identical against the backend
 * function for both a ward-level and a state-level (null lga/ward) case.
 */
export function canonicalCollationPayload(p: {
  level: CollationLevel;
  contest: string;
  state: string;
  lga: string | null;
  ward: string | null;
  votes: Vote[];
  imageSha256: string;
  venueImageSha256: string;
  capturedAt: number;
  venueCapturedAt: number;
  lat: number;
  lng: number;
}): string {
  return JSON.stringify({
    level: p.level,
    contest: p.contest,
    state: p.state,
    lga: p.lga || '',
    ward: p.ward || '',
    votes: canonicalVotes(p.votes),
    imageSha256: p.imageSha256,
    venueImageSha256: p.venueImageSha256,
    capturedAt: p.capturedAt,
    venueCapturedAt: p.venueCapturedAt,
    lat: p.lat,
    lng: p.lng,
  });
}

export type Shot = {
  uri: string;
  capturedAt: number;
  lat: number;
  lng: number;
};

export type SubmitInput = {
  puCode: string;
  contest: string;
  votes: Vote[];
  sheet: Shot;
  venue: Shot;
  /** The submission-time fix taken on the review screen. */
  fix: { lat: number; lng: number; accuracy: number };
  sheetSerial?: string;
};

export type SubmitResult =
  | { ok: true; submissionId?: number }
  | { ok: false; error: string; message: string };

export type CollationInput = {
  level: CollationLevel;
  contest: string;
  state: string;
  lga: string | null;
  ward: string | null;
  votes: Vote[];
  sheet: Shot;
  venue: Shot;
  fix: { lat: number; lng: number; accuracy: number };
  formSerial?: string;
};

/** Human line per backend error code — same tone as the web flow's one-liners. */
const ERRORS: Record<string, string> = {
  internal_error: 'The server rejected the report while saving it. Nothing was recorded.',
  invalid_level: 'Choose whether this is a ward, LGA or state collation.',
  scope_required: 'Select the full scope for this collation level.',
  unknown_scope: 'That scope is not in the register.',
  reporting_not_open: 'Reporting opens on election day — this was a full dry run, nothing was filed.',
  outside_geofence: 'You are too far from this polling unit to report it.',
  too_far_from_unit: 'You are too far from this polling unit to report it.',
  gps_required: 'GPS fix missing — turn location on and retry.',
  gps_accuracy_too_low: 'GPS accuracy is too low — step outside or wait for a better fix.',
  photo_required: 'The result-sheet photo is missing — capture it in the app.',
  venue_photo_required: 'The venue photo is missing or looks identical to the sheet photo.',
  photo_not_fresh: 'Photos are too old — capture them again and submit right away.',
  duplicate_image: 'One of these photos was already used in another report.',
  near_duplicate_image: 'One of these photos looks identical to another report’s photo.',
  already_submitted: 'You already reported this race from this device.',
  device_already_reported_race: 'This device already reported this race.',
  device_too_fast: 'Too soon after the last report from this device — wait a few minutes.',
  unknown_polling_unit: 'That polling unit is not in the register.',
  contest_not_applicable: 'This election does not run at that polling unit.',
  invalid_votes: 'Check the vote counts — whole numbers only, known parties only.',
  bad_signature: 'Could not sign the report on this device — sign out and in, then retry.',
  unknown_contest: 'Select which election you are reporting.',
};

export async function submitResult(input: SubmitInput): Promise<SubmitResult> {
  const id = await getIdentity();
  const token = await SecureStore.getItemAsync('hawkeye.auth.token');
  if (!token) return { ok: false, error: 'not_signed_in', message: 'Sign in first.' };

  // Reading and hashing happen BEFORE the network. Failures here were being
  // reported as "network error" — name the stage so the next failure is
  // diagnosable from the screen instead of by guesswork.
  let imageSha256: string;
  let venueImageSha256: string;
  try {
    imageSha256 = await sha256HexOfFile(input.sheet.uri);
    venueImageSha256 = await sha256HexOfFile(input.venue.uri);
  } catch (e) {
    return {
      ok: false,
      error: 'photo_read_failed',
      message: `Could not read the captured photos — retake them. (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  const payload = canonicalPayload({
    puCode: input.puCode,
    contest: input.contest,
    votes: input.votes,
    imageSha256,
    venueImageSha256,
    capturedAt: input.sheet.capturedAt,
    venueCapturedAt: input.venue.capturedAt,
    lat: input.fix.lat,
    lng: input.fix.lng,
    sheetLat: input.sheet.lat,
    sheetLng: input.sheet.lng,
    venueLat: input.venue.lat,
    venueLng: input.venue.lng,
  });
  const signature = id.sign(payload);

  const form = new FormData();
  form.append('puCode', input.puCode);
  form.append('contest', input.contest);
  form.append('votes', JSON.stringify(canonicalVotes(input.votes)));
  form.append('lat', String(input.fix.lat));
  form.append('lng', String(input.fix.lng));
  form.append('accuracy', String(input.fix.accuracy));
  form.append('capturedAt', String(input.sheet.capturedAt));
  form.append('venueCapturedAt', String(input.venue.capturedAt));
  form.append('sheetLat', String(input.sheet.lat));
  form.append('sheetLng', String(input.sheet.lng));
  form.append('venueLat', String(input.venue.lat));
  form.append('venueLng', String(input.venue.lng));
  form.append('signature', signature);
  if (input.sheetSerial) form.append('sheetSerial', input.sheetSerial);
  form.append('photo', filePart(input.sheet.uri, 'ec8a.jpg', 'image/jpeg'));
  form.append('venuePhoto', filePart(input.venue.uri, 'venue.jpg', 'image/jpeg'));

  try {
    const res = await fetch(`${BASE}/api/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-device-id': id.deviceId },
      body: form,
    });
    if (res.status === 401) {
      return { ok: false, error: 'session_expired', message: 'Session expired — sign in again.' };
    }
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      submissionId?: number;
      error?: string;
      hint?: string;
      distanceM?: number;
      allowedM?: number;
      retryAfterS?: number;
    };
    if (res.ok && body.ok !== false) return { ok: true, submissionId: body.submissionId };
    const code = body.error ?? `http_${res.status}`;
    let message = ERRORS[code] ?? body.hint ?? 'Submission failed — try again.';
    if (code === 'outside_geofence' && body.distanceM) {
      message = `You are ${body.distanceM}m from this unit (allowed: ${body.allowedM}m).`;
    }
    if (code === 'device_too_fast' && body.retryAfterS) {
      message = `Too soon after the last report — retry in ${body.retryAfterS}s.`;
    }
    return { ok: false, error: code, message };
  } catch (e) {
    return {
      ok: false,
      error: 'network',
      message: `Upload failed — your report was NOT sent. Retry. (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * Submit a collation report (ward / LGA / state announcement).
 *
 * Same evidence discipline as a unit result — two in-app photos, GPS and the
 * observer's signature — but scoped to an administrative level rather than a
 * polling unit, so there is no geofence and no per-unit dedupe.
 */
export async function submitCollation(input: CollationInput): Promise<SubmitResult> {
  const id = await getIdentity();
  const token = await SecureStore.getItemAsync('hawkeye.auth.token');
  if (!token) return { ok: false, error: 'not_signed_in', message: 'Sign in first.' };

  let imageSha256: string;
  let venueImageSha256: string;
  try {
    imageSha256 = await sha256HexOfFile(input.sheet.uri);
    venueImageSha256 = await sha256HexOfFile(input.venue.uri);
  } catch (e) {
    return {
      ok: false,
      error: 'photo_read_failed',
      message: `Could not read the captured photos — retake them. (${e instanceof Error ? e.message : String(e)})`,
    };
  }

  const payload = canonicalCollationPayload({
    level: input.level,
    contest: input.contest,
    state: input.state,
    lga: input.lga,
    ward: input.ward,
    votes: input.votes,
    imageSha256,
    venueImageSha256,
    capturedAt: input.sheet.capturedAt,
    venueCapturedAt: input.venue.capturedAt,
    lat: input.fix.lat,
    lng: input.fix.lng,
  });
  const signature = id.sign(payload);

  const form = new FormData();
  form.append('level', input.level);
  form.append('contest', input.contest);
  form.append('state', input.state);
  if (input.lga) form.append('lga', input.lga);
  if (input.ward) form.append('ward', input.ward);
  form.append('votes', JSON.stringify(canonicalVotes(input.votes)));
  form.append('lat', String(input.fix.lat));
  form.append('lng', String(input.fix.lng));
  form.append('accuracy', String(input.fix.accuracy));
  form.append('capturedAt', String(input.sheet.capturedAt));
  form.append('venueCapturedAt', String(input.venue.capturedAt));
  form.append('signature', signature);
  if (input.formSerial) form.append('formSerial', input.formSerial);
  form.append('photo', filePart(input.sheet.uri, 'collation.jpg', 'image/jpeg'));
  form.append('venuePhoto', filePart(input.venue.uri, 'venue.jpg', 'image/jpeg'));

  try {
    const res = await fetch(`${BASE}/api/collations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-device-id': id.deviceId },
      body: form,
    });
    if (res.status === 401) {
      return { ok: false, error: 'session_expired', message: 'Session expired — sign in again.' };
    }
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      id?: number;
      error?: string;
      hint?: string;
    };
    if (res.ok && body.ok !== false) return { ok: true, submissionId: body.id };
    const code = body.error ?? `http_${res.status}`;
    return {
      ok: false,
      error: code,
      // Always append the code + HTTP status. A bare "Submission failed" cost
      // a full device round-trip to diagnose; the screen must name the fault.
      message: `${ERRORS[code] ?? body.hint ?? 'Submission failed — try again.'} (${code} / HTTP ${res.status})`,
    };
  } catch (e) {
    return {
      ok: false,
      error: 'network',
      message: `Upload failed — your report was NOT sent. Retry. (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

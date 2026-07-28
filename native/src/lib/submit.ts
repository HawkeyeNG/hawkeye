/**
 * Result submission — the native twin of app.js's submit path.
 *
 * canonicalVotes/canonicalPayload MUST stay byte-identical to
 * backend/src/services/signatures.js (and app/app.js): the observer signs the
 * client-built string and the server verifies against its own reconstruction.
 * Same key order, same code-unit sort, plain JSON.stringify.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import { getIdentity } from '@/lib/identity';
import * as SecureStore from 'expo-secure-store';

const BASE = 'https://hawkeye.com.ng';

export type Vote = { party: string; count: number };

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

/** sha256 of a photo file's bytes, hex — matches the server's sha256Hex(buffer). */
export async function sha256HexOfFile(uri: string): Promise<string> {
  const res = await fetch(uri);
  const buf = await res.arrayBuffer();
  return toHex(sha256(new Uint8Array(buf)));
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

/** Human line per backend error code — same tone as the web flow's one-liners. */
const ERRORS: Record<string, string> = {
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

  const imageSha256 = await sha256HexOfFile(input.sheet.uri);
  const venueImageSha256 = await sha256HexOfFile(input.venue.uri);

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
  // RN FormData file entries: {uri, name, type}
  form.append('photo', { uri: input.sheet.uri, name: 'ec8a.jpg', type: 'image/jpeg' } as unknown as Blob);
  form.append('venuePhoto', { uri: input.venue.uri, name: 'venue.jpg', type: 'image/jpeg' } as unknown as Blob);

  try {
    const res = await fetch(`${BASE}/api/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-device-id': id.deviceId },
      body: form,
    });
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
  } catch {
    return { ok: false, error: 'network', message: 'Network error — your report was NOT sent. Retry.' };
  }
}

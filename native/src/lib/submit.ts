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
import * as SecureStore from '@/lib/secure-store';

import { bootstrapAuth } from '@/lib/auth';
import { confirmSigning } from '@/lib/biometric';
import { getIdentity } from '@/lib/identity';
// TYPE-ONLY, so this edge is erased at compile time and creates no runtime
// require cycle. outbox.ts legitimately imports filePart/remintSession from
// here; this file needed queueJob back, and the pair warned on every Metro
// start ("Require cycles are allowed, but can result in uninitialized values").
// The value import moved to the single call site below, as a dynamic import.
import type { JobFile } from '@/lib/outbox';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const K_TOKEN = 'hawkeye.auth.token';

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
  /**
   * This send is a REHEARSAL — the contest has not opened yet, the observer was
   * told so, and the point is to walk the whole flow and have the server refuse
   * it with `reporting_not_open`.
   *
   * It changes exactly one thing: an undelivered dry run is discarded instead of
   * being handed to the outbox. See `park()` below for why that matters.
   */
  dryRun?: boolean;
};

/**
 * The unit's aggregate as the server recomputed it with this report included —
 * how many other observers agree, and how well the location holds up.
 */
export type ResultSummary = {
  status?: string;
  confidence?: number;
  matchingReports?: number;
  totalReports?: number;
  locationStatus?: string;
  locationConfidence?: number;
  locationPlausibility?: 'consistent' | 'inconsistent' | null;
  locationScore?: number;
  venueMatches?: number;
  disputed?: boolean;
  votes?: Vote[];
  scope?: string;
};

/**
 * What the server hands back on a successful submission.
 *
 * All of this used to be parsed and thrown away. The entry hash is the
 * observer's receipt — the only handle that finds their own report in the
 * public ledger afterwards — and the agreement figures are what let the done
 * screen say something truer than "submitted".
 *
 * The aggregate is spread flat AND kept whole under `result`: a receipt card
 * reads `r.status`, anything that wants the server's object untouched reads
 * `r.result`.
 */
export type Receipt = ResultSummary & {
  entryHash?: string;
  locationVerified?: boolean;
  ocr?: { matched: number; total: number } | null;
  result?: ResultSummary | null;
  /** Set on the placeholder receipt for a report still sitting in the outbox. */
  queued?: boolean;
};

export type SubmitResult =
  | ({ ok: true; queued?: false; submissionId?: number } & Receipt)
  /**
   * Held in the offline outbox — captured, signed and safe on disk, just not
   * delivered yet. Deliberately NOT ok:true: a screen that has not been taught
   * about the queue would otherwise tell the observer their report is on the
   * public ledger while it is still sitting on the phone. As ok:false the worst
   * an untaught screen does is show `message`, which is honest either way.
   */
  | { ok: false; queued: true; error: 'queued_offline'; message: string }
  | { ok: false; queued?: false; error: string; message: string };

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
  /** Rehearsal before election day — see SubmitInput.dryRun. */
  dryRun?: boolean;
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Recover a session the server has just rejected, without signing anyone out.
 *
 * bootstrapAuth returns the STORED token first, so clearing it is precisely
 * what makes it fall through to the silent device-resume that mints a new one.
 * Not signOut(): that also sets the opted-out flag, which suppresses the resume
 * entirely and would strand a signed-in observer holding a signed report.
 *
 * Returns the fresh token, or null if the device could not be resumed.
 */
export async function remintSession(): Promise<string | null> {
  const stale = await SecureStore.getItemAsync(K_TOKEN);
  await SecureStore.deleteItemAsync(K_TOKEN);
  await bootstrapAuth();
  const fresh = await SecureStore.getItemAsync(K_TOKEN);
  return fresh && fresh !== stale ? fresh : null;
}

/**
 * POST a report with one silent session recovery.
 *
 * The form is rebuilt per attempt: a FormData whose file parts have already
 * been streamed cannot be replayed, so reusing it makes the retry throw
 * instantly and hides the 401 that caused it.
 */
async function deliver(
  path: string,
  buildForm: () => FormData,
  token: string,
  deviceId: string,
): Promise<Response> {
  const go = (t: string) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, 'x-device-id': deviceId },
      body: buildForm(),
    });
  const res = await go(token);
  if (res.status !== 401) return res;
  // A session can expire between opening the app at dawn and the close of poll.
  // The report is already signed and still valid — re-mint and retry once
  // rather than making the observer sign in with the sheet already gone.
  const fresh = await remintSession();
  return fresh ? go(fresh) : res;
}

/**
 * Hand a signed report to the offline outbox.
 *
 * Everything retryable ends up here. The photos, the GPS fix and the signature
 * cannot be reproduced once the observer walks away from the unit, and the
 * server dedupes the resend on image hash — so keeping it costs nothing and
 * discarding it costs the report.
 */
async function handOff(
  kind: 'result' | 'collation',
  body: Record<string, string>,
  files: JobFile[],
  label: string,
  why: string,
  lead = 'Saved on this phone — your signed report will send itself as soon as the network allows.',
): Promise<SubmitResult> {
  try {
    // Resolved here rather than at module load: see the import note at the top.
    const { queueJob } = await import('@/lib/outbox');
    await queueJob({ kind, body, files, label });
    return {
      ok: false,
      queued: true,
      error: 'queued_offline',
      message: `${lead} (${why})`,
    };
  } catch (e) {
    return {
      ok: false,
      error: 'queue_failed',
      message: `Upload failed and the report could not be saved — stay on this screen and retry. (${why} / ${errText(e)})`,
    };
  }
}

/**
 * The other end of `handOff` — what an UNDELIVERED DRY RUN becomes.
 *
 * A rehearsal must leave nothing behind. Queuing one would put a report the
 * observer never filed into the pending count, keep re-offering it, and
 * eventually land it in the dropped list with a refusal the observer cannot
 * explain. (It could not become a real filing — the server's poll-open gate runs
 * before anything is written, and by election day the photos are long past
 * `photoMaxAgeS` — but "harmless" is not the standard for a report the observer
 * did not make.) So a dry run that never reached the server is simply a dry run
 * that did not happen: nothing saved, nothing queued, retry when there is
 * signal.
 */
const undeliveredDryRun = (why: string): SubmitResult => ({
  ok: false,
  error: 'dry_run_undelivered',
  message: `The practice run could not reach the server, so there was nothing to rehearse — nothing was saved, queued or filed. Retry when you have signal. (${why})`,
});

export async function submitResult(input: SubmitInput): Promise<SubmitResult> {
  const id = await getIdentity();
  const token = await SecureStore.getItemAsync(K_TOKEN);
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
      message: `Could not read the captured photos — retake them. (${errText(e)})`,
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
  /**
   * THE ONE MOMENT THE KEY IS EXERCISED FOR A REPORT THAT CAN REACH THE LEDGER.
   *
   * Gated here rather than at app launch because this is the action worth
   * protecting: the signature is what gives a report its weight, and an unlocked
   * phone in someone else's hands can otherwise produce one. Off by default and
   * opt-in from Profile; see lib/biometric.ts for why it guards the action and
   * never the key at rest.
   *
   * REHEARSALS ARE EXEMPT. A dry run signs, but the server refuses it and it is
   * discarded rather than queued, so it can never reach the ledger — and
   * practice is the flow we most want people repeating. Friction belongs on the
   * real thing, not the rehearsal.
   *
   * Placed AFTER the photo hashing so a failure to read the photos does not
   * prompt the observer for nothing.
   */
  if (!input.dryRun && (await confirmSigning()) === 'cancelled') {
    return {
      ok: false,
      error: 'signing_cancelled',
      message: 'Not signed, so nothing was filed. Your photos and figures are still here — try again.',
    };
  }
  const signature = id.sign(payload);

  // Fields and files kept apart from the FormData: the same pair feeds a live
  // attempt and, if that fails, the outbox job that replays it later.
  const fields: Record<string, string> = {
    puCode: input.puCode,
    contest: input.contest,
    votes: JSON.stringify(canonicalVotes(input.votes)),
    lat: String(input.fix.lat),
    lng: String(input.fix.lng),
    accuracy: String(input.fix.accuracy),
    capturedAt: String(input.sheet.capturedAt),
    venueCapturedAt: String(input.venue.capturedAt),
    sheetLat: String(input.sheet.lat),
    sheetLng: String(input.sheet.lng),
    venueLat: String(input.venue.lat),
    venueLng: String(input.venue.lng),
    signature,
    ...(input.sheetSerial ? { sheetSerial: input.sheetSerial } : {}),
  };
  // The outbox copies these files verbatim, so the hashes above — and therefore
  // the signature — still describe the bytes that eventually reach the server.
  const files: JobFile[] = [
    { field: 'photo', uri: input.sheet.uri, name: 'ec8a.jpg', type: 'image/jpeg' },
    { field: 'venuePhoto', uri: input.venue.uri, name: 'venue.jpg', type: 'image/jpeg' },
  ];
  const buildForm = () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append(f.field, filePart(f.uri, f.name, f.type));
    return form;
  };
  const label = `Result · ${input.puCode} · ${input.contest}`;

  /** Outbox for a real report, nothing at all for a rehearsal. */
  const park = (why: string, lead?: string): SubmitResult | Promise<SubmitResult> =>
    input.dryRun ? undeliveredDryRun(why) : handOff('result', fields, files, label, why, lead);

  let res: Response;
  try {
    res = await deliver('/api/submissions', buildForm, token, id.deviceId);
  } catch (e) {
    return park(`network: ${errText(e)}`);
  }

  // Still 401 after deliver() tried to re-mint the session. Queue it anyway:
  // bootstrapAuth has just flipped the auth store to signed-out, which swaps
  // this screen for the sign-in guard and takes the photos with it. The job is
  // signed and complete, and the outbox waits for a token before each attempt.
  if (res.status === 401) {
    return park(
      'session expired / HTTP 401',
      'Signed out — your signed report is saved on this phone and will send itself once you sign in again.',
    );
  }
  // The report is fine, the server is not. Exactly the class the outbox retries,
  // so queue it instead of making the observer stand at the unit and retry.
  if (res.status >= 500 || res.status === 429) {
    return park(`HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    submissionId?: number;
    error?: string;
    hint?: string;
    distanceM?: number;
    allowedM?: number;
    retryAfterS?: number;
  } & Receipt;
  if (res.ok && body.ok !== false) {
    return {
      ok: true,
      ...(body.result ?? {}),
      submissionId: body.submissionId,
      entryHash: body.entryHash,
      locationVerified: body.locationVerified,
      ocr: body.ocr,
      result: body.result,
    };
  }
  const code = body.error ?? `http_${res.status}`;
  let message = ERRORS[code] ?? body.hint ?? 'Submission failed — try again.';
  if (code === 'outside_geofence' && body.distanceM) {
    message = `You are ${body.distanceM}m from this unit (allowed: ${body.allowedM}m).`;
  }
  if (code === 'device_too_fast' && body.retryAfterS) {
    message = `Too soon after the last report — retry in ${body.retryAfterS}s.`;
  }
  return { ok: false, error: code, message: `${message} (${code} / HTTP ${res.status})` };
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
  const token = await SecureStore.getItemAsync(K_TOKEN);
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
      message: `Could not read the captured photos — retake them. (${errText(e)})`,
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

  const fields: Record<string, string> = {
    level: input.level,
    contest: input.contest,
    state: input.state,
    ...(input.lga ? { lga: input.lga } : {}),
    ...(input.ward ? { ward: input.ward } : {}),
    votes: JSON.stringify(canonicalVotes(input.votes)),
    lat: String(input.fix.lat),
    lng: String(input.fix.lng),
    accuracy: String(input.fix.accuracy),
    capturedAt: String(input.sheet.capturedAt),
    venueCapturedAt: String(input.venue.capturedAt),
    signature,
    ...(input.formSerial ? { formSerial: input.formSerial } : {}),
  };
  const files: JobFile[] = [
    { field: 'photo', uri: input.sheet.uri, name: 'collation.jpg', type: 'image/jpeg' },
    { field: 'venuePhoto', uri: input.venue.uri, name: 'venue.jpg', type: 'image/jpeg' },
  ];
  const buildForm = () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append(f.field, filePart(f.uri, f.name, f.type));
    return form;
  };
  const label = `${input.level} collation · ${input.ward || input.lga || input.state} · ${input.contest}`;

  /** Outbox for a real report, nothing at all for a rehearsal. */
  const park = (why: string, lead?: string): SubmitResult | Promise<SubmitResult> =>
    input.dryRun ? undeliveredDryRun(why) : handOff('collation', fields, files, label, why, lead);

  let res: Response;
  try {
    res = await deliver('/api/collations', buildForm, token, id.deviceId);
  } catch (e) {
    return park(`network: ${errText(e)}`);
  }

  if (res.status === 401) {
    return park(
      'session expired / HTTP 401',
      'Signed out — your signed report is saved on this phone and will send itself once you sign in again.',
    );
  }
  if (res.status >= 500 || res.status === 429) {
    return park(`HTTP ${res.status}`);
  }

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    id?: number;
    error?: string;
    hint?: string;
  } & Receipt;
  if (res.ok && body.ok !== false) {
    return { ok: true, submissionId: body.id, entryHash: body.entryHash };
  }
  const code = body.error ?? `http_${res.status}`;
  return {
    ok: false,
    error: code,
    // Always append the code + HTTP status. A bare "Submission failed" cost
    // a full device round-trip to diagnose; the screen must name the fault.
    message: `${ERRORS[code] ?? body.hint ?? 'Submission failed — try again.'} (${code} / HTTP ${res.status})`,
  };
}

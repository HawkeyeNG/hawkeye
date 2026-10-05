/**
 * Offline outbox for signed reports — the native twin of app/outbox.js.
 *
 * A report is compressed, hashed and SIGNED on the device before it is ever
 * sent, and by the time an upload fails the sheet is usually back in the
 * presiding officer's hands. Native used to throw all of that away on the first
 * failed POST: a dead network cost the observer two photos, a GPS fix and a
 * signature that cannot be recreated. Jobs are persisted here instead and
 * flushed when connectivity returns.
 *
 * Two properties make the replay safe:
 *  - The server dedupes on image hash and one-report-per-device-per-race, so a
 *    resend either lands (2xx) or comes back 409 — both mean the server has it,
 *    and both retire the job.
 *  - The signature covers the exact bytes queued, so it stays valid however
 *    long the job waits.
 *
 * The evidence is COPIED into the document directory at queue time. The camera
 * writes into the cache directory, which Android reclaims under storage
 * pressure — the one place a report must never be stored is the one the OS is
 * allowed to empty while it waits for signal.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from '@/lib/secure-store';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { getIdentity } from '@/lib/identity';
// Cyclic with submit.ts by design: submit queues jobs, the outbox replays them
// with submit's multipart + session helpers. Both directions are function calls
// made at runtime, never at module-evaluation time, so the cycle resolves.
import { filePart, remintSession } from '@/lib/submit';
import { isDirectBusy, isHashOnly, uploadDirect, type DirectBusy } from '@/lib/direct-upload';
import { keepEvidence } from '@/lib/evidence';
import { t as i18nT } from '@/lib/i18n';
import { holdsQueue, retryAfterOf, retryDelayMs, retryableStatus } from '@/lib/retry';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const K_TOKEN = 'hawkeye.auth.token';
const K_JOBS = 'hawkeye.outbox.jobs.v1';
const K_DROPPED = 'hawkeye.outbox.dropped.v1';

export type JobKind = 'result' | 'collation' | 'incident';

/** One multipart file part: `field` is the server's form key, `name`/`type` the part headers. */
export type JobFile = { field: string; uri: string; name: string; type: string };

export type Job = {
  kind: JobKind;
  body: unknown;
  files: JobFile[];
  /** Human line for a queue list — "Result · 12-04-08-003 · PRES". */
  label: string;
  /** Epoch ms the server asked us to wait until (Retry-After + jitter). */
  notBefore?: number;
};

type StoredJob = {
  id: string;
  kind: JobKind;
  /** Non-file form fields, already flattened to the strings FormData accepts. */
  body: Record<string, string>;
  /** URIs point into the durable outbox directory, not the camera cache. */
  files: JobFile[];
  label: string;
  queuedAt: number;
  attempts: number;
  /** Epoch ms before which a flush skips this job. */
  nextAttemptAt: number;
  /**
   * Epoch ms before which the SERVER asked us not to retry (a 429/503, with its
   * Retry-After when it sent one). Unlike nextAttemptAt, a reconnect does not
   * reset this: the phone regaining signal is no news about a busy origin.
   */
  notBefore?: number;
  lastError?: string;
};

export type DroppedJob = {
  kind: JobKind;
  label: string;
  queuedAt: number;
  droppedAt: number;
  /** Why the server refused it, for the one person who will ask. */
  why: string;
};

const PATHS: Record<JobKind, string> = {
  result: '/api/submissions',
  collation: '/api/collations',
  incident: '/api/incidents',
};

/*
 * Backoff: lib/retry.ts BACKOFF_MS — ceilings of 30s, 2m, 8m, then 30m forever,
 * now with full jitter, and the server's Retry-After (+0–50%) when it sends
 * one. Never a permanent give-up on 5xx: on election day the backend can be
 * down for hours, and the report is the only copy.
 */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// -- store --------------------------------------------------------------------

export type OutboxState = {
  pending: number;
  sending: boolean;
  /** Reports the server refused outright — they are gone, and someone should know. */
  dropped: number;
  lastError: string | null;
};

let snapshot: OutboxState = { pending: 0, sending: false, dropped: 0, lastError: null };
const listeners = new Set<() => void>();

function publish(next: Partial<OutboxState>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

/** Reports queued or being sent: an OTA reload waits (lib/fresh-updates.ts). */
export function outboxBusy(): boolean {
  return snapshot.pending > 0 || snapshot.sending;
}

/** Subscribe a screen to the queue depth — same store idiom as useAuth(). */
export function useOutbox(): OutboxState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot, // server snapshot, web export only — see lib/auth.ts useAuth()
  );
}

// -- persistence --------------------------------------------------------------

let jobs: StoredJob[] = [];
let loaded: Promise<void> | null = null;

function outboxDir(...parts: string[]) {
  return new Directory(Paths.document, 'outbox', ...parts);
}

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const raw = await AsyncStorage.getItem(K_JOBS);
        jobs = raw ? (JSON.parse(raw) as StoredJob[]) : [];
      } catch {
        jobs = []; // a corrupt index must not brick the app on launch
      }
      let dropped = 0;
      try {
        dropped = JSON.parse((await AsyncStorage.getItem(K_DROPPED)) || '[]').length;
      } catch {
        dropped = 0;
      }
      publish({ pending: jobs.length, dropped });
      pruneOrphans();
    })();
  }
  return loaded;
}

// Writes are serialised: two jobs queued back to back would otherwise both
// stringify the array they were each appended to, and the second would win.
let writing: Promise<void> = Promise.resolve();

/**
 * Rejects if the index could not be written. queueJob depends on that: telling
 * an observer their report is safe when nothing reached disk is worse than
 * telling them the upload failed.
 */
function persist(): Promise<void> {
  const write = writing.then(() => AsyncStorage.setItem(K_JOBS, JSON.stringify(jobs)));
  // The chain itself must survive a failed write, or every later write is
  // poisoned by it.
  writing = write.then(
    () => undefined,
    () => undefined,
  );
  publish({ pending: jobs.length });
  return write.then(() => undefined);
}

/**
 * Delete media directories with no job behind them — the residue of a crash
 * between copying the evidence and writing the index. Bounded by design: media
 * lands in the document directory, which nothing else ever clears.
 */
function pruneOrphans() {
  try {
    const root = outboxDir();
    if (!root.exists) return;
    const live = new Set(jobs.map((j) => j.id));
    for (const entry of root.list()) {
      if (entry instanceof Directory && !live.has(entry.name)) entry.delete();
    }
  } catch {
    // Housekeeping only — never let it take the queue down with it.
  }
}

/**
 * Copy the evidence somewhere the OS will not reclaim.
 *
 * The on-disk name is index-prefixed so two parts called photo.jpg cannot
 * collide; the filename the SERVER sees still comes from `JobFile.name`.
 */
async function stash(id: string, files: JobFile[]): Promise<JobFile[]> {
  // Built INSIDE the try: where there is no document directory at all (the
  // react-native-web build the audits drive) the constructor itself throws,
  // and that used to reject the whole queueJob — "nothing was saved" for a
  // report the index could still have held.
  let dir: Directory;
  try {
    dir = outboxDir(id);
    dir.create({ intermediates: true, idempotent: true });
  } catch {
    return files; // no durable copy possible — the cache URI is better than nothing
  }
  return Promise.all(
    files.map(async (f, i) => {
      try {
        const dest = new File(dir, `${i}-${f.name}`);
        await new File(f.uri).copy(dest, { overwrite: true });
        return { ...f, uri: dest.uri };
      } catch {
        return f;
      }
    }),
  );
}

/** FormData only takes strings; anything structured the caller passed is JSON-encoded. */
function fields(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

// -- queue --------------------------------------------------------------------

/**
 * Persist a report that could not be delivered. Resolves once it is safely on
 * disk, so a caller may navigate away the moment it returns.
 */
export async function queueJob(job: Job): Promise<void> {
  await load();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Copy the media BEFORE indexing the job: a crash between the two leaves an
  // orphan directory (pruned on next load), never a job whose evidence is gone.
  const files = await stash(id, job.files);
  jobs.push({
    id,
    kind: job.kind,
    body: fields(job.body),
    files,
    label: job.label,
    queuedAt: Date.now(),
    attempts: 0,
    // First retry: jittered within the first backoff ceiling, and never before
    // the server's own Retry-After when the submit was refused as busy.
    nextAttemptAt: Math.max(Date.now() + retryDelayMs(0, null, 0), job.notBefore ?? 0),
    ...(job.notBefore ? { notBefore: job.notBefore } : {}),
  });
  await persist();
}

/** Queue contents for a "waiting to send" list. */
export async function listQueued(): Promise<
  { label: string; kind: JobKind; queuedAt: number; attempts: number; lastError?: string }[]
> {
  await load();
  return jobs.map((j) => ({
    label: j.label,
    kind: j.kind,
    queuedAt: j.queuedAt,
    attempts: j.attempts,
    lastError: j.lastError,
  }));
}

/** Reports the server refused permanently, with the reason it gave. */
export async function listDropped(): Promise<DroppedJob[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(K_DROPPED)) || '[]') as DroppedJob[];
  } catch {
    return [];
  }
}

async function recordDrop(job: StoredJob, why: string) {
  try {
    const all = [
      { kind: job.kind, label: job.label, queuedAt: job.queuedAt, droppedAt: Date.now(), why },
      ...(await listDropped()),
    ].slice(0, 20);
    await AsyncStorage.setItem(K_DROPPED, JSON.stringify(all));
    publish({ dropped: all.length });
  } catch {
    // The drop itself already happened; failing to log it changes nothing.
  }
}

/** Retire a job: forget it and release its media. */
async function retire(job: StoredJob) {
  jobs = jobs.filter((j) => j.id !== job.id);
  try {
    const dir = outboxDir(job.id);
    if (dir.exists) dir.delete();
  } catch {
    // Orphan directory at worst — pruneOrphans() clears it on the next launch.
  }
  // A failed write here just means the job is offered again and comes back 409,
  // which retires it properly. Not worth aborting the rest of the flush for.
  await persist().catch(() => undefined);
}

/**
 * Keep a job and push its next attempt out: the server's Retry-After (+0–50%)
 * for a 429/503 that sent one, otherwise full jitter under the backoff ceiling
 * for this attempt. `status` 0 = no response (network).
 */
function defer(job: StoredJob, why: string, status = 0, retryAfter: string | null = null) {
  job.attempts += 1;
  job.lastError = why;
  job.nextAttemptAt = Date.now() + retryDelayMs(status, retryAfter, job.attempts);
  // A busy server is not the network: a reconnect must not bring this forward.
  if (holdsQueue(status)) job.notBefore = job.nextAttemptAt;
  publish({ lastError: why });
  void persist().catch(() => undefined);
}

/**
 * The server said busy (429/503): hold EVERY job still queued, not just the one
 * that asked — each with its own jitter, so the queue does not return as one
 * burst either. Only `first` counts it as a failed attempt.
 */
function holdQueue(first: StoredJob, why: string, status: number, retryAfter: string | null) {
  for (const j of jobs) {
    if (j === first) continue;
    const at = Date.now() + retryDelayMs(status, retryAfter, j.attempts);
    j.nextAttemptAt = Math.max(j.nextAttemptAt, at);
    j.notBefore = Math.max(j.notBefore ?? 0, at);
  }
  defer(first, why, status, retryAfter); // persists the lot
}

// -- flush --------------------------------------------------------------------

/**
 * A FormData carrying file parts cannot be replayed — on Android the parts of a
 * body that has already been streamed are spent, so a retry throws instantly
 * and masks the original error. Every attempt gets a brand new one.
 */
function buildForm(job: StoredJob): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(job.body)) form.append(k, v);
  for (const f of job.files) form.append(f.field, filePart(f.uri, f.name, f.type));
  return form;
}

async function attempt(
  job: StoredJob,
  token: string,
  deviceId: string,
  withFigures: boolean,
): Promise<{ res: Response | DirectBusy; hashOnly: boolean }> {
  // The mode is decided HERE, not when the report was queued. A report captured
  // with no signal and flushed hours later should use whatever the server
  // offers now, and a job queued before direct upload existed still flushes
  // because it carries its files either way.
  let json: string | null = null;
  let hashOnly = false;
  const sheet = job.files.find((f) => f.field === 'photo');
  const venue = job.files.find((f) => f.field === 'venuePhoto');
  const b = job.body;
  if (job.kind === 'result' && sheet && venue && b.imageSha256 && b.venueImageSha256) {
    const ok = await uploadDirect({
      token,
      deviceId,
      sheetUri: sheet.uri,
      venueUri: venue.uri,
      sheetSha256: b.imageSha256,
      venueSha256: b.venueImageSha256,
      // D1: offer the figures; on "hash-only" the photos are copied into the
      // evidence store (lib/evidence.ts) before the job's own copy is retired.
      ...(withFigures && b.puCode && b.contest && b.votes
        ? {
            figures: { puCode: b.puCode, contest: b.contest, votes: b.votes },
            keep: () =>
              keepEvidence({
                puCode: b.puCode,
                contest: b.contest,
                photos: [
                  { slot: 'sheet' as const, uri: sheet.uri, sha256: b.imageSha256 },
                  { slot: 'venue' as const, uri: venue.uri, sha256: b.venueImageSha256 },
                ],
              }),
          }
        : {}),
    }).catch(() => null);
    // Presign refused as busy: hand that back rather than post the photos
    // multipart THROUGH the origin that just asked for less.
    if (isDirectBusy(ok)) return { res: ok, hashOnly: false };
    if (ok === true) json = JSON.stringify(b);
    else if (isHashOnly(ok)) {
      hashOnly = true;
      json = JSON.stringify({ ...b, hashOnly: '1' });
    }
  }
  const res = await fetch(`${BASE}${PATHS[job.kind]}`, {
    method: 'POST',
    headers: json
      ? { authorization: `Bearer ${token}`, 'x-device-id': deviceId, 'content-type': 'application/json' }
      : { authorization: `Bearer ${token}`, 'x-device-id': deviceId },
    body: json ?? buildForm(job),
  });
  return { res, hashOnly };
}

async function post(job: StoredJob, token: string, deviceId: string): Promise<Response | DirectBusy> {
  const first = await attempt(job, token, deviceId, true);
  // D1: the quorum moved since the presign. The photos are still in the job:
  // upload them the ordinary way and resend now, once, instead of deferring
  // to a later flush that could hear "hash-only" again.
  if (first.hashOnly && !isDirectBusy(first.res) && first.res.status === 409 && (await isRetryable409(first.res))) {
    return (await attempt(job, token, deviceId, false)).res;
  }
  return first.res;
}

/** Can the device still read this part? A copy that was evicted anyway is unsendable. */
function readable(f: JobFile): boolean {
  try {
    return new File(f.uri).exists;
  } catch {
    return true; // exotic URI scheme — let the upload be the judge
  }
}

/**
 * Is this 409 the retryable kind?
 *
 * Reads a CLONE: refusal() below may read the same response, and a body can
 * only be consumed once — draining it here would make the drop reason
 * unreadable and, worse, do it silently.
 */
async function isRetryable409(res: Response): Promise<boolean> {
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string };
  return body.error === 'photo_not_uploaded' || body.error === 'storage_unavailable';
}

/** The server's own words for a permanent refusal, so the drop is explicable. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  return `${body.hint ?? body.error ?? 'refused'} (${body.error ?? 'no code'} / HTTP ${res.status})`;
}

let sending = false;
let online = true;

/**
 * Try to deliver everything due. Never throws, never runs twice at once.
 *
 * Retry rules are app/outbox.js's: 2xx or 409 retires the job (the server has
 * it either way); 429 and 503 — the server or this observer over a limit — hold
 * the WHOLE queue until Retry-After (+ jitter) and stop the flush; other 5xx,
 * 408 and 425 stay queued with a jittered backoff; any other 4xx is unfixable
 * by retrying and is dropped with its reason.
 *
 * `ignoreBackoff` is for a genuine connectivity change: the backoff exists to
 * stop us hammering a network that is down, and a reconnect is precisely the
 * news that says it isn't. It never overrides a server's `notBefore`.
 */
export async function flushOutbox(opts: { ignoreBackoff?: boolean } = {}): Promise<{ sent: number }> {
  if (sending) return { sent: 0 };
  await load();
  if (!jobs.length) return { sent: 0 };
  if (opts.ignoreBackoff) {
    for (const job of jobs) job.nextAttemptAt = (job.notBefore ?? 0) > Date.now() ? job.notBefore! : 0;
  }

  sending = true;
  publish({ sending: true });
  let sent = 0;
  let reminted = false;
  try {
    const id = await getIdentity();
    for (const job of [...jobs]) {
      if (Math.max(job.nextAttemptAt, job.notBefore ?? 0) > Date.now()) continue;

      // A job whose photos are gone throws on every read, which the loop below
      // reads as "still offline" — it would sit at the head of the queue
      // blocking every intact report behind it. Retire it instead, loudly.
      if (!job.files.every(readable)) {
        const why = 'the photos are no longer on this device';
        await retire(job);
        await recordDrop(job, why);
        publish({ lastError: i18nT('n.lib.outbox.a-queued-report-was-dropped', { v0: why }) });
        continue;
      }

      const token = await SecureStore.getItemAsync(K_TOKEN);
      if (!token) break; // signed out — nothing to send with, and the job is still good

      let res: Response | DirectBusy;
      try {
        res = await post(job, token, id.deviceId);
      } catch (e) {
        // Still offline. Stop rather than march through the queue: every
        // attempt re-reads megabytes of photos off disk to fail the same way.
        defer(job, `network: ${msg(e)}`);
        break;
      }

      if (res.status === 401 && !reminted) {
        // The session died while the report waited. Re-mint silently — an
        // observer should not have to sign in to release evidence they already
        // signed. Once per flush; a second 401 means the device is unbound.
        reminted = true;
        const fresh = await remintSession();
        if (!fresh) {
          defer(job, 'session expired (HTTP 401)');
          break;
        }
        try {
          res = await post(job, fresh, id.deviceId);
        } catch (e) {
          defer(job, `network: ${msg(e)}`);
          break;
        }
      }

      // Presign refused as busy (429/503): nothing was posted. Hold the queue.
      if (isDirectBusy(res)) {
        holdQueue(job, `server busy (HTTP ${res.status})`, res.status, res.retryAfter);
        break;
      }

      // 409 USED TO MEAN "the server already has it" — already_submitted or
      // duplicate_image — so retiring the job was right. Direct upload adds a
      // 409 that means the OPPOSITE: photo_not_uploaded, i.e. the bucket does
      // not have the photos yet. Retiring on that would delete a signed report
      // AND count it as sent, so the observer is told it succeeded. The next
      // flush re-presigns and re-PUTs, which is exactly what it needs.
      const retryable = res.status === 409 && (await isRetryable409(res));
      if (retryable) {
        defer(job, 'photos not yet in storage (HTTP 409)');
      } else if (res.ok || res.status === 409) {
        await retire(job); // landed, or the server already had it
        sent += 1;
      } else if (res.status === 401) {
        defer(job, 'session expired (HTTP 401)');
        break;
      } else if (holdsQueue(res.status)) {
        // Busy or rate-limited: every job behind this one would hear the same.
        holdQueue(job, `HTTP ${res.status}`, res.status, await retryAfterOf(res));
        break;
      } else if (res.status >= 400 && res.status < 500 && !retryableStatus(res.status)) {
        const why = await refusal(res);
        await retire(job);
        await recordDrop(job, why);
        publish({ lastError: why });
      } else {
        // Other 5xx, 408, 425: keep it, jittered backoff.
        defer(job, `HTTP ${res.status}`, res.status, await retryAfterOf(res));
      }
    }
  } catch (e) {
    publish({ lastError: msg(e) });
  } finally {
    sending = false;
    publish({ sending: false });
  }
  return { sent };
}

// -- triggers -----------------------------------------------------------------

let started = false;

/*
 * Reconnect and resume are the moments every phone in an area acts at once (a
 * mast comes back; everyone unlocks at the close of poll), so those flushes
 * start after a random delay instead of on the event. The periodic sweep and
 * the background task are already spread by when each phone started / when the
 * OS wakes it.
 */
const RECONNECT_STAGGER_MS = 10_000;
const RESUME_STAGGER_MS = 3_000;
function staggered(maxMs: number, opts?: { ignoreBackoff?: boolean }) {
  setTimeout(() => void flushOutbox(opts), Math.floor(Math.random() * maxMs));
}

/**
 * Wire the flush triggers. Runs on import so the queue drains whether or not a
 * screen ever mounts; exported as well so the shell can call it explicitly.
 */
export function initOutbox(): void {
  if (started) return;
  started = true;
  void load();

  // Background delivery (see BG_TASK below). Idempotent: registering an
  // existing task keeps it. Android runs it at most every 15 minutes.
  BackgroundTask?.registerTaskAsync(BG_TASK, { minimumInterval: 15 }).catch(() => {});

  try {
    NetInfo.addEventListener((state) => {
      const up = state.isConnected !== false && state.isInternetReachable !== false;
      // The offline->online EDGE only: NetInfo re-emits on every interface
      // detail change, and flushing per event would re-read the photos each time.
      // Staggered: a mast coming back reconnects every phone under it at once.
      if (up && !online) staggered(RECONNECT_STAGGER_MS, { ignoreBackoff: true });
      online = up;
    });
  } catch {
    // A dev client built before NetInfo was added has no native module for it.
    // Losing the instant-on-reconnect flush is survivable; crashing the app on
    // import, which is what an unhandled throw here does, is not.
    online = true;
  }

  AppState.addEventListener('change', (s) => {
    if (s === 'active') staggered(RESUME_STAGGER_MS);
  });

  // Foreground sweep. A network that degrades without ever dropping — captive
  // portal, one bar of GPRS — produces no NetInfo edge at all, so the edge
  // alone can strand a report for the whole of election day.
  setInterval(() => {
    if (AppState.currentState === 'active') void flushOutbox();
  }, 60_000);
}

/**
 * BACKGROUND DELIVERY (expo-background-task). Android WorkManager and iOS
 * BGTaskScheduler wake the app with network and run this, so a queued report
 * leaves even if nobody reopens the app — the rural case: capture with no
 * signal, pocket the phone, walk into coverage. Every trigger above needs the
 * app in the foreground. Android: at most every 15 minutes. iOS: whenever the
 * system chooses, and never after the user force-quits the app.
 *
 * Loaded with require, not import, and guarded like NetInfo: a dev client built
 * before these modules were added has neither native side, and a throw while
 * this file loads would take the whole outbox down with it. defineTask must
 * run at module scope, before any screen mounts — this module is imported at
 * startup.
 */
const BG_TASK = 'hawkeye-outbox-flush';
let BackgroundTask: typeof import('expo-background-task') | null = null;
try {
  BackgroundTask = require('expo-background-task');
  const TaskManager: typeof import('expo-task-manager') = require('expo-task-manager');
  const BT = BackgroundTask!;
  TaskManager.defineTask(BG_TASK, async () => {
    try {
      await flushOutbox({ ignoreBackoff: true });
      return BT.BackgroundTaskResult.Success;
    } catch {
      return BT.BackgroundTaskResult.Failed;
    }
  });
} catch {
  BackgroundTask = null; // no native module in this build: foreground triggers only
}

initOutbox();

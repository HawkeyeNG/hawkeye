/**
 * When to try a report again — the native twin of the retry helpers in
 * app/outbox.js (same constants, same rules; keep them in step).
 *
 * WHY THIS EXISTS (docs/private/ELECTION-NIGHT-HOSTING.md §2.5, P0 item 10).
 * The phone is the queue, so admission control at the origin loses nothing —
 * provided the phones do not all come back in the same second. Two rules:
 *  - the server's Retry-After is a floor, never a suggestion, plus 0–50% random
 *    on top, so two phones told "30" do not both return at exactly 30 s;
 *  - with no Retry-After, FULL JITTER over the old backoff ceilings: a uniform
 *    wait in [0, ceiling). The ceilings are the table the outbox always used.
 *
 * No imports on purpose: tests/retry_jitter_test.mjs compiles this file alone.
 */

/** Backoff ceilings by failure count: 30 s, 2 m, 8 m, then 30 m forever. */
export const BACKOFF_MS = [30_000, 120_000, 480_000, 1_800_000];

/** A header is the server's word, but a wrong one must not freeze the queue. */
export const RETRY_AFTER_CAP_MS = 15 * 60_000;

/** "Not now" rather than "never". Every other 4xx keeps its old handling. */
export const retryableStatus = (s: number): boolean => s >= 500 || s === 408 || s === 425 || s === 429;

/**
 * Answers about the SERVER (503 busy) or this OBSERVER (429 rate-limited), not
 * about one report — every report behind it would hear the same, so the whole
 * queue waits, and a reconnect is no reason to ignore it.
 */
export const holdsQueue = (s: number): boolean => s === 429 || s === 503;

/** Retry-After as ms from `now`: delta-seconds or an HTTP-date; null if absent or unreadable. */
export function parseRetryAfter(v: string | null | undefined, now: number): number | null {
  const s = v == null ? '' : String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.min(RETRY_AFTER_CAP_MS, Math.round(Number(s) * 1000));
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - now)) : null;
}

/**
 * How long to wait before the next attempt, in ms. Retry-After is honoured for
 * the two statuses that define it here (429, 503). `attempt` indexes the
 * backoff ceilings. `rand`/`now` are injectable for tests.
 */
export function retryDelayMs(
  status: number,
  retryAfter: string | null | undefined,
  attempt: number,
  rand: () => number = Math.random,
  now: number = Date.now(),
): number {
  const ra = status === 429 || status === 503 ? parseRetryAfter(retryAfter, now) : null;
  if (ra != null) return ra + Math.floor(rand() * 0.5 * Math.max(ra, 2000));
  const i = Math.min(Math.max(0, Math.floor(attempt) || 0), BACKOFF_MS.length - 1);
  return Math.floor(rand() * BACKOFF_MS[i]);
}

/**
 * Retry-After from a response: the header, else the body's `retryAfterS`.
 * Reads a CLONE, so the body stays readable for whoever reads it next.
 */
export async function retryAfterOf(res: Response): Promise<string | null> {
  const h = res.headers?.get?.('retry-after');
  if (h) return h;
  const body = (await res.clone().json().catch(() => null)) as { retryAfterS?: number } | null;
  return body && body.retryAfterS != null ? String(body.retryAfterS) : null;
}

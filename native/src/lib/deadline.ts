/**
 * fetch() WITH A DEADLINE.
 *
 * React Native's fetch has no timeout of its own (OkHttp is built with every
 * timeout at 0 = never), so a socket that stalls after connecting — one bar of
 * 2G, a captive portal, a mast handing over — leaves the promise pending for as
 * long as the app lives. Every screen that awaits one sits on its spinner, and
 * the outbox, which runs one flush at a time, never runs another.
 *
 * Callers that already had a deadline inlined the same AbortController dance;
 * this is that dance once. A timeout rejects like any network error, so every
 * caller's existing "network failed" branch (park the report, say "could not
 * reach Hawkeye", re-enable the button) handles it unchanged.
 *
 * No imports on purpose: tests compile this file alone.
 */

/** JSON round trips: sign-in, session resume, presign, a hash-only submit. */
export const JSON_DEADLINE_MS = 30_000;

/**
 * A request that carries the photos. Generous on purpose: two compressed
 * photos over a slow 2G link take a minute or more, and a deadline that cuts a
 * healthy upload short would fail it on every retry. Same ceiling as the
 * incident upload's XHR (lib/upload.ts).
 */
export const UPLOAD_DEADLINE_MS = 180_000;

export async function fetchWithin(url: string, init: RequestInit = {}, ms: number = JSON_DEADLINE_MS): Promise<Response> {
  const ctl = new AbortController();
  // A caller's own signal still aborts the request.
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', () => ctl.abort(), { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted && !outer?.aborted) throw new Error(`request timed out after ${Math.round(ms / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

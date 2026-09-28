/**
 * SIGNED-IN READS: PUSH-DRIVEN, PLUS 120 s (D6, docs/private/CHEAPEST-ELECTION-NIGHT.html).
 *
 * `/api/my/rooms` and `/api/observers/me` can never be cached at the edge, and
 * the screens that need them asked again on every mount — the report flow once
 * per race at the same unit. Here an answer is kept for 120 s in memory, for the
 * token that fetched it, and a push ends that early (lib/push.ts calls
 * notePush), as does the caller's own write (bust). The unread count has its own
 * 120 s in lib/push.ts because it lives in that store.
 *
 * The web twin is app/native.js signedInReads (sessionStorage there).
 */
export const FRESH_MS = 120_000;

type Entry = { at: number; epoch: number; token: string; value: unknown };

let epoch = 0;
const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** A push landed: everything kept is stale. */
export function notePush(): void {
  epoch++;
  entries.clear();
}

/** The caller changed what `key` reads (followed, checked in): drop it. */
export function bust(key?: string): void {
  if (key) entries.delete(key);
  else entries.clear();
}

/**
 * `load()` at most once per FRESH_MS per key and token; concurrent callers share
 * one request. A failure is never kept, and an answer that was in flight when a
 * push landed is returned but not kept.
 */
export async function fresh<T>(
  key: string,
  token: string | null,
  load: () => Promise<T>,
  opts: { force?: boolean; now?: () => number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now;
  const tk = token ?? '';
  const hit = entries.get(key);
  if (!opts.force && hit && hit.token === tk && hit.epoch === epoch && now() - hit.at < FRESH_MS) {
    return hit.value as T;
  }
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const e0 = epoch;
  const at = now();
  const p = load()
    .then((value) => {
      if (epoch === e0) entries.set(key, { at, epoch: e0, token: tk, value });
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

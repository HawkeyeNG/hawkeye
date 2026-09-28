import { BASE } from '@/lib/api';
import { getToken, renewSession } from '@/lib/auth';

/**
 * An authenticated request that ANSWERS WITH THE STATUS rather than throwing on
 * it — the groups and captain screens branch on 404 / 409 / 410 / 429 the way
 * their web twins do, and authedGet (lib/auth.ts) only knows ok-or-throw.
 *
 * Renews once on an expired token, exactly as authedGet does; "signed in
 * elsewhere" is left to the screen's own authedGet load, which already ends the
 * session and says why. Throws only when the network does.
 */
export type Sent<T = unknown> = { status: number; body: T | null };

export async function authedSend<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: object,
): Promise<Sent<T>> {
  const go = async (token: string | null) => {
    // RN's fetch has no timeout of its own; same 12 s deadline as authedGet.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    try {
      return await fetch(`${BASE}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token ?? ''}`,
          // The app is always the PHONE session (backend services/sessions.js).
          'x-device-class': 'phone',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await go(getToken());
  if (res.status === 401) {
    const b = (await res.clone().json().catch(() => null)) as { error?: string } | null;
    if (b?.error !== 'signed_in_elsewhere' && (await renewSession())) res = await go(getToken());
  }
  return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
}

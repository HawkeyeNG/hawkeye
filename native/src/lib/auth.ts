/**
 * Auth — OTP sign-in against /api/observers, token in SecureStore, and a tiny
 * subscribable store so screens react to sign-in state without a state lib.
 */
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import { getIdentity } from '@/lib/identity';

const BASE = 'https://hawkeye.com.ng';
const K_TOKEN = 'hawkeye.auth.token';
const K_OBSERVER = 'hawkeye.auth.observer';
const K_OPTED_OUT = 'hawkeye.auth.optedOut';

export type AuthState = {
  status: 'loading' | 'signedOut' | 'signedIn';
  observerId: number | null;
  token: string | null;
};

let state: AuthState = { status: 'loading', observerId: null, token: null };
const listeners = new Set<() => void>();

function set(next: AuthState) {
  state = next;
  listeners.forEach((l) => l());
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export type RegisterResult = {
  ok: boolean;
  viaWhatsapp?: boolean;
  viaSms?: boolean;
  viaTelegram?: boolean;
  telegramLink?: string;
  devOtp?: string;
  error?: string;
  hint?: string;
};

async function post<T>(path: string, body: object, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Step 1 — request an OTP for a phone via the chosen channel. */
export function requestOtp(phone: string, channel: 'whatsapp' | 'sms' | 'telegram'): Promise<RegisterResult> {
  return post<RegisterResult>('/api/observers/register', { phone, channel });
}

/** Step 2 — confirm the OTP; binds this device's keypair and stores the session. */
export async function verifyOtp(phone: string, otp: string): Promise<{ ok: boolean; error?: string; hint?: string }> {
  const id = await getIdentity();
  const r = await post<{ ok?: boolean; observerId?: number; token?: string; error?: string; hint?: string }>(
    '/api/observers/verify',
    { phone, otp, publicKeyJwk: id.publicKeyJwk },
    { 'x-device-id': id.deviceId },
  );
  if (r.ok && r.token && r.observerId) {
    await SecureStore.setItemAsync(K_TOKEN, r.token);
    await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
    await SecureStore.deleteItemAsync(K_OPTED_OUT);
    set({ status: 'signedIn', observerId: r.observerId, token: r.token });
    return { ok: true };
  }
  return { ok: false, error: r.error, hint: r.hint };
}

/**
 * Password sign-in — phone + password on any device, no OTP. The server treats
 * success exactly like a fresh OTP verify: the signing key rotates to this
 * device. Its 401 hints are user-ready copy; surface them verbatim.
 */
export async function passwordLogin(
  phone: string,
  password: string,
): Promise<{ ok: boolean; error?: string; hint?: string }> {
  const id = await getIdentity();
  const r = await post<{ ok?: boolean; observerId?: number; token?: string; error?: string; hint?: string }>(
    '/api/observers/login',
    { phone, password, publicKeyJwk: id.publicKeyJwk },
    { 'x-device-id': id.deviceId },
  );
  if (r.ok && r.token && r.observerId) {
    await SecureStore.setItemAsync(K_TOKEN, r.token);
    await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
    await SecureStore.deleteItemAsync(K_OPTED_OUT);
    set({ status: 'signedIn', observerId: r.observerId, token: r.token });
    return { ok: true };
  }
  return { ok: false, error: r.error, hint: r.hint };
}

/**
 * Set (or reset) the password on the CURRENT session.
 *
 * The server only asks for the current password when the account already has
 * one AND the session wasn't minted by a phone proof in the last 15 minutes —
 * so every caller here (fresh sign-up, password-less account, forgot-password
 * reset) is inside that window and sends the new password alone. Changing a
 * password from a resumed session lives on the profile screen, which does pass
 * `currentPassword`.
 */
export async function setPassword(
  password: string,
): Promise<{ ok: boolean; error?: string; hint?: string }> {
  if (!state.token) return { ok: false, error: 'not_signed_in' };
  const id = await getIdentity();
  const r = await post<{ ok?: boolean; error?: string; hint?: string }>(
    '/api/observers/set-password',
    { password },
    { authorization: `Bearer ${state.token}`, 'x-device-id': id.deviceId },
  );
  return r.ok ? { ok: true } : { ok: false, error: r.error, hint: r.hint };
}

/**
 * Does the signed-in account have a password yet? `null` means we couldn't
 * tell (network/401) — callers must fail OPEN on null, never strand someone on
 * a password screen because a status check didn't load.
 *
 * `signOutOn401: false` is load-bearing, not defensive. This runs one tick
 * after a successful OTP verify, and the caller's fail-open branch routes into
 * the app on `null`. With the default 401 handling a blip here would signOut()
 * — wiping the token AND setting the permanent opted-out flag — while the UI
 * carried on into /(tabs): signed out, silent resume disabled forever, no way
 * back except finding the sign-in screen again. A read that answers "I don't
 * know" must never be able to end the session.
 */
export async function accountHasPassword(): Promise<boolean | null> {
  try {
    const r = await authedGet<{ hasPassword?: boolean }>('/api/observers/me', {
      signOutOn401: false,
    });
    return typeof r.hasPassword === 'boolean' ? r.hasPassword : null;
  } catch {
    return null;
  }
}

/**
 * Prove the phone number ON THIS ACCOUNT — the in-app password-reset step.
 *
 * Deliberately NOT verifyOtp: that one is the sign-in path, and it would create
 * or switch to whatever identity the typed number belongs to, rotating this
 * device's signing key with it. This endpoint refuses any number that isn't the
 * signed-in observer's, and only refreshes their own session so /set-password
 * will accept a new password without the old one.
 */
export async function verifyOwner(
  phone: string,
  otp: string,
): Promise<{ ok: boolean; error?: string; hint?: string }> {
  if (!state.token) return { ok: false, error: 'not_signed_in' };
  const id = await getIdentity();
  const r = await post<{ ok?: boolean; token?: string; observerId?: number; error?: string; hint?: string }>(
    '/api/observers/verify-owner',
    { phone, otp },
    { authorization: `Bearer ${state.token}`, 'x-device-id': id.deviceId },
  );
  if (r.ok && r.token) {
    await SecureStore.setItemAsync(K_TOKEN, r.token);
    set({ ...state, status: 'signedIn', token: r.token });
    return { ok: true };
  }
  return { ok: false, error: r.error, hint: r.hint };
}

/** App-start session restore: stored token first, then silent device resume. */
export async function bootstrapAuth(): Promise<void> {
  try {
    const token = await SecureStore.getItemAsync(K_TOKEN);
    const observer = await SecureStore.getItemAsync(K_OBSERVER);
    if (token && observer) {
      set({ status: 'signedIn', observerId: Number(observer), token });
      return;
    }
    if (await SecureStore.getItemAsync(K_OPTED_OUT)) {
      set({ status: 'signedOut', observerId: null, token: null });
      return;
    }
    const id = await getIdentity();
    const r = await post<{ ok: boolean; observerId?: number; token?: string }>('/api/observers/resume', {
      deviceId: id.deviceId,
      publicKeyJwk: id.publicKeyJwk,
    });
    if (r.ok && r.token && r.observerId) {
      await SecureStore.setItemAsync(K_TOKEN, r.token);
      await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
      set({ status: 'signedIn', observerId: r.observerId, token: r.token });
      return;
    }
  } catch {
    // network down — signed-out UI still works
  }
  set({ status: 'signedOut', observerId: null, token: null });
}

/**
 * The session ended WITHOUT the observer asking — an expired or rejected token.
 *
 * Deliberately does NOT set K_OPTED_OUT. That flag exists to remember a choice
 * the person made, and a 401 is not a choice: setting it here would permanently
 * disable silent device-resume for someone whose only mistake was leaving the
 * app closed for seven days, and they would have no idea why they now have to
 * sign in by hand every time. bootstrapAuth can recover this state on its own
 * via /api/observers/resume, which is exactly what it is for.
 */
export async function expireSession(): Promise<void> {
  await SecureStore.deleteItemAsync(K_TOKEN);
  await SecureStore.deleteItemAsync(K_OBSERVER);
  set({ status: 'signedOut', observerId: null, token: null });
}

/** The observer asked to sign out. This one IS a choice, so it is remembered. */
export async function signOut(): Promise<void> {
  await expireSession();
  // Silent device-resume would sign this person straight back in on the next
  // launch, which makes an explicit sign-out look broken. Remember the choice.
  await SecureStore.setItemAsync(K_OPTED_OUT, '1');
}

/**
 * Authenticated GET helper for Bearer-gated endpoints.
 *
 * A 401 means the token is dead, so by default we clear the session — that is
 * right for the screens that render account data and need the signed-out UI.
 * It is NOT right for a status probe whose caller treats failure as "unknown"
 * and carries on: signOut() also writes the opted-out flag that kills silent
 * device resume for good. Those callers pass `signOutOn401: false` and handle
 * the throw themselves.
 */
export async function authedGet<T>(
  path: string,
  opts: { signOutOn401?: boolean } = {},
): Promise<T> {
  if (!state.token) throw new Error('not_signed_in');
  // React Native's fetch has NO default timeout, so a stalled socket leaves this
  // promise pending forever. accountHasPassword() runs on the tick after a
  // successful OTP verify and its answer decides whether a new observer is
  // offered a password at all — a hang there holds the sign-up screen on its
  // spinner with the account already created. Same 12s deadline api.ts uses.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${state.token}` },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    // expireSession, never signOut: a rejected token clears the session but must
    // not set the opted-out flag. Background readers (unread counts, my-unit,
    // the post-verify password check) all hit this path and none of them
    // represent the observer choosing to leave. `signOutOn401: false` remains
    // for callers that must not disturb the session at all.
    if (opts.signOutOn401 !== false) await expireSession();
    throw new Error('session_expired');
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

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

export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(K_TOKEN);
  await SecureStore.deleteItemAsync(K_OBSERVER);
  // Silent device-resume would sign this person straight back in on the next
  // launch, which makes an explicit sign-out look broken. Remember the choice.
  await SecureStore.setItemAsync(K_OPTED_OUT, '1');
  set({ status: 'signedOut', observerId: null, token: null });
}

/** Authenticated GET helper for Bearer-gated endpoints. */
export async function authedGet<T>(path: string): Promise<T> {
  if (!state.token) throw new Error('not_signed_in');
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${state.token}` },
  });
  if (res.status === 401) {
    await signOut();
    throw new Error('session_expired');
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

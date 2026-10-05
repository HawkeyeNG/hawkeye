/**
 * Auth — OTP sign-in against /api/observers, token in SecureStore, and a tiny
 * subscribable store so screens react to sign-in state without a state lib.
 */
import * as SecureStore from '@/lib/secure-store';
import { useSyncExternalStore } from 'react';

import { getIdentity } from '@/lib/identity';
import { currentLangForOtp } from '@/lib/i18n';
import { pendingInviteCode, settleInviteAfterVerify } from '@/lib/pending-invite';

// Overridable so the app can run in a desktop browser against a local
// backend; production blocks cross-origin calls. See lib/api.ts.
const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';
const K_TOKEN = 'hawkeye.auth.token';
const K_OBSERVER = 'hawkeye.auth.observer';
const K_OPTED_OUT = 'hawkeye.auth.optedOut';
const K_ELSEWHERE = 'hawkeye.auth.signedOutElsewhere';

/**
 * SIGNED OUT BECAUSE THE ACCOUNT SIGNED IN ON ANOTHER DEVICE (owner decision D3).
 *
 * One device at a time: the server revokes this device's session when the
 * account signs in anywhere else, and says so — 401 `signed_in_elsewhere` on a
 * request, `signedInElsewhere` on /resume. Every 401 path in the app already
 * funnels into renewSession()/bootstrapAuth() (authedGet, push, certificate,
 * and the outbox/submit re-mint), so this is caught HERE rather than at forty
 * call sites. The flag is persisted so the explanation survives the app being
 * closed, and it is cleared by the next successful sign-in on this device.
 * components/signed-out-elsewhere.tsx shows it on welcome and sign-in.
 */
let elsewhere = false;
const elsewhereListeners = new Set<() => void>();
function setElsewhere(v: boolean) {
  if (elsewhere === v) return;
  elsewhere = v;
  elsewhereListeners.forEach((l) => l());
}
export function useSignedOutElsewhere(): boolean {
  return useSyncExternalStore(
    (l) => {
      elsewhereListeners.add(l);
      return () => elsewhereListeners.delete(l);
    },
    () => elsewhere,
    () => elsewhere, // server snapshot — see useAuth()
  );
}
async function markSignedOutElsewhere(): Promise<void> {
  setElsewhere(true);
  try { await SecureStore.setItemAsync(K_ELSEWHERE, String(Date.now())); } catch { /* the notice is a courtesy */ }
}
async function clearSignedOutElsewhere(): Promise<void> {
  setElsewhere(false);
  try { await SecureStore.deleteItemAsync(K_ELSEWHERE); } catch { /* nothing to clear */ }
}

export type AuthState = {
  status: 'loading' | 'signedOut' | 'signedIn';
  observerId: number | null;
  token: string | null;
};

let state: AuthState = { status: 'loading', observerId: null, token: null };
const listeners = new Set<() => void>();

function set(next: AuthState) {
  state = next;
  // Signed in again: the next session end is a fresh question (noteReturnAfterSignIn).
  if (next.status === 'signedIn') signedOutByChoice = false;
  listeners.forEach((l) => l());
}

/**
 * The session token, outside React.
 *
 * `useAuth()` is the hook every screen uses, but a few callers are not
 * components and cannot hold a hook — i18n's tellServer() fires from a state
 * setter. Reading the module state directly is what those need, and it is the
 * same value the hook publishes.
 */
export function getToken(): string | null {
  return state.token;
}

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    /* THE SERVER SNAPSHOT, for the web export only (a phone never server-renders,
       so React never calls it there). Without it the static render of EVERY
       route threw "Missing getServerSnapshot" from RootShell, the root Suspense
       boundary was shipped empty, and hydration logged React #419 on every page. */
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

// x-device-class: the native app is always a PHONE session — one of the two
// slots an account has (backend services/sessions.js: one phone and one
// computer). React Native's own user agent (okhttp / CFNetwork) says the same,
// so an app still on an older bundle is classed correctly without it.
async function post<T>(path: string, body: object, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-class': 'phone', ...headers },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** Step 1 — request an OTP for a phone via the chosen channel. */
/**
 * `intent` tells the server which door this is. On 'signup' it refuses a number
 * that is already a password-holding observer and sends NO code — an OTP costs
 * money and a sign-up on a registered number has only one possible outcome.
 * Every other purpose (reset, no-password rescue) must still get a code on a
 * registered number, so only sign-up passes the flag.
 */
export function requestOtp(
  phone: string,
  channel: 'whatsapp' | 'sms' | 'telegram',
  intent?: 'signup',
): Promise<RegisterResult> {
  /**
   * The language rides along because the observer row does not exist yet.
   *
   * The code is the first thing Hawkeye ever sends anyone, and it is sent
   * before there is anywhere to store a preference — the server parks this on
   * the OTP row and copies it across at /verify. Without it, the one message a
   * new observer is guaranteed to receive would be the one that could not be in
   * their language.
   */
  return post<RegisterResult>('/api/observers/register', { phone, channel, intent, lang: currentLangForOtp() });
}

/** Step 2 — confirm the OTP; binds this device's keypair and stores the session. */
/**
 * `isNew` / `hadPassword` describe the account AS IT WAS when the code was
 * accepted, so a sign-up can tell someone their account already exists rather
 * than silently signing them into it. The server answers this only after a
 * correct OTP — there is no way to ask beforehand, by design: a pre-check would
 * turn the observer list into something anyone could enumerate by typing
 * numbers, which is the whole reason only a phone HASH is stored.
 */
export async function verifyOtp(
  phone: string,
  otp: string,
  /** Sign-up's "Invite code" field: a code, or null when the person left it
   *  empty. Omitted (reset, rescue) means the parked invitation, as before. */
  opts: { referralCode?: string | null } = {},
): Promise<{ ok: boolean; error?: string; hint?: string; isNew?: boolean; needsUnit?: boolean; hadPassword?: boolean }> {
  const id = await getIdentity();
  // WHO INVITED THEM, exactly as app.js sends it: `referralCode` on /verify,
  // absent when there is none. The server records it only if this verify
  // CREATES the observer, so an existing account's referral cannot be changed
  // from here. See lib/pending-invite.ts.
  const referralCode = opts.referralCode === undefined ? await pendingInviteCode() : opts.referralCode || undefined;
  const r = await post<{
    ok?: boolean;
    observerId?: number;
    token?: string;
    error?: string;
    hint?: string;
    isNew?: boolean;
    needsUnit?: boolean;
    hasPassword?: boolean;
  }>(
    '/api/observers/verify',
    { phone, otp, publicKeyJwk: id.publicKeyJwk, referralCode },
    { 'x-device-id': id.deviceId },
  );
  if (r.ok && r.token && r.observerId) {
    await SecureStore.setItemAsync(K_TOKEN, r.token);
    await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
    await SecureStore.deleteItemAsync(K_OPTED_OUT);
    await clearSignedOutElsewhere();
    await settleInviteAfterVerify(r);
    set({ status: 'signedIn', observerId: r.observerId, token: r.token });
    // An older server sends neither field. `undefined` then means "not stated",
    // and the caller falls back to the ordinary sign-up path rather than
    // claiming an account is new when it does not know.
    return { ok: true, isNew: r.isNew, needsUnit: r.needsUnit, hadPassword: r.hasPassword };
  }
  return { ok: false, error: r.error, hint: r.hint };
}


/**
 * SIGN UP WITH AN ORGANISATION CODE INSTEAD OF AN OTP (owner decision D4).
 *
 * A party's or civic partner's single-use code stands in for the one-time
 * code, so nothing is sent to the phone. The server binds the code to this
 * number at first use and only ever CREATES an account with it — an existing
 * number is refused (backend services/orgCodes.js). Same storage as verifyOtp
 * on success; the caller then runs the ordinary set-password step.
 */
export async function orgSignup(
  phone: string,
  orgCode: string,
  opts: { referralCode?: string | null } = {},
): Promise<{ ok: boolean; error?: string; hint?: string; isNew?: boolean; needsUnit?: boolean }> {
  const id = await getIdentity();
  const referralCode = opts.referralCode === undefined ? await pendingInviteCode() : opts.referralCode || undefined;
  const r = await post<{
    ok?: boolean; observerId?: number; token?: string; error?: string; hint?: string; isNew?: boolean; needsUnit?: boolean;
  }>(
    '/api/observers/org-signup',
    { phone, orgCode, publicKeyJwk: id.publicKeyJwk, referralCode, lang: currentLangForOtp() },
    { 'x-device-id': id.deviceId },
  );
  if (r.ok && r.token && r.observerId) {
    await SecureStore.setItemAsync(K_TOKEN, r.token);
    await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
    await SecureStore.deleteItemAsync(K_OPTED_OUT);
    await clearSignedOutElsewhere();
    await settleInviteAfterVerify(r);
    set({ status: 'signedIn', observerId: r.observerId, token: r.token });
    return { ok: true, isNew: r.isNew, needsUnit: r.needsUnit };
  }
  return { ok: false, error: r.error, hint: r.hint };
}

/**
 * WHATSAPP IN REVERSE — "SEND US THE CODE" (free).
 *
 * Instead of paying to send the observer a code, the server shows one
 * (HK-XXXXXX) and the observer sends it FROM the WhatsApp on the number they
 * typed TO ours. Meta's webhook matches sender + code, and this device collects
 * its session with a poll token only it holds (backend services/waInbound.js).
 * Offered only while /api/health says `waInbound` (api.waInboundEnabled).
 *
 * The same device proof as /verify: this device's key and id ride on the
 * start, and the session that comes back is bound to them. The server counts a
 * WhatsApp proof as fresh phone proof, so /set-password takes a new password
 * without the old one, exactly as after a code.
 *
 * A POST with a deadline and the HTTP status beside the body: a poll that
 * hangs on a stalled socket would stop the waiting screen dead (React Native's
 * fetch has no timeout of its own), and 410 is an answer while a 502 page is
 * not. Throws only when the network failed or the reply was not JSON.
 */
async function postStatus<T>(path: string, body: object, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-class': 'phone', ...headers },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    return { status: res.status, body: (await res.json()) as T };
  } finally {
    clearTimeout(timer);
  }
}

export type WaStartResult =
  | { ok: true; code: string; waLink: string; waNumber: string; pollToken: string; expiresInS: number; pollAfterMs: number }
  | { ok: false; error?: string };

/**
 * Start a WhatsApp sign-in. `wa_inbound_unavailable` (the server's 503, or a
 * reply this build cannot use) means: send the paid code instead, silently.
 */
export async function waStart(
  phone: string,
  /** As verifyOtp: sign-up's typed invite (null = none); omitted = the parked one. */
  opts: { referralCode?: string | null } = {},
): Promise<WaStartResult> {
  const id = await getIdentity();
  const referralCode = opts.referralCode === undefined ? await pendingInviteCode() : opts.referralCode || undefined;
  const r = await postStatus<{
    ok?: boolean; code?: string; waLink?: string; waNumber?: string; pollToken?: string;
    expiresInS?: number; pollAfterMs?: number; error?: string;
  }>(
    '/api/observers/wa-start',
    { phone, publicKeyJwk: id.publicKeyJwk, lang: currentLangForOtp(), referralCode },
    { 'x-device-id': id.deviceId },
  );
  const b = r.body ?? {};
  if (r.status === 200 && b.ok) {
    // Only a link that opens WhatsApp is ever handed to the OS.
    const linkOk = typeof b.waLink === 'string' && /^(https:\/\/(wa\.me|api\.whatsapp\.com)\/|whatsapp:\/\/)/.test(b.waLink);
    if (typeof b.code !== 'string' || !b.code || !linkOk || typeof b.pollToken !== 'string' || !b.pollToken) {
      return { ok: false, error: 'wa_inbound_unavailable' };
    }
    return {
      ok: true,
      code: b.code,
      waLink: b.waLink as string,
      waNumber: typeof b.waNumber === 'string' ? b.waNumber : '',
      pollToken: b.pollToken,
      expiresInS: Number(b.expiresInS) > 0 ? Number(b.expiresInS) : 600,
      pollAfterMs: Number(b.pollAfterMs) > 0 ? Number(b.pollAfterMs) : 2000,
    };
  }
  if (r.status === 503) return { ok: false, error: 'wa_inbound_unavailable' };
  return { ok: false, error: b.error };
}

/** What /wa-status hands over once the message has arrived: /verify's shape. */
export type WaSession = {
  observerId: number;
  token: string;
  isNew?: boolean;
  needsUnit?: boolean;
  hasPassword?: boolean;
};

export type WaStatusResult =
  | { status: 'pending'; mismatch: boolean; retryAfterMs: number }
  | { status: 'verified'; session: WaSession }
  /** Expired, used, cancelled or another device's — one answer (410). */
  | { status: 'expired' }
  /** An answer that decides nothing (429, 5xx): ask again later. */
  | { status: 'retry' };

/**
 * One poll. Stores NOTHING: the caller adopts a verified session with
 * adoptWaSession() only if it still wants it — a reply that lands after the
 * observer tapped "Use a different number" must not sign anyone in behind
 * their back.
 */
export async function waStatus(pollToken: string): Promise<WaStatusResult> {
  const id = await getIdentity();
  const r = await postStatus<{
    ok?: boolean; status?: string; mismatch?: boolean; retryAfterMs?: number;
    observerId?: number; token?: string; isNew?: boolean; needsUnit?: boolean; hasPassword?: boolean;
  }>('/api/observers/wa-status', { pollToken }, { 'x-device-id': id.deviceId });
  const b = r.body ?? {};
  if (r.status === 410) return { status: 'expired' };
  if (r.status === 200 && b.status === 'verified' && b.token && b.observerId) {
    return {
      status: 'verified',
      session: { observerId: b.observerId, token: b.token, isNew: b.isNew, needsUnit: b.needsUnit, hasPassword: b.hasPassword },
    };
  }
  if (r.status === 200 && b.status === 'pending') {
    return { status: 'pending', mismatch: b.mismatch === true, retryAfterMs: Number(b.retryAfterMs) || 0 };
  }
  return { status: 'retry' };
}

/**
 * Keep a WhatsApp-proved session — stored exactly as verifyOtp stores one.
 * Returns what verifyOtp returns, `hadPassword` being the server's
 * `hasPassword`, so the sign-in screen runs ONE success path for both proofs.
 */
export async function adoptWaSession(
  r: WaSession,
): Promise<{ isNew?: boolean; needsUnit?: boolean; hadPassword?: boolean }> {
  await SecureStore.setItemAsync(K_TOKEN, r.token);
  await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
  await SecureStore.deleteItemAsync(K_OPTED_OUT);
  await clearSignedOutElsewhere();
  await settleInviteAfterVerify(r);
  set({ status: 'signedIn', observerId: r.observerId, token: r.token });
  return { isNew: r.isNew, needsUnit: r.needsUnit, hadPassword: r.hasPassword };
}

/** "Use a different number", or leaving the step: the code on screen stops working. */
export async function waCancel(pollToken: string): Promise<void> {
  try {
    const id = await getIdentity();
    await postStatus('/api/observers/wa-cancel', { pollToken }, { 'x-device-id': id.deviceId });
  } catch {
    /* best effort — an abandoned code also expires on its own */
  }
}

/**
 * MISSED CALL — "GIVE US A MISSED CALL" (free, SIGN-UP ONLY).
 *
 * The server shows our number; the observer rings it FROM the phone being
 * verified; our gateway rejects the call (free to the caller) and the server
 * marks that number proved; this device collects its session with a poll token
 * only it holds (backend services/callVerify.js). The same shapes as the
 * WhatsApp route above, so the sign-in screen reuses its waiting step and
 * adoptWaSession() keeps the session.
 *
 * Sign-up only, because caller ID can be forged: /call-start answers every
 * number alike, and /call-status says `has-account` (409 call_signup_only) for
 * a number that already has one — after the call, with nothing issued.
 */
export async function callVerifyEnabled(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: ctl.signal });
    const b = r.ok ? ((await r.json()) as { callVerify?: boolean }) : null;
    return b?.callVerify === true;   // fail closed
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type CallStartResult =
  | { ok: true; callNumber: string; display: string; telLink: string; pollToken: string; expiresInS: number; pollAfterMs: number }
  | { ok: false; error?: string; hint?: string };

export async function callStart(
  phone: string,
  /** As verifyOtp: sign-up's typed invite (null = none); omitted = the parked one. */
  opts: { referralCode?: string | null } = {},
): Promise<CallStartResult> {
  const id = await getIdentity();
  const referralCode = opts.referralCode === undefined ? await pendingInviteCode() : opts.referralCode || undefined;
  const r = await postStatus<{
    ok?: boolean; callNumber?: string; callNumberDisplay?: string; telLink?: string; pollToken?: string;
    expiresInS?: number; pollAfterMs?: number; error?: string; hint?: string;
  }>(
    '/api/observers/call-start',
    { phone, publicKeyJwk: id.publicKeyJwk, intent: 'signup', lang: currentLangForOtp(), referralCode },
    { 'x-device-id': id.deviceId },
  );
  const b = r.body ?? {};
  if (r.status === 200 && b.ok) {
    // Only a tel: link is ever handed to the OS.
    if (typeof b.pollToken !== 'string' || !b.pollToken || typeof b.telLink !== 'string' || !/^tel:\+?\d{6,15}$/.test(b.telLink)) {
      return { ok: false, error: 'call_unavailable' };
    }
    const callNumber = typeof b.callNumber === 'string' ? b.callNumber : b.telLink.slice(4);
    return {
      ok: true,
      callNumber,
      display: typeof b.callNumberDisplay === 'string' && b.callNumberDisplay ? b.callNumberDisplay : callNumber,
      telLink: b.telLink,
      pollToken: b.pollToken,
      expiresInS: Number(b.expiresInS) > 0 ? Number(b.expiresInS) : 600,
      pollAfterMs: Number(b.pollAfterMs) > 0 ? Number(b.pollAfterMs) : 2000,
    };
  }
  if (r.status === 503) return { ok: false, error: 'call_unavailable' };
  return { ok: false, error: b.error, hint: b.hint };
}

export type CallStatusResult =
  | { status: 'pending'; retryAfterMs: number }
  | { status: 'verified'; session: WaSession }
  /** The number already has an account: nothing issued; sign in instead. */
  | { status: 'has-account' }
  /** Expired, used, cancelled or another device's — one answer (410). */
  | { status: 'expired' }
  /** An answer that decides nothing (429, 5xx): ask again later. */
  | { status: 'retry' };

/** One poll. Stores NOTHING — the caller adopts a verified session (adoptWaSession) only if it still wants it. */
export async function callStatus(pollToken: string, phone: string): Promise<CallStatusResult> {
  const id = await getIdentity();
  const r = await postStatus<{
    ok?: boolean; status?: string; retryAfterMs?: number; error?: string;
    observerId?: number; token?: string; isNew?: boolean; needsUnit?: boolean; hasPassword?: boolean;
  }>('/api/observers/call-status', { pollToken, phone }, { 'x-device-id': id.deviceId });
  const b = r.body ?? {};
  if (r.status === 410) return { status: 'expired' };
  if (r.status === 409 && b.error === 'call_signup_only') return { status: 'has-account' };
  if (r.status === 200 && b.status === 'verified' && b.token && b.observerId) {
    return {
      status: 'verified',
      session: { observerId: b.observerId, token: b.token, isNew: b.isNew, needsUnit: b.needsUnit, hasPassword: b.hasPassword },
    };
  }
  if (r.status === 200 && b.status === 'pending') return { status: 'pending', retryAfterMs: Number(b.retryAfterMs) || 3000 };
  return { status: 'retry' };
}

/** "Use a different number", or leaving the step: a call from the old number stops counting. */
export async function callCancel(pollToken: string): Promise<void> {
  try {
    const id = await getIdentity();
    await postStatus('/api/observers/call-cancel', { pollToken }, { 'x-device-id': id.deviceId });
  } catch {
    /* best effort — an abandoned sign-in also expires on its own */
  }
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
    await clearSignedOutElsewhere();
    set({ status: 'signedIn', observerId: r.observerId, token: r.token });
    return { ok: true };
  }
  return { ok: false, error: r.error, hint: r.hint };
}

/**
 * PASSKEY SIGN-IN (lib/passkeys.ts drives the system sheet between these two).
 *
 * Step 1: a fresh, single-use challenge. No account is named — the phone
 * offers its own Hawkeye passkeys — so nothing here can tell anyone whether a
 * number is registered.
 */
export async function passkeyLoginOptions(): Promise<
  { ok: true; options: Record<string, unknown> } | { ok: false; error: string }
> {
  const r = await postStatus<{ options?: Record<string, unknown>; error?: string }>(
    '/api/observers/passkeys/login-options',
    {},
  );
  if (r.status === 200 && r.body?.options) return { ok: true, options: r.body.options };
  return { ok: false, error: r.body?.error || (r.status === 503 ? 'passkeys_unavailable' : 'failed') };
}

/**
 * Step 2: the signed assertion. Bound to this device's key and id exactly as
 * every other sign-in is, and it takes this phone's session slot (x-device-
 * class: phone, owner decision D3) — another phone signed in to the account is
 * signed out, a computer is not. A passkey session is `via: 'pk'`: never phone
 * proof, so it cannot reset a password without the current one. Stored the
 * way passwordLogin stores a session. One refusal for every failure
 * (`passkey_failed`), by the server's design.
 */
export async function passkeyLogin(
  response: object,
): Promise<{ ok: true; needsUnit: boolean } | { ok: false; error: string }> {
  const id = await getIdentity();
  const r = await postStatus<{ ok?: boolean; observerId?: number; token?: string; error?: string; needsUnit?: boolean }>(
    '/api/observers/passkeys/login',
    { response, publicKeyJwk: id.publicKeyJwk },
    { 'x-device-id': id.deviceId },
  );
  const b = r.body ?? {};
  if (r.status === 200 && b.ok && b.token && b.observerId) {
    await SecureStore.setItemAsync(K_TOKEN, b.token);
    await SecureStore.setItemAsync(K_OBSERVER, String(b.observerId));
    await SecureStore.deleteItemAsync(K_OPTED_OUT);
    await clearSignedOutElsewhere();
    set({ status: 'signedIn', observerId: b.observerId, token: b.token });
    return { ok: true, needsUnit: b.needsUnit === true };
  }
  return { ok: false, error: b.error || (r.status === 503 ? 'passkeys_unavailable' : 'passkey_failed') };
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

/**
 * RENEW A SESSION THAT EXPIRED ON THE CLOCK, RATHER THAN ENDING IT.
 *
 * Tokens are issued with expiresIn: '7d' (backend observers.js:34) and nothing
 * refreshed them, so EVERY observer was signed out exactly one week after
 * signing in — discovered on whatever request happened to be in flight at the
 * time. That is not a security boundary anyone chose; it is a default nobody
 * revisited, and on this app it lands mid-use.
 *
 * /api/observers/resume already exists for precisely this: a device that is
 * still the observer's registered device, proving it with the same fingerprint
 * and persistent key bootstrapAuth uses at launch, gets a fresh token with no
 * OTP. Expiry should therefore be invisible on a device someone still owns.
 *
 * Returns true if the session was renewed, so the caller can retry.
 *
 * IT DOES NOT LOOP. A resume that fails, or a device that is no longer
 * recognised, returns false and the caller expires the session exactly as
 * before — and the opted-out flag still disables this permanently, so someone
 * who signed out is never silently signed back in.
 */
let renewing: Promise<boolean> | null = null;
export function renewSession(): Promise<boolean> {
  // One attempt shared by every concurrent 401 — a screen firing four requests
  // must not fire four resumes.
  if (renewing) return renewing;
  renewing = (async () => {
    try {
      if (await SecureStore.getItemAsync(K_OPTED_OUT)) return false;
      const id = await getIdentity();
      const r = await post<{ ok: boolean; observerId?: number; token?: string; signedInElsewhere?: boolean }>(
        '/api/observers/resume',
        { deviceId: id.deviceId, publicKeyJwk: id.publicKeyJwk },
      );
      if (r.signedInElsewhere) {
        // Definitive, not a blip: this device is no longer the account's. End
        // the session here so every caller (push, certificate, not only
        // authedGet) lands on the explained sign-in, and say why.
        await markSignedOutElsewhere();
        await expireSession();
        return false;
      }
      if (!r.ok || !r.token || !r.observerId) return false;
      await SecureStore.setItemAsync(K_TOKEN, r.token);
      await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
      set({ status: 'signedIn', observerId: r.observerId, token: r.token });
      return true;
    } catch {
      // Network down: NOT a dead session. Say no, and let the caller decide —
      // it will expire the session, which is the pre-existing behaviour.
      return false;
    } finally {
      // Cleared on the next tick so a burst of 401s shares this attempt but a
      // later one can try again.
      setTimeout(() => { renewing = null; }, 0);
    }
  })();
  return renewing;
}

const RESUME_WAIT_MS = 1200;

/** App-start session restore: stored token first, then silent device resume. */
export async function bootstrapAuth(): Promise<void> {
  try {
    // A sign-out explained last session is still explained after a restart.
    if (await SecureStore.getItemAsync(K_ELSEWHERE)) setElsewhere(true);
  } catch {
    /* the notice is a courtesy */
  }
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
    // THE SPLASH DOES NOT WAIT ON THE NETWORK FOR LONG. The splash is held until
    // auth leaves 'loading', and a signed-out start used to wait for this whole
    // round trip — 2.5-5 s on a cold start (owner's video, 2026-10-04). After
    // RESUME_WAIT_MS the signed-out UI shows; a resume that lands later still
    // signs in (welcome.tsx moves a signed-in reader to the tabs).
    const resume = (async () => {
      const id = await getIdentity();
      const r = await post<{ ok: boolean; observerId?: number; token?: string; signedInElsewhere?: boolean }>('/api/observers/resume', {
        deviceId: id.deviceId,
        publicKeyJwk: id.publicKeyJwk,
      });
      if (r.ok && r.token && r.observerId) {
        await SecureStore.setItemAsync(K_TOKEN, r.token);
        await SecureStore.setItemAsync(K_OBSERVER, String(r.observerId));
        await clearSignedOutElsewhere();
        set({ status: 'signedIn', observerId: r.observerId, token: r.token });
        return true;
      }
      // The outbox and submit re-mint through here (submit.ts remintSession), so
      // a report parked on a 401 is explained the same way as everything else.
      if (r.signedInElsewhere) await markSignedOutElsewhere();
      return false;
    })().catch(() => false);
    const done = await Promise.race([resume, new Promise<'late'>((ok) => setTimeout(() => ok('late'), RESUME_WAIT_MS))]);
    if (done === true) return;
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

/**
 * WHERE A FINISHED SIGN-IN GOES BACK TO (flow walkthrough ONB-09).
 *
 * A refused session sends the reader to welcome from wherever they were — My
 * Groups, Profile, a deep link a cold start opened — and sign-in used to land
 * them on Home, the screen forgotten. The root layout notes the screen at the
 * bounce (app/_layout.tsx); sign-in.tsx reads it, checks it is an app path,
 * and returns there, then clears it. Memory only: it is about this session's
 * last few seconds, not something to survive a restart.
 */
let returnAfterSignIn: string | null = null;
/** signOut() was the observer's own choice: then there is nothing to return to. */
let signedOutByChoice = false;
export function noteReturnAfterSignIn(path: string | null): void {
  returnAfterSignIn = signedOutByChoice ? null : path;
}
export function peekReturnAfterSignIn(): string | null {
  return returnAfterSignIn;
}

/** The observer asked to sign out. This one IS a choice, so it is remembered. */
export async function signOut(): Promise<void> {
  // Tell the server this phone's session has ended (POST /api/observers/sign-out).
  // Until it hears, the account still holds this phone for the election soft
  // lock (backend services/deviceClaims.js) — before polling day a signed-out
  // owner is what lets another account's report claim the phone. Fire and
  // forget with a deadline: signing out must work offline and never wait.
  const token = state.token;
  // Before the session ends: the root layout notes "where they were" the
  // moment it sees signedOut, and a chosen sign-out has no way back to offer.
  signedOutByChoice = true;
  returnAfterSignIn = null;
  if (token) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5_000);
    void fetch(`${BASE}/api/observers/sign-out`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: ctl.signal,
    }).catch(() => null).finally(() => clearTimeout(timer));
  }
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
  const sentToken = state.token;
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
    /**
     * SIGNED IN ON ANOTHER DEVICE is not an expiry, and a resume cannot fix it:
     * say why and end the session — even for `signOutOn401: false` callers,
     * because this answer is definitive rather than a blip. Only if the token
     * that was refused is STILL the current one: a request in flight from
     * before a fresh sign-in on this device must not end the new session.
     */
    const b = await res.clone().json().catch(() => null) as { error?: string } | null;
    if (b?.error === 'signed_in_elsewhere') {
      if (state.token === sentToken) {
        await markSignedOutElsewhere();
        await expireSession();
      }
      throw new Error('signed_in_elsewhere');
    }
    /**
     * TRY TO RENEW BEFORE GIVING UP. A 7-day token expiring is the ordinary
     * case here, not a revoked session, and the device can prove itself without
     * an OTP. Renew and retry once; only a device the server no longer
     * recognises falls through to expiry.
     */
    if (opts.signOutOn401 !== false && (await renewSession())) {
      const retry = await fetch(`${BASE}${path}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${state.token}` },
      });
      if (retry.ok) return (await retry.json()) as T;
    }
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

/**
 * PASSKEYS IN THE NATIVE APP — sign in with a fingerprint, face or screen lock
 * instead of a code or a password. The twin of app/passkey.js: the SAME server
 * endpoints (/api/observers/passkeys/*, backend services/passkeys.js) and the
 * same rules. A passkey is for RETURNING sign-in only: never a sign-up, never
 * the phone proof that resets a password, and a passkey sign-in takes this
 * phone's session slot like every other sign-in (owner decision D3: one phone
 * and one computer per account — lib/auth.ts sends x-device-class: phone).
 *
 * THE NATIVE MODULE IS OPTIONAL, AND THAT IS LOAD-BEARING. react-native-passkeys
 * (iOS AuthenticationServices, Android Credential Manager) arrives with the
 * 1.0.12 store build; 1.0.11 and older binaries run this same JS by OTA and do
 * NOT contain it. The package's own entry calls
 * requireNativeModule('ReactNativePasskeys') AT IMPORT, which throws in such a
 * binary — so the package is never imported at runtime anywhere in native/src.
 * This file asks requireOptionalNativeModule() (null, not a throw) and calls
 * the module's functions directly. tests/native_passkeys_test.mjs proves both.
 *
 * SHOWN ONLY WHERE IT CAN WORK:
 *   - the binary has the module and the OS can do passkeys (iOS 15+, Android 9+);
 *   - /api/health says passkeys:true for RP ID hawkeye.com.ng, the one domain
 *     this binary is associated with (iOS webcredentials:, Android
 *     assetlinks get_login_creds);
 *   - to MAKE one, the phone has a lock: iOS refuses without Face ID / Touch ID
 *     enrolled (the module checks), Android needs at least a PIN or pattern.
 * Otherwise nothing about passkeys is offered. Profile still lists and removes
 * passkeys made elsewhere: that needs no native module.
 *
 * No pop-up before the system sheet (owner rule): every entry point is an
 * ordinary inline button that goes straight to the OS's own passkey sheet.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { api } from '@/lib/api';
import { passkeyLogin, passkeyLoginOptions } from '@/lib/auth';
import { authedSend } from '@/lib/authed-send';
import { currentLangForOtp, t as i18nT } from '@/lib/i18n';
import { getIdentity } from '@/lib/identity';

/** The RP ID this binary is associated with. The server's must be the same. */
export const PASSKEY_RP_ID = 'hawkeye.com.ng';

type Json = Record<string, unknown>;

/** The two calls this app makes, plus the OS check. Nothing else of the module is used. */
type PasskeysNative = {
  isSupported?: () => boolean;
  create: (request: Json) => Promise<Json | null>;
  get: (request: Json) => Promise<Json | null>;
};

function loadModule(): PasskeysNative | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    const m = requireOptionalNativeModule<PasskeysNative>('ReactNativePasskeys');
    return m && typeof m.create === 'function' && typeof m.get === 'function' ? m : null;
  } catch {
    return null;
  }
}
const mod = loadModule();

/** The binary carries the module and this OS version can do passkeys. Never throws. */
export function passkeysInBinary(): boolean {
  if (!mod) return false;
  try {
    return typeof mod.isSupported === 'function' ? mod.isSupported() !== false : true;
  } catch {
    return false;
  }
}

/**
 * …and the server has passkeys on, for this binary's domain. A yes is kept for
 * the session; a no (or no answer) is asked again next time, so a server that
 * was briefly unreachable does not hide the option until the app restarts.
 */
let serverOk = false;
export async function passkeysUsable(): Promise<boolean> {
  if (!passkeysInBinary()) return false;
  if (!serverOk) serverOk = await api.passkeysEnabled(PASSKEY_RP_ID);
  return serverOk;
}

/** A fingerprint, face or screen lock to protect a passkey (see the header for why iOS asks for more). */
async function deviceHasLock(): Promise<boolean> {
  try {
    const LA = await import('expo-local-authentication');
    if (Platform.OS === 'ios') return await LA.isEnrolledAsync();
    return (await LA.getEnrolledLevelAsync()) !== LA.SecurityLevel.NONE;
  } catch {
    return false;
  }
}

/** Can this phone MAKE a passkey: 'yes'; 'no-lock' (set one up first); 'no' (not here at all). */
export async function createState(): Promise<'yes' | 'no-lock' | 'no'> {
  if (!(await passkeysUsable())) return 'no';
  return (await deviceHasLock()) ? 'yes' : 'no-lock';
}

/* ------------------------------------------------------------------ JSON */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
/** base64url, unpadded — what the server stores and compares credential ids in. Idempotent. */
const b64u = (v: unknown) => String(v ?? '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/**
 * A credential descriptor without its `transports`. They are only hints, and
 * the iOS module reads them into a closed enum: one value it does not know
 * ("smart-card", "cable") would fail the whole request.
 */
const descriptor = (c: unknown) => ({ id: b64u((c as Json)?.id), type: 'public-key' });

/** The server's creation options, reduced to the fields the native sheet reads. */
function creationRequest(o: Json): Json {
  const rp = (o.rp ?? {}) as Json;
  return {
    rp: { name: str(rp.name) ?? 'Hawkeye', id: str(rp.id) ?? PASSKEY_RP_ID },
    user: o.user,
    challenge: o.challenge,
    pubKeyCredParams: o.pubKeyCredParams,
    timeout: o.timeout,
    attestation: o.attestation,
    authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: Array.isArray(o.excludeCredentials) ? o.excludeCredentials.map(descriptor) : [],
  };
}

/** The server's request options, likewise. No allow-list: the phone offers its Hawkeye passkeys. */
function requestOptions(o: Json): Json {
  return {
    challenge: o.challenge,
    rpId: str(o.rpId) ?? PASSKEY_RP_ID,
    timeout: o.timeout,
    userVerification: o.userVerification,
    allowCredentials: Array.isArray(o.allowCredentials) ? o.allowCredentials.map(descriptor) : [],
  };
}

/** What the server's verifyRegistrationResponse expects, from what either OS returned. */
function registrationJSON(c: Json): Json | null {
  const r = (c.response ?? {}) as Json;
  const id = str(c.id) ?? str(c.rawId);
  if (!id || !str(r.clientDataJSON) || !str(r.attestationObject)) return null;
  return {
    id: b64u(id),
    rawId: b64u(str(c.rawId) ?? id),
    type: 'public-key',
    authenticatorAttachment: str(c.authenticatorAttachment),
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64u(r.clientDataJSON),
      attestationObject: b64u(r.attestationObject),
      transports: Array.isArray(r.transports) ? r.transports.filter((t) => typeof t === 'string') : undefined,
    },
  };
}

/** What the server's verifyAuthenticationResponse expects. */
function assertionJSON(c: Json): Json | null {
  const r = (c.response ?? {}) as Json;
  const id = str(c.id) ?? str(c.rawId);
  if (!id || !str(r.clientDataJSON) || !str(r.authenticatorData) || !str(r.signature)) return null;
  return {
    id: b64u(id),
    rawId: b64u(str(c.rawId) ?? id),
    type: 'public-key',
    authenticatorAttachment: str(c.authenticatorAttachment),
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64u(r.clientDataJSON),
      authenticatorData: b64u(r.authenticatorData),
      signature: b64u(r.signature),
      userHandle: str(r.userHandle) ? b64u(r.userHandle) : undefined,
    },
  };
}

/* ---------------------------------------------------------------- errors */

/**
 * What went wrong at the system sheet, from what the module rejected with.
 * iOS: Expo exception codes (ERR_USER_CANCELLED, ERR_BIOMETRIC, ERR_NOT_CONFIGURED…);
 * Android: Credential Manager outcomes as messages (UserCancelled, NoCredentials,
 * "DomError: NotAllowedError - …"). A pressed Cancel is the commonest "failure"
 * and is not an error to the person who pressed it.
 */
export function nativeFailure(e: unknown): string {
  const x = (e ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const s = `${String(x.code ?? '')} ${String(x.name ?? '')} ${String(x.message ?? '')}`;
  if (/NoCredential/i.test(s)) return 'none-here';
  if (/cancel|NotAllowed|AbortError/i.test(s)) return 'cancelled';
  if (/Biometric/i.test(s)) return 'no-lock';
  // iOS 17.4+ answers an excluded credential with AuthorizationError 1006,
  // which the module passes on as an unknown error carrying that text.
  if (/InvalidState|excluded|error 1006\b/i.test(s)) return 'already-here';
  // Expo spells iOS codes with underscores (ERR_NOT_CONFIGURED); Android says NotSupported.
  if (/not_?configured|not_?supported|SecurityError|not associated|ProviderConfiguration/i.test(s)) return 'unavailable';
  return 'failed';
}

/** One sentence for any failure, in the reader's language (web wording where it is the same case). */
export function passkeyErrorText(e: string | undefined): string {
  switch (e) {
    case 'cancelled':
      return i18nT('passkey.cancelled');
    case 'already-here':
    case 'passkey_exists':
      return i18nT('passkey.already-here');
    case 'too_many_passkeys':
      return i18nT('passkey.too-many');
    case 'passkey_failed':
      return i18nT('passkey.failed');
    case 'unavailable':
    case 'unsupported':
    case 'passkeys_unavailable':
      return i18nT('passkey.unavailable');
    case 'network':
      return i18nT('passkey.network');
    case 'none-here':
      return i18nT('n.passkey.none-here');
    case 'no-lock':
      return i18nT('n.passkey.needs-lock');
    default:
      return i18nT('passkey.failed-generic');
  }
}

/* ----------------------------------------------------------------- calls */

export type PasskeyItem = {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  synced: boolean;
};

/**
 * Sign in with a passkey. No phone number: the OS offers this phone's Hawkeye
 * passkeys. On success the session is stored (lib/auth.ts passkeyLogin) and
 * this phone holds the account's phone slot.
 */
export async function signInWithPasskey(): Promise<{ ok: true; needsUnit: boolean } | { ok: false; error: string }> {
  if (!mod || !(await passkeysUsable())) return { ok: false, error: 'unsupported' };
  let options: Json;
  try {
    const r = await passkeyLoginOptions();
    if (!r.ok) return { ok: false, error: r.error };
    options = r.options;
  } catch {
    return { ok: false, error: 'network' };
  }
  let cred: Json | null;
  try {
    cred = await mod.get(requestOptions(options));
  } catch (e) {
    return { ok: false, error: nativeFailure(e) };
  }
  const response = cred ? assertionJSON(cred) : null;
  if (!response) return { ok: false, error: 'cancelled' };
  try {
    const r = await passkeyLogin(response);
    if (r.ok) await markHere(true);
    return r;
  } catch {
    return { ok: false, error: 'network' };
  }
}

/**
 * Make a passkey on this phone for the signed-in account. The device id rides
 * on both calls: the server adds a lasting way in only from a request bound to
 * the device the session belongs to.
 */
export async function registerPasskeyHere(): Promise<{ ok: true; passkeys: PasskeyItem[] } | { ok: false; error: string }> {
  if (!mod || !(await passkeysUsable())) return { ok: false, error: 'unsupported' };
  const id = await getIdentity();
  const dev = { 'x-device-id': id.deviceId };
  let options: Json;
  try {
    const r = await authedSend<{ options?: Json; error?: string }>(
      'POST', '/api/observers/passkeys/register-options', { lang: currentLangForOtp() }, dev,
    );
    if (r.status !== 200 || !r.body?.options) return { ok: false, error: r.body?.error || 'failed' };
    options = r.body.options;
  } catch {
    return { ok: false, error: 'network' };
  }
  let cred: Json | null;
  try {
    cred = await mod.create(creationRequest(options));
  } catch (e) {
    return { ok: false, error: nativeFailure(e) };
  }
  const response = cred ? registrationJSON(cred) : null;
  if (!response) return { ok: false, error: 'cancelled' };
  try {
    const r = await authedSend<{ passkeys?: PasskeyItem[]; error?: string }>(
      'POST', '/api/observers/passkeys/register', { response }, dev,
    );
    if (r.status !== 200) return { ok: false, error: r.body?.error || 'failed' };
    await markHere(true);
    return { ok: true, passkeys: r.body?.passkeys ?? [] };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/** The account's passkeys, for Profile. null = could not load. Needs no native module. */
export async function listPasskeys(): Promise<PasskeyItem[] | null> {
  try {
    const r = await authedSend<{ passkeys?: PasskeyItem[] }>('GET', '/api/observers/passkeys');
    return r.status === 200 ? (r.body?.passkeys ?? []) : null;
  } catch {
    return null;
  }
}

/** Remove one. Needs no native module either. */
export async function removePasskey(id: string): Promise<{ ok: true; passkeys: PasskeyItem[] } | { ok: false; error: string }> {
  try {
    const r = await authedSend<{ passkeys?: PasskeyItem[]; error?: string }>('POST', '/api/observers/passkeys/remove', { id });
    if (r.status !== 200) return { ok: false, error: r.body?.error || 'failed' };
    // This phone's own passkey may be the one that went: offer it again later.
    await markHere(false);
    return { ok: true, passkeys: r.body?.passkeys ?? [] };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/* ------------------------------------------------- the offer after sign-in */

/** Same names as the web's localStorage flags (app/passkey.js, app/app.js). */
const K_HERE = 'hawkeye_pk_here';
const K_LATER = 'hawkeye_pk_offer_later';
const LATER_MS = 30 * 24 * 3600_000;

async function markHere(on: boolean): Promise<void> {
  try {
    if (on) await AsyncStorage.setItem(K_HERE, '1');
    else await AsyncStorage.removeItem(K_HERE);
  } catch {
    /* a courtesy flag */
  }
}

/** "Not now": not asked again on this phone for 30 days. */
export async function offerPasskeyLater(): Promise<void> {
  try {
    await AsyncStorage.setItem(K_LATER, String(Date.now()));
  } catch {
    /* asked again next time, which is all that happens */
  }
}

/**
 * Offer "Sign in faster next time" after this sign-in? Only a RETURNING one,
 * never a brand-new account; not once this phone has a passkey; not within 30
 * days of "Not now"; only where one can be made. Never holds a signed-in person
 * on a spinner: no answer within 3 s means no offer.
 */
export async function shouldOfferPasskey(isNew: boolean): Promise<boolean> {
  if (isNew || !passkeysInBinary()) return false;
  try {
    const [here, later] = await Promise.all([AsyncStorage.getItem(K_HERE), AsyncStorage.getItem(K_LATER)]);
    if (here) return false;
    if (Date.now() - Number(later || 0) < LATER_MS) return false;
  } catch {
    return false;
  }
  return Promise.race([
    createState().then((s) => s === 'yes').catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
}

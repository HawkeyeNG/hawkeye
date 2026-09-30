/**
 * DEVICE SIGNALS sent with a result report or a docket verdict, so the server
 * can count DEVICES, not accounts (backend services/clusters.js).
 *
 * The threat: Hawkeye and Hawkeye Lite on ONE phone, signed in to two
 * accounts, filing the same figures twice. Each app has its own device id, so
 * nothing tied the two together. Two signals do, and both are FEATURE-DETECTED
 * — a build without the native pieces sends neither and behaves exactly as
 * before:
 *
 *  - iOS `shared`: a random id both apps can read from ONE keychain access
 *    group (G99KD9RW94.ng.com.hawkeye.shared — same Apple team). Needs the
 *    keychain-access-groups entitlement (app.config.js), so it exists from the
 *    first store build that carries it (1.0.11); before that the keychain
 *    refuses the group (errSecMissingEntitlement) and this returns nothing.
 *    Stored ThisDeviceOnly: never synced to iCloud, never restored to another
 *    phone. The server keeps only a keyed hash of it.
 *  - Android `sibling`: whether Hawkeye Lite is installed on this phone — a
 *    yes/no, never anything about the other app's account or ids. Needs the
 *    HawkeyeDevice native module and its <queries> entry (modules/
 *    hawkeye-device), so it too starts with 1.0.11.
 *
 * ONE PHONE, ONE COUNTING ACCOUNT PER ELECTION (backend services/deviceClaims.js)
 * adds two more, from the same native module and from the same store build:
 *
 *  - Android `androidId`: Settings.Secure.ANDROID_ID — one value per (this
 *    app's signing key, user, phone), unchanged by an uninstall/reinstall. The
 *    server keeps only a peppered hash of it.
 *  - iOS `dc`: a FRESH Apple DeviceCheck token (DCDevice), only for a result
 *    report (`deviceSignalsField({ deviceCheck: true })`). Not an id — every
 *    token is new — and the server only passes it on to Apple, which keeps two
 *    bits per iPhone that survive erasing it. No entitlement needed.
 *
 * Never throws, never prompts, never blocks a report: any failure is simply a
 * signal not sent.
 */
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/** Must match Lite's HawkeyeDevicePlugin.swift exactly (service, key, group). */
const SHARED = {
  keychainService: 'hawkeye.shared',
  accessGroup: 'G99KD9RW94.ng.com.hawkeye.shared',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
} as const;
const SHARED_KEY = 'device';
const LITE_PACKAGE = 'ng.com.hawkeye.lite';
const HEX64 = /^[0-9a-f]{64}$/;

export type DeviceSignals = {
  app: 'native';
  shared?: string;
  sibling?: boolean;
  androidId?: string;
  dc?: string;
};

/**
 * Every function is optional: which ones exist depends on the platform and on
 * the store build (Android: isPackageInstalled from 1.0.11's module, androidId
 * too; iOS: deviceCheckToken — the module had no iOS half before). Each is
 * feature-detected, so an older binary running newer JS simply sends less.
 */
type HawkeyeDeviceModule = {
  isPackageInstalled?(pkg: string): boolean;
  androidId?(): string | null;
  deviceCheckToken?(): Promise<string | null>;
};
const device = requireOptionalNativeModule<HawkeyeDeviceModule>('HawkeyeDevice');

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

async function sharedId(): Promise<string | undefined> {
  if (Platform.OS !== 'ios') return undefined;
  try {
    const have = await SecureStore.getItemAsync(SHARED_KEY, SHARED);
    if (have && HEX64.test(have)) return have;
    await SecureStore.setItemAsync(SHARED_KEY, toHex(Crypto.getRandomBytes(32)), SHARED);
    // Read back: if Lite wrote at the same moment, whichever landed is the id.
    const back = await SecureStore.getItemAsync(SHARED_KEY, SHARED);
    return back && HEX64.test(back) ? back : undefined;
  } catch {
    return undefined; // no entitlement in this build, or the keychain is locked
  }
}

function siblingInstalled(): boolean | undefined {
  if (Platform.OS !== 'android' || typeof device?.isPackageInstalled !== 'function') return undefined;
  try {
    return device.isPackageInstalled(LITE_PACKAGE) === true;
  } catch {
    return undefined;
  }
}

function androidId(): string | undefined {
  if (Platform.OS !== 'android' || typeof device?.androidId !== 'function') return undefined;
  try {
    const v = String(device.androidId() ?? '').toLowerCase();
    return /^[0-9a-f]{8,32}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A fresh DeviceCheck token, or nothing. Apple can be slow: never more than 3 s. */
async function deviceCheckToken(): Promise<string | undefined> {
  if (Platform.OS !== 'ios' || typeof device?.deviceCheckToken !== 'function') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const t = await Promise.race([
      device.deviceCheckToken(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 3000); }),
    ]);
    return typeof t === 'string' && t.length >= 16 && t.length <= 8192 ? t : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cached: Promise<DeviceSignals> | null = null;

/** The signals that do not change, read once per app run (never the DeviceCheck token). */
export function deviceSignals(): Promise<DeviceSignals> {
  if (!cached) {
    cached = (async () => {
      const out: DeviceSignals = { app: 'native' };
      const shared = await sharedId();
      if (shared) out.shared = shared;
      const sibling = siblingInstalled();
      if (sibling !== undefined) out.sibling = sibling;
      const aid = androidId();
      if (aid) out.androidId = aid;
      return out;
    })().catch(() => ({ app: 'native' as const }));
  }
  return cached;
}

/**
 * The `signals` form/JSON field: a string, or null if even that failed.
 * `deviceCheck: true` (a result report) adds a fresh DeviceCheck token on iOS;
 * a docket verdict does not ask — the server only uses it for reports.
 */
export async function deviceSignalsField(opts: { deviceCheck?: boolean } = {}): Promise<string | null> {
  try {
    const base = await deviceSignals();
    const dc = opts.deviceCheck ? await deviceCheckToken() : undefined;
    return JSON.stringify(dc ? { ...base, dc } : base);
  } catch {
    return null;
  }
}

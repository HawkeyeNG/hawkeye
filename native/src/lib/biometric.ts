/**
 * Require the observer's face or fingerprint before their key signs a report.
 *
 * WHY. The device key IS the observer's identity — a report carries weight
 * because that key signed it. At a polling unit phones get handed over, borrowed,
 * watched and occasionally taken, and an unlocked phone can currently sign a
 * result as its owner. This puts the person back in front of the key at the one
 * moment it matters.
 *
 * NOT the Play "Zero-Tap Sign-In" requirement. That one is about restoring a
 * session on a NEW device via the Restore Credentials API, and is unrelated to
 * this. Shipping this does not satisfy it.
 *
 * ── The rule that shapes every decision below ──
 * AN OBSERVER MUST NEVER BE LOCKED OUT ON ELECTION DAY. The whole product is a
 * person standing at a polling unit with minutes to file. So:
 *
 *   - the KEY AT REST IS NEVER GATED. expo-secure-store offers
 *     `requireAuthentication`, which would have the OS guard the key itself —
 *     and on Android re-enrolling a fingerprint PERMANENTLY invalidates that
 *     keystore entry. For a normal app that means "sign in again"; here it would
 *     destroy the observer's identity and every future report's continuity with
 *     their past ones. The key stays readable; the ACTION is what is guarded.
 *   - IF WE CANNOT ASK, WE PROCEED. No hardware, nothing enrolled, or the native
 *     module throwing all mean the question could not be put — never a reason to
 *     stop someone filing.
 *   - IF WE ASKED AND THEY DID NOT PASS, WE STOP. Failing open there would make
 *     the feature theatre: a stolen phone would sign anyway. The device passcode
 *     is always offered as fallback (`disableDeviceFallback` stays false), which
 *     the owner knows and a thief does not, so a legitimate observer always has
 *     a way through and can simply try again.
 *   - REHEARSALS ARE NOT GATED. See submit.ts — a dry run signs but can never
 *     reach the ledger, and practice is the flow we want people repeating.
 *
 * OPT-IN, default off. This sits on the most important action in the app; adding
 * an auth prompt to it silently, for everyone, is not a change to make on the
 * observer's behalf. Profile turns it on.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';

const PREF_KEY = 'hawkeye_biometric_signing';

/** 'ok' — go ahead and sign. 'cancelled' — the person declined or did not pass. */
export type GateResult = 'ok' | 'cancelled';

/**
 * Can this device ask at all? Hardware present AND something enrolled — a phone
 * with a sensor the owner never set up cannot answer, so it counts as "cannot
 * ask" and the gate stays out of the way.
 */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const [hardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hardware && enrolled;
  } catch {
    return false;
  }
}

/** Has the observer switched this on? Default FALSE — see the header. */
export async function isSigningGateEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(PREF_KEY)) === '1';
  } catch {
    // An unreadable preference must not start gating the critical action.
    return false;
  }
}

export async function setSigningGateEnabled(on: boolean): Promise<void> {
  try {
    if (on) await AsyncStorage.setItem(PREF_KEY, '1');
    else await AsyncStorage.removeItem(PREF_KEY);
  } catch {
    /* the toggle simply does not stick; nothing is broken by that */
  }
}

/**
 * The gate itself. Call immediately before signing a REAL report.
 *
 * Returns 'ok' in every case where the question could not be put, and
 * 'cancelled' only when it was put and not answered successfully.
 */
export async function confirmSigning(): Promise<GateResult> {
  try {
    if (!(await isSigningGateEnabled())) return 'ok';
    if (!(await isBiometricAvailable())) return 'ok';

    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Confirm it is you before signing this result',
      // The owner knows the passcode and a thief does not, so this is the escape
      // hatch that makes "stop on failure" safe rather than a lockout.
      disableDeviceFallback: false,
      cancelLabel: 'Cancel',
    });
    return res.success ? 'ok' : 'cancelled';
  } catch {
    // The module is missing or threw: we could not ask, so we do not block.
    return 'ok';
  }
}

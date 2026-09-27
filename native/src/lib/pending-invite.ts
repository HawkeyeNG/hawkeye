import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { Platform } from 'react-native';

import { normalizeCode, normalizeUnit, parseInstallReferrer, parseInviteLink, type Invite } from '@/lib/invite-parse';

/**
 * THE INVITATION THIS PHONE ARRIVED WITH — the app's half of app/referral.js.
 *
 * Two ways in, parked in one place:
 *
 *   1. ANDROID, FRESH INSTALL. invite.html sends the phone to Play with
 *      `referrer=ref=CODE&unit=PU` (URL-encoded) and Play hands it back through
 *      the Install Referrer API. Read ONCE, on the first signed-out launch.
 *      iOS has no equivalent at all, and never had — there the code travels by
 *      eye (invite.html prints it) and the unit is picked on the chooser.
 *   2. A LINK THAT OPENS THE APP (+native-intent.tsx): /open or hawkeye:// with
 *      `ref` / `r` and `unit`. Both platforms.
 *
 * USED EXACTLY WHERE THE WEB USES IT. The code rides on /api/observers/verify
 * as `referralCode` (lib/auth.ts), and the unit opens the sign-up chooser
 * selected — not saved (sign-in.tsx → /choose-unit?onboard=1&unit=…).
 *
 * NEVER OVERRIDES AN ACCOUNT'S CODE. The server records a referral only when
 * /verify CREATES the observer, and the first one wins; a code sent for an
 * existing account is dropped there. This side adds: the install referrer is
 * not even read for someone already signed in (an update, not an install).
 *
 * CLEARED AFTER USE. The code after a successful verify — whatever it
 * answered, that number now has an account, so the code can never apply again.
 * The unit when the chooser is opened with it, or at once when no chooser
 * follows. A failed verify keeps both, so a retry still carries them.
 *
 * AsyncStorage, like the invite and tour flags: none of this is secret — the
 * code is printed on a public page — and every failure here is quiet. An
 * invitation is never worth an error on the sign-up path.
 */
const K_CODE = 'hawkeye.invite.code';
const K_UNIT = 'hawkeye.invite.unit';
/** 'done', or how many reads have been tried (a Play service can be briefly away). */
const K_REFERRER = 'hawkeye.invite.referrer-read';
const MAX_TRIES = 3;

async function park(inv: Invite, overwrite: boolean): Promise<void> {
  if (!inv.code) return;
  const before = await AsyncStorage.getItem(K_CODE);
  // A link the reader tapped is newer, and more deliberate, than the store
  // install that preceded it: the referrer does not replace it.
  if (before && !overwrite) return;
  await AsyncStorage.setItem(K_CODE, inv.code);
  // As referral.js: a DIFFERENT invitation without a unit clears the old unit,
  // which belonged to someone else's invitation; the same code without one
  // leaves it alone.
  if (inv.unit) await AsyncStorage.setItem(K_UNIT, inv.unit);
  else if (before && before !== inv.code) await AsyncStorage.removeItem(K_UNIT);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('install referrer timed out')), ms)),
  ]);
}

async function readReferrerOnce(signedIn: boolean): Promise<void> {
  const seen = await AsyncStorage.getItem(K_REFERRER);
  if (seen === 'done') return;
  const tries = Number(seen) || 0;
  if (signedIn || tries >= MAX_TRIES) {
    await AsyncStorage.setItem(K_REFERRER, 'done');
    return;
  }
  // Counted BEFORE the call, so a read that hangs or crashes still uses a try.
  await AsyncStorage.setItem(K_REFERRER, String(tries + 1));
  const raw = await withTimeout(Application.getInstallReferrerAsync(), 8000);
  await park(parseInstallReferrer(raw), false);
  await AsyncStorage.setItem(K_REFERRER, 'done');
}

let reading: Promise<void> | null = null;

/** Root layout, once auth has resolved. Android only; resolves, never rejects. */
export function captureInstallReferrer(signedIn: boolean): Promise<void> {
  if (Platform.OS !== 'android') return Promise.resolve();
  if (!reading) {
    reading = readReferrerOnce(signedIn)
      .catch(() => {
        /* no Play Store, service away, timed out: tried again next launch */
      })
      .finally(() => {
        reading = null;
      });
  }
  return reading;
}

/** +native-intent.tsx, for every link that opens the app. Fire and forget. */
export function captureInviteLink(url: unknown): void {
  const inv = parseInviteLink(url);
  if (inv.code) park(inv, true).catch(() => {});
}

/** The code to send with /verify, or undefined (so JSON leaves the field out). */
export async function pendingInviteCode(): Promise<string | undefined> {
  try {
    if (reading) await reading;
    return normalizeCode(await AsyncStorage.getItem(K_CODE)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * After a SUCCESSFUL verify. The code is spent either way. The unit stays only
 * when the sign-up chooser is about to be offered (a new account, or one with no
 * unit saved) — sign-in.tsx then takes it.
 */
export async function settleInviteAfterVerify(r: { isNew?: boolean; needsUnit?: boolean }): Promise<void> {
  try {
    await AsyncStorage.removeItem(K_CODE);
    if (!(r.isNew === true || r.needsUnit === true)) await AsyncStorage.removeItem(K_UNIT);
  } catch {
    /* nothing to clear */
  }
}

/** The invited unit for the sign-up chooser — read AND cleared. */
export async function takeInviteUnit(): Promise<string | null> {
  try {
    const unit = normalizeUnit(await AsyncStorage.getItem(K_UNIT));
    await AsyncStorage.removeItem(K_UNIT);
    return unit;
  } catch {
    return null;
  }
}

export function clearInviteUnit(): void {
  AsyncStorage.removeItem(K_UNIT).catch(() => {});
}

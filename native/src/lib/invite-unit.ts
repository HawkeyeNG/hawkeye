import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Share } from 'react-native';

import { authedGet } from '@/lib/auth';
import { t as i18nT } from '@/lib/i18n';
import type { SavedUnit } from '@/lib/my-unit';
import { myReferral } from '@/lib/referral';

/**
 * "BRING A SECOND OBSERVER TO YOUR UNIT" — the app's half of app/invite-unit.js.
 *
 * One report at a unit shows as REPORTED; it turns VERIFIED when a second
 * observer at the same unit reports the same numbers. So the most useful person
 * an observer can recruit is someone who will stand at THEIR unit. This is the
 * ordinary invite (lib/referral.ts) with the sender's unit added:
 *
 *     https://hawkeye.com.ng/invite.html?ref=CODE&unit=NN-NN-NN-NNN
 *
 * and on the website a recipient who signs up lands on the chooser with that
 * unit selected. /choose-unit here takes the same `unit` param.
 *
 * THE ORIGIN IS WRITTEN OUT. Never BASE: that follows EXPO_PUBLIC_API_BASE,
 * which is a dev server on a dev build, and a link someone SENDS has left this
 * device — it must name the live site (the web's Lite shell once shipped
 * invites that pointed at the sender's own phone).
 *
 * WHAT IT CARRIES: the referral code and the unit code the sender chose to
 * share. No names, in the link or in the message. The server is not told which
 * unit an invite was for, so nothing public says a unit is being watched.
 *
 * Every string is resolved when it is used, never at import (lib/i18n.tsx).
 */
export const INVITE_ORIGIN = 'https://hawkeye.com.ng';

/** The register's canonical form (lib/pu-code.ts). Anything else is dropped. */
const PU_RE = /^\d{2}-\d{2}-\d{2}-\d{3}$/;
export const isUnitCode = (s: unknown): s is string => typeof s === 'string' && PU_RE.test(s);

export function inviteUnitUrl(code: string, puCode: string): string {
  const url = `${INVITE_ORIGIN}/invite.html?ref=${encodeURIComponent(code)}`;
  return isUnitCode(puCode) ? `${url}&unit=${encodeURIComponent(puCode)}` : url;
}

/**
 * The saved unit: the unit, null when none is saved, undefined when it could
 * not be asked (signed out, offline) — so a failed request never reads as "no
 * unit" and never offers the chooser to someone who has one.
 */
export async function mySavedUnit(): Promise<SavedUnit | null | undefined> {
  try {
    const r = await authedGet<{ ok?: boolean; unit?: SavedUnit | null }>('/api/observers/my-unit', {
      signOutOn401: false,
    });
    if (!r || r.ok === false) return undefined;
    return r.unit && isUnitCode(r.unit.pu_code) ? r.unit : null;
  } catch {
    return undefined;
  }
}

/** The link for a unit, or null when the referral code cannot be had. */
export async function inviteUnitLink(puCode: string): Promise<string | null> {
  const ref = await myReferral();
  return ref ? inviteUnitUrl(ref.code, puCode) : null;
}

/**
 * The OS share sheet. Same platform split as lib/share.ts, for the same
 * reason: iOS takes the link as its own item (or prints it twice), Android
 * carries one text extra and ignores `url`. True when it was sent — iOS
 * reports a dismissal; Android always reports "shared".
 */
export async function shareInviteUnit(url: string): Promise<boolean> {
  const message = i18nT('n.invite2.share-text');
  try {
    const r = await Share.share(
      Platform.OS === 'ios' ? { message, url, title: 'Hawkeye' } : { message: `${message} ${url}`, title: 'Hawkeye' },
      { dialogTitle: i18nT('n.invite2.button') },
    );
    return r.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}

/**
 * ONCE per device, right after a unit is saved in the chooser. AsyncStorage,
 * like the tour's flag; an unreadable flag means "do not ask", the quiet
 * direction.
 */
const OFFERED_KEY = 'hawkeye.invite2.offered';

/**
 * Whether to offer the invite after saving `puCode`, and the link if so.
 * Not when it has been offered before, not when the unit saved is the one an
 * invitation brought (that reader IS the second observer), and not when the
 * link cannot be made within a few seconds — the chooser then leaves exactly
 * as it always did.
 */
export async function inviteAfterSave(puCode: string, invitedCode?: string | null): Promise<string | null> {
  if (!isUnitCode(puCode) || (invitedCode && invitedCode === puCode)) return null;
  try {
    if (await AsyncStorage.getItem(OFFERED_KEY)) return null;
  } catch {
    return null;
  }
  const url = await Promise.race([
    inviteUnitLink(puCode),
    new Promise<null>((r) => setTimeout(() => r(null), 4000)),
  ]).catch(() => null);
  if (!url) return null;
  AsyncStorage.setItem(OFFERED_KEY, '1').catch(() => {});
  return url;
}

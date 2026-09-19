/**
 * The observer's own invite link — the app's half of app/profile.html's
 * invite card.
 *
 * WHY IT IS ON THE PROFILE AT ALL. Hawkeye's binding constraint is not
 * capability, it is how few people are standing at a unit with it: Osun drew
 * twelve organic observers against 3,763 polling units. The only channel that
 * reaches 176,846 units is one observer handing it to the next person, so the
 * invite sits on a screen they already visit rather than behind a menu.
 *
 * ITS OWN REQUEST, NOT A FIELD ON /me. Minting a code WRITES to the observers
 * row, and /me is read on every visit to that screen by everybody — including
 * people who will never open an invite link. A column that stays null until
 * somebody asks for it is one less thing to backfill.
 *
 * FAILS QUIET. An invite is the least important thing on the profile; if this
 * request dies the rest of the screen must still render.
 */
import { authedGet } from '@/lib/auth';

/** Where an invite lands. `invite.html` routes the phone to its own store and
 *  carries the code through Play's install referrer; iOS has no equivalent, so
 *  the page prints the code for the reader to type. See app/invite.html. */
const INVITE_BASE = 'https://hawkeye.com.ng/invite.html?r=';

export type Referral = {
  code: string;
  url: string;
  /** Made an account. */
  signedUp: number;
  /** Went on to file an accepted RESULT report. Only this one would ever be
   *  paid on, which is why both are shown from the start rather than the
   *  second being introduced alongside a payout. */
  qualified: number;
};

export async function myReferral(): Promise<Referral | null> {
  try {
    const r = await authedGet<{ code?: string; signedUp?: number; qualified?: number }>(
      '/api/observers/referral',
      { signOutOn401: false },
    );
    if (!r?.code) return null;
    return {
      code: r.code,
      url: INVITE_BASE + encodeURIComponent(r.code),
      signedUp: Number(r.signedUp) || 0,
      qualified: Number(r.qualified) || 0,
    };
  } catch {
    return null;
  }
}

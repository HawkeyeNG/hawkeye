/**
 * Attendance from inside the report flow.
 *
 * WHY IT LIVES HERE AND NOT IN THE SITUATION ROOM. On election day an agent is
 * in the report flow; the room is where their coordinator sits. Presence typed
 * into a separate screen is presence most agents will never record.
 *
 * WHY MOST PEOPLE NEVER SEE IT. `/api/my/rooms` is empty for anyone not on a
 * roster, so the control renders for nobody else. The SERVER decides, not this
 * file: Hawkeye's premise is that every citizen is an observer, and showing a
 * lone voter a button that says "let your coordinator know" would invent an
 * authority over them that does not exist.
 *
 * The web twin is app.js (loadMyRooms / renderCheckIn / doFlowCheckIn). These
 * are two renderers over one server rule, so there is nothing here to compare
 * against it — the rule is the endpoint.
 */
import { BASE } from '@/lib/api';
import { authedGet, getToken } from '@/lib/auth';
import { t as i18nT } from '@/lib/i18n';
import { trySubmitFix } from '@/lib/location';
import { bust, fresh } from '@/lib/signed-in-cache';

const ROOMS_KEY = '/api/my/rooms';

export type RoomAssignment = {
  pu_code: string;
  name: string;
  ward: string;
  lga: string;
  state: string;
};

export type MyRoom = {
  id: number;
  name: string;
  kind: string;
  contest: string;
  assigned: RoomAssignment | null;
  checkedIn: { at: number; standing: string; pu_code: string } | null;
};

/**
 * Rooms the signed-in observer is on the roster of. Empty for everybody else,
 * and empty when anything goes wrong: a roster lookup must never be able to
 * block or delay a report.
 */
export async function myRooms(): Promise<MyRoom[]> {
  try {
    /* D6: kept 120 s (lib/signed-in-cache.ts) — three races filed at one unit
       were three identical lookups. checkIn() below drops it on success, so the
       card re-reads what it just changed; a push drops it too. */
    const r = await fresh(ROOMS_KEY, getToken(), () =>
      authedGet<{ rooms: MyRoom[] }>('/api/my/rooms', { signOutOn401: false }));
    return Array.isArray(r?.rooms) ? r.rooms : [];
  } catch {
    return [];
  }
}

/** Drop the kept roster answer, after a write that changes it (app/my-groups.tsx). */
export function forgetRooms(): void {
  bust(ROOMS_KEY);
}

export type CheckInResult =
  | { ok: true; standing: 'verified' | 'plausible' | 'unverified' }
  | { ok: false; error: string };

/**
 * One tap, every room. Standing at a unit is a single fact about a person; an
 * agent on a campaign roster AND a CSO roster should not have to say it twice,
 * and should not have to know which rooms they are in.
 *
 * `puCode` is the unit they are REPORTING FROM, not the one they were assigned
 * — the point is to record where they actually are, and the server compares
 * the two.
 */
export async function checkIn(
  puCode: string,
  fix: { lat: number; lng: number; accuracy: number },
): Promise<CheckInResult> {
  const token = getToken();
  if (!token) return { ok: false, error: 'not_signed_in' };
  try {
    const res = await fetch(`${BASE}/api/my/check-in`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pu_code: puCode, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }),
    });
    const body = await res.json().catch(() => ({}));
    // A 401 is its own answer whatever the body calls it ('invalid_token',
    // 'unauthorized', …): the fix and the unit were fine, the session was not.
    if (res.status === 401) return { ok: false, error: 'signed_out' };
    if (res.status !== 200) return { ok: false, error: String(body?.error || 'failed') };
    bust(ROOMS_KEY);
    return { ok: true, standing: body.standing };
  } catch {
    return { ok: false, error: 'network' };
  }
}

/**
 * Every way a check-in can fail, as ONE vocabulary for every native caller.
 *
 * WHY THIS EXISTS (flow walkthrough R-CHECKIN-OFFLINE-BLAMES-GPS). Each caller
 * used to print "Could not read your location. Move into the open" for every
 * failure — so an agent with a perfect GPS fix and no data on election morning
 * was sent outside to fix the one thing that was working. The two awaits fail
 * for different reasons and are now told apart: the FIX (location, or a
 * permission the agent refused) and the REQUEST (no connection, a session that
 * lapsed, or a server refusal with its own code).
 */
export type CheckInFailure =
  | 'denied'        // location permission refused
  | 'location'      // permission fine, no usable fix (timeout, services off, error)
  | 'network'       // the request never reached Hawkeye
  | 'signed_out'    // 401
  | 'no_fix'        // the server judged the fix unusable
  | 'no_rooms'      // not on any roster (any more)
  | 'no_such_unit'  // the unit is not in the register
  | 'server';       // anything else the server said

export type CheckInOutcome =
  | { ok: true; standing: 'verified' | 'plausible' | 'unverified' }
  | { ok: false; why: CheckInFailure };

const SERVER_CODES: Record<string, CheckInFailure> = {
  network: 'network',
  signed_out: 'signed_out',
  not_signed_in: 'signed_out',
  no_fix: 'no_fix',
  no_rooms: 'no_rooms',
  no_such_unit: 'no_such_unit',
};

/**
 * Take the fix, then check in at `puCode` — the two awaits every caller made,
 * with their failures kept apart. The fix is the submit-grade one, same as
 * the report itself uses, so a check-in never claims more than a report could.
 */
export async function checkInAt(puCode: string): Promise<CheckInOutcome> {
  const got = await trySubmitFix();
  if (!got.ok) return { ok: false, why: got.reason === 'denied' ? 'denied' : 'location' };
  const r = await checkIn(puCode, got.fix);
  if (r.ok) return r;
  return { ok: false, why: SERVER_CODES[r.error] ?? 'server' };
}

/**
 * The line to show for a failure. Resolved per call, never at import — see
 * lib/i18n.tsx on why a module-level translated string freezes in English.
 * The web keys are shared with app.js doFlowCheckIn, so both clients say the
 * same sentence for the same failure.
 */
export function checkInFailureLine(why: CheckInFailure): string {
  switch (why) {
    case 'denied':
      return i18nT('observe.check-in-denied');
    case 'location':
      return i18nT('n.app.report.result.check-in-failed');
    case 'network':
      return i18nT('observe.check-in-offline');
    case 'signed_out':
      return i18nT('n.lib.check-in.signed-out');
    case 'no_fix':
      return i18nT('observe.check-in-no-fix');
    case 'no_rooms':
      return i18nT('observe.check-in-not-member');
    case 'no_such_unit':
      return i18nT('observe.check-in-no-such-unit');
    default:
      return i18nT('n.lib.check-in.server-failed');
  }
}

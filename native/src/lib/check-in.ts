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
    const r = await authedGet<{ rooms: MyRoom[] }>('/api/my/rooms', { signOutOn401: false });
    return Array.isArray(r?.rooms) ? r.rooms : [];
  } catch {
    return [];
  }
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
    if (res.status !== 200) return { ok: false, error: String(body?.error || 'failed') };
    return { ok: true, standing: body.standing };
  } catch {
    return { ok: false, error: 'network' };
  }
}

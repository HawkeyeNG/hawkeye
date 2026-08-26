/**
 * Hawkeye API client — read-side endpoints used by the shell.
 * Base is the production origin; the origin lock only guards non-public
 * routes, everything here is the same public API the website consumes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Production, unless a dev build points somewhere else.
 *
 * EXPO_PUBLIC_API_BASE exists for one job: running the app in a desktop browser
 * via `npm run web`. There the app's calls become real cross-origin browser
 * requests, and production sends no Access-Control-Allow-Origin — so every one
 * is blocked and the app can only say "network error, try again", which looks
 * exactly like the connection being down.
 *
 * Pointed at a local backend (which allows loopback origins in dev; see
 * server.js) the same build works in a browser. Unset in every real build, so
 * devices are unaffected.
 */
export const BASE = process.env.EXPO_PUBLIC_API_BASE || 'https://hawkeye.com.ng';

export type Contest = {
  code: string;
  name: string;
  election: string;
  date: string; // YYYY-MM-DD
  states: string[];
  /**
   * The SHAPE a contest behaves as, when it is not its own code: a by-election
   * for a federal seat is a `REP` in every way except identity. Absent for the
   * five general contests, where code and tier are the same string.
   */
  tier?: string;
  /**
   * The named constituencies a contest is confined to — what makes a by-election
   * a by-election. Present means the whole election is these places, so the
   * board IS the race and there is no wider total to rank it against.
   */
  constituencies?: string[];
  open: boolean;
  opensAt?: string;
};

/**
 * When reporting opens for a contest, as a sentence.
 *
 * A scheduled election opens at poll-open on election day (the server sends
 * open:false + opensAt until then). NAMING THE INSTANT is the whole point: an
 * observer who is told "not open" without a time comes back at random. It gives
 * the time as well as the day because between midnight and 08:30 on polling day
 * a report is still refused, and "opens 16 January" would read as broken to
 * someone standing at a unit at seven in the morning.
 *
 * Lived in report/collation.tsx until the race page's blocked modal needed the
 * same sentence. One phrasing, two screens.
 */
export function opensLine(c: Contest | null | undefined): string {
  if (!c || !c.opensAt) return 'Reporting has not opened for this election yet.';
  const d = new Date(c.opensAt);
  if (Number.isNaN(d.getTime())) return `Reporting opens ${c.opensAt}.`;
  return `Reporting opens ${d.toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  })}.`;
}

/**
 * Seat magnitude — Presidential > Governorship > Senate > Reps > State Assembly.
 *
 * BY TIER, NOT BY CODE. A by-election for a House seat is a House race: its CODE
 * (REP_BYE_GOMBE_2026) is its identity, its TIER is its category. Sorting on the
 * code put all three by-elections ABOVE the presidency, because `indexOf`
 * returns -1 for a code it does not list and -1 sorts first. An unrecognised
 * contest now sorts LAST, which is the safe end: a new contest appearing at the
 * bottom is untidy, one appearing above the presidency is a claim about its
 * importance.
 *
 * Within a category the general election leads and its by-elections follow, by
 * date then by state, so a category reads as "the race, then the seats being
 * filled out of cycle".
 *
 * It lives HERE, next to Contest, rather than in whichever screen needed it
 * first — two native screens and two web pages each kept their own copy, and
 * four copies of an ordering rule is three chances for the app to disagree with
 * itself about which race comes first. Keep byte-similar to the copies in
 * app/results.html and app/races.html, which cannot import from here.
 */
const SEAT_ORDER = ['PRES', 'GOV', 'SEN', 'REP', 'SHA'];
const tierOf = (c: Contest) => c.tier || c.code;
const seatRank = (c: Contest) => {
  const i = SEAT_ORDER.indexOf(tierOf(c));
  return i < 0 ? SEAT_ORDER.length : i;
};
const isGeneral = (c: Contest) => tierOf(c) === c.code;
export const bySeat = (x: Contest, y: Contest) =>
  seatRank(x) - seatRank(y)
  || Number(!isGeneral(x)) - Number(!isGeneral(y))
  || String(x.date || '').localeCompare(String(y.date || ''))
  || String((x.states || [])[0] || '').localeCompare(String((y.states || [])[0] || ''))
  || String(x.name || '').localeCompare(String(y.name || ''));


/**
 * How an election is named on a card.
 *
 * The catalogue's `election` string is singular — "2027 Governorship Election"
 * — which is true of the presidency and of nothing else on the list. There are
 * 28 governorships in the 2027 cycle, 109 Senate seats, 360 federal seats and
 * 993 state-assembly seats; calling any of those "Election" reads as one race
 * being announced.
 *
 * "NASS" for the National Assembly because the full name plus a chamber ran to
 * three lines on a phone, and NASS is what the institution is called in Nigeria
 * — this is not an abbreviation a reader here has to decode.
 *
 * Keyed by CODE, not by munging the server's text: a wording change upstream
 * would silently stop matching a string rule and quietly restore the singular.
 */
const CARD_ELECTION: Record<string, string> = {
  PRES: '2027 Presidential Election',      // one race, nationwide — singular is right
  GOV: '2027 Governorship Elections',
  SEN: '2027 NASS Elections',
  REP: '2027 NASS Elections',
  SHA: '2027 State Assembly Elections',
};

/** Shorter chamber labels; "House of Representatives" alone wraps a card. */
const CARD_CHAMBER: Record<string, string> = {
  SEN: 'Senate',
  REP: 'House of Reps',
};

/**
 * The card headline. Senate and Reps share one election, so the chamber is
 * appended only where it is needed to tell two cards apart — the same rule as
 * before, applied to the plural names.
 */
export function electionTitle(c: Contest, all?: Contest[] | null): string {
  const base = CARD_ELECTION[c.code] ?? c.election;
  const shared = (all ?? []).filter(
    (x) => (CARD_ELECTION[x.code] ?? x.election) === base,
  ).length > 1;
  if (!shared) return base;
  return `${base} — ${CARD_CHAMBER[c.code] ?? c.name}`;
}


export type NationalRow = {
  party: string;
  votes: number;
  units?: number;
};

/**
 * One region of a board, as backend/src/routes/national.js actually sends it.
 *
 * This declaration used to read `{ name, rows }`, a shape the server has never
 * sent, so every caller reached the real fields through a double cast and the
 * type checked nothing. Corrected here once, at the boundary.
 */
export type NationalRegion = {
  region: string;
  leader: string | null;
  leaders: string[];
  votes: Record<string, number>;
  unitsReporting: number;
  unitsVerified: number;
};

export type National = {
  contest: string;
  level: string;
  /** Set when the contest runs in ONE state — the map crops and zooms to it. */
  scope?: { state: string } | null;
  /** Every sub-unit in scope, reported or not, so the map draws before any results exist. */
  subunits?: string[];
  updatedAt: number;
  unitsReporting: number;
  inDispute: number;
  national: NationalRow[];
  regions: NationalRegion[];
};

export type Party = { code: string; name: string };

export type Incident = {
  id: number;
  kind: string;
  state?: string;
  lga?: string;
  text?: string;
  media?: { file: string; type: 'image' | 'video' }[];
  created_at: number;
};

export type IntegritySummary = {
  total: number;
  unitsFlagged: number;
  reports: number;
  bySeverity: { severity: string; c: number }[];
  byType: { type: string; c: number }[];
};

/**
 * React Native's fetch has NO default timeout, so a stalled connection hangs
 * this promise indefinitely. Callers that swallow the rejection then render an
 * eternal spinner — which is exactly how the report screen sat on "Loading
 * election…" forever instead of ever saying something was wrong.
 *
 * 12s is past the ~6.4s a good link takes for the slowest of these, and short
 * enough that an observer at a polling unit is not staring at nothing. One
 * retry, because the common failure here is a single dropped request on mobile
 * data rather than a dead server.
 */
const TIMEOUT_MS = 12_000;

async function get<T>(path: string, tries = 2): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { accept: 'application/json' },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`${path} -> ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${path} failed`);
}

/**
 * Contests, remembered.
 *
 * Every report screen is gated on this one list: the race picker needs it to
 * know what is open, and the header prints contests[0].election. When the fetch
 * failed the screen showed "Loading election…" indefinitely — a permanent
 * loading state standing in for an error, on the screen an observer opens at a
 * polling unit with the worst connection they will have all day.
 *
 * One successful load is now enough forever. Cached on success, served from
 * cache on any later failure, and validated on read so a bad entry from an
 * older build heals itself instead of poisoning every launch.
 */
const CONTESTS_KEY = 'hk_contests_v1';

const usableContests = (v: unknown): v is Contest[] =>
  Array.isArray(v) && v.length > 0 && v.every((c) => c && typeof (c as Contest).code === 'string');

async function contestsWithCache(): Promise<Contest[]> {
  try {
    const live = await get<Contest[]>('/api/contests');
    if (!usableContests(live)) throw new Error('/api/contests returned nothing usable');
    AsyncStorage.setItem(CONTESTS_KEY, JSON.stringify(live)).catch(() => {});
    return live;
  } catch (err) {
    try {
      const raw = await AsyncStorage.getItem(CONTESTS_KEY);
      const cached: unknown = raw ? JSON.parse(raw) : null;
      if (usableContests(cached)) return cached;
      if (raw) await AsyncStorage.removeItem(CONTESTS_KEY);
    } catch { /* unreadable cache — report the network failure instead */ }
    throw err;
  }
}

/**
 * Whether the server can actually deliver an SMS one-time code.
 *
 * Nigerian carriers drop SMS from unapproved sender IDs, so for months codes
 * sent that way silently never arrived and the option was hard-removed from
 * every client. That put the answer in three places — the website, the APK and
 * whatever build a given observer had installed — and turning SMS on meant a
 * redeploy AND two rebuilds. /api/health publishes the switch instead
 * (`smsOtp`, a boolean, no secret), so one server flag turns it on everywhere.
 *
 * FAILS CLOSED. No answer, no SMS option: the backend quietly falls back to
 * WhatsApp for an unroutable `sms` request, and an option that silently
 * delivers somewhere else is worse than no option at all. `get()` already
 * carries the 12s deadline and one retry, so a single dropped request on
 * mobile data does not decide this.
 */
async function smsOtpEnabled(): Promise<boolean> {
  try {
    const h = await get<{ smsOtp?: boolean }>('/api/health');
    return h?.smsOtp === true;
  } catch {
    return false;
  }
}

export const api = {
  contests: contestsWithCache,
  smsOtpEnabled,
  /**
   * A contest's board. `state` crops it to one state and subdivides one level
   * finer; `level` asks for a specific breakdown — a race map draws LGAs, and a
   * senatorial contest's own breakdown is by district, so it has to say so.
   */
  national: (contest: string, opts?: { state?: string; level?: string }) => {
    const q = new URLSearchParams();
    if (opts?.state) q.set('state', opts.state);
    if (opts?.level) q.set('level', opts.level);
    const s = q.toString();
    return get<National>(`/api/national/${encodeURIComponent(contest)}${s ? `?${s}` : ''}`);
  },
  parties: () => get<Party[]>('/api/parties'),
  incidents: () => get<{ incidents: Incident[] }>('/api/incidents'),
  integrity: () => get<IntegritySummary>('/api/integrity/summary'),
  states: (contest: string) =>
    get<string[]>(`/api/register/states?contest=${encodeURIComponent(contest)}`),
};

export const BRAND = {
  green: '#004225',
  leaf: '#0b6b3a',
  gold: '#f5b301',
  ink: '#10221a',
  mist: '#e8f2ec',
} as const;

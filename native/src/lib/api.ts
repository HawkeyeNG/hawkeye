/**
 * Hawkeye API client — read-side endpoints used by the shell.
 * Base is the production origin; the origin lock only guards non-public
 * routes, everything here is the same public API the website consumes.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE = 'https://hawkeye.com.ng';

export type Contest = {
  code: string;
  name: string;
  election: string;
  date: string; // YYYY-MM-DD
  states: string[];
  open: boolean;
  opensAt?: string;
};

export type NationalRow = {
  party: string;
  votes: number;
  units?: number;
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
  regions: { name: string; rows: NationalRow[] }[];
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
  national: (contest: string) => get<National>(`/api/national/${contest}`),
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

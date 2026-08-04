/**
 * Hawkeye API client — read-side endpoints used by the shell.
 * Base is the production origin; the origin lock only guards non-public
 * routes, everything here is the same public API the website consumes.
 */
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  contests: () => get<Contest[]>('/api/contests'),
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

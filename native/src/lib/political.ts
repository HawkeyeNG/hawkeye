/**
 * political_data.json + the party-emblem manifest — the same two static files
 * the website reads. Fetched once per app run and memoised: the data changes on
 * the order of weeks, and three screens want it.
 */
const BASE = 'https://hawkeye.com.ng';

export type Candidate = {
  name: string;
  party: string;
  initials?: string;
  line?: string;
  home?: string;
  bids?: string;
  status?: string;
  incumbent?: boolean;
  photo?: string;
};

export type Minor = { name: string; party: string; meta?: string };

export type Race = {
  asOf?: string;
  office?: string;
  election?: string;
  date?: string;
  note?: string;
  photoCredit?: string;
  incumbentNote?: string;
  notableAbsence?: string;
  stats?: { lgas?: number; pollingUnits?: number; candidates?: number };
  candidates: Candidate[];
  others?: Candidate[];
  minors?: Minor[];
};

export type Political = {
  note?: string;
  president?: { name: string; party: string };
  governors?: Record<string, string>;
  provisional?: string;
  upcoming?: {
    note?: string;
    elections: { office: string; seats: string; when: string; scope: string }[];
  };
  composition?: {
    asOf?: string;
    note?: string;
    chambers: Record<
      string,
      { label: string; size: number; total: number; parties: Record<string, number> }
    >;
  };
  race2027?: Race;
  raceOsun2026?: Race;
};

/** Party brand colours, carried over from the web pages verbatim. */
const PC: Record<string, string> = {
  APC: '#2e7d32',
  PDP: '#c62828',
  LP: '#388e3c',
  NNPP: '#1565c0',
  APGA: '#f9a825',
  SDP: '#5e35b1',
  ADC: '#00897b',
  YPP: '#ef6c00',
  APM: '#283593',
  NDC: '#2e3192',
  NRM: '#827717',
  ADP: '#455a64',
  AA: '#3e2723',
  BOOT: '#37474f',
  Accord: '#00838f',
  /** INEC's ballot code for Accord — political_data uses it for Osun. */
  A: '#00838f',
};

export const partyColor = (p: string) => PC[p] || '#9aa7a0';

/** Ballot codes that are not the party's common name. */
const PARTY_NAME: Record<string, string> = { A: 'Accord' };

/** Display label for a party code — "A" alone tells a reader nothing. */
export const partyName = (p: string) => (PARTY_NAME[p] ? `${PARTY_NAME[p]} (${p})` : p);

let cache: Promise<{ data: Political; logos: Record<string, string> }> | null = null;

export function loadPolitical() {
  if (!cache) {
    cache = Promise.all([
      fetch(`${BASE}/political_data.json`).then((r) => r.json() as Promise<Political>),
      fetch(`${BASE}/logos/manifest.json`)
        .then((r) => r.json() as Promise<Record<string, string>>)
        .catch(() => ({})),
    ]).then(([data, logos]) => ({ data, logos }));
  }
  return cache;
}

export const logoUrl = (logos: Record<string, string>, party: string) =>
  logos[party] ? `${BASE}/${logos[party]}` : null;

// WHICH IReV ELECTION IS OUR RACE? Resolved, never hardcoded.
//
// services/irev.js has sat idle since it was written because IREV_ELECTION_ID
// was never set, and it could not have been: INEC mints a new id per election
// and the 2027 ones will not exist until they stand the instance up. This
// discovers them instead, from INEC's own catalogue, and records what it found.
//
// THE ID MODEL, read off the live API (400 elections listed on 2026-09-14):
// one record per (election_type x domain) on a date. "Governorship election -
// 2026-08-15 - OSUN" is one id; a Senate seat is its own id; the presidency is
// one id over a nationwide domain. So January 2027 is not one id or three — it
// is ONE presidential id plus one per senatorial district plus one per federal
// constituency, each resolved separately.
//
// THE BASE URL IS ALSO NOT FIXED. INEC's front-end bundle carries three of
// them (a throwaway DigitalOcean app name, a herokuapp, and one on their own
// domain). Hardcoding the one we happened to see is the same failure as
// hardcoding the id, one layer down, so the host is probed and recorded too.
import { db, contests } from '../db.js';

/* Order matters: their own domain first, the app-platform names after, because
   a vendor-hosted name is the one most likely to be retired between cycles. */
export const BASES = [
  'https://lv001-r.inecelectionresults.ng/api/v1',
  'https://dolphin-app-sleqh.ondigitalocean.app/api/v1',
  'https://irev-v2.herokuapp.com/api/v1',
];

const H = { 'user-agent': 'Mozilla/5.0' };

/** First base whose /elections answers with the catalogue. Cached per process. */
let cachedBase = null;
export async function resolveBase(force = false) {
  if (cachedBase && !force) return cachedBase;
  for (const base of BASES) {
    try {
      const r = await fetch(`${base}/elections`, { headers: H, signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j?.data) && j.data.length) { cachedBase = base; return base; }
    } catch { /* try the next one */ }
  }
  return null;
}

export async function fetchCatalogue(base) {
  const r = await fetch(`${base}/elections`, { headers: H, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`/elections -> ${r.status}`);
  return (await r.json())?.data || [];
}

/**
 * IReV stores a Nigerian polling date as midnight WAT expressed in UTC, so Osun's
 * 15 Aug reads "2026-08-14T23:00:00.000Z". Comparing the ISO date directly is off
 * by one for EVERY election; shifting into WAT before taking the date is the whole
 * correction.
 */
export const wat = (iso) => new Date(new Date(iso).getTime() + 3600000).toISOString().slice(0, 10);

/* Our contest codes -> IReV's election_type.code. */
export const CODE_MAP = {
  PRES: 'PRES', GOV: 'GOV', SEN: 'SEN', REP: 'REPS', SHA: 'ASSEMBLY',
};

/**
 * Every IReV election on a given date, annotated with the contest code we use.
 * Matching is by DATE AND TYPE only — the geographic half is left to the caller,
 * because a Senate race maps to a district and this function must not pretend to
 * know which of 109 it is.
 */
export function electionsOn(catalogue, isoDate, ourCode = null) {
  const want = ourCode ? CODE_MAP[ourCode] : null;
  return catalogue
    .filter((e) => e.election_date && wat(e.election_date) === isoDate)
    .filter((e) => !want || e.election_type?.code === want)
    .map((e) => ({
      irev_id: e._id,
      election_id: e.election_id ?? null,
      code: e.election_type?.code || null,
      full_name: e.full_name || null,
      date: wat(e.election_date),
      domain_type: (e.domain_type || '').split('\\').pop() || null,
      domain_name: e.domain?.name || null,
      state_id: e.state_id ?? e.domain?.state_id ?? null,
      is_mapped: !!e.is_mapped,
    }));
}

/**
 * Record what was found. UNCONFIRMED on purpose.
 *
 * The dangerous outcome here is not "no id" — it is the WRONG id, which would
 * compare our results against a different election and produce confident
 * nonsense. So resolution writes a row and stops; a separate confirmation step
 * has to agree that the unit count matches our register before anything reads
 * it, the way the Osun audit reconciled 3,763 against 3,763.
 */
export function record(rows, base) {
  const now = Date.now();
  const put = db.prepare(`
    INSERT INTO irev_elections
      (irev_id, election_id, code, full_name, election_date, domain_type, domain_name,
       state_id, base_url, status, first_seen, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?)
    ON CONFLICT(irev_id) DO UPDATE SET
      full_name = excluded.full_name, base_url = excluded.base_url, updated_at = excluded.updated_at`);
  const run = db.transaction(() => {
    for (const r of rows) {
      put.run(r.irev_id, r.election_id, r.code, r.full_name, r.date,
        r.domain_type, r.domain_name, r.state_id, base, now, now);
    }
  });
  run();
  return rows.length;
}

/** The id a scan should use: confirmed only, newest first. */
export function confirmedFor(code, isoDate) {
  return db.prepare(`SELECT * FROM irev_elections
     WHERE code = ? AND election_date = ? AND status = 'confirmed'
     ORDER BY updated_at DESC`).all(CODE_MAP[code] || code, isoDate);
}

/**
 * Resolve every race polling in the next `days` and record what INEC has so far.
 *
 * Lives here rather than in the caller because server.js does not import
 * contests — an earlier version of the timer referenced it anyway, which throws
 * a ReferenceError inside the promise, lands in .catch(), and fails silently
 * every day forever. The service already depends on the calendar; the timer
 * should depend only on this.
 */
export async function resolveDue(days = 14) {
  const base = await resolveBase();
  if (!base) return { base: null, found: 0 };
  const catalogue = await fetchCatalogue(base);
  const today = new Date().toISOString().slice(0, 10);
  const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  let found = 0;
  for (const c of contests.filter((x) => x.date >= today && x.date <= until)) {
    const rows = electionsOn(catalogue, c.date, CODE_MAP[c.tier] ? c.tier : null);
    if (rows.length) found += record(rows, base);
  }
  return { base, found };
}

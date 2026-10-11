/**
 * THE RACE'S OWN BALLOT — twin of raceBallot() in app/app.js.
 *
 * The count step listed every registered party for every race. INEC's final
 * lists (12 Sept and 10 Oct 2026) say who actually fields a candidate: 18
 * parties for President, and a different set in each senatorial district,
 * federal constituency and state. `ballots-2027.json` on the site holds those
 * sets (scripts/build_ballots_2027.py), keyed by the register's own district
 * names, so the unit already chosen finds its own.
 *
 * It only narrows what is LISTED. Anything unknown — a State Assembly race, a
 * by-election, a unit whose district is not in the file, no file at all — gives
 * null, and the caller shows every party, as it did before.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { BASE } from './api';

export interface Ballots {
  PRES?: string[];
  GOV?: Record<string, string[]>;
  SEN?: Record<string, string[]>;
  REP?: Record<string, string[]>;
  /** "STATE|LGA" -> [senate seat | null, reps seats] — for a form that has a place, not a unit. */
  LGA?: Record<string, [string | null, string[]]>;
}
export interface BallotUnit {
  state?: string | null;
  senatorial?: string | null;
  federal_constituency?: string | null;
}

const STORE = 'hk_ballots2027_v1';
let held: Ballots | null = null;
let asked = false;

/** Validated before it is kept: a cached error page must never hide parties. */
const good = (j: unknown): j is Ballots =>
  !!j && typeof j === 'object' && Array.isArray((j as Ballots).PRES) && (j as Ballots).PRES!.length > 0;

/**
 * The stored copy at once (so the step works offline), then the site's copy.
 * `onFresh` fires if the site's copy arrives after the stored one was returned.
 */
export async function loadBallots(onFresh?: (b: Ballots) => void): Promise<Ballots | null> {
  if (!held) {
    try {
      const j = JSON.parse((await AsyncStorage.getItem(STORE)) || 'null');
      if (good(j)) held = j;
    } catch { /* unreadable — every party stays listed */ }
  }
  if (!asked) {
    asked = true;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    fetch(`${BASE}/ballots-2027.json`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (!good(j)) return;
        held = j;
        AsyncStorage.setItem(STORE, JSON.stringify(j)).catch(() => {});
        onFresh?.(j);
      })
      .catch(() => { asked = false; })   // offline now: ask again next time the step opens
      .finally(() => clearTimeout(t));
  }
  return held;
}

/** Letters and digits only, upper case — the key rule the file was built with. */
const key = (s?: string | null) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const stateKey = (s?: string | null) => {
  const k = key(s);
  if (k === 'FEDERALCAPITALTERRITORY' || k === 'FCTABUJA' || k === 'ABUJA') return 'FCT';
  return k === 'NASSARAWA' ? 'NASARAWA' : k;
};

/** The parties fielding a candidate in this race at this unit, or null if not known. */
export function raceBallot(b: Ballots | null, contest: string | null | undefined, u: BallotUnit | null | undefined): string[] | null {
  if (!b || !u || !contest) return null;
  const st = stateKey(u.state);
  const list =
    contest === 'PRES' ? b.PRES
      : contest === 'GOV' ? b.GOV?.[st]
        : contest === 'SEN' ? b.SEN?.[`${st}|${key(u.senatorial)}`]
          : contest === 'REP' ? b.REP?.[`${st}|${key(u.federal_constituency)}`]
            : null;
  return Array.isArray(list) && list.length ? list : null;
}

/**
 * A COLLATION FORM HAS A PLACE, NOT A UNIT — twin of collationBallot() in
 * app/collation.html. President and Governorship need only the state; Senate
 * and Reps follow the LGA chosen (`LGA` in the file). A statewide Senate or
 * Reps entry, State Assembly, a by-election: null, every party is listed.
 */
export function placeBallot(
  b: Ballots | null,
  contest: string | null | undefined,
  place: { state?: string | null; lga?: string | null; statewide?: boolean },
): string[] | null {
  if (!b || !contest) return null;
  const ok = (l?: string[] | null) => (Array.isArray(l) && l.length ? l : null);
  if (contest === 'PRES') return ok(b.PRES);
  const st = stateKey(place.state);
  if (!st) return null;
  if (contest === 'GOV') return ok(b.GOV?.[st]);
  if ((contest !== 'SEN' && contest !== 'REP') || place.statewide) return null;
  const e = b.LGA?.[`${st}|${key(place.lga)}`];
  if (!Array.isArray(e)) return null;
  if (contest === 'SEN') return e[0] ? ok(b.SEN?.[`${st}|${e[0]}`]) : null;
  // Reps: an LGA shared by two constituencies lists the parties of both.
  const lists = (e[1] || []).map((k) => b.REP?.[`${st}|${k}`]);
  if (!lists.length || lists.some((l) => !ok(l))) return null;
  return [...new Set(lists.flatMap((l) => l as string[]))].sort();
}

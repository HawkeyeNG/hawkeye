// Resolve which SPECIFIC race a contest is at a given polling unit. The unit —
// not the observer's claim — determines the race: senatorial district and
// federal constituency come straight off the INEC register row; governorship
// and state assembly follow from the unit's state. Combined with the geofence /
// GPS-plausibility layers, an observer standing in Sokoto physically cannot
// file into a Lagos race. Keep byte-similar to contestScope() in app/app.js.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const stateLabel = (s) => (s === 'FCT' ? 'the FCT' : `${s} State`);

/**
 * TIER vs CODE — the distinction the whole by-election model rests on.
 *
 * A contest's CODE is its identity: it is the `contest` column of `results`
 * (whose primary key is `(pu_code, contest)`), the prefix of every raceKey, and
 * therefore what keeps a 2026 by-election in the Gombe/Kwami/Funakaye federal
 * constituency from colliding with the 2027 general election in the SAME seat.
 * Reuse `REP` for both and the two results overwrite each other in the database
 * and merge into one anchored subchain — permanently, once published.
 *
 * A contest's TIER is its SHAPE: which register column locates it, what it is
 * called, how a board buckets it. A by-election for a federal seat is a REP in
 * every way except identity.
 *
 * So: switch on the tier, key on the code. `tier` defaults to the code, which
 * makes all five existing contests behave exactly as before.
 *
 * Read from the JSON rather than imported from db.js deliberately — this module
 * is the single source of the register column names that get interpolated into
 * SQL, and it has no other dependency. Pulling in db.js would attach a live
 * database connection to it.
 */
const CONTEST_TIERS = (() => {
  try {
    const rows = JSON.parse(
      fs.readFileSync(path.join(config.dataDir, 'contests.json'), 'utf8'),
    );
    return new Map(rows.map((c) => [c.code, c.tier || c.code]));
  } catch {
    // A contests.json that cannot be read is db.js's error to raise, loudly, at
    // startup. Here it degrades to "every code is its own tier", i.e. exactly
    // the behaviour before by-elections existed.
    return new Map();
  }
})();

/** The shape a contest behaves as: its `tier`, or its own code. */
export const contestTier = (code) => CONTEST_TIERS.get(code) || code;

// The FCT is administered by an appointed minister — no governorship, no state
// assembly. Those contests simply do not exist for FCT units.
// `states` (optional) is a contest's allowlist of state names — used by
// single-state elections (e.g. the Osun 2026 governorship pilot) so only units
// in those states can file. Absent/empty ⇒ nationwide, i.e. current behaviour.
/**
 * `constituencies` is what makes a by-election a by-election.
 *
 * A `states: ['Gombe']` allowlist admits every unit in Gombe — all six federal
 * constituencies, 3,088 units — into an election held in ONE of them. So a
 * contest may also name the constituencies it runs in, tested against its
 * TIER's own register column: `federal_constituency` for a REP by-election,
 * `lga` for a SHA one.
 *
 * regionLevelFor().col, not scopeColFor(): scopeColFor returns 'state' for SHA,
 * which would quietly turn the Delta and Kano gates back into state gates and
 * admit the whole state again.
 *
 * Values must be REGISTER spellings, not INEC's. The register calls Kano's LGA
 * `Dawaki Kudu` while INEC (and this app elsewhere) says `Dawakin Kudu`; the
 * register even contradicts itself, its `federal_constituency` column reading
 * `Dawakin Kudu/Warawa`. A mismatch fails closed — every unit rejected, one
 * whole seat offline, behind an opaque contest_not_applicable — so
 * scripts/check_contests.mjs asserts every value matches a real register row.
 */
export const contestApplies = (pu, contest, states, constituencies) => {
  const tier = contestTier(contest);
  if (pu.state === 'FCT' && (tier === 'GOV' || tier === 'SHA')) return false;
  if (states && states.length && !states.includes(pu.state)) return false;
  if (constituencies && constituencies.length) {
    const col = regionLevelFor(tier).col;
    if (!constituencies.includes(pu[col])) return false;
  }
  return true;
};

export function contestScope(pu, contest) {
  // Tier, not code: a by-election for a federal seat describes itself exactly
  // as the general election for that seat does.
  switch (contestTier(contest)) {
    case 'SEN':
      return pu.senatorial
        ? `${pu.senatorial} Senatorial District, ${stateLabel(pu.state)}`
        : `${stateLabel(pu.state)} — senatorial district not on register`;
    case 'REP':
      return pu.federal_constituency
        ? `${pu.federal_constituency} Federal Constituency, ${stateLabel(pu.state)}`
        : `${stateLabel(pu.state)} — federal constituency not on register`;
    case 'GOV':
      return contestApplies(pu, contest)
        ? `${pu.state} State Governorship`
        : 'Not applicable — the FCT has no governorship election';
    case 'SHA':
      // State-assembly constituencies are not in the register; scope to state+LGA.
      return contestApplies(pu, contest)
        ? `${pu.state} State House of Assembly (constituency covering ${pu.lga} LGA)`
        : 'Not applicable — the FCT has no state assembly election';
    case 'PRES':
      return 'Presidential — national contest';
    default:
      // PRES used to live in `default`, which meant every unrecognised contest
      // code was DESCRIBED as the presidential race. See raceKey() below for why
      // that mattered far more there than here.
      return `Unknown contest "${contest}"`;
  }
}

// Canonical, compact key for the SPECIFIC race a submission belongs to — the
// partition used for per-race subchains and Merkle-batched anchoring. Derived
// from the unit (never the observer's claim), mirroring contestScope() above.
// Returns null for a contest that does not exist at the unit (FCT GOV/SHA).
// A contest with a scheduled election `date` accepts result/collation reports
// only from poll-open on election day — 08:30 WAT (INEC accreditation/voting
// start). Dateless contests (mock elections) are always open. Returns the ISO
// opening instant, or null for always-open.
/**
 * WHICH REGION A CONTEST DIVIDES INTO — the one table, used by every endpoint
 * that buckets reports.
 *
 * It lived only in routes/national.js, so /api/coverage/gaps grouped by STATE
 * for every nationwide contest whatever its level. A Senate board therefore read
 * "0 of 37 states in this election have reports", counting states for an
 * election fought in 109 senatorial districts.
 *
 * `col` is the register column and is interpolated into SQL, so it may only ever
 * come from HERE — never from a request.
 */
export const LEVEL_COLS = {
  state: 'state',
  lga: 'lga',
  senatorial: 'senatorial',
  federal: 'federal_constituency',
};

/**
 * What one region of each level is called, for headings and sentences — and its
 * PLURAL, because clients were building one with `noun + 's'` and printing
 * "federal constituencys". English plurals are not a client's problem to solve.
 */
export const LEVEL_NOUN = {
  state: 'state',
  lga: 'LGA',
  senatorial: 'senatorial district',
  federal: 'federal constituency',
};

export const LEVEL_NOUN_PLURAL = {
  state: 'states',
  lga: 'LGAs',
  senatorial: 'senatorial districts',
  federal: 'federal constituencies',
};

/** Nationwide shape — used when a contest is not confined to one state. */
export const REGION_LEVEL = {
  PRES: 'state',
  GOV: 'state',
  // State-assembly constituencies are genuinely absent from the register, so LGA
  // is the honest finest grain for SHA.
  SHA: 'lga',
  SEN: 'senatorial',
  REP: 'federal',
};

/**
 * Cropped to one state, subdivided one level finer: a governorship becomes its
 * LGAs. LGA is the floor — ward names do not join to the register.
 */
export const REGION_LEVEL_SCOPED = {
  PRES: 'lga',
  GOV: 'lga',
  SHA: 'lga',
  SEN: 'senatorial',
  REP: 'federal',
};

/**
 * The register column holding the region a report for this contest is filed
 * INTO — the partition /api/national buckets by, subscriptions.js:reportScope
 * pings on, and a race's own `join.value` names. Interpolated into SQL, so it
 * may only ever come from here.
 */
export const SCOPE_COLS = { SEN: 'senatorial', REP: 'federal_constituency' };
/**
 * `Object.hasOwn`, not `SCOPE_COLS[code] ||`. The comment above says this value
 * is interpolated into SQL and may only ever come from here — but a plain index
 * also answers for inherited keys, and `SCOPE_COLS['constructor']` is a truthy
 * function, which would then be interpolated. No caller can reach that today:
 * routes/pollingUnits.js uppercases the parameter and routes/national.js checks
 * it against contestCodes first. This is the belt to those braces, since what
 * stands between a query parameter and a SQL identifier should not depend on a
 * caller two files away remembering to uppercase.
 */
export const scopeColFor = (code) => {
  const tier = contestTier(code);
  return (Object.hasOwn(SCOPE_COLS, tier) ? SCOPE_COLS[tier] : null) || 'state';
};

/** `{ level, col, noun, nounPlural }` for a contest, cropped to `state` or not. */
export function regionLevelFor(code, state) {
  const tier = contestTier(code);
  const table = state ? REGION_LEVEL_SCOPED : REGION_LEVEL;
  /**
   * Unlike raceKey, an unrecognised code keeps a fallback here — this decides
   * how a BOARD is bucketed for display, not which race a report is filed into,
   * so a sensible default is better than an empty screen. `Object.hasOwn` for
   * the same prototype-key reason as scopeColFor: `level` reaches LEVEL_COLS and
   * from there SQL.
   */
  const level = (Object.hasOwn(table, tier) ? table[tier] : null) || table.PRES;
  return {
    level,
    col: LEVEL_COLS[level],
    noun: LEVEL_NOUN[level],
    nounPlural: LEVEL_NOUN_PLURAL[level],
  };
}

export const reportingOpensAt = (c) => (c && c.date ? `${c.date}T08:30:00+01:00` : null);
export const reportingOpen = (c) => {
  const at = reportingOpensAt(c);
  return !at || Date.now() >= Date.parse(at);
};

/**
 * PRES IS AN EXPLICIT CASE, AND UNKNOWN CODES RETURN NULL.
 *
 * This used to end `default: return 'PRES'`, so a contest code the switch did
 * not recognise silently became the PRESIDENTIAL race. A typo in a `?contest=`
 * parameter, or a contest added to contests.json without a case added here,
 * would file into the presidential subchain — and quietly, because a wrong race
 * key is indistinguishable from a right one once written. That is the worst
 * failure mode this file has: the key partitions the per-race subchains and is
 * the Merkle leaf preimage (services/merkle.js raceLeaf), so a misfiled report
 * is anchored into the wrong race's history and cannot be unpicked afterwards.
 *
 * The literal 'PRES' must stay byte-identical: it is stored in
 * anchor_races.race_key and hardcoded in routes/admin.js. Its case is therefore
 * written out rather than left to a fallback.
 *
 * Both callers — services/ledger.js and routes/admin.js — already skip a null
 * key, which is how the FCT GOV/SHA cases have always behaved. An unknown code
 * now takes that same path: counted nowhere rather than counted wrongly.
 */
export function raceKey(pu, contest) {
  const st = pu.state || '?';
  /**
   * SWITCH ON THE TIER, KEY ON THE CODE — and the second half is the one that
   * matters. Resolving the tier first and then building `REP|Gombe|Gombe/Kwami/
   * Funakaye` would emit the SAME key for the 2026 by-election and the 2027
   * general election in that seat: one subchain, two elections, merged inside a
   * published Rekor anchor and not separable afterwards. The full contest code
   * leads instead, so the two are different races from the first entry.
   *
   * For the five original contests `contest === contestTier(contest)`, so every
   * key they have ever produced is byte-identical — which it must be, being the
   * Merkle leaf preimage in services/merkle.js and stored in
   * anchor_races.race_key.
   */
  switch (contestTier(contest)) {
    case 'GOV': return contestApplies(pu, contest) ? `${contest}|${st}` : null;
    case 'SEN': return `${contest}|${st}|${pu.senatorial || '_unknown'}`;
    case 'REP': return `${contest}|${st}|${pu.federal_constituency || '_unknown'}`;
    case 'SHA': return contestApplies(pu, contest) ? `${contest}|${st}|${pu.lga || '?'}` : null;
    case 'PRES': return 'PRES';
    default:    return null;
  }
}

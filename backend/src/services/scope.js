// Resolve which SPECIFIC race a contest is at a given polling unit. The unit —
// not the observer's claim — determines the race: senatorial district and
// federal constituency come straight off the INEC register row; governorship
// and state assembly follow from the unit's state. Combined with the geofence /
// GPS-plausibility layers, an observer standing in Sokoto physically cannot
// file into a Lagos race. Keep byte-similar to contestScope() in app/app.js.
const stateLabel = (s) => (s === 'FCT' ? 'the FCT' : `${s} State`);

// The FCT is administered by an appointed minister — no governorship, no state
// assembly. Those contests simply do not exist for FCT units.
// `states` (optional) is a contest's allowlist of state names — used by
// single-state elections (e.g. the Osun 2026 governorship pilot) so only units
// in those states can file. Absent/empty ⇒ nationwide, i.e. current behaviour.
export const contestApplies = (pu, contest, states) =>
  !(pu.state === 'FCT' && (contest === 'GOV' || contest === 'SHA'))
  && (!states || !states.length || states.includes(pu.state));

export function contestScope(pu, contest) {
  switch (contest) {
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
export const scopeColFor = (code) =>
  (Object.hasOwn(SCOPE_COLS, code) ? SCOPE_COLS[code] : null) || 'state';

/** `{ level, col, noun, nounPlural }` for a contest, cropped to `state` or not. */
export function regionLevelFor(code, state) {
  const table = state ? REGION_LEVEL_SCOPED : REGION_LEVEL;
  /**
   * Unlike raceKey, an unrecognised code keeps a fallback here — this decides
   * how a BOARD is bucketed for display, not which race a report is filed into,
   * so a sensible default is better than an empty screen. `Object.hasOwn` for
   * the same prototype-key reason as scopeColFor: `level` reaches LEVEL_COLS and
   * from there SQL.
   */
  const level = (Object.hasOwn(table, code) ? table[code] : null) || table.PRES;
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
  switch (contest) {
    case 'GOV': return contestApplies(pu, 'GOV') ? `GOV|${st}` : null;
    case 'SEN': return `SEN|${st}|${pu.senatorial || '_unknown'}`;
    case 'REP': return `REP|${st}|${pu.federal_constituency || '_unknown'}`;
    case 'SHA': return contestApplies(pu, 'SHA') ? `SHA|${st}|${pu.lga || '?'}` : null;
    case 'PRES': return 'PRES';
    default:    return null;
  }
}

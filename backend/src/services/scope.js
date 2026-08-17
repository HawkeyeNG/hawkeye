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
    default:
      return 'Presidential — national contest';
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

/** `{ level, col, noun, nounPlural }` for a contest, cropped to `state` or not. */
export function regionLevelFor(code, state) {
  const level = (state ? REGION_LEVEL_SCOPED[code] : REGION_LEVEL[code]) || REGION_LEVEL.PRES;
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

export function raceKey(pu, contest) {
  const st = pu.state || '?';
  switch (contest) {
    case 'GOV': return contestApplies(pu, 'GOV') ? `GOV|${st}` : null;
    case 'SEN': return `SEN|${st}|${pu.senatorial || '_unknown'}`;
    case 'REP': return `REP|${st}|${pu.federal_constituency || '_unknown'}`;
    case 'SHA': return contestApplies(pu, 'SHA') ? `SHA|${st}|${pu.lga || '?'}` : null;
    default:    return 'PRES';
  }
}

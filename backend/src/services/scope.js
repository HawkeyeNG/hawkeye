// Resolve which SPECIFIC race a contest is at a given polling unit. The unit —
// not the observer's claim — determines the race: senatorial district and
// federal constituency come straight off the INEC register row; governorship
// and state assembly follow from the unit's state. Combined with the geofence /
// GPS-plausibility layers, an observer standing in Sokoto physically cannot
// file into a Lagos race. Keep byte-similar to contestScope() in app/app.js.
const stateLabel = (s) => (s === 'FCT' ? 'the FCT' : `${s} State`);

// The FCT is administered by an appointed minister — no governorship, no state
// assembly. Those contests simply do not exist for FCT units.
export const contestApplies = (pu, contest) =>
  !(pu.state === 'FCT' && (contest === 'GOV' || contest === 'SHA'));

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

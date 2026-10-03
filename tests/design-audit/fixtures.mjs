/**
 * Fixture answers for the endpoints that need a session (found by discover.mjs),
 * so signed-in screens render WITHOUT an account. Shapes from the route code
 * (backend/src/routes/*.js). Everything here is invented: observer #7, a sample
 * polling unit, two sample rooms. No real person, no party affiliation.
 *
 * FIXTURES(method, url) -> undefined (not ours: pass through / block) | { status, json }
 * EMPTY variant: the same endpoints answering a brand-new observer (no unit, no
 * rooms, no alerts) — the empty states a first-time observer actually sees.
 */
const NOW = Date.now();
const H = 3_600_000;
const UNIT = { pu_code: '24-16-05-007', name: 'LGEA Primary School, Ojota I', ward: 'Ojota', lga: 'Kosofe', state: 'Lagos' };

const POPULATED = {
  '/api/observers/me': {
    ok: true, observerId: 7, identityHash: 'da'.repeat(32), createdAt: NOW - 40 * 24 * H, hasPassword: true,
    unit: UNIT,
    subscriptions: [{ contest: 'PRES', state: null }, { contest: 'GOV', state: 'Lagos' }],
    reports: [{ pu_code: UNIT.pu_code, contest: 'PRES', created_at: NOW - 5 * H, entry_hash: 'a1b2c3d4'.repeat(8), name: UNIT.name, lga: UNIT.lga, state: UNIT.state }],
    collation: [],
    incidents: [{ id: 77, kind: 'late_materials', status: 'approved', pu_code: UNIT.pu_code, state: 'Lagos', created_at: NOW - 7 * H }],
    mappings: [{ pu_code: UNIT.pu_code, created_at: NOW - 20 * 24 * H, name: UNIT.name, ward: UNIT.ward, lga: UNIT.lga, state: UNIT.state, crowd_reports: 3, coords_source: 'crowd', source: 'fix', confirmed: true }],
  },
  '/api/notifications': {
    items: [
      { id: 312, kind: 'result', title: 'New result at your unit', body: 'Presidential · LGEA Primary School, Ojota I', url: 'https://hawkeye.com.ng/results.html', read: 0, created_at: NOW - 2 * H },
      { id: 305, kind: 'incident', title: 'Your incident report was published', body: 'Late materials · 24-16-05-007', url: 'https://hawkeye.com.ng/incident-reports.html', read: 0, created_at: NOW - 6 * H },
      { id: 290, kind: 'group_joined', title: 'You joined a room', body: 'Lagos Citizens Observer Network', url: 'https://hawkeye.com.ng/my-groups.html', read: 1, created_at: NOW - 30 * H },
      { id: 281, kind: 'mapping', title: 'Your unit location was confirmed', body: 'LGEA Primary School, Ojota I', url: null, read: 1, created_at: NOW - 4 * 24 * H },
    ],
    unread: 2,
  },
  '/api/practice/nudge': { show: true, practised: false, practiceOpen: true, practiceDay: null },
  '/api/observers/passkeys': { ok: true, available: true, passkeys: [] },
  '/api/observers/referral': { code: 'K7PM3X', signedUp: 2, qualified: 0 },
  '/api/groups': {
    managing: [],
    member: [
      { id: 12, name: 'Lagos Citizens Observer Network', kind: 'cso', contest: 'GOV', scope: 'Lagos', slug: 'lagos-citizens', manages: null,
        assigned_pu: UNIT.pu_code, assign_state: 'confirmed', joined_at: NOW - 10 * 24 * H, member_state: '',
        assigned_name: UNIT.name, assigned_ward: UNIT.ward, assigned_lga: UNIT.lga, assigned_state: UNIT.state,
        scope_label: 'Lagos', party: null, party_claim: null, party_state: null, org: 'Sample Civic Trust', org_claim: null, org_state: 'verified', org_listed: true },
      { id: 19, name: 'Kosofe Ward Volunteers', kind: 'cso', contest: 'PRES', scope: '', slug: 'kosofe-volunteers', manages: null,
        assigned_pu: null, assign_state: null, joined_at: NOW - 2 * 24 * H, member_state: 'invited',
        assigned_name: null, assigned_ward: null, assigned_lga: null, assigned_state: null,
        scope_label: '', party: null, party_claim: null, party_state: null, org: null, org_claim: null, org_state: null, org_listed: null },
    ],
  },
  '/api/group-races': { kind: 'national', column: '', states: [], races: [] },
  '/api/my/rooms': { rooms: [{ id: 12, name: 'Lagos Citizens Observer Network', kind: 'cso', contest: 'GOV', assigned: UNIT, checkedIn: null }] },
  '/api/observers/my-unit': { ok: true, unit: UNIT },
  '/api/captains/mine': { application: null, canApply: true },
  '/api/practice/mine': { runs: [] },
  // The situation room as a PLAIN MEMBER sees it (routes/groups.js GET /groups/:id) — a state room, nothing reported yet
  '/api/groups/12': {
    id: 12, name: 'Lagos Citizens Observer Network', kind: 'cso', contest: 'GOV', scope: 'Lagos',
    party: null, party_claim: null, party_state: null, org: 'Sample Civic Trust', org_claim: null, org_state: 'verified', org_listed: true,
    admits: true, admission_block: null, slug: 'lagos-citizens', scope_kind: null, scope_label: 'Lagos', scope_state: 'Lagos',
    members: 38, assigned: 31, pending: 4, reported: 0, restricted: true,
    attendance: { checkedIn: 0, atUnit: 0, elsewhere: 0, expected: 38 },
    zones: [], me_id: 7, me: { role: null, scope_kind: null, scope_value: null }, org_code_check: false, managers: [],
  },
};

const EMPTY = {
  ...POPULATED,
  '/api/observers/me': { ok: true, observerId: 7, identityHash: 'da'.repeat(32), createdAt: NOW - H, hasPassword: true, unit: null, subscriptions: [], reports: [], collation: [], incidents: [], mappings: [] },
  '/api/notifications': { items: [], unread: 0 },
  '/api/groups': { managing: [], member: [] },
  '/api/my/rooms': { rooms: [] },
  '/api/observers/my-unit': { ok: true, unit: null },
  '/api/observers/referral': { code: 'K7PM3X', signedUp: 0, qualified: 0 },
};

/* Writes that a screen makes on its own while rendering, answered locally. */
const WRITES = {
  '/api/observers/resume': { ok: false, recognized: false },
  '/api/practice/submit': { ok: true, entryHash: 'e2e0'.repeat(16), designAudit: true },
  '/api/push/subscribe': { ok: true },
  '/api/notifications/read': { ok: true },
};

export function makeFixtures(variant = 'populated') {
  const table = variant === 'empty' ? EMPTY : POPULATED;
  return (method, url) => {
    const p = url.pathname;
    if (method === 'GET' && Object.prototype.hasOwnProperty.call(table, p)) return { status: 200, json: table[p] };
    if (method !== 'GET' && Object.prototype.hasOwnProperty.call(WRITES, p)) return { status: 200, json: WRITES[p] };
    return undefined;
  };
}
export const FIXTURES = makeFixtures('populated');

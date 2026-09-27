// READ STORM: what the results/ledger audience does on election night.
// The weights follow docs/private/ELECTION-NIGHT-HOSTING.md §1.1: the web
// results page polls /api/national every 30 s; the native home tab polls
// contests, integrity, the ledger head, incidents and docket every 30 s.
import http from 'k6/http';
import { check } from 'k6';
import { headers, url, pick, weighted, noteResponse } from './common.js';
import { PROD_NAMED } from './guard.js';
import { pus, uploadPool } from './fixtures.js';

const RACES = ['PRES', 'SEN', 'REP'];
const STATES = ['Lagos', 'Kano', 'Rivers', 'Oyo', 'Kaduna', 'FCT', 'Anambra', 'Borno', 'Osun', 'Enugu'];
// LEGACY=1 also requests the shapes SHIPPED clients use today: the 1,000-row
// ledger default and the unbounded /api/results. Staging only; that is the point
// of measuring them. Never in the prod smoke.
const LEGACY = String(__ENV.LEGACY || '') === '1' && !PROD_NAMED;

const national = () => {
  const r = pick(RACES);
  return Math.random() < 0.3 ? `/api/national/${r}?state=${encodeURIComponent(pick(STATES))}` : `/api/national/${r}`;
};

const MIX = [
  ['national', 30, national],
  ['contests', 10, () => '/api/contests'],
  ['integrity_summary', 8, () => '/api/integrity/summary'],
  ['incidents', 8, () => '/api/incidents'],
  ['ledger_head', 8, () => '/api/ledger/entries?limit=3'],
  ['docket', 5, () => '/api/docket?limit=30'], // the native home tab's call
  ['declarations', 4, () => '/api/declarations'],
  ['anchors', 2, () => '/api/anchors'],
  ['register_states', 3, () => '/api/register/states'],
  // 404 {error:'no_reports_yet'} is the correct answer for a unit nobody has
  // reported yet (most of them, before an upload run), so it is not a failure.
  ['result_pu', pus.length && !PROD_NAMED ? 10 : 0, () => `/api/results/${encodeURIComponent(pick(pus).code)}?contest=${pick(RACES)}`, [404]],
  ['html_results', 4, () => '/results.html'],
  ['html_index', 4, () => '/'],
  ['ledger_default_legacy', LEGACY ? 4 : 0, () => '/api/ledger/entries'],
  ['results_all_legacy', LEGACY ? 1 : 0, () => '/api/results'],
];
const choose = weighted(MIX);

// Extra expected statuses per endpoint (built once, in the init context), so
// http_req_failed counts real failures only.
const OK_2XX = http.expectedStatuses({ min: 200, max: 299 });
const CALLBACK = {};
for (const [name, , , alsoOk] of MIX) {
  CALLBACK[name] = alsoOk ? http.expectedStatuses({ min: 200, max: 299 }, ...alsoOk) : OK_2XX;
}

export function publicReadIteration() {
  const [name, , path, alsoOk] = choose();
  const res = http.get(url(path()), { headers: headers(), tags: { name }, responseCallback: CALLBACK[name] });
  noteResponse(res);
  check(res, { [`${name} ok`]: (r) => (r.status >= 200 && r.status < 300) || Boolean(alsoOk && alsoOk.includes(r.status)) });
}

// Authenticated GETs: never cacheable, and the largest origin read class
// (§1.2 R3). Uses the seeded test observers; staging only.
const AUTHED = [
  ['me', 4, () => '/api/observers/me'],
  ['notifications', 4, () => '/api/notifications'],
  ['my_unit', 2, () => '/api/observers/my-unit'],
];
const chooseAuthed = weighted(AUTHED);

export function authedReadIteration() {
  if (!uploadPool.length) return;
  const f = uploadPool[Math.floor(Math.random() * uploadPool.length)];
  const [name, , path] = chooseAuthed();
  const res = http.get(url(path()), {
    headers: headers({ authorization: `Bearer ${f.token}`, 'x-device-id': f.deviceId }),
    tags: { name },
  });
  noteResponse(res);
  check(res, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
}

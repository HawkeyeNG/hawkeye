// RAMP TO TARGET: every class at once, on the election-night shape. Warm at
// 10%, ramp to 100% of the profile, hold, then a +50% spike standing in for the
// read herd after a push broadcast, recover, drain. STAGING ONLY (it writes).
//
//   run.sh ramp --base-url https://staging.hawkeye.com.ng --profile origin \
//     --fixtures .fixtures/staging.json --direct-origin
//
// PROFILE=origin is the design point in ELECTION-NIGHT-HOSTING.md §1.2
// (250 reports/s, 1,500 authed GET/s, 400 public GET/s uncached, 20 auth/s).
// PROFILE=stress is 1.5x. TIME_SCALE=0.2 compresses the ~30 min shape.
import exec from 'k6/execution';
import { initGuard, setupGuard } from '../lib/guard.js';
import { profile, arrival, headers } from '../lib/common.js';
import { publicReadIteration, authedReadIteration } from '../lib/read.js';
import { uploadIteration, uploadPreflight } from '../lib/upload.js';
import { authIteration, authPreflight } from '../lib/auth.js';
import { checkAttestation } from '../lib/fixtures.js';

initGuard('write');
const P = profile();

const scenarios = {
  public_read: arrival(P.publicRead, 'publicRead', { pre: 100, max: 3000 }),
  authed_read: arrival(P.authedRead, 'authedRead', { pre: 200, max: 4000 }),
  upload: arrival(P.upload, 'upload', { pre: 200, max: 4000 }),
  auth: arrival(P.auth, 'auth', { pre: 20, max: 500 }),
};
for (const k of Object.keys(scenarios)) {
  if (!(Math.max(...scenarios[k].stages.map((s) => s.target)) > 0)) delete scenarios[k];
}

export const options = {
  scenarios,
  thresholds: {
    'http_req_failed{scenario:public_read}': ['rate<0.01'],
    'http_req_duration{scenario:authed_read}': ['p(95)<500'],
    report_ok: ['rate>0.98'],
    otp_flow_ok: ['rate>0.98'],
    report_end_to_end_ms: ['p(95)<6000'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  setupGuard('write', headers());
  const bad = checkAttestation()
    || (scenarios.upload ? uploadPreflight() : null)
    || (scenarios.auth ? authPreflight() : null);
  if (bad) exec.test.abort(`ramp preflight: ${bad}`);
  return {};
}

export function publicRead() { publicReadIteration(); }
export function authedRead() { authedReadIteration(); }
export async function upload() { await uploadIteration(); }
export function auth() { authIteration(); }

// READ STORM: results, ledger and the public boards, plus authenticated GETs
// when fixtures are given. The ONLY scenario allowed against production, and
// there it is capped (PROD_MAX_RPS, default 25, hard ceiling 50; at most 3 min),
// restricted to cacheable endpoints, and never sends authenticated requests.
//
//   run.sh read --base-url https://staging.hawkeye.com.ng --profile origin
import exec from 'k6/execution';
import { initGuard, setupGuard, PROD_NAMED } from '../lib/guard.js';
import { profile, arrival, headers } from '../lib/common.js';
import { publicReadIteration, authedReadIteration } from '../lib/read.js';
import { hasFixtures, uploadPool } from '../lib/fixtures.js';

initGuard('read');
const P = profile();

function prodScenario() {
  const rps = Math.min(50, Math.max(1, Number(__ENV.PROD_MAX_RPS || 25)));
  return {
    executor: 'constant-arrival-rate', rate: rps, timeUnit: '1s', duration: '3m',
    preAllocatedVUs: 20, maxVUs: 100, exec: 'publicRead',
  };
}

const scenarios = PROD_NAMED
  ? { public_read: prodScenario() }
  : { public_read: arrival(P.publicRead, 'publicRead', { pre: 100, max: 3000 }) };
if (!PROD_NAMED && hasFixtures && P.authedRead > 0) {
  scenarios.authed_read = arrival(P.authedRead, 'authedRead', { pre: 200, max: 4000 });
}

export const options = {
  scenarios,
  discardResponseBodies: true,
  thresholds: {
    'http_req_failed{scenario:public_read}': ['rate<0.01'],
    'http_req_duration{name:national}': ['p(95)<1000'],
    'http_req_duration{scenario:public_read}': ['p(95)<800'],
    ...(scenarios.authed_read ? { 'http_req_duration{scenario:authed_read}': ['p(95)<500'] } : {}),
    // Through Cloudflare (PROFILE=edge) the allowlisted API should be served from cache.
    ...(P.name === 'edge' ? { edge_hit: ['rate>0.9'] } : {}),
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const g = setupGuard('read', headers());
  if (g.prod && P.name !== 'smoke' && P.name !== 'edge') {
    exec.test.abort('Production smoke only: use --profile smoke or edge (the rate is capped regardless).');
  }
  if (hasFixtures && !uploadPool.length) exec.test.abort('FIXTURES given but empty');
  return { env: g.env };
}

export function publicRead() { publicReadIteration(); }
export function authedRead() { authedReadIteration(); }

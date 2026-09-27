// AUTH / OTP on STAGING ONLY, with the OTP stub. Aborts before the first
// iteration unless the canary sign-up comes back as devOtp (console provider)
// and /api/health reports smsOtp=false and waCloud=false. Run it direct to the
// origin (--direct-origin) so per-IP limits see a CGNAT-like spread of client
// IPs instead of the generator's own address.
//
//   run.sh auth --base-url https://staging.hawkeye.com.ng --profile origin \
//     --fixtures .fixtures/staging.json --direct-origin
import exec from 'k6/execution';
import { initGuard, setupGuard } from '../lib/guard.js';
import { profile, arrival, headers } from '../lib/common.js';
import { authIteration, authPreflight } from '../lib/auth.js';
import { checkAttestation } from '../lib/fixtures.js';

initGuard('auth');
const P = profile();

export const options = {
  scenarios: { auth: arrival(P.auth, 'auth', { pre: 20, max: 500 }) },
  discardResponseBodies: false, // devOtp is read from the register reply
  thresholds: {
    otp_flow_ok: ['rate>0.98'],
    'http_req_duration{name:otp_register}': ['p(95)<1000'],
    'http_req_duration{name:login_password}': ['p(95)<1000'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  setupGuard('auth', headers());
  const bad = checkAttestation() || authPreflight();
  if (bad) exec.test.abort(`auth preflight: ${bad}`);
  return {};
}

export function auth() { authIteration(); }

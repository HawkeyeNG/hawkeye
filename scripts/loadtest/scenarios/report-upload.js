// REPORT UPLOAD MIX on STAGING ONLY: presign, R2 PUT x2, signed JSON submit
// (or multipart with UPLOAD_PATH=proxy). Refuses production at init and again
// in setup. Needs fixtures and synthetic JPEGs from seed/.
//
//   run.sh upload --base-url https://staging.hawkeye.com.ng --profile origin \
//     --fixtures .fixtures/staging.json --direct-origin
import exec from 'k6/execution';
import { initGuard, setupGuard } from '../lib/guard.js';
import { profile, arrival, headers } from '../lib/common.js';
import { uploadIteration, uploadPreflight } from '../lib/upload.js';
import { checkAttestation, uploadPool } from '../lib/fixtures.js';

initGuard('write');
const P = profile();

export const options = {
  scenarios: { upload: arrival(P.upload, 'upload', { pre: 200, max: 4000 }) },
  discardResponseBodies: false, // presign replies are read
  thresholds: {
    report_ok: ['rate>0.98'],
    'http_req_duration{name:presign}': ['p(95)<800'],
    'http_req_duration{name:submit}': ['p(95)<1500'],
    // UPLOAD_PATH=proxy tags the multipart submit 'submit_proxy'; without this its
    // latency was never checked (the 'submit' threshold passed with zero samples).
    'http_req_duration{name:submit_proxy}': ['p(95)<3000'],
    report_end_to_end_ms: ['p(95)<6000'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  setupGuard('write', headers());
  const bad = checkAttestation() || uploadPreflight();
  if (bad) exec.test.abort(`upload preflight: ${bad}`);
  return { reports: uploadPool.length * 3 };
}

export async function upload() { await uploadIteration(); }

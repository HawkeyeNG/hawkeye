// Test-only fixtures produced ON THE STAGING HOST by seed/seed_staging.mjs.
// They hold staging-only JWTs and private keys for flagged test observers
// (is_staff=1, phone_hash prefixed "loadtest:"). Never commit them: .fixtures/
// is gitignored. FIXTURES must be an ABSOLUTE path (run.sh makes it absolute).
//
// Everything is read through SharedArray: the callbacks run ONCE (first VU's
// init) and every VU shares one copy. A plain top-level open()+JSON.parse would
// re-parse a ~15 MB file in every VU's init context.
import { SharedArray } from 'k6/data';
import { HOST } from './guard.js';

const PATH = __ENV.FIXTURES || '';
let meta = null;
const load = () => {
  if (!PATH) return null;
  if (!meta) meta = JSON.parse(open(PATH));
  return meta;
};

export const hasFixtures = Boolean(PATH);
export const uploadPool = new SharedArray('upload', () => (load() ? load().upload : []));
export const authPool = new SharedArray('auth', () => (load() ? load().auth : []));
export const pus = new SharedArray('pus', () => (load() ? load().pus : []));
export const parties = new SharedArray('parties', () => (load() ? load().parties : []));
const attestArr = new SharedArray('attest', () => (load() ? [load().attest] : []));

// The seed script records which host the fixtures belong to and when it checked
// the OTP stub. Refuse fixtures made for another host or older than 24 h, so a
// stale file cannot vouch for a server whose .env has since changed.
export function checkAttestation() {
  const a = attestArr.length ? attestArr[0] : null;
  if (!a) return 'no fixtures (FIXTURES not set)';
  if (String(a.host || '').toLowerCase() !== HOST) return `fixtures were made for ${a.host}, not ${HOST}`;
  if (!a.otpStub) return 'the seed did not confirm the OTP stub';
  if (Date.now() - Number(a.checkedAt || 0) > 24 * 3600 * 1000) return 'fixtures are older than 24 h; re-run the seed';
  return null;
}

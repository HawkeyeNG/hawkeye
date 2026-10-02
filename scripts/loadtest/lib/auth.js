// AUTH / OTP. NEVER SENDS A REAL SMS OR WHATSAPP.
//
// Staging must run SMS_PROVIDER=console with no Sendchamp, Termii, BulkSMS or
// WhatsApp Cloud credentials. On that provider, outside production, the server
// echoes the code back as `devOtp` (routes/observers.js). The canary in
// authPreflight() makes one sign-up and ABORTS THE WHOLE TEST unless the reply
// carries devOtp and none of viaWhatsapp / viaSms / telegramLink. Every
// iteration re-checks the same thing and aborts on the first real send.
//
// Phone numbers: 0700 + 7 digits, a non-mobile (non-geographic) prefix that
// still passes normalizePhone(). Sign-ups use 0700 0000000-4999999; the seeded
// password fixtures use 0700 5000000-9999999. The stub, not the prefix, is the
// safety.
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { headers, url, noteResponse, otpOk, weighted } from './common.js';
import { authPool } from './fixtures.js';

const J = { 'content-type': 'application/json' };
// The wrong-code verify is SUPPOSED to be refused; without this every one of
// them counted in http_req_failed (~15% of a clean auth run).
const EXPECT_400 = http.expectedStatuses(400);
// 409 = the number is already an observer from an earlier run; signupFlow treats it as fine.
const EXPECT_REGISTER = http.expectedStatuses({ min: 200, max: 299 }, 409);

function phoneFor(n) {
  return `0700${String(n % 5_000_000).padStart(7, '0')}`; // 11 digits
}
function hex64() {
  let s = '';
  for (let i = 0; i < 64; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}

function realSendHappened(body) {
  return !body || !body.devOtp || body.viaWhatsapp || body.viaSms || body.telegramLink;
}

function register(phone, tag) {
  const res = http.post(url('/api/observers/register'), JSON.stringify({ phone, channel: 'telegram', lang: 'en', intent: 'signup' }),
    { headers: headers(J), tags: { name: tag }, responseCallback: EXPECT_REGISTER });
  noteResponse(res);
  return res;
}

export function authPreflight() {
  if (!authPool.length) return 'no auth fixtures (seed with --auth N)';
  const res = register(phoneFor(4_999_999), 'otp_canary');
  let body = null;
  try { body = res.json(); } catch (_) { /* handled below */ }
  if (res.status !== 200 || realSendHappened(body)) {
    return `OTP canary did not come back as devOtp (HTTP ${res.status}). Refusing: staging may be wired to a real provider.`;
  }
  return null;
}

function signupFlow(n, wrongCode) {
  const phone = phoneFor(n);
  const reg = register(phone, 'otp_register');
  if (reg.status === 409) return true; // already an observer from an earlier run: fine
  if (!check(reg, { 'register 200': (r) => r.status === 200 })) return false;
  const body = reg.json();
  if (realSendHappened(body)) exec.test.abort('A register reply had no devOtp: a real message may have been sent. Aborted.');
  const f = authPool[n % authPool.length];
  const otp = wrongCode ? String((Number(body.devOtp) + 1) % 1_000_000).padStart(String(body.devOtp).length, '0') : body.devOtp;
  const ver = http.post(url('/api/observers/verify'), JSON.stringify({ phone, otp, publicKeyJwk: f.publicJwk }),
    { headers: headers({ ...J, 'x-device-id': hex64() }), tags: { name: wrongCode ? 'otp_verify_wrong' : 'otp_verify' },
      ...(wrongCode ? { responseCallback: EXPECT_400 } : {}) });
  noteResponse(ver);
  return wrongCode ? check(ver, { 'wrong code refused': (r) => r.status === 400 }) : check(ver, { 'verify 200': (r) => r.status === 200 });
}

// Password sign-in (scryptSync today: the event-loop cost this measures).
function loginFlow(n) {
  const f = authPool[n % authPool.length];
  const res = http.post(url('/api/observers/login'), JSON.stringify({ phone: f.phone, password: f.password, publicKeyJwk: f.publicJwk }),
    { headers: headers({ ...J, 'x-device-id': f.deviceId }), tags: { name: 'login_password' } });
  noteResponse(res);
  return check(res, { 'login 200': (r) => r.status === 200 });
}

// Device resume: no OTP, no password. Uses the fixture's own key so it never
// rotates a key another scenario signs with (auth pool is disjoint from upload).
function resumeFlow(n) {
  const f = authPool[n % authPool.length];
  const res = http.post(url('/api/observers/resume'), JSON.stringify({ deviceId: f.deviceId, publicKeyJwk: f.publicJwk }),
    { headers: headers(J), tags: { name: 'resume' } });
  noteResponse(res);
  // /resume answers 200 {ok:false} for an unknown device, so read the body.
  return check(res, { 'resume recognised': (r) => r.status === 200 && r.json('ok') === true });
}

const choose = weighted([
  ['signup', 50, (n) => signupFlow(n, false)],
  ['wrong_code', 20, (n) => signupFlow(n, true)],
  ['login', 20, loginFlow],
  ['resume', 10, resumeFlow],
]);

export function authIteration() {
  const n = exec.scenario.iterationInTest;
  const [, , fn] = choose();
  otpOk.add(Boolean(fn(n)));
}

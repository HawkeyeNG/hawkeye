// SIGN-IN AND SESSION RENEWAL ON A STALLED LINK (pre-election review, native/).
//
// lib/auth.ts post() — behind sign-in, OTP request/verify, password, and the
// silent /resume — had no deadline, and RN's fetch never times out.
//   1. On a socket that stalled after connecting, passwordLogin() (and every
//      other sign-in step) never settled: the button spun until the app was
//      killed. Now it rejects, and the screen's catch says "network error".
//   2. renewSession() shares ONE in-flight /resume among every 401 and clears
//      it only when it settles. A /resume that never answered therefore wedged
//      every later authenticated request in the app — authedGet and
//      authedSend both wait on it — for the life of the process.
// CONTROL: a /resume that answers renews the session and the request retries.
//
// The SHIPPED native/src/lib/auth.ts and deadline.ts run in Node via
// tests/helpers/native-loader.mjs.
//
//   node tests/native_session_deadline_test.mjs
import { tally } from './helpers/harness.mjs';
import { fastTimers, loadNative, settles, stalled } from './helpers/native-loader.mjs';

const { check, finish } = tally();
fastTimers();
const N = globalThis.__native;
const A = await loadNative('lib/auth.ts', { stub: ['@/lib/identity', '@/lib/i18n', '@/lib/pending-invite', '@/lib/secure-store'] });
const signIn = () => { N.secure.set('hawkeye.auth.token', 'tok'); N.secure.set('hawkeye.auth.observer', '7'); };
signIn();
await A.bootstrapAuth();
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

console.log('=== 1. sign-in on a stalled link ends ===');
globalThis.fetch = (_url, init) => stalled(init);
check('passwordLogin() settles (rejects -> "network error, try again")',
  await settles(A.passwordLogin('08031234567', 'secret')), (v) => v.startsWith('rejected'));
check('requestOtp() settles', await settles(A.requestOtp('08031234567', 'sms')), (v) => v.startsWith('rejected'));

console.log('\n=== 2. a stalled /resume does not wedge every later request ===');
globalThis.fetch = (url, init) => (url.endsWith('/api/observers/resume') ? stalled(init) : Promise.resolve(json(401, { error: 'invalid_token' })));
check('authedGet() on an expired token settles while /resume hangs', await settles(A.authedGet('/api/observers/me', { signOutOn401: true })), 'rejected session_expired');
// The session above was expired by that answer; sign back in for the next one.
signIn();
await A.bootstrapAuth();
check('...and a LATER authedGet settles too', await settles(A.authedGet('/api/observers/me')), 'rejected session_expired');

console.log('\n=== CONTROL ===');
// renewSession() lets go of its finished attempt on the next tick, by design.
await new Promise((r) => setTimeout(r, 5));
signIn();
await A.bootstrapAuth();
globalThis.fetch = (url, init) => {
  if (url.endsWith('/api/observers/resume')) return Promise.resolve(json(200, { ok: true, observerId: 7, token: 'fresh' }));
  const auth = init?.headers?.authorization;
  return Promise.resolve(auth === 'Bearer fresh' ? json(200, { hasPassword: true }) : json(401, { error: 'invalid_token' }));
};
check('a /resume that answers renews, and the request is retried', await A.authedGet('/api/observers/me'), { hasPassword: true });

finish();

// SIGNING UP MUST END WITH A PASSWORD.
//
// "Become an observer" -> number -> code -> straight into the app. No password
// step, so the new observer's only way back in was another one-time code.
//
// Nothing in sign-in.tsx was wrong. It sets step='set-password' unconditionally
// on the sign-up path, with a comment saying two earlier attempts were lost to
// over-conditioning it. The navigation was being done by a screen NOBODY WAS
// LOOKING AT: welcome.tsx is pushed under /sign-in and stays mounted, and its
// plain `useEffect(() => { if (signedIn) router.replace('/(tabs)') })` fired the
// instant verifyOtp stored the token — tearing down the stack, and with it the
// screen that was one line from rendering the password step.
//
// That is why these checks live on welcome.tsx and not on the sign-up screen:
// the bug was never where the symptom was.
import fs from 'node:fs';
import { readNative } from './helpers/native-text.mjs';

const N = '/home/elrio/hawkeye/native/src';
const B = '/home/elrio/hawkeye/backend/src';
let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const welcome = readNative(`${N}/app/welcome.tsx`);
const signin = readNative(`${N}/app/sign-in.tsx`);
const auth = readNative(`${N}/lib/auth.ts`);
const observers = fs.readFileSync(`${B}/routes/observers.js`, 'utf8');

console.log('=== the screen underneath must not steer ===');
check('welcome redirects only while focused', /useFocusEffect\(\s*\n?\s*useCallback\(/.test(welcome), true);
// The exact regression: a bare effect on auth.status navigating away.
check('no bare effect redirecting on auth.status',
  /useEffect\(\s*\(\)\s*=>\s*\{\s*\n?\s*if \(auth\.status === 'signedIn'\) router\.replace/.test(welcome), false);
check('it still redirects a signed-in session off the door',
  /auth\.status === 'signedIn'\) router\.replace\('\/\(tabs\)'\)/.test(welcome), true);
check('and imports useFocusEffect', /import \{ router, useFocusEffect \} from 'expo-router'/.test(welcome), true);

console.log('\n=== sign-up still ends on the password step ===');
const signupBranch = (() => {
  const src = signin.split('\n');
  const at = src.findIndex((l) => l.includes("if (purpose === 'signup') {"));
  if (at < 0) return '';
  // The branch ends at the first line that closes it at that indent.
  const end = src.findIndex((l, j) => j > at && l === '      }');
  return src.slice(at, end < 0 ? at + 30 : end).join('\n');
})();
check('the sign-up branch sets it', /setStep\('set-password'\)/.test(signupBranch), true);
// The comment in the file records that conditioning this is how it broke before,
// so scope this to the BRANCH BODY: accountHasPassword() legitimately appears
// just after it, for the reset / no-password purposes that do need the check.
check('the branch body exists', signupBranch.length > 0, true);
check('and nothing in it gates on an account-status check',
  /accountHasPassword/.test(signupBranch), false);

console.log('\n=== an existing observer is told, not silently signed in ===');
check('there is an exists step', /'set-password' \| 'exists'/.test(signin), true);
check('reached only for an existing account WITH a password',
  /r\.isNew === false && r\.hadPassword/.test(signin), true);
check('the pane says the account already exists',
  /This account already exists/.test(signin), true);
check('it offers the forgot-password route', /Forgot your password\?/.test(signin), true);
/* Keyed in bd6de75 (native i18n tranche 3) as a bare expression —
   `existsAfterOtp ? i18nT('…set-a-new-one') : i18nT('…reset-it')` — which the
   shared helper does not resolve (it only rewrites `{i18nT('k')}`). Resolve
   bare calls here, through the same native bundle, so the check still reads the
   English a reader sees and still pins which wording goes with which route. */
const NATIVE_EN = JSON.parse(fs.readFileSync(`${N}/lib/i18n/en.json`, 'utf8'));
const bareEnglish = (src) => src.replace(/i18nT\('([^']+)'\)/g,
  (m, k) => (Object.hasOwn(NATIVE_EN, k) ? `'${NATIVE_EN[k]}'` : m));
const BOTH_ROUTES = /existsAfterOtp \? 'Set a new one' : 'Reset it'/;
check('worded for both routes into the pane', BOTH_ROUTES.test(bareEnglish(signin)), true);
// CONTROL: the two wordings swapped between the routes must go red.
check('CONTROL: swapped wordings are caught', BOTH_ROUTES.test(bareEnglish(signin
  .replace("'n.app.sign-in.set-a-new-one'", "'SWAP'")
  .replace("'n.app.sign-in.reset-it'", "'n.app.sign-in.set-a-new-one'")
  .replace("'SWAP'", "'n.app.sign-in.reset-it'"))), false);
check('and a way out if the number was not theirs', /signOut\(\)/.test(signin), true);

console.log('\n=== how the client learns it ===');
// 2305169 put needsUnit between the two, so read the one return type as a whole
// rather than requiring the fields to be adjacent.
check('verifyOtp returns isNew / hadPassword',
  /Promise<\{[^}]*\bisNew\?: boolean;[^}]*\bhadPassword\?: boolean[^}]*\}>/.test(auth), true);
// ...and hadPassword is the server's hasPassword, not some other flag.
check('and hadPassword is mapped from the server\'s hasPassword',
  /isNew: r\.isNew,[^}\n]*hadPassword: r\.hasPassword/.test(auth), true);
// An older server sends neither; undefined must not be read as "new".
check('an unstated answer falls back to the normal path',
  /r\.isNew === false/.test(signin), true);

console.log('\n=== and the server only says so AFTER the code ===');
/* Scoped to the /verify handler's own res.json({...}) rather than a byte window:
   fc6f7190 put needsUnit (and its comment) between isNew and hasPassword. */
const verifyReply = (src) => {
  const at = src.indexOf("observersRouter.post('/verify',");
  if (at < 0) return '';
  const next = src.indexOf('observersRouter.', at + 1);
  const handler = src.slice(at, next < 0 ? undefined : next);
  return (/res\.json\(\{([\s\S]*?)\}\);/.exec(handler) || [])[1] || '';
};
const saysBoth = (reply) => /\bisNew,/.test(reply) && /hasPassword: !!observer\.password_hash/.test(reply);
check('/verify returns isNew and hasPassword', saysBoth(verifyReply(observers)), true);
// CONTROL: the same reply with hasPassword dropped must go red.
check('CONTROL: a /verify reply without hasPassword is caught',
  saysBoth(verifyReply(observers.replace(/hasPassword: !!observer\.password_hash,?/, ''))), false);
// AND BEFORE ONE, WHERE IT SAVES MONEY. Every OTP is a billed send, and a
// sign-up on a registered number has exactly one possible outcome, so /register
// refuses it without sending. That does tell a caller the number is registered
// — but /login already does (password_login_unavailable for an unknown number,
// a different error for a known one), so it is not new exposure. There is still
// no standalone lookup endpoint, which would be.
check('/register refuses a sign-up on a registered number',
  /error: 'account_exists'/.test(observers), true);
check('and only for the sign-up intent, so reset still delivers',
  /req\.body\?\.intent \|\| ''\) === 'signup'/.test(observers), true);
check('an account with no password still gets its rescue code',
  /existing\.password_hash/.test(observers), true);
check('the refusal returns BEFORE the code is generated',
  observers.indexOf("error: 'account_exists'") < observers.indexOf('crypto.randomInt(100000'), true);
check('no standalone registration-lookup endpoint',
  /observersRouter\.(get|post)\('\/observers\/(exists|lookup|check)/.test(observers), false);
check('the client sends the intent only on sign-up',
  /purpose === 'signup' \? 'signup' : undefined/.test(signin), true);
check('and the pane knows whether a code was spent',
  /existsAfterOtp/.test(signin), true);

console.log(fail ? `\n${fail} check(s) failed` : '\nall passed');
process.exit(fail ? 1 : 0);

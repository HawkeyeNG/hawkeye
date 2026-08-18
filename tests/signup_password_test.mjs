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

const N = '/home/elrio/hawkeye/native/src';
const B = '/home/elrio/hawkeye/backend/src';
let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const welcome = fs.readFileSync(`${N}/app/welcome.tsx`, 'utf8');
const signin = fs.readFileSync(`${N}/app/sign-in.tsx`, 'utf8');
const auth = fs.readFileSync(`${N}/lib/auth.ts`, 'utf8');
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
check('the sign-up branch sets it', /if \(purpose === 'signup'\)[\s\S]{0,900}?setStep\('set-password'\)/.test(signin), true);
// The comment in the file records that conditioning this is how it broke before,
// so scope this to the BRANCH BODY: accountHasPassword() legitimately appears
// just after it, for the reset / no-password purposes that do need the check.
const signupBranch = (() => {
  const src = signin.split('\n');
  const at = src.findIndex((l) => l.includes("if (purpose === 'signup') {"));
  if (at < 0) return '';
  // The branch ends at the first line that closes it at that indent.
  const end = src.findIndex((l, j) => j > at && l === '      }');
  return src.slice(at, end < 0 ? at + 30 : end).join('\n');
})();
check('the branch body exists', signupBranch.length > 0, true);
check('and nothing in it gates on an account-status check',
  /accountHasPassword/.test(signupBranch), false);

console.log('\n=== an existing observer is told, not silently signed in ===');
check('there is an exists step', /'set-password' \| 'exists'/.test(signin), true);
check('reached only for an existing account WITH a password',
  /r\.isNew === false && r\.hadPassword/.test(signin), true);
check('the pane says the account already exists',
  /This account already exists/.test(signin), true);
check('it offers the forgot-password route', /Forgot your password\? Set a new one/.test(signin), true);
check('and a way out if the number was not theirs', /signOut\(\)/.test(signin), true);

console.log('\n=== how the client learns it ===');
check('verifyOtp returns isNew / hadPassword', /isNew\?: boolean; hadPassword\?: boolean/.test(auth), true);
// An older server sends neither; undefined must not be read as "new".
check('an unstated answer falls back to the normal path',
  /r\.isNew === false/.test(signin), true);

console.log('\n=== and the server only says so AFTER the code ===');
check('/verify returns isNew and hasPassword',
  /res\.json\(\{[\s\S]{0,200}?isNew,[\s\S]{0,120}?hasPassword: !!observer\.password_hash/.test(observers), true);
// THE PRIVACY LINE. An endpoint answering "is this number registered" before an
// OTP would turn the observer list into something anyone can enumerate by
// typing numbers — which is the whole reason only a phone hash is stored.
check('no route reports registration before an OTP',
  /observersRouter\.(get|post)\('\/observers\/(exists|lookup|check)/.test(observers), false);

console.log(fail ? `\n${fail} check(s) failed` : '\nall passed');
process.exit(fail ? 1 : 0);

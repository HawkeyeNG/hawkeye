/**
 * THE CLIENTS OFFER ONLY THE WHATSAPP ROUTES THE SERVER RUNS (owner, 2026-10-02).
 *
 * WA_PAID_OTP on the server (off by default) decides whether a PAID WhatsApp
 * code exists at all; /api/health says `waPaidOtp`. This checks the wiring in
 * the native sources (the browser half — web and Lite — is driven for real in
 * backend/tests/signin_routes_ui_test.mjs):
 *
 *  - native Send code is DISABLED until a channel chip is picked. It used to
 *    fire with none, and the server served "no channel" as a paid WhatsApp
 *    code: how the owner, signing up with Telegram, got one.
 *  - every "get a code on WhatsApp" fallback (the wa-send pane, the 503
 *    fallback, Profile's password reset) is gated on the server's waPaidOtp;
 *  - the WhatsApp choice runs the free route whenever paid codes are off.
 *
 * Each rule is also run against a MUTATED copy that re-opens the old door —
 * the check must fail there, or it proves nothing.
 *
 *   node tests/wa_paid_clients_test.mjs
 */
import fs from 'node:fs';

const ROOT = '/home/elrio/hawkeye';
const read = (f) => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const RULES = {
  'native Send code is disabled with no channel (unless an organisation code)': (s) =>
    /const sendBlocked = busy \|\| phone\.trim\(\)\.length < 10 \|\| \(!withOrgCode && !channel\);/.test(s)
    && /disabled=\{sendBlocked\}\s*\n\s*onPress=\{onRequest\}/.test(s),
  'onRequest and send() refuse to go without a channel (backstops)': (s) =>
    /if \(!channel\) return; \/\/ Send code is disabled/.test(s) && /if \(!via\) \{\s*setStep\('request'\);\s*return;\s*\}/.test(s),
  'the wa-send pane offers the paid code only while waPaid': (s) =>
    /\{waPaid \? \(\s*<Pressable[^>]*onPress=\{\(\) => paidCode\('whatsapp'\)\}/.test(s),
  'paidCode() itself refuses WhatsApp without waPaid': (s) =>
    /if \(via === 'whatsapp' && !waPaid\) return;/.test(s),
  'a 503 from /wa-start falls back to the paid code only while waPaid': (s) =>
    /if \(waPaid\) \{\s*paidCode\('whatsapp'\);\s*\} else \{\s*setStep\('request'\);\s*setLine\(i18nT\('auth\.wa-unavailable'\)\);/.test(s),
  'with paid codes off the WhatsApp choice is always the free route': (s) =>
    /const freeWhatsapp = channel === 'whatsapp' && \(!waPaid \|\| \(waOk && !waLimited\)\);/.test(s),
  'the switches come from the server (api.waRoutes)': (s) =>
    /api\.waRoutes\(\)\.then\(\(r\) => \{[\s\S]{0,120}setWaPaid\(r\?\.paid === true\)/.test(s),
  'no chip picked: a prompt says to choose (no default route)': (s) =>
    /\{!withOrgCode && !channel \? \(\s*<Text[^>]*>\{i18nT\('auth\.choose-route'\)\}<\/Text>/.test(s),
};
const MUTANTS = {
  'native Send code is disabled with no channel (unless an organisation code)': (s) => s.replace('|| (!withOrgCode && !channel);', ';'),
  'onRequest and send() refuse to go without a channel (backstops)': (s) => s.replace("if (!channel) return; // Send code is disabled", '// gone'),
  'the wa-send pane offers the paid code only while waPaid': (s) => s.replace('{waPaid ? (\n                    <Pressable', '{true ? (\n                    <Pressable'),
  'paidCode() itself refuses WhatsApp without waPaid': (s) => s.replace("if (via === 'whatsapp' && !waPaid) return;", ''),
  'a 503 from /wa-start falls back to the paid code only while waPaid': (s) => s.replace('if (waPaid) {\n          paidCode', 'if (true) {\n          paidCode'),
  'with paid codes off the WhatsApp choice is always the free route': (s) => s.replace('(!waPaid || (waOk && !waLimited))', 'waOk && !waLimited'),
  'the switches come from the server (api.waRoutes)': (s) => s.replace('setWaPaid(r?.paid === true)', 'setWaPaid(true)'),
  'no chip picked: a prompt says to choose (no default route)': (s) => s.replace("{i18nT('auth.choose-route')}", '{null}'),
};

console.log('=== native sign-in ===');
const signIn = read('native/src/app/sign-in.tsx');
for (const [label, rule] of Object.entries(RULES)) {
  check(label, rule(signIn), true);
  const mutated = MUTANTS[label](signIn);
  check(`  CONTROL mutant re-opens it -> the check fails`, mutated !== signIn && !rule(mutated), true);
}

console.log('\n=== native Profile password reset ===');
const profile = read('native/src/app/profile.tsx');
const resetRule = (s) => /\.\.\.\(waPaid \? \(\['whatsapp'\] as ResetChannel\[\]\) : \[\]\),\s*'telegram',/.test(s)
  && /api\.waRoutes\(\)\.then\(\(r\) => \{ if \(alive\) setWaPaid\(r\?\.paid === true\); \}\);/.test(s);
check('WhatsApp is a reset channel only while waPaid; Telegram always', resetRule(profile), true);
const pm = profile.replace("...(waPaid ? (['whatsapp'] as ResetChannel[]) : []),", "'whatsapp',");
check('  CONTROL WhatsApp always offered -> the check fails', pm !== profile && !resetRule(pm), true);
check('the "Code sent — check WhatsApp/SMS" line is gone (it named channels the code may not have used)',
  /code-sent-check-whatsapp-sms/.test(profile), false);
check('an unlinked Telegram number gets the bot link, not "could not send"',
  /if \(r\.telegramLink && !r\.viaSms\) \{[\s\S]{0,400}WebBrowser\.openBrowserAsync\(r\.telegramLink\)/.test(profile), true);

console.log('\n=== native api ===');
const api = read('native/src/lib/api.ts');
check('waRoutes reads waPaidOtp, fail-closed (=== true)', /paid: h\.waPaidOtp === true/.test(api), true);
check('...and an unanswered health is null (WhatsApp stays, the server decides)', /return h \? \{ free: h\.waInbound === true, paid: h\.waPaidOtp === true \} : null;/.test(api), true);

console.log('\n=== web (wiring only; behaviour: backend/tests/signin_routes_ui_test.mjs) ===');
const app = read('app/app.js');
const html = read('app/observe.html');
check('the paid line starts hidden in the markup (fail closed)', /<p class="hint auth-alt" id="wa-paid-line" hidden>/.test(html), true);
check('it is shown only from the server\'s waPaidOtp', /if \(h && h\.waPaidOtp === true\) WA_PAID = true;/.test(app) && /\$\('wa-paid-line'\)\.hidden = !WA_PAID;/.test(app), true);
check('the WhatsApp-under-Telegram switch is paid only while WA_PAID, else the free route', /const waSwitch = WA_PAID\s*\?[\s\S]{0,200}switch-wa"[\s\S]{0,200}: WA_INBOUND\s*\?[\s\S]{0,200}switch-wa-free"/.test(app), true);

console.log(`\n${fail ? `${fail} FAILED` : 'ALL PASSED'}`);
process.exit(fail ? 1 : 0);

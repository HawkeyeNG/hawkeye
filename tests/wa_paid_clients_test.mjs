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
  'D2: SMS is not in the Telegram/WhatsApp row; it sits below, small, labelled as the fallback': (s) =>
    !/key: 'sms'/.test(s.slice(s.indexOf('const CHANNELS'), s.indexOf('const CHANNELS') + 400))
    && /\{smsOk && !withOrgCode \? \(\s*<Pressable\s*onPress=\{\(\) => setChannel\('sms'\)\}[\s\S]{0,400}text-xs[\s\S]{0,120}SMS · \{i18nT\('auth\.sms-fallback'\)\}/.test(s),
  'D2: a phone that has a passkey leads with it (primary, above the password); otherwise it stays below': (s) =>
    /\{pkUsable && pkHere \? \(\s*<Pressable[\s\S]{0,300}bg-hawk-green/.test(s) && /\{pkUsable && !pkHere \? \(/.test(s)
    && s.indexOf('{pkUsable && pkHere ?') < s.indexOf("n.app.sign-in.your-phone-number-and-password-your"),
  'D3: a reset nudges "before 9 January" until then': (s) =>
    /purpose === 'reset' && NUDGE_RESETS \? \(\s*<Text[^>]*>\{i18nT\('auth\.reset-before-9-jan'\)\}/.test(s)
    && /const NUDGE_RESETS = Date\.now\(\) < Date\.parse\('2027-01-09T00:00:00\+01:00'\);/.test(s),
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
  'D2: SMS is not in the Telegram/WhatsApp row; it sits below, small, labelled as the fallback': (s) =>
    s.replace("{ key: 'telegram', label: 'Telegram' },", "{ key: 'telegram', label: 'Telegram' },\n    { key: 'sms', label: 'SMS' },"),
  'D2: a phone that has a passkey leads with it (primary, above the password); otherwise it stays below': (s) => s.replace('{pkUsable && pkHere ? (', '{false ? ('),
  'D3: a reset nudges "before 9 January" until then': (s) => s.replace("{i18nT('auth.reset-before-9-jan')}", '{null}'),
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

console.log('\n=== native: the ONLY paid WhatsApp link is the gated one ===');
{
  const src = read('native/src/app/sign-in.tsx');
  const uses = [...src.matchAll(/n\.auth\.wa-fallback-whatsapp/g)].map((m) => m.index);
  const gate = src.indexOf('{waPaid ? (\n                    <Pressable');
  check('one use of the paid-link string, inside the waPaid gate', uses.length === 1 && gate > 0 && uses[0] > gate && uses[0] - gate < 400, true);
}

console.log('\n=== native: a published OTA runs after a real absence (lib/fresh-updates.ts) ===');
{
  const { stripTypeScriptTypes } = await import('node:module');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const ts = read('native/src/lib/fresh-updates.ts');
  const body = stripTypeScriptTypes(ts.replace(/^import [^;]+;\n/gm, ''), { mode: 'strip' });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hk-fresh-')), 'm.mjs');
  fs.writeFileSync(f, 'const Updates = {}; const AppState = {}; const useEffect = () => {}; const __DEV__ = false;\n' + body);
  const M = await import(pathToFileURL(f).href);
  const run = async ({ awayMin, available = true, enabled = true }) => {
    let t = 0;
    const calls = [];
    const api = {
      isEnabled: enabled,
      checkForUpdateAsync: async () => { calls.push('check'); return { isAvailable: available }; },
      fetchUpdateAsync: async () => { calls.push('fetch'); },
      reloadAsync: async () => { calls.push('reload'); },
    };
    const l = M.freshUpdatesListener(api, () => t);
    l('background');
    t += awayMin * 60_000;
    await l('active');
    return calls;
  };
  check('back after 20 min with a newer update: check, fetch, RELOAD', await run({ awayMin: 20 }), ['check', 'fetch', 'reload']);
  check('CONTROL back after 1 min (mid-task, e.g. sending the WhatsApp code): nothing', await run({ awayMin: 1 }), []);
  check('CONTROL nothing newer: check only, no reload', await run({ awayMin: 20, available: false }), ['check']);
  check('CONTROL updates disabled (development): nothing', await run({ awayMin: 20, enabled: false }), []);
  const layout = read('native/src/app/_layout.tsx');
  check('mounted in the root layout', /import \{ useFreshUpdates \} from '@\/lib\/fresh-updates';/.test(layout) && /\n  useFreshUpdates\(\);/.test(layout), true);
}

console.log(`\n${fail ? `${fail} FAILED` : 'ALL PASSED'}`);
process.exit(fail ? 1 : 0);

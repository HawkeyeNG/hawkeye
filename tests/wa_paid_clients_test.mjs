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
  'native Send code LOOKS off with no channel (unless an organisation code)': (s) =>
    /const sendLooksOff = sendBlocked \|\| \(!withOrgCode && !channel\);/.test(s)
    && /disabled=\{sendBlocked\}\s*\n\s*onPress=\{onRequest\}/.test(s) && /sendLooksOff \? 'bg-disabled'/.test(s),
  'onRequest and send() refuse to go without a channel (backstops)': (s) =>
    /if \(!channel\) \{\s*setNeedChoice\(true\);\s*return;\s*\}/.test(s) && /if \(!via\) \{\s*setStep\('request'\);\s*return;\s*\}/.test(s),
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
    /\{needChoice && !withOrgCode && !channel \? \(\s*<Text[^>]*>\{i18nT\('auth\.choose-route'\)\}<\/Text>/.test(s),
  /* SIGN-UP's LINE-UP (owner, 2026-10-04): WhatsApp, Telegram, Call — then SMS,
     its own chip after the row, so LAST; "SMS (paid)" while the four fit one
     line, plain "SMS" once measured wrapped. Never pre-selected. */
  'D2: sign-up WhatsApp, Telegram, Call; SMS its own chip, last, "(paid)" while one line fits; no default': (s) => {
    const at = s.indexOf('const CHANNELS');
    const decl = at < 0 ? '' : s.slice(at, s.indexOf('];', at) + 2);
    return !!decl && !/key: 'sms'/.test(decl)
      && /purpose === 'signup'\s*\?\s*\[\.\.\.WA_CHIP, \.\.\.TG_CHIP, \.\.\.\(callRoute \? \[\{ key: 'call'/.test(decl)
      && /\{smsOk \? \(\s*<Pressable\s*onPress=\{\(\) => \{\s*setChannel\('sms'\);[\s\S]{0,700}\{smsShort \? i18nT\('observe\.sms'\) : i18nT\('auth\.sms-paid'\)\}/.test(s)
      && s.indexOf("setChannel('sms')") > s.indexOf('CHANNELS.map(')
      && /useState<Channel \| null>\(null\)/.test(s);
  },
  'D2: a phone that has a passkey leads with it (primary, above the password); otherwise it stays below': (s) =>
    /\{pkUsable && pkHere \? \(\s*<Pressable[\s\S]{0,300}bg-hawk-green/.test(s) && /\{pkUsable && !pkHere \? \(/.test(s)
    && s.indexOf('{pkUsable && pkHere ?') < s.indexOf("n.app.sign-in.number-never-stored"),
  'D3: a reset nudges "before 9 January" until then': (s) =>
    /purpose === 'reset' && NUDGE_RESETS \? \(\s*<Text[^>]*>\{i18nT\('auth\.reset-before-9-jan'\)\}/.test(s)
    && /const NUDGE_RESETS = Date\.now\(\) < Date\.parse\('2027-01-09T00:00:00\+01:00'\);/.test(s),
};
const MUTANTS = {
  'native Send code LOOKS off with no channel (unless an organisation code)': (s) => s.replace('const sendLooksOff = sendBlocked || (!withOrgCode && !channel);', 'const sendLooksOff = sendBlocked;'),
  'onRequest and send() refuse to go without a channel (backstops)': (s) => s.replace('      setNeedChoice(true);\n      return;\n', '      setNeedChoice(true);\n'),
  'the wa-send pane offers the paid code only while waPaid': (s) => s.replace('{waPaid ? (\n                    <Pressable', '{true ? (\n                    <Pressable'),
  'paidCode() itself refuses WhatsApp without waPaid': (s) => s.replace("if (via === 'whatsapp' && !waPaid) return;", ''),
  'a 503 from /wa-start falls back to the paid code only while waPaid': (s) => s.replace('if (waPaid) {\n          paidCode', 'if (true) {\n          paidCode'),
  'with paid codes off the WhatsApp choice is always the free route': (s) => s.replace('(!waPaid || (waOk && !waLimited))', 'waOk && !waLimited'),
  'the switches come from the server (api.waRoutes)': (s) => s.replace('setWaPaid(r?.paid === true)', 'setWaPaid(true)'),
  'no chip picked: a prompt says to choose (no default route)': (s) => s.replace("{i18nT('auth.choose-route')}", '{null}'),
  // SMS back in the row, in front of Call — the old door.
  'D2: sign-up WhatsApp, Telegram, Call; SMS its own chip, last, "(paid)" while one line fits; no default': (s) =>
    s.replace('? [...WA_CHIP, ...TG_CHIP, ...(callRoute', "? [...WA_CHIP, ...TG_CHIP, { key: 'sms' as Channel, label: 'SMS' }, ...(callRoute"),
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
{
  // The line-up rule's other doors: a default pick, Telegram leading sign-up,
  // and a fixed "SMS (paid)" that cannot step down when the line wraps.
  const rule = RULES['D2: sign-up WhatsApp, Telegram, Call; SMS its own chip, last, "(paid)" while one line fits; no default'];
  for (const [what, m] of [
    ['a default route', signIn.replace('useState<Channel | null>(null)', "useState<Channel | null>('whatsapp')")],
    ['Telegram first on sign-up', signIn.replace('? [...WA_CHIP, ...TG_CHIP,', '? [...TG_CHIP, ...WA_CHIP,')],
    ['"(paid)" always', signIn.replace("{smsShort ? i18nT('observe.sms') : i18nT('auth.sms-paid')}", "{i18nT('auth.sms-paid')}")],
  ]) check(`  CONTROL ${what} -> the check fails`, m !== signIn && !rule(m), true);
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

console.log('\n=== native: a published OTA runs at the next SAFE moment (lib/fresh-updates.ts) ===');
{
  const { stripTypeScriptTypes } = await import('node:module');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const ts = read('native/src/lib/fresh-updates.ts');
  const body = stripTypeScriptTypes(ts.replace(/^import [^;]+;\n/gm, ''), { mode: 'strip' });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hk-fresh-')), 'm.mjs');
  fs.writeFileSync(f, 'const Updates = {}; const AppState = {}; const useEffect = () => {}; const __DEV__ = false;\n'
    + 'const outboxBusy = () => globalThis.__outboxBusy === true;\n' + body);
  const M = await import(pathToFileURL(f).href);
  /** Leave the app from `where`, come back after `awayMin`; returns the calls made. */
  const scenario = async ({ where, awayMin = 20, available = true, enabled = true, hold = false, busy = false }) => {
    let t = 1_000_000;
    const calls = [];
    const api = {
      isEnabled: enabled,
      checkForUpdateAsync: async () => { calls.push('check'); return { isAvailable: available }; },
      fetchUpdateAsync: async () => { calls.push('fetch'); },
      reloadAsync: async () => { calls.push('reload'); },
    };
    globalThis.__outboxBusy = busy;
    M.noteRoute(where);
    const l = M.freshUpdatesListener(api, () => t);   // the real safety check
    const release = hold ? M.holdUpdates() : null;
    l.onState('background');
    t += awayMin * 60_000;
    await l.onState('active');
    return { calls: [...calls], calls_: calls, release, l };
  };
  const HOME = ['(tabs)'];
  const WA_WAIT = ['sign-in'];   // the "Send us this code on WhatsApp" waiting step lives on /sign-in
  let s = await scenario({ where: HOME });
  check('Home, nothing pending, 20 min away: check, fetch, RELOAD', s.calls, ['check', 'fetch', 'reload']);
  s = await scenario({ where: WA_WAIT });
  check('WhatsApp sign-in waiting screen, 20 min away: fetched but NO reload', s.calls, ['check', 'fetch']);
  M.noteRoute(['(tabs)', 'alerts']);
  await new Promise((r) => setTimeout(r, 10));
  check('...then on a tab root (Alerts): the waiting update is applied', s.calls_.at(-1), 'reload');
  for (const [label, where] of [['a report in progress', ['report', 'capture']], ['the Report tab (holds a draft)', ['(tabs)', 'report']],
    ['an incident report', ['incidents']], ['a practice run', ['practice']], ['Profile (forms)', ['profile']]]) {
    s = await scenario({ where });
    check(`${label}: no reload`, s.calls.includes('reload'), false);
  }
  s = await scenario({ where: HOME, hold: true });
  check('Home with a sheet/modal open: no reload', s.calls.includes('reload'), false);
  s.release();
  await new Promise((r) => setTimeout(r, 10));
  check('...the sheet closes: applied', s.calls_.at(-1), 'reload');
  s = await scenario({ where: HOME, busy: true });
  check('Home with reports queued or sending: no reload', s.calls.includes('reload'), false);
  globalThis.__outboxBusy = false;
  s = await scenario({ where: HOME, awayMin: 1 });
  check('CONTROL a short trip out (1 min): nothing asked at all', s.calls, []);
  s = await scenario({ where: HOME, available: false });
  check('CONTROL nothing newer: check only', s.calls, ['check']);
  s = await scenario({ where: HOME, enabled: false });
  check('CONTROL updates disabled (development): nothing', s.calls, []);
  const layout = read('native/src/app/_layout.tsx');
  check('root layout: mounted, and reports the route', /import \{ noteRoute, useFreshUpdates \} from '@\/lib\/fresh-updates';/.test(layout)
    && /\n  useFreshUpdates\(\);/.test(layout) && /useEffect\(\(\) => \{ noteRoute\(segments\); \}, \[segments\]\);/.test(layout), true);
  const modals = ['components/modal-card.tsx', 'components/confirm-sheet.tsx', 'components/image-viewer.tsx', 'components/video-viewer.tsx',
    'components/sheet-reference.tsx', 'components/report-content.tsx', 'app/(tabs)/alerts.tsx'];
  check('every Modal holds updates while visible', modals.filter((m) => !/<Modal[\s\S]{0,700}?>\s*\{\/\*[^*]*\*\/\}\s*<HoldUpdates \/>/.test(read(`native/src/${m}`))), []);
  const allModal = execList();
  // A Modal on a non-tab screen (practice, profile, support) is already covered: those routes are never safe.
  check('...and no Modal on a tab root or in a shared component without a HoldUpdates', allModal.filter((m) => !modals.includes(m) && (m.startsWith('components/') || m.startsWith('app/(tabs)/'))), []);
}
function execList() {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(`${ROOT}/native/src/${d}`, { withFileTypes: true })) {
    const p = d ? `${d}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p); else if (/\.tsx$/.test(e.name) && /<Modal[\s>]/.test(read(`native/src/${p}`))) out.push(p);
  } };
  walk('');
  return out;
}

console.log(`\n${fail ? `${fail} FAILED` : 'ALL PASSED'}`);
process.exit(fail ? 1 : 0);

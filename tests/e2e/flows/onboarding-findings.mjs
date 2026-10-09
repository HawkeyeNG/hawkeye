/**
 * Findings for the `onboarding` flow group, built from checks.json.
 *
 * Each finding has a `when` that reads the run's own observations, so a re-run
 * after a fix drops it. `ev` names the checks whose screenshots are the evidence.
 * Source lines were read when the finding was written (2026-10-03, main @ 8395df90).
 */
const SURF = ['web', 'lite', 'native'];
/* Filled in after reading the source for each untranslated line (see the final report). */
const HA_SOURCE = {
  native: 'native/src/app/sign-in.tsx:1050 ("New here?"), :1207 ("First time?"), :1274 ("Forgot your password?") are English literals around keyed text',
  web: 'app/index.html:818 (Home alerts empty state "Nothing yet — reports at your saved unit…" has no i18n key; it is exactly what a new observer sees)',
  lite: 'app/index.html:818 (Home alerts empty state "Nothing yet — reports at your saved unit…" has no i18n key; it is exactly what a new observer sees)',
};

let MG_TEXT = {};
export function buildFindings(checks, steps) {
  // The my-groups 5xx screen's own text (steps.json), read for ONB-10.
  MG_TEXT = {};
  for (const s of SURF) MG_TEXT[s] = (steps?.['session-500-my-groups']?.[s]?.en || []).map((x) => x.text).join(' ');
  const get = (flow, s, l, n) => checks?.[flow]?.[s]?.[l]?.[n];
  const v = (flow, s, l, n) => get(flow, s, l, n)?.value;
  const on = (pred) => SURF.filter((s) => { try { return !!pred(s); } catch { return false; } });
  const pngs = (list) => [...new Set(list.flatMap(([flow, s, l, n]) => {
    const c = get(flow, s, l, n);
    if (!c || !c.png) return [];
    return Array.isArray(c.png) ? c.png : [c.png];
  }))].map((p) => `tests/e2e/out/flows/onboarding/${p}`);
  const out = [];
  const add = (f) => {
    const surfaces = f.surfaces.filter(Boolean);
    if (!surfaces.length) return;
    out.push({
      id: f.id, flow: f.flow, surfaces, severity: f.severity, title: f.title, actual: f.actual, expected: f.expected,
      evidence: pngs(f.ev(surfaces)), source: f.source, fix: f.fix, needsDevice: !!f.needsDevice,
    });
  };

  /* ---------------------------------------------------------------- P1 */
  add({
    id: 'ONB-01', flow: 'signin', severity: 'P1',
    surfaces: on((s) => s !== 'native' && v('signin-forgot', s, 'en', 'forgotPicker')?.pickerDisplay === 'none' && v('signin-forgot', s, 'en', 'forgotPicker')?.pickerHiddenAttr === false),
    title: '"Forgot your password?" on Sign In is a dead end: no route picker, then no new-password field',
    actual: 'On observe.html?intent=signin, tapping "Forgot your password?" switches the pane to code mode in JS (button "Send Code", link "Sign in with your password instead") but the route picker stays display:none and the old Password field stays on screen. Send Code only says "Choose how to verify your number first." with nothing to choose, and nothing is sent. Even with a route forced by script, the code screen has no visible "new password" field, and Verify then refuses with "Your password must be at least 8 characters." pointing at a hidden field. Lite opens on this exact screen at first launch, every 401 bounce lands here, and password_login_unavailable tells the reader to use this route.',
    expected: 'Forgot password shows the Telegram / WhatsApp / SMS choice, sends a code, and asks for a new password on screen (as native does).',
    ev: (S) => S.flatMap((s) => [['signin-forgot', s, 'en', 'forgotPicker'], ['signin-forgot', s, 'en', 'forgotSendNoRoute'], ['signin-forgot', s, 'en', 'forgotVerifyMsg']]),
    source: 'app/styles.css:2020-2024 (html.intent-signin #channel-pick / #pw-opt display:none !important, #pw-signin-wrap display:block !important); app/observe.html:248-261 adds the class at parse time and nothing removes it; app/app.js:972-986 (#pw-link) only toggles [hidden]',
    fix: 'Toggle the class with the mode: document.documentElement.classList.toggle(\'intent-signin\', authMode === \'password\') in the #pw-link handler, enterOtpMode and resetAuthPane (or drop the !important rules once app.js has painted).',
  });
  add({
    id: 'ONB-02', flow: 'session', severity: 'P1',
    surfaces: on((s) => s !== 'native' && (v('session', s, 'en', '401_my-groups')?.navigations ?? 0) >= 6),
    title: 'My Groups with a refused token loops between my-groups.html and Sign In forever',
    actual: 'A 401 (invalid_token / unknown_observer / device_mismatch) on /api/groups sends the reader to observe.html?intent=signin&next=my-groups.html WITHOUT dropping the token; observe.html sees an unexpired token and forwards straight back to my-groups.html, which 401s again. The page flips back and forth (navigation count in evidence) and the sign-in form never appears.',
    expected: 'The refused token is dropped and the sign-in form shows, then returns to My Groups after sign-in (what situation-room.html already does).',
    ev: (S) => S.map((s) => ['session', s, 'en', '401_my-groups']),
    source: 'app/my-groups.html:80 (any 401 -> location.replace, token kept); app/app.js:3502-3504 (fresh token + next -> location.href = NEXT_DEST); compare app/situation-room.html:816-822',
    fix: 'In my-groups.html api(): if HAWKEYE.authRejected(status, body) remove hawkeye_token, then location.replace(...&next=my-groups.html); treat any other 401/5xx as "could not reach".',
  });

  /* ---------------------------------------------------------------- P2 */
  add({
    id: 'ONB-03', flow: 'signup', severity: 'P2',
    // Native is the reference order: listed only beside a web/Lite surface that differs.
    surfaces: ((web) => (web.length ? [...web, ...on((s) => s === 'native' && v('signup', s, 'en', 'pwOnFirstScreen') === false && Array.isArray(v('signup', s, 'en', 'pwStepAsked')))] : []))(
      on((s) => s !== 'native' && v('signup', s, 'en', 'pwOnFirstScreen') === true && v('signup', s, 'en', 'pwCheckedBeforeCode')?.verifyCalled === false)),
    title: 'Password is asked BEFORE the code is verified on web/Lite, AFTER it on native',
    actual: 'Web/Lite: step 1 asks number + route + "Create a Password" + invite code; step 2 (code screen) still shows the password field; tapping Verify with a code but no password is refused ("Your password must be at least 8 characters.") without the code being checked; on the free WhatsApp route the password must be typed before the code is even issued. One password field, no repeat. Native: step 1 number + route + invite code; step 2 code only; step 3 "Create Your Password" (new + repeat) after the code is verified. Same split for the organisation-code route (web: password before the "is this your number?" sheet; native: after the account exists).',
    expected: 'One order everywhere: number + route (+ code field) -> code -> create password (new + repeat) -> choose unit.',
    ev: (S) => S.flatMap((s) => (s === 'native'
      ? [['signup', s, 'en', 'signupAsked'], ['signup', s, 'en', 'codeAsked'], ['signup', s, 'en', 'pwStepAsked']]
      : [['signup', s, 'en', 'signupAsked'], ['signup', s, 'en', 'codeAsked'], ['signup', s, 'en', 'pwCheckedBeforeCode'], ['signup-whatsapp', s, 'en', 'waNeedsPwFirst']])),
    source: 'web: app/observe.html:359-365 (#pw-opt), app/app.js:686-693 (applySignUpMode shows it up front), app/app.js:1274-1284 (WhatsApp: password before /wa-start), app/app.js:1297-1302 (password validated before /verify), app/app.js:1333-1341 (set-password after verify), app/app.js:832-833 (org: password before confirm); native: native/src/app/sign-in.tsx:631-656 (afterProof -> set-password step), :1497-1536 (password step), :456-462 (org -> set-password)',
    fix: 'Port native\'s order to app.js: hide #pw-opt on the first and code screens; after /verify, /wa-status verified or /org-signup succeed, show a "Create your password" step (new + repeat) that calls /set-password (fresh phone proof, observers.js:869-882), then afterVerified().',
  });
  add({
    id: 'ONB-04', flow: 'signup', severity: 'P2',
    surfaces: on((s) => s !== 'native' && v('signup', s, 'en', 'existingNumber')?.registerIntent == null && v('signup', s, 'en', 'existingNumber')?.passwordOverwritten === true),
    title: 'Web "Create account" with an already-registered number sends a code and silently replaces the password',
    actual: 'Web/Lite sign-up posts /register without intent:"signup", so the server sends a code (paid on SMS) instead of answering 409 account_exists. After the code, app.js calls /set-password with whatever was typed, overwriting the existing password, and drops the reader into the report flow with no word that the account already existed. Native sends intent:"signup", nothing is sent, and the reader sees "This account already exists" with Sign in instead / Reset it.',
    expected: 'As native: the sign-up form refuses an existing number before any code ("already registered — sign in or reset").',
    ev: (S) => S.flatMap((s) => [['signup', s, 'en', 'existingNumber'], ['signup', s, 'en', 'registerBody']]).concat([['signup', 'native', 'en', 'accountExistsMsg']]),
    source: 'app/app.js:1287-1291 (register body {phone, channel, lang}); app/app.js:1333-1341 (set-password regardless of isNew/hasPassword); native/src/lib/auth.ts:139 (intent), native/src/app/sign-in.tsx:325-330 and :640-648 (exists step); backend/src/routes/observers.js:218-228',
    fix: 'Send intent:"signup" from the web sign-up form, show native\'s "exists" pane on 409 account_exists, and skip /set-password when /verify says isNew:false && hasPassword:true.',
  });
  add({
    id: 'ONB-05', flow: 'signup', severity: 'P2',
    surfaces: on((s) => s === 'lite' && v('signup', s, 'en', 'firstScreen') === 'sign-in form'),
    title: 'Lite first launch opens on "Sign In — Welcome back", not on a welcome or sign-up',
    actual: 'A stranger opening Lite for the first time is redirected from index.html to observe.html?intent=signin&next=index.html: "Sign In / Welcome back — sign in to your observer account", phone + password. Sign-up is a small "Don\'t have an account? Sign Up" link at the bottom (1 extra tap). Native opens on a welcome screen with "Become an observer" first; web opens on the landing page with "Become an observer".',
    expected: 'First launch offers both doors with sign-up first (native welcome), or opens on the sign-up form.',
    ev: () => [['signup', 'lite', 'en', 'firstScreen'], ['signup', 'native', 'en', 'firstScreen'], ['signup', 'web', 'en', 'firstScreen']],
    source: 'app/authgate.js:63 and :83-86 (app shell: index.html is not in ALWAYS, so it is sent to ?intent=signin)',
    fix: 'In the app shell, send a signed-out index.html to observe.html?intent=observe (or let index.html render its is-landing welcome with "Become an observer" + "Sign in").',
  });
  add({
    id: 'ONB-06', flow: 'signup', severity: 'P2',
    surfaces: [...on((s) => s !== 'native' && v('signup', s, 'en', 'kbdForm') && v('signup', s, 'en', 'kbdForm').span > v('signup', s, 'en', 'kbdForm').room), ...on((s) => s !== 'native' && v('signup', s, 'en', 'kbdCode') && v('signup', s, 'en', 'kbdCode').span > v('signup', s, 'en', 'kbdCode').room)].filter((x, i, a) => a.indexOf(x) === i),
    title: 'Keyboard up: Send Code / Verify can never be on screen with the field on web/Lite',
    actual: 'At 360x740 with the keyboard (~42%) up, the visible height is 429px but the distance from the number field to Send Code is ~537px (password + invite fields sit between them), and from the code field to Verify ~505px. Whatever the scroll, the reader cannot see the field and the button together. Native: 320px / 124px (fits).',
    expected: 'The primary button sits directly under the field being typed in (fits in 429px).',
    ev: (S) => S.flatMap((s) => [['signup', s, 'en', 'kbdForm'], ['signup', s, 'en', 'kbdCode']]).concat([['signup', 'native', 'en', 'kbdCode']]),
    source: 'app/observe.html:280-390 (field, route fieldset, #pw-opt, #ref-opt, then #btn-auth); app/app.js:1106-1133 keepAuthInView keeps the field in sight first',
    fix: 'Follows from ONB-03 (no password field on these screens); also move the invite/ORG field below the button behind "Have a code?" on the code screen.',
  });
  add({
    id: 'ONB-07', flow: 'signup', severity: 'P2',
    surfaces: on((s) => s !== 'native' && [v('signup', s, 'en', 'err500Msg'), v('signin', s, 'en', 'pw500Msg')].includes('internal_error')),
    title: 'A server error shows the raw code "internal_error" on web/Lite sign-up and sign-in',
    actual: 'A 500 {error:"internal_error"} on /register or /login prints "internal_error" under the field (in every language). An HTML 502 says "Something went wrong." with no next step. Native: "Sign-in failed — try again." / "Network error — try again.".',
    expected: 'A translated sentence that says Hawkeye could not be reached right now and to try again (typed input is kept, which it already is).',
    ev: (S) => S.flatMap((s) => [['signup', s, 'en', 'err500Msg'], ['signin', s, 'en', 'pw500Msg']]),
    source: 'app/app.js:440-448 explain(): falls back to body.hint || own || code',
    fix: 'In explain(): for status >= 500 or an unknown code, return T(\'observe.err.server-busy\', \'Hawkeye could not finish that just now — try again in a minute.\') instead of the code.',
  });
  add({
    id: 'ONB-08', flow: 'session', severity: 'P2',
    surfaces: on((s) => s !== 'native' && v('session', s, 'en', 'return_profile') !== undefined && !/profile\.html/.test(v('session', s, 'en', 'return_profile') || '')),
    title: 'Profile with a refused token: in-place "not signed in" whose link opens SIGN-UP, and sign-in never returns to Profile',
    actual: 'profile.html drops the token and shows "You\'re not signed in. Sign in or register" in place; the link is observe.html (sign-up mode, no next). The reader must find "Have an account? Sign In", and after signing in lands on Home, not Profile (3+ taps more than the room page, which returns).',
    expected: 'Straight to observe.html?intent=signin&next=profile.html, back on Profile after sign-in (as situation-room.html does).',
    ev: (S) => S.flatMap((s) => [['session', s, 'en', '401_profile'], ['session', s, 'en', '401_profile_link'], ['session', s, 'en', 'return_profile']]),
    source: 'app/profile.html:597-600 and :148-150 (link href="observe.html")',
    fix: 'location.replace(\'observe.html?intent=signin&next=profile.html\') on authRejected (or point the in-place link there).',
  });
  add({
    id: 'ONB-09', flow: 'session', severity: 'P2',
    surfaces: on((s) => s === 'native' && v('session', s, 'en', 'return_my-groups') !== undefined && !/my-groups/.test(v('session', s, 'en', 'return_my-groups') || '')),
    title: 'Native: a refused token drops the reader on Welcome and sign-in lands on Home, not where they were',
    actual: 'A 401 on My Groups (after a failed silent resume) expires the session and the root layout replaces the stack with /welcome; Sign in then goes to the tabs. The page the reader was on is forgotten. Web returns to the room (next=) but not to Profile or My Groups.',
    expected: 'After signing in again the reader is back on the screen they were on.',
    ev: () => [['session', 'native', 'en', '401_my-groups'], ['session', 'native', 'en', 'return_my-groups']],
    source: 'native/src/app/_layout.tsx:209-253 (router.replace(\'/welcome\')); native/src/app/sign-in.tsx:366-375 finishReturning -> router.replace(\'/(tabs)\')',
    fix: 'Pass the current route to welcome/sign-in (e.g. /welcome?next=/my-groups) at the bounce and router.replace(next) in finishReturning.',
  });
  add({
    id: 'ONB-10', flow: 'session', severity: 'P2',
    surfaces: on((s) => s !== 'native' && v('session', s, 'en', 'keep_my-groups_500')?.tokenKept === true && /not joined|none/i.test(JSON.stringify(v('session', s, 'en', 'keep_my-groups_500')) + (MG_TEXT[s] || ''))),
    title: 'My Groups on a server error (5xx / HTML 502) says "You have not joined any campaign or observer group"',
    actual: 'Offline shows "Could not load your groups … Try again", but a 500 or a Cloudflare 502 page is rendered as an empty membership: a room member is told they are in no group, with no retry. (The session is kept, as 90bc7efb intends.)',
    expected: 'Any non-200 that is not an auth 401 shows the same "Could not load your groups" + Try again card as offline.',
    ev: (S) => S.flatMap((s) => [['session', s, 'en', 'keep_my-groups_500'], ['session', s, 'en', 'keep_my-groups_502html'], ['session', s, 'en', 'keep_my-groups_offline']]),
    source: 'app/my-groups.html:98-110 (load() ignores status: body.member || [] -> my-groups.none); the offline card is only in the .catch at :244-248',
    fix: 'In load(): if (status !== 200) throw new Error(String(status)) so the existing load-failed card handles it.',
  });
  add({
    id: 'ONB-20', flow: 'session', severity: 'P3',
    surfaces: on((s) => s === 'native' && /HTTP 5\d\d/.test(v('session', s, 'en', 'keep_profile_500')?.says || '')),
    title: 'Native Profile on a server error shows "Could not load your profile. (HTTP 500)" with no retry',
    actual: 'The session is kept (correct) but the reader gets an HTTP status code; offline says "No connection. Check your network and try again.". Web shows "Could not reach Hawkeye" + Try again and paints the last known profile.',
    expected: 'The web wording and a Try again, with the last /me painted.',
    ev: () => [['session', 'native', 'en', 'keep_profile_500'], ['session', 'native', 'en', 'keep_profile_502html'], ['session', 'web', 'en', 'keep_profile_500']],
    source: 'native/src/app/profile.tsx:368-381',
    fix: 'Replace could-not-load-your-profile-http with common.cant-reach-hawkeye + a retry button.',
  });
  add({
    id: 'ONB-11', flow: 'org', severity: 'P2',
    surfaces: on((s) => /choose-unit/.test(v('org', s, 'en', 'orgArrival') || '') && v('org', s, 'en', 'orgRoomInMyGroups') === true),
    title: 'Organisation-code sign-up ends on "choose your unit" then Home; the room they were put in is never opened or named',
    actual: 'The server joins the agent to the issuer\'s room at sign-up (or once the unit is saved), but every surface routes the new account to choose-unit and then Home, and Home has no rooms card. Web/Lite show it at most as one unread line in Latest Alerts ("You joined …", once the notification exists and Home can fetch it); native Home shows nothing. The room itself is only in My Groups (web: Menu; native: More).',
    expected: 'After an ORG sign-up (and the unit), land in the room or show "You are in <room>" with a button to open it.',
    ev: (S) => S.flatMap((s) => [['org', s, 'en', 'orgArrival'], ['org', s, 'en', 'orgRoomOnHome'], ['org', s, 'en', 'orgRoomInMyGroups']]),
    source: 'app/app.js:865 + :916 (org -> afterVerified -> choose-unit.html?onboard=1); app/choose-unit.html:675 (-> index.html); native/src/app/sign-in.tsx:805-811; backend/src/routes/groups.js:1775-1838 (autoJoinOrgRoom)',
    fix: 'After an ORG sign-up, have choose-unit\'s Save/Skip check /api/groups and go to my-groups.html (native /my-groups) when a membership exists.',
  });
  add({
    id: 'ONB-12', flow: 'signin', severity: 'P2',
    // Native is the reference: listed only beside a web/Lite surface that still differs.
    surfaces: ((web) => (web.length ? web.concat(on((s) => s === 'native' && v('signin', s, 'en', 'pwUnavailableRoutes') === true).length ? ['native'] : []) : []))(
      on((s) => s !== 'native' && /one-time code/i.test(v('signin', s, 'en', 'pwUnavailableMsg') || ''))),
    title: 'No-password account at sign-in: native moves straight into the code step; web/Lite only tell the reader to go find it',
    actual: 'Web/Lite answer password_login_unavailable with a sentence ("Sign in with a one-time code, then set a password…"); the reader must tap "Forgot your password?" (which is broken, ONB-01). Native routes straight into "No password on this account" with the route picker.',
    expected: 'One behaviour: move into the code step for them (native).',
    ev: (S) => S.map((s) => ['signin', s, 'en', s === 'native' ? 'pwUnavailableRoutes' : 'pwUnavailableMsg']),
    source: 'app/app.js:1326 + :415 (AUTH_ERRORS.password_login_unavailable); native/src/app/sign-in.tsx:740-743',
    fix: 'In app.js, on password_login_unavailable switch to the code mode (the #pw-link path, once ONB-01 is fixed) and keep the number.',
  });

  /* ---------------------------------------------------------------- P3 */
  add({
    id: 'ONB-13', flow: 'signup', severity: 'P3',
    surfaces: on((s) => s !== 'native' && v('signup', s, 'en', 'resendNoCooldown') >= 2),
    title: 'Web/Lite "Resend code" has no cooldown (native waits 30 s)',
    actual: 'Two taps on Resend Code within 2 s sent two /register requests. Native shows "Resend in 28s" and disables it.',
    expected: 'A visible countdown like native, so a nervous reader does not burn the OTP rate limit or paid SMS.',
    ev: (S) => S.map((s) => ['signup', s, 'en', 'resendNoCooldown']).concat([['signup', 'native', 'en', 'resendCooldown']]),
    source: 'app/app.js:1236-1250 (#otp-resend); native/src/app/sign-in.tsx:270-276, :1485-1490',
    fix: 'Disable #otp-resend for 30 s after each send and paint "Resend in {n}s".',
  });
  add({
    id: 'ONB-14', flow: 'signup', severity: 'P3',
    surfaces: on((s) => s !== 'native' && v('signup', s, 'en', 'changeNumberKeeps')?.number === ''),
    title: 'Web/Lite "Use a different number" wipes the number, the route and the password',
    actual: 'resetAuthPane() clears all three; native keeps the number on screen to correct it.',
    expected: 'Keep what was typed (as native) so a one-digit typo is a one-digit fix.',
    ev: (S) => S.map((s) => ['signup', s, 'en', 'changeNumberKeeps']).concat([['signup', 'native', 'en', 'changeNumberKeeps']]),
    source: 'app/app.js:924-962 (resetAuthPane: input.value = \'\', radios cleared, pw cleared)',
    fix: 'In #auth-reset, restore pendingPhone into the field and keep the picked route.',
  });
  add({
    id: 'ONB-15', flow: 'signup', severity: 'P3',
    surfaces: on((s) => (s === 'native' ? v('signup', s, 'en', 'reloadAtCode')?.number === '' : v('signup', s, 'en', 'reloadAtCode')?.mode === 'phone entry')),
    title: 'Leaving the code screen (Back, reload, app restart) loses the number and starts over',
    actual: 'Web/Lite: browser/Android Back on the code screen leaves sign-up for the previous page; a reload returns to an empty phone step (number and password gone). Native: the header close leaves sign-up; a restart opens an empty form. A code already sent cannot be typed in without sending another.',
    expected: 'Keep the number (and that a code is in flight) for a few minutes, so coming back from Telegram/SMS lands on the code step.',
    ev: (S) => S.flatMap((s) => [['signup', s, 'en', 'reloadAtCode'], ['signup', s, 'en', 'backAtCode']]),
    source: 'app/app.js:584-600 (pendingPhone/authMode in memory only); native/src/app/sign-in.tsx:99-101 (component state)',
    fix: 'Persist {phone, channel, sentAt} in sessionStorage / AsyncStorage for ~10 min and resume on the code step.',
  });
  add({
    id: 'ONB-16', flow: 'signup', severity: 'P3',
    surfaces: on((s) => s === 'native' && /check the number/i.test(v('signup', s, 'en', 'err500Msg') || '')),
    title: 'Native: a server error on Send Code blames the number ("Could not send a code — check the number.")',
    actual: 'A 500 internal_error with no hint falls back to could-not-send-a-code-check, so a correct number looks wrong.',
    expected: '"Hawkeye could not send a code just now — try again."',
    ev: () => [['signup', 'native', 'en', 'err500Msg']],
    source: 'native/src/app/sign-in.tsx:333-341',
    fix: 'Map 5xx/unknown errors to network-error-try-again (or a new server-busy line).',
  });
  add({
    id: 'ONB-17', flow: 'signout', severity: 'P3',
    surfaces: [...on((s) => s !== 'native' && (v('signout', s, 'en', 'confirm_menu') === false || v('signout', s, 'en', 'confirm_profile') === false)), ...on((s) => s === 'native' && v('signout', s, 'en', 'confirm_profile') === true)],
    title: 'Sign out: no confirmation on web/Lite (menu and Profile), a confirm sheet on native; different landings',
    actual: 'Web/Lite sign out at one tap from the menu or Profile and land on index.html (web: landing page; Lite: bounced to the Sign In form). Native asks "Sign out?" and lands on Welcome.',
    expected: 'One behaviour on all three (native\'s confirm + a welcome/landing).',
    ev: (S) => S.flatMap((s) => [['signout', s, 'en', 'confirm_menu'], ['signout', s, 'en', 'confirm_profile'], ['signout', s, 'en', 'landing_menu'], ['signout', s, 'en', 'landing_profile']]),
    source: 'app/menu.js:1920-1937; app/profile.html:918-925; native/src/app/profile.tsx:549-555, :1094-1110',
    fix: 'hkConfirm(T(\'n.app.profile.sign-out-body\'…)) before both web sign-outs.',
  });
  add({
    id: 'ONB-18', flow: 'firstrun', severity: 'P3',
    surfaces: on((s) => v('firstrun', s, 'en', 'readyOffered') === false),
    title: 'First run never reaches the readiness check; web has no tour',
    actual: 'Order after sign-up — web: choose unit -> Home (practice nudge). Lite: choose unit -> Home -> 5-card tour -> practice nudge. Native: password -> choose unit -> Home -> tour -> practice nudge. "Ready for election day" (ready.html / /ready) is only in Menu/More; nothing in the first run points to it.',
    expected: 'The same sequence everywhere, with the readiness check offered once (e.g. on the nudge card after practice).',
    ev: (S) => S.flatMap((s) => [['firstrun', s, 'en', 'order'], ['firstrun', s, 'en', 'readyOffered']]),
    source: 'app/menu.js:1736 (tour: app shell only); app/index.html:743-780 (nudge); native/src/app/(tabs)/index.tsx:640-646 (Tour auto); app/menu.js:436-441 (ready.html only in the menu)',
    fix: 'Add a "Ready for election day" link to the practice nudge/done card on all three.',
  });
  // Untranslated text in Hausa, per surface.
  const FLOWKEYS = Object.keys(checks || {});
  /* The primary button of the sign-up form, left in English (a boot-order race). */
  const sendCode = (s) => FLOWKEYS.some((f) => (v(f, s, 'ha', 'untranslated') || []).some((x) => /: Send Code$/.test(x)));
  add({
    id: 'ONB-21', flow: 'signup', severity: 'P2',
    surfaces: on((s) => s !== 'native' && sendCode(s)),
    title: 'Hausa: the sign-up form\'s main button reads "Send Code" in English (intermittent on web, repeatable on Lite)',
    actual: 'Everything else on the form is Hausa ("Aika lamba" is the right label and does appear on other loads). The button has no data-i18n and sign-up mode never paints it at boot; only the hawkeye-lang listener does, and it skips the repaint when the language bundle lands before app.js has shown the register screen.',
    expected: '"Aika lamba" on every load.',
    ev: (S) => S.flatMap((s) => FLOWKEYS.filter((f) => (v(f, s, 'ha', 'untranslated') || []).some((x) => /: Send Code$/.test(x))).map((f) => [f, s, 'ha', 'untranslated'])),
    source: 'app/observe.html:390 (<button id="btn-auth" disabled>Send Code</button>, no data-i18n); app/app.js:3438-3444 paintRegister() does not paint it; app/app.js:3450-3467 repaints only if #screen-register is already visible',
    fix: 'Give #btn-auth data-i18n="observe.send-code" (sign-in/otp modes already overwrite it), or paint it in applySignUpMode().',
  });
  /* Lines that are FIXTURE DATA (tests/design-audit/fixtures.mjs) or language names, not app copy. */
  const NOISE = /^(.*: )?(New result at your unit|Your incident report was published|You joined a room|Your unit location was confirmed|Presidential|English|Lagos Citizens Observer Network|Kosofe Ward Volunteers|Sample .*|just now)$/;
  for (const s of SURF) {
    let all = FLOWKEYS.flatMap((f) => (v(f, s, 'ha', 'untranslated') || []).filter((x) => !NOISE.test(x) && !/: Send Code$/.test(x)).map((x) => `${f}/${x}`));
    /* A screen with MANY English lines was shot before its bundle applied (a
       slow load on this machine's flaky link: a direct re-load of the same page
       in Hausa came out translated). Not counted; single stray lines are. */
    const perScreen = {};
    for (const x of all) { const k = x.split(': ')[0]; perScreen[k] = (perScreen[k] || 0) + 1; }
    all = all.filter((x) => perScreen[x.split(': ')[0]] <= 4);
    if (!all.length) continue;
    add({
      id: `ONB-HA-${s}`, flow: 'all', severity: 'P3', surfaces: [s],
      title: `Hausa: English left on onboarding screens (${s})`,
      actual: [...new Set(all)].slice(0, 14).join(' ; '),
      expected: 'Every line in Hausa.',
      ev: () => FLOWKEYS.filter((f) => all.some((x) => x.startsWith(`${f}/`))).map((f) => [f, s, 'ha', 'untranslated']),
      source: HA_SOURCE[s] || 'see actual (each line names its flow/screen)',
      fix: 'Key the literal halves of these sentences / translate the listed strings.',
    });
  }
  return out;
}

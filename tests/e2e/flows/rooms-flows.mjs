/**
 * The four flows of group `rooms`. Loaded by rooms.mjs, which owns the browser,
 * the guard and the output. Every function here receives H (the harness).
 */

const SRC = {
  joinGo: 'app/join.html:212-238',
  joinSignin: 'app/join.html:213-222',
  signupLine: 'app/observe.html:409',
  nextDest: 'app/app.js:643-646',
  afterVerified: 'app/app.js:901-922',
  joinCatch: 'app/join.html:225-236',
  joinAlert: 'app/join.html:233-235',
  mgAct: 'app/my-groups.html:186-215',
  mgApi: 'app/my-groups.html:75-82',
  nJoin: 'native/src/app/join/[token].tsx:124-136',
  nJoinGone: 'native/src/app/join/[token].tsx:107-122',
  nSignInDone: 'native/src/app/sign-in.tsx:366-375',
  nMyGroupsRoom: 'native/src/app/my-groups.tsx:316',
};

// =============================================================================
// FLOW 1 — JOIN A ROOM AS AN OBSERVER
// =============================================================================
export async function flow1(H, { surfaces, langs }) {
  const { TOK, JOIN_ROOM } = H;
  // ---- control for the stuck detector, once: a preview that never answers must
  // read as stuck; one that answers must not.
  if (H.on('stuckControl')) {
    const hang = await H.open('web', {
      extra: async (ctx) => { await ctx.route(new RegExp(`/api/join/${TOK.hang}$`), () => { /* never answered */ }); },
    });
    await H.gotoWeb(hang.page, `/join/${TOK.hang}`, 'en');
    const isStuck = await H.stuck(hang.page, 6000);
    await hang.ctx.close();
    const okp = await H.open('web');
    await H.gotoWeb(okp.page, `/join/${TOK.ok}`, 'en');
    const okStuck = await H.stuck(okp.page, 3000);
    await okp.ctx.close();
    H.check('1:control:stuck-detector', { flagged: !(isStuck && !okStuck), detail: `hanging preview stuck=${isStuck} (must be true); answered preview stuck=${okStuck} (must be false)` });
  }

  for (const surface of surfaces) {
    for (const lang of langs) {
      if (surface === 'native') {
        if (H.on('joinSignedIn')) await nativeJoinSignedIn(H, lang);
        if (H.on('joinSignedOut')) await nativeJoinSignedOut(H, lang);
        if (H.on('myGroups')) await nativeMyGroups(H, lang);
      } else {
        if (H.on('joinSignedIn')) await webJoinSignedIn(H, surface, lang);
        if (H.on('joinSignedOut')) await webJoinSignedOut(H, surface, lang);
        if (H.on('myGroups')) await webMyGroups(H, surface, lang);
      }
    }
    if (H.on('joinErrors')) { if (surface === 'native') await nativeJoinErrors(H); else await webJoinErrors(H, surface); }
    if (H.on('myGroupsErrors')) { if (surface !== 'native') await webMyGroupsErrors(H, surface); else await nativeMyGroupsErrors(H); }
  }
  // A typed code: the one code field at sign-up (an organisation code puts the
  // new account in its issuer's room). Walked up to the point a password would
  // be typed — no credential is entered.
  if (H.on('typedCode')) for (const surface of surfaces) await typedCode(H, surface, langs[0]);
  // /invite.html — the OTHER invite link (a friend's referral). It joins no room;
  // walked so the parity table shows what it asks.
  if (surfaces.includes('web') && H.on('inviteHtml')) await inviteHtml(H, langs[0]);
}

async function inviteHtml(H, lang) {
  const R = H.recorder('1-join', 'web', lang, 's360', 'invite-html');
  const { ctx, page } = await H.open('web', { lang, signedIn: false });
  try {
    await H.gotoWeb(page, '/invite.html?ref=K7PM3X', lang);
    await H.sleep(1200);
    const btns = await page.locator('.iv-btns a:visible').allInnerTexts().catch(() => []);
    const f1 = await R.step(page, 'invite-html', { screen: 'invite.html?ref=', asked: btns.join(' / ') });
    await page.locator('#g-web').click().catch(() => {});
    await page.waitForURL(/observe\.html/, { timeout: 12000 }).catch(() => {});
    await H.sleep(1500);
    const code = await page.inputValue('#ref-input').catch(() => '');
    const f2 = await R.step(page, 'continue-in-browser', { screen: 'observe.html?intent=observe&ref=', tap: 'Continue in this browser', note: `invite code prefilled: "${code}" — a referral, no room involved` });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

// ---------------------------------------------------------------- web, signed in
const CONTEST_CODE = {
  id: 'R-CONTEST-CODE', flow: '1-join', severity: 'P3',
  title: 'Invite and My Groups name the race by its code: "the GOV race in Lagos"',
  actual: 'join.html builds "You have been invited to observe … for the {contest} race" from the raw contest code, so it reads "for the GOV race in Lagos" (Hausa: "takarar GOV"); My Groups (web and native) and the native invite show "GOV · Lagos".',
  expected: 'The race’s name in the reader’s language ("the Governorship race in Lagos"), as situation-room.html already does with contestName().',
  source: 'app/join.html:126-137; app/my-groups.html:153; native/src/app/join/[token].tsx:203-206; native/src/app/my-groups.tsx:73-74',
  fix: 'Map contest codes through the contest.* keys (as contestName() in situation-room.html) before interpolating.',
};

async function webJoinSignedIn(H, surface, lang) {
  const { TOK, JOIN_ROOM, wt } = H;
  const server = H.roomServer();
  const { ctx, page, errors } = await H.open(surface, { lang, server,
    extra: surface === 'lite' ? liteLaunchUrl(`https://hawkeye.com.ng/join/${TOK.ok}`) : null });
  const R = H.recorder('1-join', surface, lang, 's360', 'link');
  try {
    // Lite: the App Link arrives as the launch URL and native.js routes it to the
    // bundled join.html?t= — the same thing a tap in WhatsApp does on a phone.
    if (surface === 'lite') await H.gotoWeb(page, '/index.html', lang);
    else await H.gotoWeb(page, `/join/${TOK.ok}`, lang);
    await H.waitText(page, JOIN_ROOM.name, 15000);
    await H.webLang(page, lang);
    const f1 = await R.step(page, 'invite-preview', { screen: surface === 'lite' ? 'join.html?t= (from App Link)' : 'join.html (/join/<token>)', asked: 'read the consent notice; tap Join' });
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      const t = await H.text(page);
      const consentEnglish = t.includes('They will see the reports you file from now on.');
      if (H.check(`1:consent-english:${surface}`, { flagged: consentEnglish, detail: 'join.html consent list renders in English under ha', evidence: [f1] })) {
        H.finding({ id: 'R-CONSENT-LANG', flow: '1-join', severity: 'P2', surfaces: [surface],
          title: 'The join consent notice is English on web/Lite but Hausa on native',
          actual: 'Under ha, join.html shows the four consent points and the fine print in English (lang="en"); native join/[token].tsx shows the same four points translated (n.app.join.point-*).',
          expected: 'One account of what joining discloses, in the reader’s language on every surface (or English on every surface until the human-reviewed translation lands).',
          evidence: [H.ev(f1)], source: 'app/join.html:149-169 (lang="en" list) vs native/src/app/join/[token].tsx:212-217 + native/src/lib/i18n/ha.json:440-443',
          fix: 'Pick one rule: ship the reviewed Hausa consent text to join.html, or keep native on the English text until it is reviewed.' });
      }
      H.check(`1:english-left:join:${surface}:${lang}`, { flagged: en.length > 0, detail: en.join(' | ') });
    }
    const btn = (await page.locator('#go').innerText().catch(() => '')).trim();
    const prevText = await H.text(page);
    if (H.check(`1:contest-code-in-invite:${surface}:${lang}`, { flagged: /\bGOV\b/.test(prevText), detail: 'the invite names the race by its code ("GOV")', evidence: [f1] })) {
      H.finding({ ...CONTEST_CODE, surfaces: [surface], evidence: [H.ev(f1)] });
    }
    await page.click('#go');
    await H.waitAny(page, [wt(lang, 'join.you-are-in'), 'You are in'], 10000);
    const f2 = await R.step(page, 'joined', { screen: 'join.html (done card)', tap: btn, note: 'arrival: "You are in" + links Report a result · My Groups' });
    const doneText = await H.text(page);
    H.check(`1:joined-confirmed:${surface}:${lang}`, { flagged: !doneText.includes(wt(lang, 'join.you-are-in')), detail: 'done card shows "You are in"', evidence: [f2] });
    // On to My Groups from the done card.
    await page.locator('#jn a[href="my-groups.html"]').last().click().catch(() => {});
    await H.waitText(page, JOIN_ROOM.name, 12000);
    await H.sleep(600);
    const f3 = await R.step(page, 'my-groups-has-room', { screen: 'my-groups.html', tap: wt(lang, 'my-groups.your-groups') });
    const mg = await H.text(page);
    H.check(`1:room-in-my-groups:${surface}:${lang}`, { flagged: !mg.includes(JOIN_ROOM.name), detail: 'joined room listed on My Groups', evidence: [f3] });
    // Browser back from My Groups: what does the reader land on?
    await page.goBack({ waitUntil: 'load' }).catch(() => {});
    await H.waitText(page, JOIN_ROOM.name, 10000);
    await H.sleep(800);
    const f4 = await R.step(page, 'back-after-join', { screen: 'join.html (again)', tap: 'browser Back' });
    const backText = await H.text(page);
    const offersJoinAgain = backText.includes(wt(lang, 'join.button-join', { name: JOIN_ROOM.name }));
    if (H.check(`1:back-offers-join-again:${surface}:${lang}`, { flagged: offersJoinAgain, detail: 'after joining, Back re-shows the preview with the Join button', evidence: [f4] })) {
      H.finding({ id: 'R-JOIN-BACK-AGAIN', flow: '1-join', severity: 'P3', surfaces: [surface],
        title: 'Back after joining shows the invite again with a live "Join" button',
        actual: 'From My Groups, Back returns to the invite preview, which offers "Join <room>" as if the reader were not in it; tapping it answers "You are already with <room>".',
        expected: 'The preview knows the reader is already a member (or Back skips the spent invite) and says so before the tap.',
        evidence: [H.ev(f4)], source: 'app/join.html:106-121 (preview never asks whether the reader is already in)', fix: 'When signed in, have GET /api/join/:token (or the page) mark an existing membership and paint "You are already with X" with a link to My Groups.' });
    }
    if (errors.length) H.check(`1:pageerrors:join:${surface}:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

/** Lite: a Capacitor App plugin whose launch URL is `url` (an App Link that opened Lite cold). */
function liteLaunchUrl(url) {
  return async (ctx) => {
    await ctx.addInitScript((u) => {
      try {
        const hook = () => {
          if (!window.Capacitor || !window.Capacitor.Plugins) return;
          window.Capacitor.Plugins.App = { addListener() { return { remove() {} }; }, getLaunchUrl: async () => ({ url: u }), getInfo: async () => ({ build: '30', version: '1.7' }) };
        };
        hook();
        Object.defineProperty(window, '__hkLaunch', { value: 1 });
      } catch (e) { /* */ }
    }, url);
  };
}

// ---------------------------------------------------------------- web, signed out
async function webJoinSignedOut(H, surface, lang) {
  const { TOK, JOIN_ROOM, wt } = H;
  const { ctx, page } = await H.open(surface, { lang, signedIn: false });
  const R = H.recorder('1-join', surface, lang, 's360', 'signed-out');
  try {
    await H.gotoWeb(page, `/join/${TOK.ok}`, lang);
    await H.waitText(page, JOIN_ROOM.name, 15000);
    await H.webLang(page, lang);
    const btn = (await page.locator('#go').innerText().catch(() => '')).trim();
    const f1 = await R.step(page, 'invite-preview-signed-out', { screen: 'join.html', asked: 'consent notice; "Sign in to join"' });
    await page.click('#go');
    await page.waitForURL(/observe\.html/, { timeout: 15000 }).catch(() => {});
    await H.webLang(page, lang);
    await H.sleep(1500);
    const f2 = await R.step(page, 'sign-in-form', { screen: 'observe.html?intent=signin&next=join.html?t=…', tap: btn, asked: 'phone number + password (sign-in), or Sign Up' });
    const signinUrl = page.url();
    const next = await page.evaluate(() => (typeof NEXT_DEST !== 'undefined' ? NEXT_DEST : '(no NEXT_DEST)')).catch(() => '(eval failed)');
    H.check(`1:signin-keeps-invite:${surface}:${lang}`, { flagged: !String(next).includes(TOK.ok), detail: `sign-in page NEXT_DEST=${next} url=${signinUrl}`, evidence: [f2] });
    // The invitee who has NO account: "Don't have an account? Sign Up".
    const signup = page.locator('#signup-line a');
    const href = await signup.getAttribute('href').catch(() => null);
    const vis = await signup.isVisible().catch(() => false);
    if (vis) {
      await signup.click();
      await page.waitForURL(/intent=observe/, { timeout: 12000 }).catch(() => {});
      await H.webLang(page, lang);
      await H.sleep(1500);
    }
    const f3 = await R.step(page, 'sign-up-form-from-invite', { screen: 'observe.html?intent=observe', tap: 'Sign Up', asked: 'phone, channel, optional password, invite/org code' });
    const next2 = await page.evaluate(() => (typeof NEXT_DEST !== 'undefined' ? NEXT_DEST : null)).catch(() => 'err');
    const kept = await page.evaluate((t) => {
      const all = [];
      try { for (let i = 0; i < localStorage.length; i++) all.push(localStorage.getItem(localStorage.key(i))); } catch (e) { /* */ }
      try { for (let i = 0; i < sessionStorage.length; i++) all.push(sessionStorage.getItem(sessionStorage.key(i))); } catch (e) { /* */ }
      return all.some((v) => String(v).includes(t)) || location.href.includes(t);
    }, TOK.ok).catch(() => false);
    // CONTROL: the same reading on the sign-IN page found the token (above). Here:
    const lost = vis && !String(next2 || '').includes(TOK.ok) && !kept;
    if (H.check(`1:signup-drops-invite:${surface}:${lang}`, { flagged: lost, detail: `Sign Up href=${href}; NEXT_DEST after=${next2}; token anywhere in url/storage=${kept}`, control: `sign-in page NEXT_DEST=${next}`, evidence: [f2, f3] })) {
      H.finding({ id: 'R-SIGNUP-DROPS-INVITE', flow: '1-join', severity: 'P1', surfaces: [surface],
        title: 'An invitee with no account loses the invitation: "Sign Up" drops the join link',
        actual: `join.html sends a signed-out invitee to observe.html?intent=signin&next=join.html?t=<token>. Someone invited to observe usually has no account, so they tap "Don't have an account? Sign Up", whose href is the bare "${href}" — the next= (and with it the token) is gone (NEXT_DEST=${next2}, token not in the URL or storage). After the code and password they land on the unit chooser / report flow and never see the invitation again.`,
        expected: 'The sign-up path carries next= (or the token is parked like the referral code) so the new observer returns to the Join button after creating the account.',
        evidence: [H.ev(f2), H.ev(f3)], source: `${SRC.signupLine} (static href); ${SRC.joinSignin}; ${SRC.afterVerified}`,
        fix: 'Rewrite #signup-line / #signin-line hrefs to keep ?next= (and send join.html’s signed-out tap to intent=observe with next= when there is no account).' });
    }
    // The signed-in half of the round trip, entered exactly as afterVerified()
    // would enter it — location.href = NEXT_DEST — in a signed-in context (the
    // harness's storage init would otherwise wipe a token set by hand).
    await ctx.close();
    const back = await H.open(surface, { lang, signedIn: true });
    if (String(next).includes('join.html')) await H.gotoWeb(back.page, '/' + next, lang);
    await H.waitText(back.page, JOIN_ROOM.name, 12000);
    const f4 = await R.step(back.page, 'back-at-invite-after-sign-in', { screen: 'join.html?t=', note: 'entered as afterVerified() would (NEXT_DEST); no credential typed', asked: 'Join (second tap of the same button)' });
    const btn2 = (await back.page.locator('#go').innerText().catch(() => '')).trim();
    H.check(`1:returns-to-join:${surface}:${lang}`, { flagged: !btn2.includes(JOIN_ROOM.name), detail: `after sign-in the button reads "${btn2}"`, evidence: [f4] });
    await back.ctx.close();
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); await ctx.close().catch(() => {}); }

  // /room/<slug> and my-groups.html, signed out: do they come back after sign-in?
  const o2 = await H.open(surface, { lang, signedIn: false });
  const R2 = H.recorder('1-join', surface, lang, 's360', 'room-link-signed-out');
  try {
    await H.gotoWeb(o2.page, '/room/lagos-citizens', lang);
    await o2.page.waitForURL(/observe\.html/, { timeout: 15000 }).catch(() => {});
    await H.sleep(1200);
    const f = await R2.step(o2.page, 'room-link-signed-out', { screen: 'observe.html?intent=signin', asked: 'sign in' });
    const next = await o2.page.evaluate(() => (typeof NEXT_DEST !== 'undefined' ? NEXT_DEST : null)).catch(() => null);
    H.check(`1:room-link-keeps-room:${surface}:${lang}`, { flagged: !String(next || '').includes('lagos-citizens'), detail: `NEXT_DEST=${next} url=${o2.page.url()}`, evidence: [f] });
  } catch (e) { R2.rec.error = String(e.message || e).slice(0, 300); }
  await o2.ctx.close();
}

// ---------------------------------------------------------------- web, failures
async function webJoinErrors(H, surface) {
  const { TOK, JOIN_ROOM, wt } = H;
  const lang = 'en';
  const R = H.recorder('1-join', surface, lang, 's360', 'errors');
  const cases = [
    ['gone', 'join.not-recognised-title'], ['rev', 'join.withdrawn-title'], ['exp', 'join.expired-title'], ['held', 'join.held-title'], ['err', 'join.went-wrong-title'],
  ];
  for (const [k, key] of cases) {
    const { ctx, page } = await H.open(surface, { lang });
    await H.gotoWeb(page, `/join/${TOK[k]}`, lang);
    await H.waitText(page, wt(lang, key), 10000);
    const f = await R.step(page, `preview-${k}`, { screen: 'join.html', note: `GET /api/join → ${k}` });
    const t = await H.text(page);
    H.check(`1:preview-msg-${k}:${surface}`, { flagged: !t.includes(wt(lang, key)), detail: `expected "${wt(lang, key)}"`, evidence: [f] });
    await ctx.close();
  }
  // The tap fails AFTER a good preview.
  const posts = [['postExp', 'join.alert-expired'], ['postRev', null], ['postErr', 'join.alert-failed'], ['postNet', null]];
  for (const [k, key] of posts) {
    const extra = k === 'postNet' ? async (ctx) => {
      await ctx.route(new RegExp(`/api/join/${TOK.postNet}$`), (r) => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback()));
    } : null;
    const { ctx, page } = await H.open(surface, { lang, extra });
    await H.gotoWeb(page, `/join.html?t=${TOK[k]}`, lang);
    await H.waitText(page, JOIN_ROOM.name, 10000);
    await page.click('#go').catch(() => {});
    let msg = null;
    if (k !== 'postNet') msg = await H.webDialog(page, null, 8000);
    const f = await R.step(page, `tap-join-${k}`, { screen: 'join.html', note: `POST /api/join → ${k}; dialog: ${msg ? msg.replace(/\s+/g, ' ') : '(none)'}` });
    if (k !== 'postNet') await H.webDialog(page, 'ok', 2000);
    if (k === 'postRev') {
      const generic = msg && msg.includes(wt(lang, 'join.alert-failed'));
      if (H.check(`1:post-revoked-msg:${surface}`, { flagged: generic, detail: `dialog: ${msg}`, control: 'postExp shows the specific "expired" line', evidence: [f] })) {
        H.finding({ id: 'R-JOIN-REVOKED-GENERIC', flow: '1-join', severity: 'P3', surfaces: [surface],
          title: 'A link withdrawn between preview and tap says "Could not join just now"',
          actual: 'POST /api/join answers 410 invite_revoked; join.html maps only invite_expired, so the reader is told to try again ("Could not join just now.") and the button becomes "Try again" — a retry that can never work.',
          expected: 'The withdrawn wording the preview already has ("That invitation was withdrawn — ask whoever sent it for a fresh link").',
          evidence: [H.ev(f)], source: SRC.joinAlert, fix: 'Map invite_revoked (and 404 no_such_invite) in go() to the same titles main() uses.' });
      }
    }
    if (k === 'postNet') {
      const t1 = await H.text(page);
      const isStuck = await H.stuck(page, 8000, [wt(lang, 'join.joining')]);
      const btnDisabled = await page.locator('#go').isDisabled().catch(() => false);
      const f2 = await R.step(page, 'tap-join-offline-after-8s', { screen: 'join.html', note: `button disabled=${btnDisabled}` });
      if (H.check(`1:post-offline-stuck:${surface}`, { flagged: isStuck && btnDisabled, detail: `after 8 s: "${t1.includes('Joining') ? 'Joining…' : '?'}" disabled=${btnDisabled}`, control: 'control:stuck-detector', evidence: [f, f2] })) {
        H.finding({ id: 'R-JOIN-OFFLINE-STUCK', flow: '1-join', severity: 'P2', surfaces: [surface],
          title: 'Join tapped with no connection: the button stays "Joining…" and disabled for ever',
          actual: 'go() awaits fetch() with no try/catch; a network failure rejects, the button keeps disabled + "Joining…", and nothing tells the reader it failed. Only a reload recovers.',
          expected: 'The failure is caught: the button returns to "Try again" with "Check your connection" (the line main() already has).',
          evidence: [H.ev(f), H.ev(f2)], source: SRC.joinCatch, fix: 'Wrap the POST in try/catch and reuse join.check-connection; re-enable #go.' });
      }
    }
    await ctx.close();
  }
}

// ---------------------------------------------------------------- web My Groups
const DECLINE_NO_UNDO = {
  id: 'R-DECLINE-NO-UNDO', flow: '1-join', severity: 'P3',
  title: '"That is not where I will be" is one tap with no confirm and no way back',
  actual: 'Declining the unit a room has you down for posts at once (no confirm) and the card then offers only Leave — the member cannot take a mis-tap back; the coordinator sees them as "declined" until they reassign. Same on web, Lite and native.',
  expected: 'Either a short confirm, or an "I will be there after all" on the declined card (POST …/decline is the only member-side verb).',
  source: 'app/my-groups.html:165, 204-208; native/src/app/my-groups.tsx:317-324; backend/src/routes/groups.js:2047-2052 (no un-decline route)',
  fix: 'Add a member-side "accept this unit again" (assign_state back to proposed) and show it on the declined card.',
};

async function webMyGroups(H, surface, lang) {
  const { wt, memberRow, INVITED_ROW } = H;
  const server = H.roomServer({ member: [memberRow(), { ...INVITED_ROW }, memberRow({ id: 23, name: 'Ojota Youth Watch', slug: 'ojota-youth', member_state: 'invited', assigned_pu: null, assign_state: '', assigned_name: null })] });
  const { ctx, page, errors } = await H.open(surface, { lang, server });
  const R = H.recorder('1-join', surface, lang, 's360', 'my-groups');
  try {
    await H.gotoWeb(page, '/my-groups.html', lang);
    await H.waitText(page, 'Kosofe Ward Volunteers', 12000);
    await H.sleep(500);
    const f1 = await R.step(page, 'my-groups', { screen: 'my-groups.html', asked: 'invite cards: Accept / No thanks; member card: room, "That is not where I will be", Leave' });
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      H.check(`1:english-left:my-groups:${surface}`, { flagged: en.length > 0, detail: en.join(' | '), evidence: [f1] });
    }
    // Does Lite give a way to paste an invite link (native does)?
    const inputs = await page.locator('main input').count();
    if (surface === 'lite' && H.check('1:lite-no-paste-link', { flagged: inputs === 0, detail: `inputs on Lite My Groups: ${inputs}`, evidence: [f1] })) {
      H.finding({ id: 'R-NO-PASTE-LINK', flow: '1-join', severity: 'P2', surfaces: ['lite'],
        title: 'Lite (and web) My Groups has no "Have an invite link?" box; native has one',
        actual: 'Native My Groups lets a member paste an invite link that opened in the wrong place (a messenger that rewrote it, an unverified App Link) and joins in-app. Lite has no address bar and no such field, so the only way in is the website in a browser — a separate, signed-out session.',
        expected: 'The same paste box on Lite’s My Groups (and web), opening join.html?t=<token>.',
        evidence: [H.ev(f1)], source: 'native/src/app/my-groups.tsx:400-426 vs app/my-groups.html:106-118', fix: 'Port the native paste box (inviteToken() rules) to my-groups.html, shown at least in the app shell.' });
    }
    // Accept the first invite.
    await page.locator('button[data-act="accept"][data-gid="19"]').click();
    await page.waitForFunction(() => !document.querySelector('button[data-act="accept"][data-gid="19"]'), null, { timeout: 8000 }).catch(() => {});
    await H.sleep(500);
    const f2 = await R.step(page, 'accepted-invite', { screen: 'my-groups.html', tap: wt(lang, 'my-groups.accept'), note: 'card becomes a membership with its unit' });
    // Refuse the second invite.
    await page.locator('button[data-act="refuse"][data-gid="23"]').click();
    const conf = await H.webDialog(page, null);
    const f3 = await R.step(page, 'refuse-confirm', { screen: 'dialog', tap: wt(lang, 'my-groups.no-thanks'), asked: (conf || '').replace(/\s+/g, ' ').slice(0, 140) });
    await H.webDialog(page, 'ok');
    await page.waitForFunction(() => !document.body.innerText.includes('Ojota Youth Watch'), null, { timeout: 8000 }).catch(() => {});
    const f4 = await R.step(page, 'refused', { screen: 'my-groups.html', note: 'row removed' });
    // Decline the unit of the first membership.
    await page.locator('button[data-act="decline"][data-gid="12"]').click();
    await H.waitText(page, wt(lang, 'my-groups.declined-note'), 8000);
    const f5 = await R.step(page, 'declined-unit', { screen: 'my-groups.html', tap: wt(lang, 'my-groups.not-where'), note: 'no confirmation; card says declined' });
    const undo = await page.locator('[data-gid="12"]').allInnerTexts().catch(() => []);
    const canUndo = undo.some((x) => /undo|accept|confirm|is where/i.test(x));
    if (H.check(`1:decline-no-undo:${surface}:${lang}`, { flagged: !canUndo, detail: `buttons on the card after declining: ${undo.join(' / ')}`, evidence: [f5] })) {
      H.finding({ ...DECLINE_NO_UNDO, surfaces: [surface], evidence: [H.ev(f5)] });
    }
    // Leave the accepted room.
    await page.locator('button[data-act="leave"][data-gid="19"]').click();
    const lv = await H.webDialog(page, null);
    const f6 = await R.step(page, 'leave-confirm', { screen: 'dialog', tap: wt(lang, 'my-groups.leave'), asked: (lv || '').replace(/\s+/g, ' ').slice(0, 140) });
    await H.webDialog(page, 'ok');
    await page.waitForFunction(() => !document.body.innerText.includes('Kosofe Ward Volunteers'), null, { timeout: 8000 }).catch(() => {});
    const f7 = await R.step(page, 'left', { screen: 'my-groups.html', note: 'room gone, no toast' });
    const t = await H.text(page);
    H.check(`1:leave-removes:${surface}:${lang}`, { flagged: t.includes('Kosofe Ward Volunteers'), detail: 'left room no longer listed', evidence: [f7] });
    // The room from My Groups.
    const roomHref = await page.locator('a.btn.go').first().getAttribute('href').catch(() => null);
    H.check(`1:open-room-link:${surface}:${lang}`, { flagged: !roomHref || !roomHref.includes('/room/'), detail: `Open situation room → ${roomHref}` });
    if (errors.length) H.check(`1:pageerrors:my-groups:${surface}:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function webMyGroupsErrors(H, surface) {
  const { wt, memberRow, INVITED_ROW } = H;
  const lang = 'en';
  const R = H.recorder('1-join', surface, lang, 's360', 'my-groups-errors');
  // 409 held, 500, offline — on Accept.
  for (const kind of ['409', '500', 'offline', 'double']) {
    const over = kind === '409' ? { 'POST /api/groups/19/accept': { status: 409, json: { error: 'room_pending_verification' } } }
      : kind === '500' ? { 'POST /api/groups/19/accept': { status: 500, json: { error: 'internal' } } } : {};
    const server = H.roomServer({ over });
    const extra = kind === 'offline' ? async (ctx) => {
      await ctx.route(/\/api\/groups\/19\/accept$/, (r) => r.abort('internetdisconnected'));
    } : null;
    const { ctx, page } = await H.open(surface, { lang, server, extra });
    try {
      await H.gotoWeb(page, '/my-groups.html', lang);
      await H.waitText(page, 'Kosofe Ward Volunteers', 12000);
      const b = page.locator('button[data-act="accept"][data-gid="19"]');
      if (kind === 'double') {
        await b.click();
        await b.click({ timeout: 1500 }).catch(() => {});
      } else await b.click();
      const msg = await H.webDialog(page, null, kind === 'offline' ? 5000 : 8000);
      await H.sleep(800);
      const f = await R.step(page, `accept-${kind}`, { screen: 'my-groups.html', tap: 'Accept', note: `dialog: ${msg ? msg.replace(/\s+/g, ' ') : '(none)'}` });
      const accepts = server.st.calls.filter((c) => c === 'POST /api/groups/19/accept').length;
      if (kind === 'offline') {
        const t = await H.text(page);
        const silent = !msg && t.includes(wt(lang, 'my-groups.accept'));
        if (H.check(`1:accept-offline-silent:${surface}`, { flagged: silent, detail: `dialog=${msg}`, control: 'the 500 case shows "Could not accept just now."', evidence: [f] })) {
          H.finding({ id: 'R-MG-OFFLINE-SILENT', flow: '1-join', severity: 'P2', surfaces: [surface],
            title: 'My Groups: Accept / No thanks / Leave do nothing at all when the request cannot be sent',
            actual: 'act() awaits api() (a bare fetch) with no catch; offline the promise rejects, no dialog shows and the card is unchanged — the tap looks ignored. (A 500 does say "Could not accept just now.")',
            expected: 'Every failure says something: the same "Could not … just now — check your connection" line the status paths use.',
            evidence: [H.ev(f)], source: `${SRC.mgAct}; ${SRC.mgApi}`, fix: 'try/catch around api() in act(), falling through to the existing *-failed alerts.' });
        }
      }
      if (kind === 'double') {
        const lateErr = msg && msg.includes(wt(lang, 'my-groups.accept-failed'));
        if (H.check(`1:accept-double:${surface}`, { flagged: accepts > 1 && lateErr, detail: `accept POSTs=${accepts}; dialog=${msg}` , evidence: [f] })) {
          H.finding({ id: 'R-MG-DOUBLE-ACCEPT', flow: '1-join', severity: 'P3', surfaces: [surface],
            title: 'A second tap on Accept reports "Could not accept just now" after the first succeeded',
            actual: 'The web buttons have no busy state, so a double tap sends two POSTs; the second meets 404 nothing_to_accept and the reader is told it failed while the list shows them accepted.',
            expected: 'The button disables while the request is in flight (native shows a spinner), or nothing_to_accept is treated as done.',
            evidence: [H.ev(f)], source: SRC.mgAct, fix: 'Disable [data-act] buttons during act(); treat 404 nothing_to_accept as success.' });
        }
      }
      H.check(`1:accept-${kind}-said:${surface}`, { flagged: (kind === '409' || kind === '500') && !msg, detail: `dialog=${msg}` });
    } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
    await ctx.close();
  }
}

// ---------------------------------------------------------------- native
async function nativeJoinSignedIn(H, lang) {
  const { TOK, JOIN_ROOM, nt } = H;
  const { ctx, page, errors } = await H.open('native', { lang });
  const R = H.recorder('1-join', 'native', lang, 's360', 'link');
  try {
    await H.gotoNative(page, `/join/${TOK.ok}`);
    await H.waitText(page, JOIN_ROOM.name, 15000);
    const f1 = await R.step(page, 'invite-preview', { screen: 'join/[token]', asked: 'consent card (4 points); Join this group / Not now' });
    if (H.check(`1:contest-code-in-invite:native:${lang}`, { flagged: /\bGOV\b/.test(await H.text(page)), detail: 'native invite shows "GOV · Lagos"', evidence: [f1] })) {
      H.finding({ ...CONTEST_CODE, surfaces: ['native'], evidence: [H.ev(f1)] });
    }
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      H.check(`1:english-left:native-join:${lang}`, { flagged: en.length > 0, detail: en.join(' | '), evidence: [f1] });
    }
    await H.ntap(page, nt(lang, 'n.app.join.join'));
    await H.waitText(page, nt(lang, 'n.app.join.done-title'), 10000);
    const f2 = await R.step(page, 'joined', { screen: 'join/[token] (done)', tap: nt(lang, 'n.app.join.join'), note: 'arrival: "You are in" + Continue / Back to Hawkeye' });
    await H.ntap(page, nt(lang, 'n.app.join.continue'));
    await H.waitText(page, JOIN_ROOM.name, 10000);
    await H.sleep(1200);
    const f3 = await R.step(page, 'my-groups-has-room', { screen: 'my-groups', tap: nt(lang, 'n.app.join.continue') });
    const t = await H.text(page);
    H.check(`1:room-in-my-groups:native:${lang}`, { flagged: !t.includes(JOIN_ROOM.name), detail: 'joined room on native My Groups', evidence: [f3] });
    // A plain member on native has no way to the room at all (owner decision): record it.
    const roomBtn = await H.visible(page, nt(lang, 'my-groups.open-room'));
    R.rec.steps[R.rec.steps.length - 1].note = `"${nt(lang, 'my-groups.open-room')}" shown for a plain member: ${roomBtn} (web shows it to every member)`;
    // Header close on My Groups (router.back) after a deep-linked join.
    await page.getByLabel(nt(lang, 'common.close')).first().click().catch(() => {});
    await H.sleep(1500);
    const stillThere = /\/my-groups/.test(page.url()) && (await H.has(page, JOIN_ROOM.name));
    const f4 = await R.step(page, 'close-my-groups', { screen: stillThere ? 'my-groups (unchanged)' : 'moved', tap: 'header close (x)', note: `X did nothing: ${stillThere}` });
    if (H.check(`1:native-close-dead-after-deeplink:${lang}`, { flagged: stillThere, detail: 'after a deep-linked join → Continue (router.replace), the X on My Groups has nothing to go back to', evidence: [f4] })) {
      H.finding({ id: 'R-NATIVE-MG-CLOSE-DEAD', flow: '1-join', severity: 'P3', surfaces: ['native'],
        title: 'Native: after joining from a link, the X on My Groups does nothing',
        actual: 'An invite link opens join/[token] as the first screen; Continue does router.replace(\'/my-groups\'), so My Groups is the only screen in the stack and its X (router.back()) has nowhere to go. The crest still goes Home; Android Back would leave the app.',
        expected: 'X falls back to Home when there is nothing to go back to (as menu.js does on the web: history.length > 1 ? back() : index.html).',
        evidence: [H.ev(f4)], source: 'native/src/app/my-groups.tsx:353 (onClose={() => router.back()}); native/src/app/join/[token].tsx:149-152', fix: 'onClose: router.canGoBack() ? router.back() : router.replace(\'/(tabs)\').', needsDevice: true });
    }
    if (errors.length) H.check(`1:pageerrors:native-join:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function nativeJoinSignedOut(H, lang) {
  const { TOK, JOIN_ROOM, nt } = H;
  const { ctx, page } = await H.open('native', { lang, signedIn: false });
  const R = H.recorder('1-join', 'native', lang, 's360', 'signed-out');
  try {
    await H.gotoNative(page, `/join/${TOK.ok}`);
    await H.waitText(page, JOIN_ROOM.name, 15000);
    const f1 = await R.step(page, 'invite-preview-signed-out', { screen: 'join/[token]', asked: 'consent; "Sign in to join"' });
    await H.ntap(page, nt(lang, 'n.app.join.sign-in'));
    await H.sleep(2500);
    const f2 = await R.step(page, 'sign-in', { screen: 'sign-in (pushed over the invite)', tap: nt(lang, 'n.app.join.sign-in'), asked: '(reads the screen)' });
    const t = await H.text(page);
    R.rec.steps[R.rec.steps.length - 1].asked = t.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8).join(' / ').slice(0, 220);
    // Where a completed sign-in goes is in the source (no credential is typed here):
    // sign-in.tsx finishReturning() → router.replace('/(tabs)'); a new account →
    // router.replace('/choose-unit?onboard=1'). Neither returns to the invite.
    H.finding({ id: 'R-NATIVE-SIGNIN-LEAVES-INVITE', flow: '1-join', severity: 'P2', surfaces: ['native'],
      title: 'Native: after "Sign in to join", a finished sign-in lands on Home / the unit chooser, not back on the invite',
      actual: 'join/[token] pushes /sign-in expecting to stay underneath, but sign-in ends with router.replace(\'/(tabs)\') (returning) or router.replace(\'/choose-unit?onboard=1\') (new account), so the reader is taken to Home with the invite buried in the stack (reachable only by system Back, if at all). A new account then goes through the chooser to the tabs.',
      expected: 'After sign-in the reader is back on the invite with the button reading "Join this group" (router.back() when the sign-in was pushed from a join, or a returnTo param).',
      evidence: [H.ev(f1), H.ev(f2)], source: `${SRC.nJoin}; ${SRC.nSignInDone}; native/src/app/sign-in.tsx:805-811`,
      fix: 'Pass a returnTo (e.g. /sign-in?next=/join/<token>) and have finishReturning / the onboarding chooser honour it.', needsDevice: true });
    // Back from sign-in: is the invite still underneath?
    await page.getByLabel(nt(lang, 'common.close')).first().click().catch(async () => { await page.goBack().catch(() => {}); });
    await H.sleep(1500);
    if (!(await H.has(page, JOIN_ROOM.name))) { await page.goBack().catch(() => {}); await H.sleep(1500); }
    const f3 = await R.step(page, 'back-from-sign-in', { screen: 'join/[token]?', tap: 'back' });
    H.check(`1:native-back-to-invite:${lang}`, { flagged: !(await H.has(page, JOIN_ROOM.name)), detail: 'Back from sign-in shows the invite again', evidence: [f3] });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function nativeJoinErrors(H) {
  const { TOK, JOIN_ROOM, nt } = H;
  const lang = 'en';
  const R = H.recorder('1-join', 'native', lang, 's360', 'errors');
  for (const k of ['gone', 'rev', 'exp', 'held', 'err']) {
    const { ctx, page } = await H.open('native', { lang });
    await H.gotoNative(page, `/join/${TOK[k]}`);
    await H.waitAny(page, [nt(lang, 'n.app.join.expired-title'), nt(lang, 'join.held-title')], 10000);
    const f = await R.step(page, `preview-${k}`, { screen: 'join/[token]', note: `GET /api/join → ${k}` });
    const t = await H.text(page);
    if (k === 'err' && H.check('1:native-500-says-invalid', { flagged: t.includes(nt(lang, 'n.app.join.expired-title')), detail: 'a 500 on the preview reads "That invitation is no longer valid"', evidence: [f] })) {
      H.finding({ id: 'R-NATIVE-JOIN-ERR-INVALID', flow: '1-join', severity: 'P2', surfaces: ['native'],
        title: 'Native join: a server error or dropped connection is shown as "That invitation is no longer valid"',
        actual: 'Any non-OK preview (404, 410, 500) and any thrown fetch (offline) set state "gone": "That invitation is no longer valid — ask whoever sent it for a fresh link." A temporary 500 or a dropped signal sends the reader to ask for a new link they do not need, with only "Back to Hawkeye" offered. The web distinguishes withdrawn / expired / not recognised / "Something went wrong — try again".',
        expected: 'Distinct states as on the web, and a Try again for 5xx / network.',
        evidence: [H.ev(f)], source: SRC.nJoinGone, fix: 'Map 410 invite_revoked/invite_expired and 404 to their titles; 5xx and catch → "Something went wrong" + retry.' });
    }
    await ctx.close();
  }
  for (const k of ['postErr', 'postNet']) {
    const extra = k === 'postNet' ? async (ctx) => {
      await ctx.route(new RegExp(`/api/join/${TOK.postNet}$`), (r) => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.fallback()));
    } : null;
    const { ctx, page } = await H.open('native', { lang, extra });
    await H.gotoNative(page, `/join/${TOK[k]}`);
    await H.waitText(page, JOIN_ROOM.name, 10000);
    await H.ntap(page, nt(lang, 'n.app.join.join'));
    await H.sleep(3000);
    const f = await R.step(page, `tap-join-${k}`, { screen: 'join/[token]', note: `POST /api/join → ${k}` });
    const t = await H.text(page);
    if (k === 'postErr') H.check('1:native-post500-invalid', { flagged: t.includes(nt(lang, 'n.app.join.expired-title')), detail: 'POST 500 → "no longer valid"', evidence: [f] }) && H.finding({ id: 'R-NATIVE-JOIN-ERR-INVALID', surfaces: ['native'], evidence: [H.ev(f)] });
    if (k === 'postNet') {
      const silent = t.includes(nt(lang, 'n.app.join.join')) && !/connection|network|intanet/i.test(t);
      if (H.check('1:native-post-offline-silent', { flagged: silent, detail: 'offline tap returns to the Join button with no message', evidence: [f] })) {
        H.finding({ id: 'R-NATIVE-JOIN-OFFLINE-SILENT', flow: '1-join', severity: 'P3', surfaces: ['native'],
          title: 'Native join: tapping Join offline just puts the button back, with no message',
          actual: 'The catch in join() sets state back to "ready"; the spinner disappears and nothing says the join did not happen.',
          expected: 'A line under the button: "Could not join — check your connection and try again."',
          evidence: [H.ev(f)], source: SRC.nJoin, fix: 'Keep an error line in state and show it under the Join button.' });
      }
    }
    await ctx.close();
  }
}

async function nativeMyGroups(H, lang) {
  const { nt, memberRow, INVITED_ROW } = H;
  const server = H.roomServer({ member: [memberRow(), { ...INVITED_ROW }, memberRow({ id: 23, name: 'Ojota Youth Watch', slug: 'ojota-youth', member_state: 'invited', assigned_pu: null, assign_state: '', assigned_name: null })] });
  const { ctx, page, errors } = await H.open('native', { lang, server });
  const R = H.recorder('1-join', 'native', lang, 's360', 'my-groups');
  try {
    await H.gotoNative(page, '/my-groups');
    await H.waitText(page, 'Kosofe Ward Volunteers', 15000);
    await H.sleep(800);
    const f1 = await R.step(page, 'my-groups', { screen: 'my-groups', asked: 'invite cards (Accept / No thanks), member card (check-in, not-where, Leave), paste-a-link box' });
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      H.check(`1:english-left:native-my-groups`, { flagged: en.length > 0, detail: en.join(' | '), evidence: [f1] });
    }
    // Accept the first invite (the first Accept on screen belongs to Kosofe: list order).
    await H.ntap(page, nt(lang, 'my-groups.accept'), { first: true });
    await H.sleep(2000);
    const f2 = await R.step(page, 'accepted', { screen: 'my-groups', tap: nt(lang, 'my-groups.accept') });
    await H.ntap(page, nt(lang, 'my-groups.no-thanks'), { first: true });
    await H.sleep(1000);
    const f3 = await R.step(page, 'refuse-sheet', { screen: 'ConfirmSheet', tap: nt(lang, 'my-groups.no-thanks') });
    // The sheet's confirm button carries the same label; the last visible one is the sheet's.
    await H.ntap(page, nt(lang, 'my-groups.no-thanks'));
    await H.sleep(2000);
    const f4 = await R.step(page, 'refused', { screen: 'my-groups' });
    await H.ntap(page, nt(lang, 'my-groups.not-where'), { first: true });
    await H.sleep(2000);
    const f5 = await R.step(page, 'declined-unit', { screen: 'my-groups', tap: nt(lang, 'my-groups.not-where') });
    const t5 = await H.text(page);
    if (H.check(`1:decline-no-undo:native:${lang}`, { flagged: t5.includes(nt(lang, 'my-groups.declined-note')) && !/undo|after all/i.test(t5), detail: 'declined card offers no way back', evidence: [f5] })) {
      H.finding({ ...DECLINE_NO_UNDO, surfaces: ['native'], evidence: [H.ev(f5)] });
    }
    await H.ntap(page, nt(lang, 'my-groups.leave'), { first: true });
    await H.sleep(1000);
    const f6 = await R.step(page, 'leave-sheet', { screen: 'ConfirmSheet', tap: nt(lang, 'my-groups.leave') });
    await H.ntap(page, nt(lang, 'my-groups.leave'));
    await H.sleep(2000);
    const f7 = await R.step(page, 'left', { screen: 'my-groups' });
    const left = server.st.calls.filter((c) => /DELETE \/api\/groups\/\d+\/membership/.test(c));
    H.check(`1:native-leave-called:${lang}`, { flagged: left.length < 2, detail: `membership DELETEs: ${left.join(', ')}`, evidence: [f7] });
    // Paste a bad link, then a good one.
    const box = page.locator('input[placeholder^="https://hawkeye.com.ng/join/"]');
    // KEYBOARD UP (viewport cut ~42%): are the field and "Open invite" both on screen?
    await box.focus().catch(() => {});
    await page.setViewportSize({ width: 360, height: Math.round(740 * 0.58) });
    await box.scrollIntoViewIfNeeded().catch(() => {});
    await H.sleep(500);
    const kb = await kbVisible(page, box, page.getByText(nt(lang, 'n.app.my-groups.open-link'), { exact: true }).last());
    const fk = await R.step(page, 'paste-keyboard-up', { screen: 'my-groups (keyboard up)', note: `field visible=${kb.field}, "Open invite" visible=${kb.action}` });
    H.check(`1:kb-paste:native:${lang}`, { flagged: !(kb.field && kb.action), detail: JSON.stringify(kb), evidence: [fk] });
    await page.setViewportSize({ width: 360, height: 740 });
    await box.fill('hello there').catch(() => {});
    await H.ntap(page, nt(lang, 'n.app.my-groups.open-link'));
    await H.sleep(600);
    const f8 = await R.step(page, 'paste-bad-link', { screen: 'my-groups', asked: 'paste an invite link', note: (await H.has(page, nt(lang, 'n.app.my-groups.bad-link'))) ? 'says: not a Hawkeye invite link' : 'no message' });
    await box.fill(`https://hawkeye.com.ng/join/${H.TOK.ok}`).catch(() => {});
    await H.ntap(page, nt(lang, 'n.app.my-groups.open-link'));
    await H.waitText(page, H.JOIN_ROOM.name, 10000);
    const f9 = await R.step(page, 'paste-good-link', { screen: 'join/[token]', tap: nt(lang, 'n.app.my-groups.open-link') });
    if (errors.length) H.check(`1:pageerrors:native-my-groups:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function nativeMyGroupsErrors(H) {
  const { nt } = H;
  const lang = 'en';
  const R = H.recorder('1-join', 'native', lang, 's360', 'my-groups-errors');
  for (const kind of ['409', 'offline']) {
    const over = kind === '409' ? { 'POST /api/groups/19/accept': { status: 409, json: { error: 'room_pending_verification' } } } : {};
    const extra = kind === 'offline' ? async (ctx) => { await ctx.route(/\/api\/groups\/19\/accept$/, (r) => r.abort('internetdisconnected')); } : null;
    const { ctx, page } = await H.open('native', { lang, server: H.roomServer({ over }), extra });
    await H.gotoNative(page, '/my-groups');
    await H.waitText(page, 'Kosofe Ward Volunteers', 15000);
    await H.ntap(page, nt(lang, 'my-groups.accept'), { first: true });
    await H.sleep(2500);
    const f = await R.step(page, `accept-${kind}`, { screen: 'my-groups', note: (await H.text(page)).includes(nt(lang, kind === '409' ? 'join.held-title' : 'n.app.my-groups.try-again-later')) ? 'explained' : 'not explained' });
    await ctx.close();
  }
}

const ORG_CODE_ORDER = {
  id: 'R-ORG-CODE-ORDER', flow: '1-join', severity: 'P2',
  title: 'Organisation-code sign-up asks for the password BEFORE the account on web/Lite, AFTER it (twice) on native',
  actual: 'Web/Lite: one form — phone, "Create a password (at least 8)", the ORG code — then "This code will be tied to {phone} for good" and the account is made with that password. Native: phone + ORG code only → confirm sheet → account created → a separate "Create your password" step with the password typed twice. Same task, different questions in a different order; a web user who mistypes the password once has no repeat field.',
  expected: 'One order on every surface (and the same number of password fields).',
  source: 'app/app.js:828-866 (orgSignUp: password checked before /org-signup) vs native/src/app/sign-in.tsx:430-465 (password step after /org-signup) + 1497-1515',
  fix: 'Pick one: native asks the password on the code screen, or web moves it after the account as native does — and use the same repeat-field rule.',
};

/** Is each element's box inside the (shrunk) viewport? */
async function kbVisible(page, field, action) {
  const inView = async (loc) => {
    const b = await loc.boundingBox().catch(() => null);
    const vp = page.viewportSize();
    return !!(b && b.y >= 0 && b.y + b.height <= vp.height && b.height > 0);
  };
  return { field: await inView(field), action: await inView(action) };
}

// ---------------------------------------------------------------- typed code
async function typedCode(H, surface, lang) {
  const { nt, wt } = H;
  const CODE = 'ORG-ABCD-EFGH-JKMN';
  const R = H.recorder('1-join', surface, lang, 's360', 'typed-org-code');
  const { ctx, page } = await H.open(surface, { lang, signedIn: false });
  try {
    if (surface === 'native') {
      await H.gotoNative(page, '/sign-in?intent=signup');
      const f1 = await R.step(page, 'sign-up', { screen: 'sign-in?intent=signup', asked: '(reads the screen)' });
      R.rec.steps[0].asked = (await H.text(page)).split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12).join(' / ').slice(0, 300);
      // The one code field carries an accessibility label (no placeholder): sign-in.tsx:1128-1141.
      const field = page.getByLabel(nt(lang, 'auth.code-label-short')).first();
      const typed = await field.fill(CODE).then(() => true).catch(() => false);
      await H.sleep(800);
      const t2 = await H.text(page);
      const f2 = await R.step(page, 'org-code-typed', { screen: 'sign-in (sign-up, organisation code)', note: `code field found=${typed}; "${nt(lang, 'n.auth.code-kind-org')}" shown=${t2.includes(nt(lang, 'n.auth.code-kind-org'))}`, asked: t2.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 16).join(' / ').slice(0, 300) });
      const pwFields = await page.locator('input[type="password"]').count();
      // Native's order (password after the account) is the one web/Lite now follow, so
      // this is recorded, not a finding: the web-side check below flags any mismatch.
      H.check(`1:org-code-password-later:native`, { flagged: false, detail: `password fields on the code screen: ${pwFields} (typed=${typed})`, evidence: [f2] });
      await page.setViewportSize({ width: 360, height: Math.round(740 * 0.58) });
      await field.focus().catch(() => {});
      await field.scrollIntoViewIfNeeded().catch(() => {});
      await H.sleep(600);
      const btnLoc = page.getByText(nt(lang, 'n.auth.org-create-account'), { exact: true }).first();
      const kb = await kbVisible(page, field, btnLoc);
      const f3 = await R.step(page, 'code-keyboard-up', { screen: 'sign-in (keyboard up)', note: `code field visible=${kb.field}, primary button visible=${kb.action}` });
      H.check(`1:kb-code:native:${lang}`, { flagged: !(kb.field && kb.action), detail: JSON.stringify(kb), evidence: [f3] });
    } else {
      await H.gotoWeb(page, '/observe.html?intent=observe', lang);
      await page.waitForSelector('#auth-input', { state: 'visible', timeout: 12000 }).catch(() => {});
      await H.sleep(800);
      const f1 = await R.step(page, 'sign-up', { screen: 'observe.html (sign-up)', asked: 'phone, route (WhatsApp/Telegram/Call/SMS), invite or organisation code; the password after the proof' });
      await page.fill('#ref-input', CODE).catch(() => {});
      await H.sleep(500);
      const btn = (await page.locator('#btn-auth').innerText().catch(() => '')).trim();
      const pick = await page.locator('#channel-pick').isVisible().catch(() => null);
      const kind = await page.locator('#ref-kind-org').isVisible().catch(() => null);
      const f2 = await R.step(page, 'org-code-typed', { screen: 'observe.html (sign-up, organisation code)', note: `button="${btn}", channel picker visible=${pick}, "organisation code" line=${kind}`, asked: 'phone; then "This code will be tied to {phone} for good" confirm; then the password (new + repeat)' });
      // ANY visible password box on the code form (the up-front #pw-opt-input
      // is gone; a by-id look-up would now be a detector that cannot fire).
      const pwVisible = (await page.locator('#auth-card input[type="password"]:visible').count().catch(() => 0)) > 0;
      if (H.check(`1:org-code-password-first:${surface}`, { flagged: pwVisible && kind, detail: `password field on the code form: ${pwVisible}`, evidence: [f2] })) {
        H.finding({ ...ORG_CODE_ORDER, surfaces: [surface], evidence: [H.ev(f2)] });
      }
      // CONTROL: on a 140px-high screen scrolled to the top, the code field and the
      // button cannot both be on screen — the detector must say so.
      await page.setViewportSize({ width: 360, height: 140 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await H.sleep(300);
      const ctl = await kbVisible(page, page.locator('#ref-input'), page.locator('#btn-auth'));
      H.check(`1:control:kb-detector:${surface}`, { flagged: ctl.field && ctl.action, detail: `140px, top: field visible=${ctl.field}, button visible=${ctl.action} (both true would mean the detector cannot fail)` });
      await page.setViewportSize({ width: 360, height: Math.round(740 * 0.58) });
      await page.focus('#ref-input').catch(() => {});
      await page.locator('#ref-input').scrollIntoViewIfNeeded().catch(() => {});
      await H.sleep(500);
      const kb = await kbVisible(page, page.locator('#ref-input'), page.locator('#btn-auth'));
      const f3 = await R.step(page, 'code-keyboard-up', { screen: 'observe.html (keyboard up)', note: `code field visible=${kb.field}, "${btn}" visible=${kb.action}` });
      H.check(`1:kb-code:${surface}:${lang}`, { flagged: !(kb.field && kb.action), detail: JSON.stringify(kb), evidence: [f3] });
    }
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

// =============================================================================
// FLOW 2 — ROOM CHECK-IN ON ELECTION DAY
// =============================================================================
const CHECKIN_BLAMES_GPS = {
  id: 'R-CHECKIN-OFFLINE-BLAMES-GPS', flow: '2-checkin', severity: 'P2',
  title: 'Check-in with no connection says "Could not read your location. Move into the open"',
  actual: 'When the check-in request cannot be sent (no data on election morning), the card says the LOCATION failed and tells the agent to move into the open — the GPS fix was fine. Native says that same line for EVERY failure: no connection, a server refusal (400 no_fix, 403), and a refused location permission (where the web says "Location permission was refused").',
  expected: '"Could not reach Hawkeye — check your connection and try again" for a network failure; the location line only when getPosition() fails.',
  source: 'app/app.js:2453-2457 (one catch for getPosition() and api()); native/src/app/my-groups.tsx:190-208, native/src/app/report/result.tsx:2145-2155, native/src/lib/check-in.ts:93-95',
  fix: 'Separate the two awaits: catch the fix failure (location line) apart from the request failure (connection line); on native map r.error === "network", permission and server codes to their own strings.',
};
export async function flow2(H, { surfaces, langs }) {
  for (const surface of surfaces) {
    for (const lang of langs) {
      if (surface === 'native') {
        if (H.on('checkInMyGroups')) await nativeCheckInMyGroups(H, lang);
        if (lang === langs[0] && H.on('checkInReport')) await nativeCheckInReport(H, lang);
      } else if (H.on('checkInReport')) await webCheckInReport(H, surface, lang);
    }
    if (H.on('checkInFailures')) { if (surface === 'native') await nativeCheckInFailures(H); else await webCheckInFailures(H, surface); }
  }
  // The room's own check-in (situation-room.html Team tab) — web only (the room is web-only).
  if (surfaces.includes('web') && H.on('roomCheckIn')) for (const lang of langs) await roomCheckIn(H, lang);
}

/** The report flow (observe.html) for a roster member: the card on arrival. */
async function webCheckInReport(H, surface, lang) {
  const { wt, UNIT } = H;
  const server = H.roomServer({ member: [H.memberRow({ assign_state: 'confirmed' })] });
  const { ctx, page, errors } = await H.open(surface, { lang, server });
  const R = H.recorder('2-checkin', surface, lang, 's360', 'report-flow');
  try {
    await H.gotoWeb(page, '/observe.html', lang);
    const shown = await page.waitForSelector('#checkin-card', { state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    await H.sleep(800);
    const inView = await page.evaluate(() => { const r = document.getElementById('checkin-card')?.getBoundingClientRect(); return r ? r.top < innerHeight && r.bottom > 0 : false; }).catch(() => false);
    const f1 = await R.step(page, 'report-opens-with-card', { screen: 'observe.html report flow (step 1 photos below)', asked: `"${wt(lang, 'observe.check-in-title')}" + "${wt(lang, 'observe.check-in')}"`, note: `card shown=${shown}, in first viewport=${inView}` });
    H.check(`2:card-shown:${surface}:${lang}`, { flagged: !shown, detail: 'check-in card renders for a roster member', evidence: [f1] });
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      H.check(`2:english-left:report:${surface}`, { flagged: en.length > 0, detail: en.join(' | '), evidence: [f1] });
    }
    // Keyboard is irrelevant here (no field); tap.
    await page.click('#btn-checkin');
    const ok = await H.waitText(page, wt(lang, 'observe.checked-in-ok'), 15000);
    await H.sleep(900);
    const f2 = await R.step(page, 'checked-in', { screen: 'observe.html', tap: wt(lang, 'observe.check-in'), note: `receipt="${ok ? wt(lang, 'observe.checked-in-ok') : '(none)'}"; page moved on to the photos` });
    H.check(`2:checked-in-ok:${surface}:${lang}`, { flagged: !ok, detail: 'success line shown', evidence: [f2] });
    // Reload mid-flow: does the card remember?
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    await H.webLang(page, lang);
    await H.sleep(2500);
    const again = await H.waitText(page, wt(lang, 'observe.checked-in-already'), 10000);
    const f3 = await R.step(page, 'reload-after-check-in', { screen: 'observe.html', tap: 'reload', note: again ? 'says "Your coordinator knows you are here."' : 'card not remembered' });
    if (errors.length) H.check(`2:pageerrors:report:${surface}:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
  // CONTROL: the ordinary observer (on no roster) must see no card at all.
  if (lang === 'en') {
    const s2 = H.roomServer({ member: [] });
    const o = await H.open(surface, { lang, server: s2 });
    await H.gotoWeb(o.page, '/observe.html', lang);
    await H.sleep(5000);
    const card = await o.page.locator('#checkin-card').isVisible().catch(() => false);
    const f = await R.step(o.page, 'control-ordinary-observer', { screen: 'observe.html', note: `no roster → card visible=${card}` });
    H.check(`2:control-no-card-for-ordinary:${surface}`, { flagged: card, detail: `card visible for an observer on no roster: ${card}`, evidence: [f] });
    await o.ctx.close();
  }
}

async function webCheckInFailures(H, surface) {
  const { wt } = H;
  const lang = 'en';
  const R = H.recorder('2-checkin', surface, lang, 's360', 'failures');
  const cases = [
    ['weak', { 'POST /api/my/check-in': { status: 200, json: { ok: true, standing: 'unverified', rooms: [] } } }, 'observe.checked-in-weak'],
    ['no_fix', { 'POST /api/my/check-in': { status: 400, json: { error: 'no_fix' } } }, 'observe.check-in-no-fix'],
    ['no_rooms', { 'POST /api/my/check-in': { status: 403, json: { error: 'no_rooms' } } }, 'observe.check-in-not-member'],
    ['server_500', { 'POST /api/my/check-in': { status: 500, json: { error: 'internal' } } }, 'common.something-went-wrong'],
    ['offline', {}, null],
    ['denied', {}, 'observe.check-in-denied'],
  ];
  for (const [k, over, key] of cases) {
    const server = H.roomServer({ member: [H.memberRow({ assign_state: 'confirmed' })], over });
    const extra = k === 'offline' ? async (ctx) => { await ctx.route(/\/api\/my\/check-in$/, (r) => r.abort('internetdisconnected')); } : null;
    const { ctx, page } = await H.open(surface, { lang, server, extra, geo: k !== 'denied' });
    try {
      await H.gotoWeb(page, '/observe.html', lang);
      await page.waitForSelector('#btn-checkin', { state: 'visible', timeout: 15000 }).catch(() => {});
      await page.click('#btn-checkin').catch(() => {});
      // Wait for the outcome, not a fixed time: the line leaves "Finding your location…".
      const locating = wt(lang, 'observe.check-in-locating');
      await H.sleep(800);
      await page.waitForFunction((l) => { const c = document.getElementById('checkin-card') || document.getElementById('checkin-host'); return c && !c.innerText.includes(l); }, locating, { timeout: 20000 }).catch(() => {});
      await H.sleep(400);
      const note = (await page.locator('#checkin-host').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const f = await R.step(page, `check-in-${k}`, { screen: 'observe.html', tap: wt(lang, 'observe.check-in'), note });
      if (key) H.check(`2:msg-${k}:${surface}`, { flagged: !note.includes(wt(lang, key)), detail: `card: ${note}`, evidence: [f] });
      if (k === 'offline') {
        const misleads = note.includes(wt(lang, 'observe.check-in-failed'));
        if (H.check(`2:offline-blames-location:${surface}`, { flagged: misleads, detail: `card: ${note}`, control: 'no_fix/500 cases show their own server-side lines', evidence: [f] })) {
          H.finding({ ...CHECKIN_BLAMES_GPS, surfaces: [surface], evidence: [H.ev(f)] });
        }
      }
    } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
    await ctx.close();
  }
}

/** The room's own check-in: a plain member on the Team tab of situation-room.html. */
async function roomCheckIn(H, lang) {
  const { wt, UNIT } = H;
  for (const variant of ['ok', 'no_fix']) {
    const team = { 12: { contest: 'GOV', restricted: true, members: [{ observer_id: 7, label: null, role: null, shared: 0, joined_at: H.NOW - 5 * 24 * H.H, assign_state: 'confirmed', assigned: { ...UNIT }, reported: null, status: 'silent', attendance: null }] } };
    const over = variant === 'no_fix' ? { 'POST /api/groups/12/check-in': { status: 400, json: { error: 'no_fix' } } } : {};
    const server = H.roomServer({ member: [H.memberRow({ assign_state: 'confirmed' })], team, over });
    const { ctx, page, errors } = await H.open('web', { lang, server });
    const R = H.recorder('2-checkin', 'web', lang, 's360', `room-${variant}`);
    try {
      await H.gotoWeb(page, '/room/lagos-citizens', lang);
      await page.waitForURL(/situation-room\.html/, { timeout: 15000 }).catch(() => {});
      await H.webLang(page, lang);
      await H.waitText(page, 'Lagos Citizens Observer Network', 15000);
      await H.sleep(1500);
      const f1 = await R.step(page, 'room-as-member', { screen: 'situation-room.html (plain member, Overview)', note: 'no check-in on Overview; it is on the Team tab' });
      await page.locator('.sr-tabs [data-tab="team"]').click().catch(() => {});
      await page.waitForSelector('#sr-checkin', { timeout: 10000 }).catch(() => {});
      const f2 = await R.step(page, 'team-tab', { screen: 'situation-room.html Team', tap: wt(lang, 'situation-room.team'), asked: wt(lang, 'situation-room.check-in-prompt') });
      if (variant === 'ok' && H.check(`2:cso-called-campaign:${lang}`, { flagged: (await H.text(page)).includes(wt(lang, 'situation-room.read-only-title')), detail: 'a civil-society room tells its member "You are on this campaign’s roster."', evidence: [f2] })) {
        H.finding({ id: 'R-CSO-CALLED-CAMPAIGN', flow: '2-checkin', severity: 'P3', surfaces: ['web'],
          title: 'A civil-society room tells its members they are on a "campaign’s roster"',
          actual: 'The plain-member Team tab of a CSO room (kind "cso", shown as "Civil society") says "You are on this campaign’s roster." — the one word a non-partisan observer group would not want attached to it.',
          expected: 'Kind-aware wording, as join.html already has ("this observer group" / "this campaign").',
          evidence: [H.ev(f2)], source: 'app/situation-room.html:2759 (situation-room.read-only-title used for every kind)',
          fix: 'Add a CSO variant of read-only-title and pick by g.kind.' });
      }
      await page.click('#sr-checkin').catch(() => {});
      await H.sleep(4500);
      const t = await H.text(page);
      const posted = server.st.calls.includes('POST /api/groups/12/check-in');
      const sayFailed = t.includes(wt(lang, 'situation-room.check-in-failed'));
      const sayOk = t.includes(wt(lang, 'situation-room.you-are-checked-in'));
      const f3 = await R.step(page, `after-tap-${variant}`, { screen: 'situation-room.html Team', tap: wt(lang, 'situation-room.check-in'), note: `POST sent=${posted}; shows ok=${sayOk}; shows "could not read your location"=${sayFailed}` });
      if (variant === 'no_fix') {
        H.check(`2:control-room-no-fix:${lang}`, { flagged: !t.includes(wt(lang, 'situation-room.check-in-no-fix')), detail: 'a 400 no_fix shows its own line (control for the success case)', evidence: [f3] });
      } else if (H.check(`2:room-checkin-success-says-failed:${lang}`, { flagged: posted && sayFailed && !sayOk, detail: `server answered 200 verified; page says location failed. pageerrors=${errors.join(' | ')}`, control: `2:control-room-no-fix:${lang}`, evidence: [f2, f3] })) {
        H.finding({ id: 'R-ROOM-CHECKIN-FALSE-FAIL', flow: '2-checkin', severity: 'P1', surfaces: ['web'],
          title: 'Situation room: a SUCCESSFUL check-in is reported as "Could not read your location. Move into the open"',
          actual: 'On the Team tab, "I’m at my unit" sends POST /groups/:id/check-in; the server answers 200 (recorded, verified) and the page then calls load(true) — a function that does not exist in situation-room.html (i18n.js keeps its own load() inside an IIFE). The ReferenceError lands in the catch, which tells the member the location failed and re-enables the button. They are checked in but told they are not, and will keep retrying.',
          expected: 'After a 200 the Team tab re-reads and shows "You are checked in."',
          evidence: [H.ev(f2), H.ev(f3)], source: 'app/situation-room.html:1519-1521 (await load(true)) caught at 1522-1527',
          fix: 'Replace `await load(true)` with `await loadTab(true)` (S.team is already cleared), and catch the fetch separately from getCurrentPosition.' });
      }
    } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
    await ctx.close();
  }
}

/** Native: My Groups carries the check-in (the web My Groups does not). */
async function nativeCheckInMyGroups(H, lang) {
  const { nt } = H;
  const server = H.roomServer({ member: [H.memberRow({ assign_state: 'confirmed' })] });
  const { ctx, page, errors } = await H.open('native', { lang, server });
  const R = H.recorder('2-checkin', 'native', lang, 's360', 'my-groups');
  try {
    await H.gotoNative(page, '/my-groups');
    await H.waitText(page, nt(lang, 'n.app.report.result.check-in'), 15000);
    const f1 = await R.step(page, 'my-groups-card', { screen: 'my-groups', asked: `"${nt(lang, 'n.app.report.result.check-in-sub')}" + "${nt(lang, 'n.app.report.result.check-in')}"` });
    await H.ntap(page, nt(lang, 'n.app.report.result.check-in'));
    const ok = await H.waitText(page, nt(lang, 'n.app.report.result.checked-in-ok'), 15000);
    const f2 = await R.step(page, 'checked-in', { screen: 'my-groups', tap: nt(lang, 'n.app.report.result.check-in'), note: ok ? 'shows "✔ Checked in…"' : (await H.text(page)).slice(0, 200) });
    H.check(`2:native-checked-in:${lang}`, { flagged: !ok, detail: 'native My Groups check-in confirms', evidence: [f2] });
    if (errors.length) H.check(`2:pageerrors:native-mg:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

/** Native report flow: where does the check-in sit? (After the two photos.) */
async function nativeCheckInReport(H, lang) {
  const { nt } = H;
  const server = H.roomServer({ member: [H.memberRow({ assign_state: 'confirmed' })] });
  const { ctx, page } = await H.open('native', { lang, server });
  const R = H.recorder('2-checkin', 'native', lang, 's360', 'report-flow');
  try {
    // ARRIVAL is the Report sheet (the Report tab), as a real observer reaches the
    // flow; components/report-sheet.tsx draws the check-in card there, at the
    // assigned unit. Going straight to /report/result skipped it.
    await H.gotoNative(page, '/');
    await H.sleep(2000);
    await page.getByText(nt(lang, 'nav.report'), { exact: true }).last().click().catch(() => {});
    await H.sleep(1500);
    const tSheet = await H.text(page);
    await H.gotoNative(page, '/report/result');
    await H.sleep(2500);
    const t = await H.text(page);
    const hasCheckIn = [tSheet, t].some((x) => x.includes(nt(lang, 'observe.check-in-title')) || x.includes(nt(lang, 'n.app.report.result.check-in')));
    const f1 = await R.step(page, 'report-opens', { screen: 'report/result (step: sheet photo)', asked: nt(lang, 'n.app.report.result.photo-1-of-2-the-result'), note: `check-in offered on arrival: ${hasCheckIn}` });
    if (H.check('2:native-report-checkin-after-photos', { flagged: !hasCheckIn, detail: 'native report flow opens on the result-sheet camera; no check-in', control: 'web report flow shows the card on arrival (2:card-shown)', evidence: [f1] })) {
      H.finding({ id: 'R-NATIVE-CHECKIN-AFTER-PHOTOS', flow: '2-checkin', severity: 'P2', surfaces: ['native'],
        title: 'Check-in order differs: web/Lite offer it on arrival; native only after photographing the result sheet and the venue',
        actual: 'Web/Lite: the report flow opens with "Tell your coordinator you are here" above the photos (assigned unit known). Native: the report flow opens on "Photo 1 of 2 — the result sheet"; the check-in card is drawn only in the unit step, after both photos — and on arrival in the morning there is no result sheet to photograph. Native’s other route is My Groups (which the web My Groups does not have).',
        expected: 'The same place on every surface: on arrival, before the photos, for a roster member with an assigned unit.',
        evidence: [H.ev(f1)], source: 'native/src/app/report/result.tsx:287-294 (step order) + 2112-2178 (card inside step "unit"); app/app.js:2297-2301 (card on entering the flow)',
        fix: 'Render the native check-in card above the camera on entering the flow when myRooms() has an assigned unit (as enterReportFlow does), and add the check-in to web My Groups or drop it from native for parity.' });
    }
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function nativeCheckInFailures(H) {
  const { nt } = H;
  const lang = 'en';
  const R = H.recorder('2-checkin', 'native', lang, 's360', 'failures');
  for (const k of ['offline', 'no_fix', 'denied']) {
    const over = k === 'no_fix' ? { 'POST /api/groups/12/check-in': { status: 400, json: { error: 'no_fix' } } } : {};
    const extra = k === 'offline' ? async (ctx) => { await ctx.route(/\/api\/groups\/12\/check-in$/, (r) => r.abort('internetdisconnected')); } : null;
    const server = H.roomServer({ member: [H.memberRow({ assign_state: 'confirmed' })], over });
    const { ctx, page } = await H.open('native', { lang, server, extra, geo: k !== 'denied' });
    try {
      await H.gotoNative(page, '/my-groups');
      await H.waitText(page, nt(lang, 'n.app.report.result.check-in'), 15000);
      await H.ntap(page, nt(lang, 'n.app.report.result.check-in'));
      await H.sleep(k === 'denied' ? 6000 : 3500);
      const t = await H.text(page);
      const f = await R.step(page, `check-in-${k}`, { screen: 'my-groups', note: t.includes(nt(lang, 'n.app.report.result.check-in-failed')) ? `says "${nt(lang, 'n.app.report.result.check-in-failed')}"` : t.slice(0, 160) });
      if (H.check(`2:native-checkin-${k}-blames-gps`, { flagged: t.includes(nt(lang, 'n.app.report.result.check-in-failed')), detail: `after ${k}: ${t.includes(nt(lang, 'n.app.report.result.check-in-failed')) ? 'location line' : 'other'}`, control: '2:native-checked-in (the success path says Checked in)', evidence: [f] })) {
        H.finding({ ...CHECKIN_BLAMES_GPS, surfaces: ['native'], evidence: [H.ev(f)] });
      }
    } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
    await ctx.close();
  }
}
// =============================================================================
// FLOW 3 — RUN A SITUATION ROOM AS A MANAGER (web only, desktop d1366)
// =============================================================================
function roomDetail(H, o) {
  return {
    id: 31, name: 'Adaeze 2027', kind: 'campaign', contest: 'PRES', scope: '', party: 'APC', party_claim: null, party_state: 'approved',
    org: null, org_claim: null, org_state: null, org_listed: null,
    admits: true, admission_block: null, slug: 'adaeze-2027', scope_kind: null, scope_label: '', scope_state: null,
    members: 3, assigned: 2, pending: 0, reported: 0, restricted: false,
    attendance: { checkedIn: 0, atUnit: 0, elsewhere: 0, expected: 3 },
    zones: ['North Central', 'North East', 'North West', 'South East', 'South South', 'South West'],
    me_id: 7, me: { role: 'owner', scope_kind: null, scope_value: null }, org_code_check: true,
    managers: [{ observer_id: 7, role: 'owner', scope_kind: null, scope_value: null }],
    ...o,
  };
}
const mgRow = (o) => ({ id: 31, name: 'Adaeze 2027', kind: 'campaign', contest: 'PRES', scope: '', party: 'APC', party_claim: null, slug: 'adaeze-2027', role: 'owner', scope_kind: null, scope_value: null, members: 3, scope_label: '', ...o });
const TEAM31 = (H) => ({ contest: 'PRES', restricted: false, members: [
  { observer_id: 7, label: 'Me (owner)', role: 'owner', shared: 0, joined_at: H.NOW - 9 * 24 * H.H, assign_state: 'proposed', assigned: { ...H.UNIT }, reported: null, status: 'silent', attendance: null },
  { observer_id: 41, label: 'Chidi O.', role: null, shared: 0, joined_at: H.NOW - 6 * 24 * H.H, assign_state: 'proposed', assigned: { ...H.UNIT2 }, reported: null, status: 'silent', attendance: null },
  { observer_id: 42, label: null, role: null, shared: 0, joined_at: H.NOW - 2 * 24 * H.H, assign_state: '', assigned: null, reported: null, status: 'unassigned', attendance: null },
] });

/** Three rooms: an approved party room WITH a code issuer (owner), a CSO room with NO issuer (owner, empty), and one this account only manages. */
function threeRooms(H) {
  const managing = [
    mgRow({}),
    mgRow({ id: 32, name: 'Lagos Watch Desk', kind: 'cso', contest: 'GOV', scope: 'Lagos', scope_label: 'Lagos', party: null, slug: 'lagos-watch-desk', members: 0 }),
    mgRow({ id: 33, name: 'Kano Volunteers', kind: 'cso', contest: 'GOV', scope: 'Kano', scope_label: 'Kano', party: null, slug: 'kano-volunteers', role: 'manager', members: 12 }),
  ];
  const groupDetail = {
    31: roomDetail(H, {}),
    32: roomDetail(H, { id: 32, name: 'Lagos Watch Desk', kind: 'cso', contest: 'GOV', scope: 'Lagos', scope_label: 'Lagos', scope_state: 'Lagos', party: null, org: 'Sample Civic Trust', org_state: 'verified', org_listed: true, slug: 'lagos-watch-desk', members: 0, assigned: 0, org_code_check: false, attendance: { checkedIn: 0, atUnit: 0, elsewhere: 0, expected: 0 } }),
    33: roomDetail(H, { id: 33, name: 'Kano Volunteers', kind: 'cso', contest: 'GOV', scope: 'Kano', scope_label: 'Kano', scope_state: 'Kano', party: null, org: 'Sample Civic Trust', org_state: 'verified', slug: 'kano-volunteers', members: 12, assigned: 9, org_code_check: false, me: { role: 'manager', scope_kind: null, scope_value: null }, managers: [{ observer_id: 3, role: 'owner' }, { observer_id: 7, role: 'manager' }] }),
  };
  return { managing, groupDetail, team: { 31: TEAM31(H), 32: { contest: 'GOV', restricted: false, members: [] }, 33: { contest: 'GOV', restricted: false, members: [] } } };
}

export async function flow3(H, { surfaces, langs }) {
  if (!surfaces.includes('web')) return;
  for (const lang of langs) {
    if (H.on('roomCreate')) await roomCreate(H, lang);
    if (H.on('roomRun')) await roomRun(H, lang);
    if (H.on('roomDeleteAndLeave')) await roomDeleteAndLeave(H, lang);
  }
  if (H.on('roomDeleteLast')) await roomDeleteLast(H, langs[0]);
  if (H.on('roomCodes')) await roomCodes(H, 'en');
  if (H.on('roomSmall')) await roomSmall(H, 'en');
}

async function roomCreate(H, lang) {
  const { wt } = H;
  const server = H.roomServer({ member: [], managing: [] });
  let createCalls = 0;
  server.st.over.create = () => {
    createCalls += 1;
    if (createCalls === 1) return { status: 400, json: { error: 'name_names_party', party: 'PDP' } };
    server.st.managing = [mgRow({ party: null, party_claim: 'APC' })];
    server.st.member = [];
    server.st.groupDetail[31] = roomDetail(H, { party: null, party_claim: 'APC', party_state: 'pending', admits: false, admission_block: 'room_pending_verification', members: 1, assigned: 1, org_code_check: false });
    server.st.team[31] = { contest: 'PRES', restricted: false, members: [TEAM31(H).members[0]] };
    return { status: 201, json: { id: 31, name: 'Adaeze 2027', kind: 'campaign', contest: 'PRES', scope: '', scope_label: '', party: null, party_claim: 'APC', admits: false, admission_block: 'room_pending_verification', slug: 'adaeze-2027' } };
  };
  const { ctx, page, errors } = await H.open('web', { lang, server, vp: 'd1366', desktop: true });
  const R = H.recorder('3-room', 'web', lang, 'd1366', 'create');
  try {
    await H.gotoWeb(page, '/situation-room.html', lang);
    await page.waitForSelector('#mk', { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('#mk-party option').length > 3 && document.querySelectorAll('#mk-contest option').length > 0, null, { timeout: 15000 }).catch(() => {});
    const f1 = await R.step(page, 'setup-form', { screen: 'situation-room.html (no rooms: setup)', asked: 'name, type, party (campaign) / organisation (CSO), election, [state], [seat]' });
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      H.check(`3:english-left:setup:${lang}`, { flagged: en.length > 0, detail: en.join(' | '), evidence: [f1] });
    }
    // Interruption: a reload with the name typed.
    await page.fill('#mk-name', 'Draft name');
    await page.reload({ waitUntil: 'load' }).catch(() => {});
    await H.webLang(page, lang);
    await page.waitForSelector('#mk', { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('#mk-party option').length > 3, null, { timeout: 15000 }).catch(() => {});
    const keptDraft = await page.inputValue('#mk-name').catch(() => '');
    R.rec.steps.push({ n: 0, name: 'reload-mid-form', screen: 'setup form', tap: 'reload', note: `typed name after reload: "${keptDraft}"` });
    // CSO: the organisation picker and its Other box.
    await page.selectOption('#mk-kind', 'cso');
    await H.sleep(300);
    await page.selectOption('#mk-org', '__other').catch(() => {});
    await H.sleep(300);
    const f1b = await R.step(page, 'setup-cso', { screen: 'setup form (CSO)', tap: 'Type: Civil society', asked: 'organisation (list or Other + full name)' });
    // GOV needs a state: pick the contest and read what appears.
    const govOpt = await page.locator('#mk-contest option').evaluateAll((os) => (os.find((o) => /GOV/.test(o.value)) || {}).value).catch(() => null);
    if (govOpt) { await page.selectOption('#mk-contest', govOpt); await H.sleep(1500); }
    const f1c = await R.step(page, 'setup-gov-state', { screen: 'setup form', tap: `election: ${govOpt}`, asked: 'state' });
    // Back to a campaign for the presidency.
    await page.selectOption('#mk-kind', 'campaign');
    const presOpt = await page.locator('#mk-contest option').evaluateAll((os) => (os.find((o) => /^PRES/.test(o.value)) || os[0] || {}).value).catch(() => null);
    if (presOpt) { await page.selectOption('#mk-contest', presOpt); await H.sleep(1200); }
    await page.fill('#mk-name', 'Adaeze 2027');
    await page.locator('#mk button[type="submit"]').click();
    const m0 = await H.webDialog(page, null);
    const f2 = await R.step(page, 'submit-without-party', { screen: 'dialog', tap: wt(lang, 'situation-room.create-situation-room'), note: (m0 || '').replace(/\s+/g, ' ') });
    await H.webDialog(page, 'ok');
    const partyVal = await page.locator('#mk-party option').evaluateAll((os) => (os.find((o) => o.value === 'APC') || os[1] || {}).value);
    await page.selectOption('#mk-party', partyVal);
    await page.locator('#mk button[type="submit"]').click();
    const m1 = await H.webDialog(page, null);
    const f3 = await R.step(page, 'refused-name-names-party', { screen: 'dialog', note: (m1 || '').replace(/\s+/g, ' ') });
    await H.webDialog(page, 'ok');
    const kept = (await page.inputValue('#mk-name').catch(() => '')) === 'Adaeze 2027';
    H.check(`3:create-error-keeps-form:${lang}`, { flagged: !kept, detail: `form kept after a refusal: ${kept}`, evidence: [f3] });
    await page.waitForSelector('.hk-dlg', { state: 'detached', timeout: 5000 }).catch(() => {});
    await H.sleep(400);
    await page.locator('#mk button[type="submit"]').click();
    if (!(await page.waitForSelector('#sr-held', { timeout: 8000 }).then(() => true).catch(() => false))) {
      // A click swallowed by the closing dialog is the harness's, not the page's: once more.
      if (createCalls < 2) await page.locator('#mk button[type="submit"]').click().catch(() => {});
    }
    await page.waitForSelector('#sr-held', { timeout: 10000 }).catch(() => {});
    await H.sleep(1500);
    const held = await page.locator('#sr-held').innerText().catch(() => '');
    const f4 = await R.step(page, 'room-created-pending', { screen: 'situation-room.html (new room, label pending)', note: `banner: ${held.replace(/\s+/g, ' ').slice(0, 160)}` });
    H.check(`3:created-lands-in-room:${lang}`, { flagged: !held, detail: 'after create the room opens with the pending banner', evidence: [f4] });
    // Invite while pending: explained, not silent.
    await page.locator('#invite-btn').click().catch(() => {});
    const m2 = await H.webDialog(page, null);
    const f5 = await R.step(page, 'invite-while-pending', { screen: 'dialog', tap: wt(lang, 'situation-room.invite-observers'), note: (m2 || '(none)').replace(/\s+/g, ' ').slice(0, 200) });
    await H.webDialog(page, 'ok');
    if (errors.length) H.check(`3:pageerrors:create:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function roomRun(H, lang) {
  const { wt } = H;
  const rooms = threeRooms(H);
  const server = H.roomServer({ member: [], ...rooms });
  server.st.over['POST /api/groups/31/managers/41'] = () => { server.st.groupDetail[31].managers.push({ observer_id: 41, role: 'manager', scope_kind: null, scope_value: null }); server.st.team[31].members[1].role = 'manager'; return { status: 200, json: { ok: true, role: 'manager' } }; };
  const { ctx, page, errors } = await H.open('web', { lang, server, vp: 'd1366', desktop: true });
  const R = H.recorder('3-room', 'web', lang, 'd1366', 'run');
  try {
    await H.gotoWeb(page, '/room/adaeze-2027', lang);
    await page.waitForURL(/situation-room\.html\?room=adaeze-2027/, { timeout: 15000 }).catch(() => {});
    await H.webLang(page, lang);
    await page.waitForSelector('.sr-tabs', { timeout: 15000 }).catch(() => {});
    await H.sleep(2500);
    const tabs = await page.locator('.sr-tabs [role="tab"]').allInnerTexts().catch(() => []);
    const f1 = await R.step(page, 'overview', { screen: 'situation-room.html?room=adaeze-2027 Overview', note: `tabs: ${tabs.join(' / ')}` });
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      H.check(`3:english-left:overview:${lang}`, { flagged: en.length > 0, detail: en.join(' | '), evidence: [f1] });
    }
    // KEYBOARD: 1..n switch tabs, r refreshes, i opens invites, Esc closes.
    const sel = async () => page.locator('.sr-tabs [aria-selected="true"]').getAttribute('data-tab').catch(() => null);
    const keyRes = {};
    for (const k of ['2', '3', '4', '5', '1']) {
      await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
      await page.keyboard.press(k);
      await H.sleep(900);
      keyRes[k] = await sel();
    }
    const covBefore = server.st.calls.filter((c) => c.startsWith('GET /api/groups/31/coverage')).length;
    await page.keyboard.press('r');
    await H.sleep(1500);
    const covAfter = server.st.calls.filter((c) => c.startsWith('GET /api/groups/31/coverage')).length;
    const f2 = await R.step(page, 'keyboard-tabs', { screen: 'Overview', tap: 'keys 2,3,4,5,1,r', note: `2→${keyRes['2']} 3→${keyRes['3']} 4→${keyRes['4']} 5→${keyRes['5']} 1→${keyRes['1']}; r re-fetched coverage: ${covAfter > covBefore}` });
    H.check(`3:keys-switch-tabs:${lang}`, { flagged: !(keyRes['2'] === 'coverage' && keyRes['3'] === 'team' && keyRes['4'] === 'incidents' && keyRes['5'] === 'codes' && keyRes['1'] === 'overview'), detail: JSON.stringify(keyRes), evidence: [f2] });
    H.check(`3:key-r-refreshes:${lang}`, { flagged: !(covAfter > covBefore), detail: `coverage GETs ${covBefore}→${covAfter}` });
    // i → invite links (first open creates one).
    await page.keyboard.press('i');
    await page.waitForSelector('.sr-sheet [data-copy]', { timeout: 10000 }).catch(() => {});
    await H.sleep(600);
    const f3 = await R.step(page, 'invite-sheet', { screen: 'Invite links sheet', tap: 'key i', note: `links: ${await page.locator('.sr-sheet [data-copy]').count()}` });
    await page.locator('.sr-sheet [data-copy]').first().click().catch(() => {});
    await H.sleep(500);
    const copied = (await page.locator('.sr-sheet [data-copy]').first().innerText().catch(() => '')).trim();
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    await page.locator('#inv-new').click().catch(() => {});
    await H.sleep(1500);
    const n2 = await page.locator('.sr-sheet [data-copy]').count();
    const f4 = await R.step(page, 'invite-copy-and-another', { screen: 'Invite links sheet', tap: 'Copy, Create another link', note: `button after copy: "${copied}", clipboard: ${clip}; links now ${n2}` });
    H.check(`3:invite-copy:${lang}`, { flagged: !/\/join\/tokNEW/.test(clip), detail: `clipboard=${clip}`, evidence: [f4] });
    // Revoke both: the second revoke leaves no live link.
    for (let i = 0; i < 2; i++) {
      await page.locator('.sr-sheet [data-revoke]').first().click().catch(() => {});
      await page.waitForSelector('.sr-ask:not(:has(.sr-sheet)) [data-yes]', { timeout: 5000 }).catch(() => {});
      const q = await page.locator('.sr-ask-card[role="alertdialog"] p').last().innerText().catch(() => '');
      await page.locator('.sr-ask-card[role="alertdialog"] [data-yes]').last().click().catch(() => {});
      await H.sleep(1500);
      if (i === 0) R.rec.steps.push({ n: 0, name: 'revoke-confirm', screen: 'confirm', asked: q.replace(/\s+/g, ' '), tap: wt(lang, 'situation-room.revoke') });
    }
    const after = await page.locator('.sr-sheet [data-copy]').count();
    const posts = server.st.calls.filter((c) => c === 'POST /api/groups/31/invites').length;
    const f5 = await R.step(page, 'revoked-all', { screen: 'Invite links sheet', tap: 'Revoke ×2 (confirmed)', note: `live links shown after revoking both: ${after}; POST /invites calls: ${posts}` });
    if (H.check(`3:revoke-last-mints-new:${lang}`, { flagged: after > 0 && posts >= 3, detail: `after revoking every link the sheet shows ${after} link(s); invites POSTed ${posts} times`, evidence: [f5] })) {
      H.finding({ id: 'R-REVOKE-LAST-MINTS', flow: '3-room', severity: 'P3', surfaces: ['web'],
        title: 'Revoking the last invite link silently creates a new one',
        actual: 'showInvite() mints a link whenever none is live, and it re-runs after every revoke — so revoking the only link (to stop joining) immediately shows a brand-new live link, with nothing saying one was made. Closing the sheet while that re-run is in flight mints the link anyway and then throws (situation-room.html:3944, $(\'inv-new\') is null in the detached sheet).',
        expected: 'After revoking the last link the sheet says "No live links" with a "Create a link" button; links are minted only on request (or on the very first open).',
        evidence: [H.ev(f5)], source: 'app/situation-room.html:3911-3919, 3939-3943', fix: 'Pass a flag from the revoke handler so showInvite() does not auto-create; render an empty state instead.' });
    }
    await page.keyboard.press('Escape');
    await H.sleep(500);
    const sheetOpen = await page.locator('.sr-sheet').count();
    const f6 = await R.step(page, 'esc-closes-sheet', { screen: 'Overview', tap: 'Esc', note: `sheet still open: ${sheetOpen > 0}` });
    H.check(`3:esc-closes:${lang}`, { flagged: sheetOpen > 0, detail: `sheets open after Esc: ${sheetOpen}`, evidence: [f6] });
    // Team: roster and roles.
    await page.keyboard.press('3');
    await page.waitForSelector('[data-act="promote"]', { timeout: 10000 }).catch(() => {});
    await H.sleep(800);
    const f7 = await R.step(page, 'team', { screen: 'Team tab', tap: 'key 3', note: 'roster with Confirm / Set unit / Give access / Rename / Remove' });
    await page.locator('[data-act="promote"][data-obs="41"]').click().catch(() => {});
    await page.waitForSelector('#pr-role', { timeout: 6000 }).catch(() => {});
    const f8 = await R.step(page, 'give-access', { screen: 'Give access sheet', tap: wt(lang, 'situation-room.give-access'), asked: 'Role (manager / coordinator) [+ area cascade]' });
    await page.locator('#pr-go').click().catch(() => {});
    await H.sleep(2000);
    const f9 = await R.step(page, 'manager-added', { screen: 'Team tab', tap: wt(lang, 'situation-room.confirm'), note: (await H.text(page)).toLowerCase().includes(wt(lang, 'situation-room.who-manages-this-room').toLowerCase()) ?'"Who manages this room" now lists 2' : 'no visible change' });
    if (errors.length) H.check(`3:pageerrors:run:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function roomCodes(H, lang) {
  const { wt } = H;
  const rooms = threeRooms(H);
  const server = H.roomServer({ member: [], ...rooms });
  const C = { unused: 'ORG-ABCD-EFGH-JKMN', used: 'ORG-BCDE-FGHJ-KMNP', other: 'ORG-CDEF-GHJK-MNPQ' };
  let withdrawn = false;
  server.st.codes = {
    check: () => ({ status: 200, json: { ok: true, max: 5000, results: [
      { code: C.unused, status: withdrawn ? 'revoked' : 'unused', ...(withdrawn ? { restorable: true } : {}) }, { code: C.used, status: 'used', usedOn: '2026-09-28' }, { code: C.other, status: 'not_yours' }, { code: 'XYZ', status: 'malformed' }] } }),
    withdraw: () => { withdrawn = true; return { status: 200, json: { ok: true, max: 5000, withdrawn: 1, results: [{ code: C.unused, status: 'revoked', restorable: true, changed: true }] } }; },
    restore: () => { withdrawn = false; return { status: 200, json: { ok: true, max: 5000, restored: 1, results: [{ code: C.unused, status: 'unused', changed: true }] } }; },
  };
  const { ctx, page, errors } = await H.open('web', { lang, server, vp: 'd1366', desktop: true });
  const R = H.recorder('3-room', 'web', lang, 'd1366', 'codes');
  try {
    await H.gotoWeb(page, '/situation-room.html?room=adaeze-2027&tab=codes', lang);
    await page.waitForSelector('#cc-text', { timeout: 15000 }).catch(() => {});
    const f1 = await R.step(page, 'codes-tab', { screen: 'Codes tab', asked: 'paste codes or upload CSV; Check' });
    await page.fill('#cc-text', `${C.unused}\n${C.used}\n${C.other}\nXYZ`);
    await page.click('#cc-check');
    await page.waitForSelector('#cc-table', { timeout: 10000 }).catch(() => {});
    await H.sleep(500);
    const f2 = await R.step(page, 'codes-checked', { screen: 'Codes tab results', tap: wt(lang, 'situation-room.codes-check') });
    await page.locator('#cc-all').check().catch(() => {});
    await H.sleep(300);
    const wbtn = (await page.locator('#cc-withdraw').innerText().catch(() => '')).trim();
    await page.click('#cc-withdraw').catch(() => {});
    await page.waitForSelector('.sr-ask [data-yes], .hk-dlg .hk-dlg-ok', { timeout: 5000 }).catch(() => {});
    const q = (await page.locator('.sr-ask p, .hk-dlg .hk-dlg-msg').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
    const f3 = await R.step(page, 'withdraw-confirm', { screen: 'confirm', tap: wbtn, asked: q });
    await page.locator('.sr-ask [data-yes], .hk-dlg .hk-dlg-ok').last().click().catch(() => {});
    await page.waitForSelector('#cc-undo', { timeout: 8000 }).catch(() => {});
    const note = (await page.locator('#cc-note').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const f4 = await R.step(page, 'withdrawn', { screen: 'Codes tab', note });
    await page.click('#cc-undo').catch(() => {});
    await H.sleep(1500);
    const note2 = (await page.locator('#cc-note').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const f5 = await R.step(page, 'restored-by-undo', { screen: 'Codes tab', tap: wt(lang, 'situation-room.codes-undo'), note: note2 });
    H.check('3:codes-withdraw-restore', { flagged: !(server.st.calls.includes('POST /api/groups/31/org-codes/withdraw') && server.st.calls.includes('POST /api/groups/31/org-codes/restore')), detail: `notes: "${note}" / "${note2}"`, evidence: [f4, f5] });
    // 429 on check.
    server.st.codes.check = () => ({ status: 429, json: { error: 'too_many_requests', retryAfterMin: 37 } });
    await page.click('#cc-check').catch(() => {});
    await page.waitForSelector('#cc-msg', { timeout: 8000 }).catch(() => {});
    const m = (await page.locator('#cc-msg').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const f6 = await R.step(page, 'check-429', { screen: 'Codes tab', note: m });
    H.check('3:codes-429-explained', { flagged: !/37/.test(m), detail: m, evidence: [f6] });
    // THE ROOM WITHOUT AN ISSUER: no Codes tab — is the absence explained?
    await H.gotoWeb(page, '/situation-room.html?room=lagos-watch-desk', lang);
    await page.waitForSelector('.sr-tabs', { timeout: 15000 }).catch(() => {});
    await H.sleep(2000);
    const tabs = await page.locator('.sr-tabs [role="tab"]').allInnerTexts().catch(() => []);
    const all = [];
    for (const t of ['overview', 'coverage', 'team', 'incidents']) {
      await page.locator(`.sr-tabs [data-tab="${t}"]`).click().catch(() => {});
      await H.sleep(1200);
      all.push(await H.text(page));
    }
    const mentions = all.some((t) => /\bcodes?\b/i.test(t.replace(/postcode/ig, '')));
    const f7 = await R.step(page, 'room-without-issuer', { screen: 'situation-room.html?room=lagos-watch-desk', note: `tabs: ${tabs.join(' / ')}; any mention of codes on any tab: ${mentions}` });
    // CONTROL: the issuer room does show the tab (above: Codes tab reached by ?tab=codes and by key 5).
    if (H.check('3:codes-tab-absence-silent', { flagged: !tabs.some((t) => /code/i.test(t)) && !mentions, detail: `tabs=${tabs.join('/')}`, control: '3:keys-switch-tabs (5→codes on the issuer room)', evidence: [f7] })) {
      H.finding({ id: 'R-CODES-TAB-SILENT', flow: '3-room', severity: 'P2', surfaces: ['web'],
        title: 'A room without an organisation-code issuer has no Codes tab and nothing says why',
        actual: 'The Codes tab is drawn only when GET /groups/:id says org_code_check (approved party/CSO claim + an org_issuers row + owner/coordinator). On an approved CSO room with no issuer the tab is simply absent; no tab, banner or empty state mentions organisation codes, so an owner who was told "check your codes in the room" cannot tell whether it is missing, broken, or not for them.',
        expected: 'A disabled/explained Codes entry (or a line on Team/Overview): "Organisation codes are not set up for {org} — Hawkeye issues them on request" vs "only the owner or a named coordinator can check codes".',
        evidence: [H.ev(f7)], source: 'app/situation-room.html:952 (tab only when g.org_code_check) and :918; backend/src/routes/groups.js:1290',
        fix: 'Have the server return why (no_issuer / not_your_role / label_pending) beside org_code_check, and draw a muted Codes tab that explains it.' });
    }
    if (errors.length) H.check('3:pageerrors:codes', { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function roomDeleteAndLeave(H, lang) {
  const { wt } = H;
  const rooms = threeRooms(H);
  const server = H.roomServer({ member: [], ...rooms });
  const { ctx, page, errors } = await H.open('web', { lang, server, vp: 'd1366', desktop: true });
  const R = H.recorder('3-room', 'web', lang, 'd1366', 'delete-leave');
  const askYes = async () => {
    await page.waitForSelector('.sr-ask [data-yes]', { timeout: 6000 }).catch(() => {});
    const q = (await page.locator('.sr-ask p').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
    return q;
  };
  try {
    // 1. Delete the EMPTY room (no members): one confirm.
    await H.gotoWeb(page, '/situation-room.html?room=lagos-watch-desk', lang);
    await page.waitForSelector('#del-btn', { timeout: 15000 }).catch(() => {});
    await H.sleep(1500);
    const f0 = await R.step(page, 'room-header', { screen: 'Lagos Watch Desk', note: `header actions: ${(await page.locator('#sr-actions button').allInnerTexts().catch(() => [])).join(' / ')}` });
    await page.click('#del-btn');
    const q1 = await askYes();
    const f1 = await R.step(page, 'delete-empty-confirm', { screen: 'confirm', tap: wt(lang, 'situation-room.delete'), asked: q1 });
    await page.locator('.sr-ask [data-yes]').last().click();
    await H.sleep(3000);
    const t1 = await H.text(page);
    const landed = (await page.locator('.sr-bar h1').innerText().catch(() => '')).trim();
    const said = t1.includes('Lagos Watch Desk');
    const f2 = await R.step(page, 'after-delete-empty', { screen: `next room: ${landed}`, note: `the deleted room's name appears anywhere (a "was deleted" notice): ${said}` });
    if (H.check(`3:delete-silent-when-rooms-left:${lang}`, { flagged: !said && landed && landed !== 'Lagos Watch Desk', detail: `landed on "${landed}", no deletion notice`, control: 'the last-room case below shows "{name} was deleted"', evidence: [f2] })) {
      H.finding({ id: 'R-DELETE-NO-CONFIRMATION', flow: '3-room', severity: 'P3', surfaces: ['web'],
        title: 'Deleting a room when others remain jumps to another room with no "deleted" confirmation',
        actual: 'deleteRoom() sets S.gone and reboots; render() only uses S.gone when NO rooms are left, and clears it otherwise. With rooms left, the console simply shows a different room — nothing says the deletion happened (the last-room case does say "{name} was deleted").',
        expected: 'A short notice on the room it lands in: "Lagos Watch Desk was deleted. Its observers’ reports stay in the public record."',
        evidence: [H.ev(f2)], source: 'app/situation-room.html:3881-3885, 910-912', fix: 'In render(), show S.gone as a dismissible .sr-note before clearing it.' });
    }
    // 2. Delete the room WITH members: typed-name confirm; wrong name first.
    if (!landed.includes('Adaeze')) { await H.gotoWeb(page, '/situation-room.html?room=adaeze-2027', lang); await page.waitForSelector('#del-btn', { timeout: 15000 }).catch(() => {}); await H.sleep(1200); }
    await page.click('#del-btn');
    await page.waitForSelector('#sr-ask-input', { timeout: 6000 }).catch(() => {});
    const q2 = (await page.locator('#sr-ask-label').innerText().catch(() => '')).replace(/\s+/g, ' ');
    await page.fill('#sr-ask-input', 'Adaeze');
    const f3 = await R.step(page, 'delete-typed-confirm', { screen: 'typed-name prompt', tap: wt(lang, 'situation-room.delete'), asked: q2 });
    await page.keyboard.press('Enter');
    const m = await H.webDialog(page, null);
    const f4 = await R.step(page, 'delete-name-mismatch', { screen: 'dialog', note: (m || '').replace(/\s+/g, ' ') });
    await H.webDialog(page, 'ok');
    await page.click('#del-btn');
    await page.waitForSelector('#sr-ask-input', { timeout: 6000 }).catch(() => {});
    await page.fill('#sr-ask-input', 'Adaeze 2027');
    await page.keyboard.press('Enter');
    await H.sleep(3000);
    const landed2 = (await page.locator('.sr-bar h1').innerText().catch(() => '')).trim();
    const f5 = await R.step(page, 'after-delete-with-members', { screen: `next room: ${landed2}` });
    // 3. Leave (the header's "Sign out") the room this account only manages — the last one.
    const leaveLabel = (await page.locator('#leave-btn').innerText().catch(() => '')).trim();
    const leaveTitle = await page.locator('#leave-btn').getAttribute('title').catch(() => '');
    await page.click('#leave-btn').catch(() => {});
    const q3 = await askYes();
    const f6 = await R.step(page, 'leave-confirm', { screen: 'confirm', tap: `${leaveLabel} (title: ${leaveTitle})`, asked: q3 });
    if (H.check(`3:leave-labelled-sign-out:${lang}`, { flagged: leaveLabel === wt(lang, 'situation-room.sign-out'), detail: `the leave-room button reads "${leaveLabel}"`, evidence: [f6] })) {
      H.finding({ id: 'R-LEAVE-SAYS-SIGN-OUT', flow: '3-room', severity: 'P3', surfaces: ['web'],
        title: 'The room’s "leave this room" button is labelled "Sign out"',
        actual: `For a manager, the header button that removes their own manager role (DELETE /groups/:id/managers/me) reads "${leaveLabel}". On a shared office computer "Sign out" is what someone presses to end their session; here it costs them access to the room until the owner re-adds them (the confirm does explain).`,
        expected: '"Leave room" / "Stop managing" — and a real account sign-out elsewhere on the page if one is wanted.',
        evidence: [H.ev(f6)], source: 'app/situation-room.html:972-974; app/i18n/en.json "situation-room.sign-out"', fix: 'Relabel to situation-room.leave-room ("Stop managing") in every language.' });
    }
    await page.locator('.sr-ask [data-yes]').last().click().catch(() => {});
    await H.sleep(3000);
    const t3 = await H.text(page);
    const empty = t3.includes(wt(lang, 'situation-room.no-rooms-heading'));
    const stale = await page.locator('#sr-actions button').allInnerTexts().catch(() => []);
    const f7 = await R.step(page, 'no-rooms-left', { screen: empty ? 'no-rooms page' : 'setup form (welcome)', note: `"${wt(lang, 'situation-room.no-rooms-heading')}" shown: ${empty}; header actions: ${stale.join(' / ')}` });
    const staleLevers = stale.length > 1;
    if (H.check(`3:no-rooms-page:${lang}`, { flagged: !empty || staleLevers, detail: `no-rooms page shown=${empty}; header still offers: ${stale.join(' / ')}`, evidence: [f7] })) {
      // What the left-over "Invite observers" does now.
      let inviteSays = '(no button)';
      if (await page.locator('#invite-btn').count()) {
        await page.click('#invite-btn').catch(() => {});
        inviteSays = (await H.webDialog(page, 'ok', 6000)) || `(no dialog; sheet open: ${await page.locator('.sr-sheet').count() > 0})`;
        await page.keyboard.press('Escape').catch(() => {});
      }
      const nullCalls = server.st.calls.filter((c) => /\/api\/groups\/null/.test(c));
      const f7b = await R.step(page, 'stale-invite-button', { screen: 'setup form', tap: wt(lang, 'situation-room.invite-observers'), note: `says: ${String(inviteSays).replace(/\s+/g, ' ').slice(0, 120)}; requests to /api/groups/null: ${nullCalls.join(', ')}` });
      H.finding({ id: 'R-NO-ROOMS-PAGE-UNREACHABLE', flow: '3-room', severity: 'P2', surfaces: ['web'],
        title: 'After deleting / leaving your last room you get the setup form with the old room’s buttons still in the header — never "You have no situation rooms"',
        actual: `deleteRoom()/leaveRoom() set S.gone and call boot(), but boot() goes straight to renderWelcome() when the list is empty (render() is the only reader of S.gone), so renderNoRooms() never runs: no "<room> was deleted / you stepped back" line, and the header keeps the departed room’s levers (${stale.join(' / ')}). The left-over "Invite observers" then asks for /api/groups/null/invites (${String(inviteSays).replace(/\s+/g, ' ').slice(0, 80)}).`,
        expected: 'The "You have no situation rooms" page with only New room in the header, as renderNoRooms() was written to show.',
        evidence: [H.ev(f7), H.ev(f7b)], source: 'app/situation-room.html:4087 (boot → renderWelcome, S.gone ignored) vs 910-911 + 1033-1045; header actions are painted only by render()/renderNoRooms()',
        fix: 'In boot(): if (!S.groups.length) return S.gone ? renderNoRooms() : renderWelcome(); and clear #sr-actions in renderWelcome().' });
    }
    await page.click('#new-btn').catch(() => {});
    await page.waitForSelector('#mk', { timeout: 8000 }).catch(() => {});
    const f8 = await R.step(page, 'new-room-from-empty', { screen: 'setup form', tap: wt(lang, 'situation-room.new-room'), note: `Cancel offered: ${await page.locator('#mk-cancel').count()}` });
    if (lang === 'ha') {
      const en = await H.englishLeft(page);
      H.check(`3:english-left:no-rooms:${lang}`, { flagged: en.length > 0, detail: en.join(' | '), evidence: [f8] });
    }
    if (errors.length) H.check(`3:pageerrors:delete:${lang}`, { flagged: true, detail: errors.join(' | ') });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

/** Delete the ONLY room: the other way to reach the "no rooms" page. */
async function roomDeleteLast(H, lang) {
  const { wt } = H;
  const rooms = threeRooms(H);
  const server = H.roomServer({ member: [], managing: [rooms.managing[1]], groupDetail: { 32: rooms.groupDetail[32] }, team: rooms.team });
  const { ctx, page } = await H.open('web', { lang, server, vp: 'd1366', desktop: true });
  const R = H.recorder('3-room', 'web', lang, 'd1366', 'delete-last');
  try {
    await H.gotoWeb(page, '/situation-room.html?room=lagos-watch-desk', lang);
    await page.waitForSelector('#del-btn', { timeout: 15000 }).catch(() => {});
    await H.sleep(1200);
    await page.click('#del-btn');
    await page.waitForSelector('.sr-ask [data-yes]', { timeout: 6000 }).catch(() => {});
    await page.locator('.sr-ask [data-yes]').last().click();
    await H.sleep(3000);
    const t = await H.text(page);
    const stale = await page.locator('#sr-actions button').allInnerTexts().catch(() => []);
    const f = await R.step(page, 'after-deleting-only-room', { screen: t.includes(wt(lang, 'situation-room.no-rooms-heading')) ? 'no-rooms page' : 'setup form', tap: `${wt(lang, 'situation-room.delete')} → OK`, note: `"was deleted" line: ${t.includes('Lagos Watch Desk')}; header: ${stale.join(' / ')}` });
    if (!t.includes(wt(lang, 'situation-room.no-rooms-heading'))) H.finding({ id: 'R-NO-ROOMS-PAGE-UNREACHABLE', surfaces: ['web'], evidence: [H.ev(f)] });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

/** s390 spot check: the desktop console on a phone-size screen. */
async function roomSmall(H, lang) {
  const rooms = threeRooms(H);
  const server = H.roomServer({ member: [], ...rooms });
  const { ctx, page } = await H.open('web', { lang, server, vp: 's390' });
  const R = H.recorder('3-room', 'web', lang, 's390', 'phone');
  try {
    await H.gotoWeb(page, '/situation-room.html?room=adaeze-2027', lang);
    await page.waitForSelector('.sr-tabs', { timeout: 15000 }).catch(() => {});
    await H.sleep(2500);
    const ov = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, w: innerWidth })).catch(() => ({}));
    const f1 = await R.step(page, 'room-at-390', { screen: 'Overview @390', note: `scrollWidth ${ov.sw} vs ${ov.w}` });
    H.check('3:s390-hscroll', { flagged: ov.sw > ov.w + 2, detail: JSON.stringify(ov), evidence: [f1] });
    await page.locator('.sr-tabs [data-tab="team"]').click().catch(() => {});
    await H.sleep(1500);
    const ov2 = await page.evaluate(() => ({ sw: document.scrollingElement.scrollWidth, w: innerWidth })).catch(() => ({}));
    const f2 = await R.step(page, 'team-at-390', { screen: 'Team @390', note: `scrollWidth ${ov2.sw} vs ${ov2.w}` });
    H.check('3:s390-hscroll-team', { flagged: ov2.sw > ov2.w + 2, detail: JSON.stringify(ov2), evidence: [f2] });
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}
// =============================================================================
// FLOW 4 — A ROOM NOTIFICATION, TAPPED FROM THE NOTIFICATIONS LIST
// =============================================================================
/* The room notifications the backend files (routes/groups.js, services/roomLabels.js),
   with their real urls. Bodies kept under 40 characters so a tap NAVIGATES
   (a longer one opens a modal first — notifications.html ONE_LINE). */
const NOTES = (H) => [
  { id: 501, kind: 'group_joined', title: 'You were added to a room', body: 'Kano Volunteers', url: 'https://hawkeye.com.ng/my-groups.html', read: 0, created_at: H.NOW - 1 * H.H, want: 'my-groups', room: 'Kano Volunteers' },
  { id: 502, kind: 'group_invite', title: 'A room asked you to observe', body: 'Kosofe Ward Volunteers', url: 'https://hawkeye.com.ng/my-groups.html', read: 0, created_at: H.NOW - 2 * H.H, want: 'my-groups', room: 'Kosofe Ward Volunteers' },
  { id: 503, kind: 'assignment', title: 'Your coordinator set your unit', body: 'Lagos Citizens Observer Network', url: 'https://hawkeye.com.ng/my-groups.html', read: 0, created_at: H.NOW - 3 * H.H, want: 'my-groups', room: 'Lagos Citizens Observer Network' },
  { id: 504, kind: 'group_role', title: 'You can now manage a room', body: 'Kano Volunteers', url: 'https://hawkeye.com.ng/room/kano-volunteers', read: 0, created_at: H.NOW - 4 * H.H, want: 'room', room: 'Kano Volunteers' },
  { id: 505, kind: 'room_label', title: 'Your room was verified', body: 'Adaeze 2027', url: 'https://hawkeye.com.ng/room/adaeze-2027', read: 0, created_at: H.NOW - 5 * H.H, want: 'room', room: 'Adaeze 2027' },
];

export async function flow4(H, { surfaces, langs }) {
  for (const surface of surfaces) {
    for (const lang of langs) {
      for (const n of NOTES(H)) {
        if (lang !== langs[0] && n.id !== 501 && n.id !== 504) continue; // the second language: two kinds
        if (!H.on('notes')) continue;
        if (surface === 'native') await nativeNote(H, lang, n); else await webNote(H, surface, lang, n);
      }
    }
  }
}

function noteServer(H) {
  const rooms = threeRooms(H);
  // The manager was just made manager of Kano Volunteers (33), and owns Adaeze (31), which sorts first.
  const s = H.roomServer({ member: [H.memberRow(), { ...H.INVITED_ROW }, H.memberRow({ id: 33, name: 'Kano Volunteers', slug: 'kano-volunteers', contest: 'GOV', scope: 'Kano', scope_label: 'Kano', manages: 'manager' })],
    managing: [rooms.managing[0], rooms.managing[2]], groupDetail: rooms.groupDetail, team: rooms.team,
    notifications: { items: NOTES(H).map(({ want, room, ...x }) => x), unread: 5 } });
  return s;
}

async function webNote(H, surface, lang, n) {
  const server = noteServer(H);
  const { ctx, page } = await H.open(surface, { lang, server });
  const R = H.recorder('4-notify', surface, lang, 's360', n.kind);
  try {
    await H.gotoWeb(page, '/notifications.html', lang);
    await page.waitForSelector(`[data-id="${n.id}"]`, { timeout: 15000 }).catch(() => {});
    await H.sleep(600);
    const f1 = await R.step(page, 'notifications', { screen: 'notifications.html', asked: `tap "${n.title}"` });
    // What the tap does: on the web it is location.href = n.url. In Lite (served
    // from https://localhost on a phone) an absolute hawkeye.com.ng url is a
    // DIFFERENT origin — record the target before following it.
    const navTarget = new Promise((res) => {
      page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) res(fr.url()); });
      setTimeout(() => res(null), 15000);
    });
    await page.locator(`[data-id="${n.id}"]`).click();
    const target = await navTarget;
    await page.waitForLoadState('load').catch(() => {});
    await H.webLang(page, lang);
    if (n.want === 'room') {
      await page.waitForURL(/situation-room\.html/, { timeout: 15000 }).catch(() => {});
      await page.waitForSelector('.sr-bar h1', { timeout: 15000 }).catch(() => {});
    } else await H.waitText(page, n.room, 12000);
    await H.sleep(1500);
    const h1 = (await page.locator('.sr-bar h1').innerText().catch(() => '')).trim();
    const f2 = await R.step(page, 'landed', { screen: n.want === 'room' ? `situation-room.html: ${h1}` : 'my-groups.html', tap: n.title, note: `navigated to ${target}` });
    if (n.want === 'room') {
      const wrong = h1 && h1 !== n.room;
      if (H.check(`4:right-room:${n.kind}:${surface}:${lang}`, { flagged: wrong || !h1, detail: `notification about "${n.room}" opened "${h1}"`, control: n.kind === 'room_label' ? 'this IS the control: room_label carries /room/<slug>' : '4:right-room:room_label', evidence: [f2] }) && n.kind === 'group_role') {
        H.finding({ id: 'R-ROLE-NOTE-WRONG-ROOM', flow: '4-notify', severity: 'P2', surfaces: [surface],
          title: '"You can now manage a room" opens whichever room sorts first, not the one you were given',
          actual: `The group_role notification links to /situation-room.html with no room; the room opens the first room in the list (managed rooms by creation date). A manager of "Adaeze 2027" made manager of "${n.room}" lands on "${h1}" and has to find the switcher. (room_label notifications carry /room/<slug> and land right.)`,
          expected: 'The notification opens the room it is about: /room/<slug>.',
          evidence: [H.ev(f2)], source: 'backend/src/routes/groups.js:1916-1922 (url: situation-room.html, no slug); app/situation-room.html:4095',
          fix: "url: 'https://hawkeye.com.ng/room/' + encodeURIComponent(req.group.slug)." });
      }
    } else {
      const t = await H.text(page);
      H.check(`4:lands-my-groups:${n.kind}:${surface}:${lang}`, { flagged: !t.includes(n.room), detail: `landed ${page.url()}`, evidence: [f2] });
    }
    if (surface === 'lite' && target && /^https:\/\/hawkeye\.com\.ng\//.test(target)) {
      H.check(`4:lite-absolute-url:${n.kind}:${lang}`, { flagged: true, detail: `Lite navigates to the absolute ${target}; on a phone Lite is https://localhost, and Capacitor opens other hosts outside the app`, evidence: [f1, f2] });
      H.finding({ id: 'R-LITE-NOTE-LEAVES-APP', flow: '4-notify', severity: 'P1', surfaces: ['lite'],
        title: 'Lite: tapping a room notification leaves the app for the (signed-out) website',
        actual: 'notifications.html (and the push tap in native.js) does location.href = n.url, and every room notification url is absolute (https://hawkeye.com.ng/my-groups.html, /situation-room.html, /room/<slug>). Lite runs from https://localhost with no allowNavigation, and Capacitor 8 Bridge.launchIntent() hands any other host to the system (ACTION_VIEW) — the browser, signed out, or the native app if it claims the path. The in-app My Groups / room is never reached. In this harness Lite is served from hawkeye.com.ng, so the hop cannot be seen; the target url is recorded.',
        expected: 'A url on hawkeye.com.ng is opened as the bundled page (strip the origin, as native.js already does for /join and /open deep links).',
        evidence: [H.ev(f1), H.ev(f2)], source: 'app/notifications.html:557 + 565-566; app/native.js:849; mobile/capacitor.config.json (no server.allowNavigation); mobile/node_modules/@capacitor/android/.../Bridge.java:389-420',
        fix: 'In Lite, rewrite https://hawkeye.com.ng/<path> to /<path> before navigating (one helper used by notifications.html and the push tap).', needsDevice: true });
    }
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

async function nativeNote(H, lang, n) {
  const server = noteServer(H);
  const { ctx, page } = await H.open('native', { lang, server });
  const R = H.recorder('4-notify', 'native', lang, 's360', n.kind);
  try {
    await H.gotoNative(page, '/alerts');
    await H.waitText(page, n.title, 15000);
    const f1 = await R.step(page, 'alerts', { screen: '(tabs)/alerts', asked: `tap "${n.title}"` });
    await page.getByText(n.title, { exact: true }).first().click().catch(() => {});
    await H.sleep(3000);
    const url = new URL(page.url()).pathname;
    const t = await H.text(page);
    const f2 = await R.step(page, 'landed', { screen: url, tap: n.title, note: `room "${n.room}" visible: ${t.includes(n.room)}` });
    H.check(`4:native-lands:${n.kind}:${lang}`, { flagged: !/my-groups/.test(url) || !t.includes(n.room), detail: `landed ${url}; room visible ${t.includes(n.room)}`, evidence: [f2] });
    if (n.want === 'room') {
      // The room is web-only on native (owner decision): My Groups' "Open situation room" → a share sheet.
      const btn = await H.ntap(page, H.nt(lang, 'my-groups.open-room'), { first: true });
      await H.sleep(1200);
      const f3 = await R.step(page, 'room-button', { screen: 'ConfirmSheet (room is on a computer)', tap: H.nt(lang, 'my-groups.open-room'), note: btn ? (await H.text(page)).split('\n').filter((x) => /computer|kwamfuta|http/i.test(x)).slice(0, 2).join(' / ').slice(0, 220) : 'no room button' });
    }
  } catch (e) { R.rec.error = String(e.message || e).slice(0, 300); }
  await ctx.close();
}

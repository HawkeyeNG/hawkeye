// Hawkeye FUNCTIONAL test suite — drives the real UI in a real browser against a
// LOCAL backend and asserts that features actually work (auth, dashboard,
// profile, navigation, page health). Complements:
//   backend/scripts/smoke_test.js  — API/ledger/attack-rejection contract
//   audit/full_audit.mjs           — a11y/contrast/Lighthouse/links
//
// Never point this at production: it registers observers and writes data.
//   cd ~/hawkeye/backend && SMS_PROVIDER=console node src/server.js   # terminal 1
//   cd ~/hawkeye/audit && node functional_test.mjs                    # terminal 2
//
// (Written against the plain Playwright library on purpose — the @playwright/test
// runner exits silently in this WSL/Node environment.)
import crypto from 'node:crypto';
import { chromium, devices } from 'playwright';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8430';
if (/hawkeye\.com\.ng/.test(BASE)) { console.error('refusing to run against production'); process.exit(1); }

// ---- tiny harness ----------------------------------------------------------
let pass = 0; const failures = [];
let current = '';
const t = async (name, fn) => {
  current = name;
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(`${name} — ${e.message.split('\n')[0]}`); console.log(`  FAIL  ${name}\n        ${e.message.split('\n')[0]}`); }
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg || 'mismatch'} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const section = (s) => console.log(`\n-- ${s} --`);

// ---- identity helpers (same path the app uses) -----------------------------
const randPhone = () => '0803' + String(crypto.randomInt(1000000, 9999999));
const randDevice = () => crypto.randomBytes(32).toString('hex');
const newJwk = async () => {
  const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
};
async function makeObserver({ password = null } = {}) {
  const phone = randPhone();
  // Deliberately mint WITHOUT an x-device-id so the JWT carries no `did` claim:
  // the token is then device-agnostic, and requireObserver's device-binding
  // check is skipped. (A real user's token is minted in-browser bound to their
  // getDeviceId; injecting a token bound to a different device would trip
  // device_mismatch. Device binding itself is covered by the API smoke test.)
  const h = { 'content-type': 'application/json' };
  let r = await fetch(BASE + '/api/observers/register', { method: 'POST', headers: h, body: JSON.stringify({ phone }) });
  const reg = await r.json();
  if (!reg.devOtp) throw new Error('backend must run with SMS_PROVIDER=console (no devOtp)');
  r = await fetch(BASE + '/api/observers/verify', { method: 'POST', headers: h, body: JSON.stringify({ phone, otp: reg.devOtp, publicKeyJwk: await newJwk() }) });
  const v = await r.json();
  if (!v.token) throw new Error('verify failed: ' + JSON.stringify(v));
  if (password) {
    const sp = await (await fetch(BASE + '/api/observers/set-password', {
      method: 'POST', headers: { ...h, authorization: 'Bearer ' + v.token }, body: JSON.stringify({ password }),
    })).json();
    if (!sp.ok) throw new Error('set-password failed: ' + JSON.stringify(sp));
  }
  return { phone, token: v.token, observerId: v.observerId };
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const newCtx = async (token) => {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.addInitScript(() => { try { navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())); } catch {} });
  if (token) await ctx.addInitScript((tk) => localStorage.setItem('hawkeye_token', tk), token);
  return ctx;
};
// Sign in WITHOUT an init script, so an in-app sign-out/delete that clears the
// token stays cleared (addInitScript would re-inject it on the next navigation).
// Use for tests that sign out or delete the identity.
const signInNoReinject = async (page, token) => {
  await page.goto(BASE + '/index.html');
  await page.evaluate((t) => localStorage.setItem('hawkeye_token', t), token);
};
// capture the next alert() and return its text
const nextDialog = (page) => new Promise((res) => page.once('dialog', async (d) => { const m = d.message(); await d.dismiss(); res(m); }));

console.log(`Hawkeye functional tests against ${BASE}`);

// ============================ AUTH =========================================
section('auth');

await t('OTP registration signs in and lands on the dashboard', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.fill('#auth-input', randPhone());
  await page.click('#btn-auth');
  await page.waitForFunction(() => /\d{6}/.test(document.getElementById('otp-hint').textContent));
  const otp = (await page.textContent('#otp-hint')).match(/\d{6}/)[0];
  await page.fill('#auth-input', otp);
  await page.click('#btn-auth');
  await page.waitForURL('**/index.html', { timeout: 15000 });
  ok((await page.textContent('#home-greet')).includes('Welcome back'), 'no dashboard greeting');
  ok(await page.evaluate(() => !!localStorage.getItem('hawkeye_token')), 'no token stored');
  await ctx.close();
});

await t('optional password at sign-up is actually set', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.fill('#auth-input', randPhone());
  await page.click('#btn-auth');
  await page.waitForFunction(() => /\d{6}/.test(document.getElementById('otp-hint').textContent));
  const otp = (await page.textContent('#otp-hint')).match(/\d{6}/)[0];
  ok(await page.isVisible('#pw-opt'), 'password checkbox not shown at OTP step');
  await page.check('#pw-opt-check');
  ok(await page.isVisible('#pw-opt-field'), 'checkbox did not reveal the field');
  await page.fill('#pw-opt-input', 'e2e-signup-pass');
  await page.fill('#auth-input', otp);
  await page.click('#btn-auth');
  await page.waitForURL('**/index.html', { timeout: 15000 });
  const has = await page.evaluate(async () => (await (await fetch('/api/observers/me', { headers: { authorization: 'Bearer ' + localStorage.getItem('hawkeye_token') } })).json()).hasPassword);
  eq(has, true, 'password was not set at sign-up');
  await ctx.close();
});

await t('short sign-up password is blocked before the OTP is spent', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.fill('#auth-input', randPhone());
  await page.click('#btn-auth');
  await page.waitForFunction(() => /\d{6}/.test(document.getElementById('otp-hint').textContent));
  const otp = (await page.textContent('#otp-hint')).match(/\d{6}/)[0];
  await page.check('#pw-opt-check');
  await page.fill('#pw-opt-input', 'short');
  await page.fill('#auth-input', otp);
  const dlg = nextDialog(page);
  await page.click('#btn-auth');
  ok(/8 characters/.test(await dlg), 'no length warning');
  ok(await page.isVisible('#screen-register'), 'left the register screen anyway');
  await ctx.close();
});

await t('password sign-in works on a new device (phone + password together)', async () => {
  const { phone } = await makeObserver({ password: 'e2e-login-pass' });
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.click('#pw-link');
  ok(await page.isVisible('#pw-signin-wrap'), 'password pane did not appear');
  eq(await page.textContent('#btn-auth'), 'Sign In', 'button label');
  eq(await page.textContent('#pw-link'), 'Sign in with OTP', 'link label');
  await page.fill('#auth-input', phone);
  await page.fill('#pw-signin-input', 'e2e-login-pass');
  await page.click('#btn-auth');
  await page.waitForURL('**/index.html', { timeout: 15000 });
  ok((await page.textContent('#home-greet')).includes('Welcome back'), 'did not reach dashboard');
  await ctx.close();
});

await t('password link toggles back to the OTP flow', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.click('#pw-link');
  ok(await page.isVisible('#pw-signin-wrap'), 'pane not shown');
  await page.click('#pw-link');
  ok(!(await page.isVisible('#pw-signin-wrap')), 'pane did not hide');
  eq(await page.textContent('#btn-auth'), 'Request OTP', 'button did not revert');
  await ctx.close();
});

await t('wrong password is rejected and points at OTP recovery', async () => {
  const { phone } = await makeObserver({ password: 'e2e-right-pass' });
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.click('#pw-link');
  await page.fill('#auth-input', phone);
  await page.fill('#pw-signin-input', 'e2e-WRONG-pass');
  const dlg = nextDialog(page);
  ok(/wrong password|forgot/i.test(await (await page.click('#btn-auth'), dlg)), 'no rejection message');
  ok(!(await page.evaluate(() => localStorage.getItem('hawkeye_token'))), 'signed in with a wrong password!');
  await ctx.close();
});

await t('OTP-only account cannot use password sign-in', async () => {
  const { phone } = await makeObserver();
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.click('#pw-link');
  await page.fill('#auth-input', phone);
  await page.fill('#pw-signin-input', 'anything-at-all');
  const dlg = nextDialog(page);
  ok(/no password|OTP/i.test(await (await page.click('#btn-auth'), dlg)), 'no guidance shown');
  await ctx.close();
});

await t('?intent=observe keeps the user in the report flow', async () => {
  const { phone } = await makeObserver({ password: 'e2e-intent-pass' });
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/observe.html?intent=observe');
  await page.waitForSelector('#screen-register:not([hidden])');
  await page.click('#pw-link');
  await page.fill('#auth-input', phone);
  await page.fill('#pw-signin-input', 'e2e-intent-pass');
  await page.click('#btn-auth');
  await page.waitForSelector('#screen-locate:not([hidden])', { timeout: 15000 });
  ok(page.url().includes('observe.html'), 'was ejected to the dashboard mid-task');
  await ctx.close();
});

// ============================ HOME =========================================
section('observer home / dashboard');

await t('signed-out visitors get the landing page', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  ok(await page.isVisible('.hero h1'), 'landing hero missing');
  ok(!(await page.isVisible('.home-obs')), 'dashboard leaked to a signed-out visitor');
  await ctx.close();
});

await t('signed-in observers get the dashboard with 4 quick actions', async () => {
  const { token, observerId } = await makeObserver();
  const ctx = await newCtx(token); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => !document.getElementById('home-greet').textContent.endsWith('back'));
  ok(await page.isVisible('.home-obs'), 'dashboard not shown');
  ok(!(await page.isVisible('.hero')), 'landing page still visible');
  ok((await page.textContent('#home-greet')).includes(`Observer #${observerId}`), 'greeting lacks observer id');
  eq(await page.locator('.qa').count(), 4, 'quick action count');
  ok((await page.getAttribute('.qa.primary', 'href')).includes('observe.html'), 'primary action misrouted');
  await ctx.close();
});

await t('no-unit prompt links to Map a Polling Unit', async () => {
  const { token } = await makeObserver();
  const ctx = await newCtx(token); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.waitForSelector('#home-unit-chip');
  ok((await page.textContent('#home-unit-chip')).includes('No polling unit saved'), 'chip text');
  eq(await page.getAttribute('#home-unit-chip', 'href'), 'map-unit.html', 'chip target');
  await ctx.close();
});

await t('a dead session falls back to the landing page and clears the token', async () => {
  const ctx = await newCtx('not.a.real.token'); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => !document.documentElement.classList.contains('obs-home'), null, { timeout: 10000 });
  ok(await page.isVisible('.hero h1'), 'landing not restored');
  eq(await page.evaluate(() => localStorage.getItem('hawkeye_token')), null, 'dead token not cleared');
  await ctx.close();
});

// ============================ PROFILE ======================================
section('profile');

await t('shows identity, hash and empty activity lists', async () => {
  const { token, observerId } = await makeObserver();
  const ctx = await newCtx(token); const page = await ctx.newPage();
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#profile:not([hidden])');
  eq(await page.textContent('#p-id'), `#${observerId}`, 'observer id');
  ok(/^[0-9a-f]{64}$/.test(await page.textContent('#p-hash')), 'identity hash not a sha256');
  ok((await page.textContent('#p-unit')).includes('None saved'), 'unit state');
  ok((await page.textContent('#p-reports')).includes('No result reports yet'), 'reports state');
  await ctx.close();
});

await t('signed-out visitors are told to sign in', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#signed-out:not([hidden])');
  ok(!(await page.isVisible('#profile')), 'profile leaked to signed-out visitor');
  await ctx.close();
});

await t('a fresh OTP session sets a password and can reset it (recovery path)', async () => {
  // makeObserver's token is minted via OTP < 15 min ago, so it IS the
  // forgot-password reset path: setting and re-setting the password needs no
  // current password. This is by design (see /set-password in observers.js).
  const { token } = await makeObserver();
  const ctx = await newCtx(token); const page = await ctx.newPage();
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#profile:not([hidden])');
  ok((await page.textContent('#pw-state')).includes('No password yet'), 'initial state');
  await page.fill('#pw-new', 'e2e-profile-pass');
  await page.click('#btn-pw');
  await page.waitForFunction(() => /Password set/.test(document.getElementById('pw-msg').textContent));
  eq(await page.textContent('#btn-pw'), 'Change password', 'button did not switch');
  ok(await page.isVisible('#pw-current-wrap'), 'current-password field not revealed');

  // fresh-OTP session: a reset goes through even with a blank/irrelevant current field
  await page.fill('#pw-new', 'e2e-reset-pass');
  await page.click('#btn-pw');
  await page.waitForFunction(() => /Password changed/.test(document.getElementById('pw-msg').textContent));
  await ctx.close();
});

await t('a password-login session must supply the current password to change it', async () => {
  // Give the observer a password, then sign in WITH it to get a `via: pw` token —
  // NOT a fresh OTP proof — so the current-password requirement is enforced.
  const { phone } = await makeObserver({ password: 'e2e-orig-pass' });
  const jwk = await newJwk();
  const login = await (await fetch(BASE + '/api/observers/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password: 'e2e-orig-pass', publicKeyJwk: jwk }),
  })).json();
  ok(login.token, 'password login failed');

  const ctx = await newCtx(login.token); const page = await ctx.newPage();
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#profile:not([hidden])');
  ok(await page.isVisible('#pw-current-wrap'), 'has-password observer should see current-password field');

  // wrong current password is rejected
  await page.fill('#pw-current', 'wrong-current');
  await page.fill('#pw-new', 'e2e-new-pass-1');
  await page.click('#btn-pw');
  await page.waitForFunction(() => /current password/i.test(document.getElementById('pw-msg').textContent));

  // correct current password succeeds
  await page.fill('#pw-current', 'e2e-orig-pass');
  await page.fill('#pw-new', 'e2e-new-pass-1');
  await page.click('#btn-pw');
  await page.waitForFunction(() => /Password changed/.test(document.getElementById('pw-msg').textContent));
  await ctx.close();
});

await t('short password is rejected client-side', async () => {
  const { token } = await makeObserver();
  const ctx = await newCtx(token); const page = await ctx.newPage();
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#profile:not([hidden])');
  await page.fill('#pw-new', 'tiny');
  await page.click('#btn-pw');
  ok(/at least 8/.test(await page.textContent('#pw-msg')), 'no client-side length guard');
  await ctx.close();
});

await t('sign out clears the session', async () => {
  const { token } = await makeObserver();
  const ctx = await newCtx(); const page = await ctx.newPage();
  await signInNoReinject(page, token);
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#profile:not([hidden])');
  await page.click('#btn-signout');
  await page.waitForURL('**/index.html', { timeout: 15000 });
  eq(await page.evaluate(() => localStorage.getItem('hawkeye_token')), null, 'token survived sign-out');
  await ctx.close();
});

await t('delete identity kills the session server-side', async () => {
  const { token } = await makeObserver();
  const ctx = await newCtx(); const page = await ctx.newPage();
  await signInNoReinject(page, token);
  await page.goto(BASE + '/profile.html');
  await page.waitForSelector('#profile:not([hidden])');
  page.on('dialog', (d) => d.accept());
  await page.click('#btn-delete');
  await page.waitForURL('**/index.html', { timeout: 15000 });
  const status = await page.evaluate(async (tk) => (await fetch('/api/observers/me', { headers: { authorization: 'Bearer ' + tk } })).status, token);
  eq(status, 401, 'deleted identity still authenticates');
  await ctx.close();
});

// ============================ PAGE HEALTH ==================================
section('page health');

const PAGES = [
  ['/index.html', /witnessed and unchangeable/i], ['/results.html', /National leaderboard/i],
  ['/dashboard.html', /Live polling unit reports/i], ['/ledger.html', /Verify the Ledger/i],
  ['/integrity.html', /Election Integrity/i], ['/docket.html', /Public Docket/i],
  ['/incidents.html', /Report an Incident/i], ['/collation.html', /Collation/i],
  ['/map-unit.html', /Map a Polling Unit/i], ['/candidates.html', /Candidates/i],
  ['/political.html', /Political Data/i], ['/how.html', /How Hawkeye/i],
  ['/guide.html', /Guide/i], ['/faq.html', /Question|FAQ/i], ['/privacy.html', /Privacy/i],
  ['/about.html', /About/i], ['/terms.html', /Terms/i],
];
{
  const ctx = await newCtx(); const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${current}: ${e.message}`));
  for (const [p, heading] of PAGES) {
    await t(`${p} loads, renders and stays inside the viewport`, async () => {
      errs.length = 0;
      // domcontentloaded (not networkidle): pages with live maps / auto-refresh
      // never reach network-idle. h1s are static markup, ready immediately.
      const resp = await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
      ok(resp.status() < 400, `HTTP ${resp.status()}`);
      // the VISIBLE h1 — index.html carries a hidden dashboard <h1> first in source.
      const h1 = await page.locator('h1:visible').first().textContent();
      ok(heading.test(h1), `h1 "${h1}" !~ ${heading}`);
      ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), 'horizontal overflow');
      await page.waitForTimeout(400); // let any late scripts throw
      eq(errs.length, 0, 'JS errors: ' + errs.join(' | '));
    });
  }
  await t('/404 unknown route returns 404 with a page', async () => {
    const r = await page.goto(BASE + '/definitely-not-real.html');
    eq(r.status(), 404, 'status');
    ok(await page.isVisible('h1'), 'no 404 heading');
  });
  await t('case.html handles a missing case with no empty skeletons', async () => {
    await page.goto(BASE + '/case.html?id=99999999', { waitUntil: 'networkidle' });
    eq(await page.textContent('#title'), 'Case not found', 'title');
    eq(await page.locator('.card:visible').count(), 0, 'skeleton cards left visible');
  });
  await ctx.close();
}

// ============================ NAVIGATION ===================================
section('navigation');

await t('menu exposes the full link set and every target resolves', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  const hrefs = await page.$$eval('#menu-panel a', (as) => as.map((a) => a.getAttribute('href')));
  for (const key of ['observe.html', 'collation.html', 'incidents.html', 'map-unit.html', 'ledger.html', 'docket.html', 'integrity.html']) {
    ok(hrefs.includes(key), `menu missing ${key}`);
  }
  for (const h of [...new Set(hrefs)].filter((x) => x && !/^https?:/.test(x))) {
    const r = await page.request.get(BASE + '/' + h.replace(/^\//, ''));
    ok(r.status() < 400, `${h} -> ${r.status()}`);
  }
  await ctx.close();
});

await t('signed-in menu gains Dashboard + My Profile above Sign out (no Delete my ID)', async () => {
  const { token } = await makeObserver();
  const ctx = await newCtx(token); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  // the sign-out link lives inside the CLOSED (hidden) dropdown — wait for it to
  // be attached, not visible.
  await page.waitForSelector('#menu-panel a.sign-out', { state: 'attached' });
  const labels = await page.$$eval('#menu-panel a', (as) => as.map((a) => a.textContent.trim()));
  for (const l of ['Dashboard', 'My Profile', 'Sign out']) ok(labels.includes(l), `menu missing ${l}`);
  ok(labels.indexOf('My Profile') < labels.indexOf('Sign out'), 'My Profile must sit above Sign out');
  ok(!labels.includes('Delete my ID'), 'Delete my ID should live on the profile page only');
  await ctx.close();
});

await t('signed-out menu has no account links', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  const labels = await page.$$eval('#menu-panel a', (as) => as.map((a) => a.textContent.trim()));
  ok(!labels.includes('Sign out') && !labels.includes('My Profile'), 'account links leaked when signed out');
  await ctx.close();
});

await t('theme toggle switches and persists across reloads', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  await page.goto(BASE + '/index.html');
  await page.click('.theme-btn');
  eq(await page.getAttribute('html', 'data-theme'), 'dark', 'theme not applied');
  eq(await page.evaluate(() => localStorage.getItem('hawkeye_theme')), 'dark', 'theme not persisted');
  await page.reload();
  eq(await page.getAttribute('html', 'data-theme'), 'dark', 'theme not restored after reload');
  await ctx.close();
});

await t('gated pages prompt signed-out users to register', async () => {
  const ctx = await newCtx(); const page = await ctx.newPage();
  for (const p of ['/incidents.html', '/map-unit.html']) {
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /register your device/i.test(document.body.textContent), null, { timeout: 15000 });
  }
  await ctx.close();
});

await browser.close();

console.log(`\n==== ${pass} passed, ${failures.length} failed ====`);
if (failures.length) { console.log(failures.map((f) => ' ✗ ' + f).join('\n')); process.exitCode = 1; }

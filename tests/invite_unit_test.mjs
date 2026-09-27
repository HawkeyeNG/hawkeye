/**
 * "BRING A SECOND OBSERVER TO YOUR UNIT."
 *
 * Two things must hold, and each has failed before in a sibling feature:
 *
 *  1. THE LINK NAMES THE LIVE SITE. Hawkeye Lite serves these very files from
 *     https://localhost, and an invite built from location.origin once pointed
 *     at the sender's own phone. So the page is served here from 127.0.0.1 — a
 *     device-local origin of the same kind — and the COPIED text is checked,
 *     not the source. CONTROL: the same check flags a link built from
 *     location.origin.
 *
 *  2. THE UNIT ARRIVES SELECTED. invite.html?ref=…&unit=… → sign-up →
 *     choose-unit.html?onboard=1 opens with that unit picked (not saved).
 *     CONTROL: the same page with no invitation picks nothing.
 *
 * Plus: the Profile row only with a unit saved; the after-save offer only
 * ONCE; never after a real result (native and web source checks); and the
 * native More tab's coverage link.
 */
import { createRequire, stripTypeScriptTypes } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const LIVE = 'https://hawkeye.com.ng';
const CODE = 'ABCDEF';
const MINE = { pu_code: '37-06-02-141', name: 'Wonderland Estate', ward: 'Garki', lga: 'Municipal', state: 'FCT' };
const THEIRS = { pu_code: '37-06-01-105', name: 'No 20 Ogbomosho Street', ward: 'City Centre', lga: 'Municipal', state: 'FCT' };

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

/** The rule under test, as one predicate: an invite to THIS unit, on the live
 *  origin, and no device-local address anywhere in what was sent. */
/*  /open?to=invite: the path both apps claim, so the link opens an installed
 *  app on sign-up; in a browser open/index.html forwards it to invite.html. */
const liveInvite = (text, unit) => typeof text === 'string'
  && text.includes(`${LIVE}/open?to=invite&ref=${CODE}&unit=${unit}`)
  && !/localhost|127\.0\.0\.1|capacitor:|file:/.test(text);

// ---------------------------------------------------------------------------
console.log('=== native + web source: where it may and may not appear ===');
{
  const lib = fs.readFileSync(`${ROOT}/native/src/lib/invite-unit.ts`, 'utf8');
  check('native builds from a written-out live origin', /INVITE_ORIGIN = 'https:\/\/hawkeye\.com\.ng'/.test(lib), true);
  const fn = lib.slice(lib.indexOf('export function inviteUnitUrl'), lib.indexOf('export async function mySavedUnit'));
  const usesDeviceOrigin = (src) => /\bBASE\b|location\.origin|EXPO_PUBLIC_API_BASE/.test(src);
  check('and never from BASE / location', usesDeviceOrigin(fn), false);
  check('CONTROL the origin check flags a BASE-built link',
    usesDeviceOrigin('export function inviteUnitUrl(c, p) { return `${BASE}/open?to=invite&ref=${c}`; }'), true);
  // The function itself, run: the new format, and a bad unit left off.
  const urlSrc = lib.slice(lib.indexOf('export const INVITE_ORIGIN'), lib.indexOf('/**', lib.indexOf('export function inviteUnitUrl')));
  const inviteUnitUrl = new Function(`${stripTypeScriptTypes(urlSrc, { mode: 'strip' }).replace(/^export /gm, '')}; return inviteUnitUrl;`)();
  check('native link: /open?to=invite with code + unit', inviteUnitUrl(CODE, THEIRS.pu_code),
    `${LIVE}/open?to=invite&ref=${CODE}&unit=${THEIRS.pu_code}`);
  check('native link: a malformed unit is left off', inviteUnitUrl(CODE, '37-06-01-1O5'), `${LIVE}/open?to=invite&ref=${CODE}`);
  check('native profile invite (lib/referral.ts) uses /open too',
    /const INVITE_BASE = 'https:\/\/hawkeye\.com\.ng\/open\?to=invite&ref=';/.test(fs.readFileSync(`${ROOT}/native/src/lib/referral.ts`, 'utf8')), true);

  const route = fs.readFileSync(`${ROOT}/native/src/app/choose-unit.tsx`, 'utf8');
  check('native /choose-unit reads ?unit= into the chooser', /prefillCode=\{typeof unit === 'string'/.test(route), true);
  const comp = fs.readFileSync(`${ROOT}/native/src/components/choose-unit.tsx`, 'utf8');
  check('and the chooser selects it without saving', /setPicked\(\(p\) => p \?\? \{ pu_code: invited/.test(comp), true);
  check('the after-save offer goes through the once-only gate', /inviteAfterSave\(unit\.pu_code, invited\)/.test(comp), true);

  const practice = fs.readFileSync(`${ROOT}/native/src/app/practice.tsx`, 'utf8');
  check('native practice completion shows the card', /<InviteUnitCard \/>/.test(practice), true);
  const profile = fs.readFileSync(`${ROOT}/native/src/app/profile.tsx`, 'utf8');
  check('native Profile offers it only with a saved unit', /savedUnit && referral && isUnitCode\(savedUnit\.pu_code\)/.test(profile), true);

  // NOT after a real result: that count is already over.
  const tsx = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsx(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const mentions = (f) => /invite-unit|InviteUnitCard|n\.invite2\./.test(fs.readFileSync(f, 'utf8'));
  const reportFiles = tsx(`${ROOT}/native/src/app/report`);
  check('the scan sees the native report screens', reportFiles.length, (n) => n >= 3);
  check('no native report screen offers it', reportFiles.filter(mentions).map((f) => path.basename(f)), []);
  check('CONTROL the scan catches a planted use', mentions(`${ROOT}/native/src/app/practice.tsx`), true);
  const webReport = ['observe.html', 'app.js', 'collation.html'].map((f) => fs.readFileSync(`${APP}/${f}`, 'utf8')).join('\n');
  check('no web report page loads or calls it', /invite-unit\.js|HawkeyeInviteUnit/.test(webReport), false);

  const more = fs.readFileSync(`${ROOT}/native/src/app/(tabs)/more.tsx`, 'utf8');
  check('More lists Observer coverage', /labelKey: 'coverage\.observer-coverage', href: 'coverage\.html'/.test(more), true);
  check('and a non-native row opens the live site in the in-app browser',
    /WebBrowser\.openBrowserAsync\(`https:\/\/hawkeye\.com\.ng\/\$\{it\.href\}`\)/.test(more), true);

  // Sign-up must actually carry the invite code: observe.html runs app.js,
  // which reads window.HAWKEYE_REFERRAL — defined only by referral.js.
  const observe = fs.readFileSync(`${APP}/observe.html`, 'utf8');
  check('the sign-up page loads referral.js', /<script src="referral\.js\?v=\d+"><\/script>/.test(observe), true);
}

// ---------------------------------------------------------------------------
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const S = { unit: MINE, referral: { code: CODE, signedUp: 0, qualified: 0 }, posts: [] };
const server = http.createServer((req, res) => {
  const [url, q = ''] = req.url.split('?');
  const json = (v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url === '/api/observers/me') {
    return json({ observerId: 1, createdAt: Date.now(), identityHash: 'abc', hasPassword: true, unit: S.unit });
  }
  if (url === '/api/observers/referral') return json(S.referral);
  if (url === '/api/observers/my-unit' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; });
    return req.on('end', () => { S.posts.push(JSON.parse(b).puCode); json({ ok: true }); });
  }
  if (url === '/api/observers/my-unit') return json({ ok: true, unit: S.unit });
  if (url === '/api/register/unit') {
    const code = new URLSearchParams(q).get('pu_code');
    const u = [MINE, THEIRS].find((x) => x.pu_code === code);
    return u ? json({ unit: u }) : json({ error: 'not_found' }, 404);
  }
  if (url === '/api/register/search') return json({ truncated: false, units: [THEIRS] });
  if (url === '/api/practice') return json({ active: false });
  if (url.startsWith('/api/')) return json({});
  let f = path.join(APP, decodeURIComponent(url));
  /* A directory, as the live site serves /open: 301 to the slash form (query
     kept), then its index.html. */
  if (f.startsWith(APP) && fs.existsSync(f) && fs.statSync(f).isDirectory() && fs.existsSync(path.join(f, 'index.html'))) {
    if (!url.endsWith('/')) { res.writeHead(301, { location: `${url}/${q ? `?${q}` : ''}` }); return res.end(); }
    f = path.join(f, 'index.html');
  }
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
// See choose_unit_test.mjs: reduced motion stops headless Chromium stalling
// after a cross-document view transition.
const ctxOpts = { viewport: { width: 390, height: 780 }, reducedMotion: 'reduce' };
/** A context whose clipboard RECORDS what was written, signed in or not. */
async function context({ signedIn = true } = {}) {
  const ctx = await b.newContext(ctxOpts);
  await ctx.addInitScript((si) => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => ({ writeText: (t) => { window.__copied.push(String(t)); return Promise.resolve(); } }),
    });
    try {
      localStorage.setItem('hawkeye_lang_prompted', '1');
      if (si) {
        const body = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }));
        localStorage.setItem('hawkeye_token', 'hdr.' + body + '.sig');
      }
    } catch (e) { /* about:blank */ }
  }, signedIn);
  return ctx;
}
const copied = (p) => p.evaluate(() => window.__copied.slice());

console.log(`\n=== the copied link names the live site (page served from ${base}) ===`);
check('CONTROL the rule flags a link built from location.origin',
  liveInvite(`${base}/open?to=invite&ref=${CODE}&unit=${MINE.pu_code}`, MINE.pu_code), false);
check('CONTROL the rule flags the old invite.html form (it opens no app)',
  liveInvite(`x ${LIVE}/invite.html?ref=${CODE}&unit=${MINE.pu_code}`, MINE.pu_code), false);
check('CONTROL and passes the real thing', liveInvite(`x ${LIVE}/open?to=invite&ref=${CODE}&unit=${MINE.pu_code}`, MINE.pu_code), true);

console.log('\n=== (b) Profile: next to My Polling Unit, only with a unit saved ===');
{
  S.unit = MINE;
  const ctx = await context();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/profile.html`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  const row = await p.evaluate(() => {
    const b = document.getElementById('btn-invite-unit');
    // RENDERED, not the attribute: .prow sets display:flex, which beats [hidden].
    return { shown: !!b && b.getClientRects().length > 0, after: b?.previousElementSibling?.id };
  });
  check('the row shows with a unit saved', row.shown, true);
  check('directly under My Polling Unit', row.after, 'btn-pick-unit');
  await p.click('#btn-invite-unit');
  await p.waitForTimeout(400);
  const c = await copied(p);
  check('tapping it copies an invite to THIS unit on the live site', liveInvite(c[0], MINE.pu_code), true);
  check('carrying only code and unit code — no names', /Wonderland|Observer #/.test(c[0] || ''), false);
  check('and says it copied', await p.evaluate(() => document.getElementById('p-invite-unit').textContent), 'Copied');
  check('no page error', errs.slice(0, 2), []);
  await ctx.close();

  S.unit = null;   // CONTROL: none saved
  const ctx2 = await context();
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}/profile.html`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(500);
  check('CONTROL with no unit saved the row is not drawn',
    await p2.evaluate(() => document.getElementById('btn-invite-unit').getClientRects().length), 0);
  // …and that measure can fail: without the page's .prow[hidden] rule, .prow's
  // display:flex draws a [hidden] row anyway (the trap this page had).
  await p2.addStyleTag({ content: '.prow[hidden] { display: flex !important; }' });
  check('CONTROL the measure sees a [hidden] row that CSS still draws',
    await p2.evaluate(() => document.getElementById('btn-invite-unit').getClientRects().length), (n) => n > 0);
  await ctx2.close();
  S.unit = MINE;
}

console.log('\n=== (a) practice completion card ===');
{
  const ctx = await context();
  const p = await ctx.newPage();
  await p.goto(`${base}/practice.html`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  // #done is hidden until a run finishes, so nothing in it has a box yet:
  // computed display is what says whether each part WOULD draw.
  const card = await p.evaluate((src) => {
    const shows = new Function('id', src);
    return {
    shown: shows('iu-card'),
    inDone: !!document.getElementById('iu-card').closest('#done'),
    btn: shows('iu-btn') && !shows('iu-choose'),
    unit: document.getElementById('iu-unit').textContent,
  };
  }, "return getComputedStyle(document.getElementById(id)).display !== 'none';");
  check('the card is filled for a signed-in observer', card.shown && card.btn, true);
  check('on the completion screen only', card.inDone, true);
  check('naming their SAVED unit', /Wonderland Estate/.test(card.unit) && card.unit.includes(MINE.pu_code), true);
  // The card lives in #done, which is hidden until a practice run finishes.
  await p.evaluate(() => document.getElementById('iu-btn').click());
  await p.waitForTimeout(400);
  check('its button copies the live invite', liveInvite((await copied(p))[0], MINE.pu_code), true);
  await ctx.close();

  const ctx2 = await context({ signedIn: false });
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}/practice.html`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(400);
  check('CONTROL signed out: no card',
    await p2.evaluate(() => getComputedStyle(document.getElementById('iu-card')).display), 'none');
  await ctx2.close();
}

console.log('\n=== invite.html shows the unit and carries it on ===');
{
  const ctx = await context({ signedIn: false });
  const p = await ctx.newPage();
  await p.goto(`${base}/invite.html?ref=${CODE}&unit=${THEIRS.pu_code}`, { waitUntil: 'networkidle' });
  const v = await p.evaluate(() => ({
    shown: document.getElementById('g-unitwrap').getClientRects().length > 0,
    name: document.getElementById('g-unit-name').textContent,
    web: document.getElementById('g-web').getAttribute('href'),
    parked: localStorage.getItem('hawkeye_invite_unit'),
    code: localStorage.getItem('hawkeye_referral'),
  }));
  check('the invited unit is printed', [v.shown, v.name], [true, THEIRS.name]);
  check('"continue in this browser" goes to sign-up with code and unit', v.web, `/observe.html?intent=observe&ref=${CODE}&unit=${THEIRS.pu_code}`);
  check('referral.js parks both', [v.code, v.parked], [CODE, THEIRS.pu_code]);
  await p.goto(`${base}/invite.html?ref=${CODE}`, { waitUntil: 'networkidle' });
  check('CONTROL an invite with no unit prints none',
    await p.evaluate(() => document.getElementById('g-unitwrap').getClientRects().length), 0);
  check('and the same code keeps the parked unit', await p.evaluate(() => localStorage.getItem('hawkeye_invite_unit')), THEIRS.pu_code);
  await p.goto(`${base}/invite.html?ref=HJKMNP`, { waitUntil: 'networkidle' });
  check('a DIFFERENT invite without a unit clears it', await p.evaluate(() => localStorage.getItem('hawkeye_invite_unit')), null);
  await p.goto(`${base}/invite.html?ref=${CODE}&unit=37-06-01-1O5`, { waitUntil: 'networkidle' });
  check('a malformed unit is dropped, not guessed', await p.evaluate(() => localStorage.getItem('hawkeye_invite_unit')), null);
  await ctx.close();
}

console.log('\n=== "Continue in this browser" → the create-account form ===');
{
  const ctx = await context({ signedIn: false });
  const p = await ctx.newPage();
  await p.goto(`${base}/invite.html?ref=${CODE}&unit=${THEIRS.pu_code}`, { waitUntil: 'networkidle' });
  await Promise.all([p.waitForURL(/observe\.html/, { timeout: 8000 }).catch(() => {}), p.click('#g-web')]);
  await p.waitForLoadState('networkidle').catch(() => {});
  const s = await p.evaluate(() => ({
    path: location.pathname,
    field: !!document.getElementById('ref-input') && !document.getElementById('ref-input').closest('[hidden]'),
    value: document.getElementById('ref-input') ? document.getElementById('ref-input').value : null,
    unit: localStorage.getItem('hawkeye_invite_unit'),
    signin: document.documentElement.classList.contains('intent-signin'),
  }));
  check('lands on the sign-up form, not home', [s.path, s.signin], ['/observe.html', false]);
  check('the invite field is shown and holds the code', [s.field, s.value], [true, CODE]);
  check('the unit is parked for the chooser', s.unit, THEIRS.pu_code);
  await ctx.close();

  const ctx2 = await context({ signedIn: true });   // CONTROL: already signed in
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}/invite.html?ref=${CODE}&unit=${THEIRS.pu_code}`, { waitUntil: 'networkidle' });
  check('CONTROL signed in: nothing to sign up for, home', await p2.evaluate(() => document.getElementById('g-web').getAttribute('href')), '/');
  await ctx2.close();
}

console.log('\n=== /open?to=invite in a browser → invite.html, same params ===');
{
  /** Where a page load of `u` finally settles (open/index.html replaces itself). */
  async function landsOn(u, { signedIn = false, lite = false } = {}) {
    const ctx = await context({ signedIn });
    if (lite) await ctx.addInitScript(() => { window.Capacitor = { isNativePlatform: () => true }; });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    let loads = 0;
    p.on('load', () => { loads++; });
    // A page that reloads itself forever never fires a settled 'load' for
    // goto — that is a FAIL to report below, not a crash.
    await p.goto(u, { waitUntil: 'commit', timeout: 8000 }).catch(() => {});
    await p.waitForURL((x) => !/\/open\/?(index\.html)?$/.test(new URL(x).pathname), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(600);
    const out = { path: new URL(p.url()).pathname, q: Object.fromEntries(new URL(p.url()).searchParams), loads, errs };
    if (out.path === '/invite.html') {
      await p.waitForLoadState('load').catch(() => {});
      out.unitShown = await p.evaluate(() => document.getElementById('g-unitwrap').getClientRects().length > 0).catch(() => null);
    }
    await ctx.close();
    return out;
  }
  const w = await landsOn(`${base}/open?to=invite&ref=${CODE}&unit=${THEIRS.pu_code}`);
  check('a browser lands on invite.html', w.path, '/invite.html');
  check('with ref + unit, and no `to`', w.q, { ref: CODE, unit: THEIRS.pu_code });
  check('which prints the invited unit', w.unitShown, true);
  check('no page error', w.errs, []);
  const signedInWeb = await landsOn(`${base}/open?to=invite&ref=${CODE}`, { signedIn: true });
  check('a signed-in browser still gets the invite page (its buttons decide)', signedInWeb.path, '/invite.html');
  const bot = await landsOn(`${base}/open?to=report&pu=${THEIRS.pu_code}`);
  check('CONTROL the bot\'s to=report still goes to the report page', [bot.path, bot.q], ['/observe.html', { pu: THEIRS.pu_code }]);
  const stale = await landsOn(`${base}/open?to=nonsense`);
  check('an unknown target lands on home, once (no reload loop)', [stale.path, stale.loads <= 3], ['/index.html', true]);

  // HAWKEYE LITE: native.js hands /open links to /open/index.html inside the app.
  const lite = await landsOn(`${base}/open/index.html?to=invite&ref=${CODE}&unit=${THEIRS.pu_code}`, { lite: true });
  check('Lite, signed out: straight to sign-up with code + unit (no store page)', [lite.path, lite.q],
    ['/observe.html', { intent: 'observe', ref: CODE, unit: THEIRS.pu_code }]);
  const liteIn = await landsOn(`${base}/open/index.html?to=invite&ref=${CODE}`, { lite: true, signedIn: true });
  check('Lite, signed in: home', liteIn.path, '/index.html');
  const notLite = await landsOn(`${base}/open/index.html?to=invite&ref=${CODE}`);
  check('CONTROL the same URL outside Lite is the invite page', notLite.path, '/invite.html');
}

console.log('\n=== sign-up: the chooser opens with the invited unit selected ===');
{
  const ctx = await context();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/invite.html?ref=${CODE}&unit=${THEIRS.pu_code}`, { waitUntil: 'networkidle' });
  await p.goto(`${base}/choose-unit.html?onboard=1`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  const s = await p.evaluate(() => ({
    named: document.getElementById('unit-picked-name').textContent,
    shown: document.getElementById('unit-picked').getClientRects().length > 0,
    invitedLine: document.getElementById('unit-invited').getClientRects().length > 0,
    save: document.getElementById('btn-unit-save').disabled,
  }));
  check('the invited unit is selected and named from the register', [s.shown, s.named], [true, THEIRS.name]);
  check('with the line saying why', s.invitedLine, true);
  check('and Save is live — confirm, not retype', s.save, false);
  check('nothing was saved on arrival', S.posts, []);
  await Promise.all([p.waitForURL(/index\.html/, { timeout: 6000 }).catch(() => {}), p.click('#btn-unit-save')]);
  await p.waitForTimeout(300);
  check('Save posts the invited unit', S.posts, [THEIRS.pu_code]);
  check('the second observer is not asked to invite a second observer', await p.evaluate(() => location.pathname), '/index.html');
  check('and the invitation is spent', await p.evaluate(() => localStorage.getItem('hawkeye_invite_unit')), null);
  check('no page error', errs.slice(0, 2), []);
  await ctx.close();
  S.posts = [];

  const ctx2 = await context();   // CONTROL: no invitation
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}/choose-unit.html?onboard=1`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(400);
  check('CONTROL without an invitation nothing is selected', await p2.evaluate(() => ({
    shown: document.getElementById('unit-picked').getClientRects().length > 0,
    save: document.getElementById('btn-unit-save').disabled,
  })), { shown: false, save: true });
  // ?unit= (native's /choose-unit parameter) works on the page too.
  await p2.goto(`${base}/choose-unit.html?current=&unit=${THEIRS.pu_code}`, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(400);
  check('?unit= selects directly', await p2.evaluate(() => document.getElementById('unit-picked-name').textContent), THEIRS.name);
  await ctx2.close();
}

console.log('\n=== (c) once, right after saving a unit ===');
{
  const ctx = await context();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/profile.html`, { waitUntil: 'networkidle' });
  await Promise.all([p.waitForURL(/choose-unit\.html/), p.click('#btn-pick-unit')]);
  await p.waitForTimeout(500);
  await p.fill('#pus-q', 'ogbomosho');
  await p.waitForSelector('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await p.click('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await p.click('#btn-unit-save');
  await p.waitForTimeout(600);
  const o = await p.evaluate(() => ({
    path: location.pathname,
    offer: document.getElementById('cu-after').getClientRects().length > 0,
    saveHidden: document.getElementById('btn-unit-save').getClientRects().length === 0,
    modal: !!document.querySelector('dialog[open], [role="dialog"]:not([hidden])'),
  }));
  check('the save landed', S.posts, [THEIRS.pu_code]);
  check('the offer takes Save\'s place, on the page', [o.path, o.offer, o.saveHidden], ['/choose-unit.html', true, true]);
  check('not as a pop-up', o.modal, false);
  await p.click('#cu-invite');
  await p.waitForTimeout(300);
  check('it copies a live invite to the unit just saved', liveInvite((await copied(p))[0], THEIRS.pu_code), true);
  check('the way on now says Done', await p.evaluate(() => document.getElementById('cu-after-on').textContent), 'Done');
  await Promise.all([p.waitForURL(/profile\.html/, { timeout: 5000 }).catch(() => {}), p.click('#cu-after-on')]);
  await p.waitForTimeout(300);
  check('and it returns to Profile', await p.evaluate(() => location.pathname), '/profile.html');

  // ONCE: the next save goes straight back, as it always did.
  S.posts = [];
  await Promise.all([p.waitForURL(/choose-unit\.html/), p.click('#btn-pick-unit')]);
  await p.waitForTimeout(500);
  await p.fill('#pus-q', 'ogbomosho');
  await p.waitForSelector('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await p.click('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await Promise.all([p.waitForURL(/profile\.html/, { timeout: 5000 }).catch(() => {}), p.click('#btn-unit-save')]);
  await p.waitForTimeout(400);
  check('the second save is not offered it again', [S.posts, await p.evaluate(() => location.pathname)], [[THEIRS.pu_code], '/profile.html']);
  check('no page error', errs.slice(0, 2), []);
  await ctx.close();
  S.posts = [];

  // CONTROL: no referral code to be had -> leaves exactly as before.
  S.referral = {};
  const ctx2 = await context();
  const p2 = await ctx2.newPage();
  await p2.goto(`${base}/choose-unit.html?current=`, { waitUntil: 'networkidle' });
  await p2.fill('#pus-q', 'ogbomosho');
  await p2.waitForSelector('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await p2.click('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await Promise.all([p2.waitForURL(/profile\.html/, { timeout: 6000 }).catch(() => {}), p2.click('#btn-unit-save')]);
  await p2.waitForTimeout(300);
  check('CONTROL with no invite code the save just leaves', await p2.evaluate(() => location.pathname), '/profile.html');
  await ctx2.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

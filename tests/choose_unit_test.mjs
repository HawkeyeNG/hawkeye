/**
 * "MY POLLING UNIT" MUST NOT OPEN A SURVEYING SCREEN.
 *
 * Both clients sent it to Map a Polling Unit — a screen whose instruction is
 * "Only do this while physically standing at the unit" and whose primary action
 * captures a GPS fix. Saving was a secondary control on it. Someone who only
 * wants to say which unit is theirs was handed a surveying tool and told to be
 * standing in the right place to use it.
 *
 * Mapping contributes a coordinate to the register. Choosing is a preference
 * about alerts. This asserts the two stay separate on BOTH clients.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readNative } from './helpers/native-text.mjs';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

console.log('=== native: the profile row opens the picker, not /map-unit ===');
{
  const profile = readNative(`${ROOT}/native/src/app/profile.tsx`);
  const modal = readNative(`${ROOT}/native/src/components/choose-unit.tsx`);
  // The row must no longer navigate. Scoped to the My Polling Unit row so an
  // unrelated /map-unit link elsewhere on the screen would not mask a regression.
  check('the row exists', profile.includes('label="My Polling Unit"'), true);
  // Whole file, not a window around the row: the row's comment explaining WHY it
  // changed is long enough that a fixed slice missed the handler below it, and
  // an absence check over the whole file is the stronger claim anyway — there
  // must be no route to the surveying screen from this screen at all.
  check('nothing on this screen pushes /map-unit', /router\.push\('\/map-unit'\)/.test(profile), false);
  // The chooser is a PAGE now (/choose-unit), not a modal mounted on Profile.
  check('the row opens the chooser page instead', /router\.push\(\{\s*pathname:\s*'\/choose-unit'/.test(profile), true);
  check('and Profile hears the save without a refetch', /onMyUnitSaved\(/.test(profile), true);

  check('the picker reuses UnitSearch rather than a new one', /<UnitSearch/.test(modal), true);
  check('and the shared location helpers', /tryQuickFix|describeFixFailure/.test(modal), true);
  check('and the one saved-unit writer', /observers\/my-unit/.test(modal), true);
  // The distinction the whole change is about must be said to the user.
  check('it tells the reader they need not be there', /do not need to be there|don&apos;t need to be there|not need to be there/i.test(modal), true);

  // /map-unit must survive untouched — it is still the right screen for mapping.
  const mapUnit = readNative(`${ROOT}/native/src/app/map-unit.tsx`);
  check('map-unit is still the surveying screen', /Map a polling unit/.test(mapUnit), true);
  check('and still asks for a GPS fix', /record fix|record one GPS fix/i.test(mapUnit), true);
}

console.log('\n=== native: the chooser is its own route, and sign-up lands on it ===');
{
  const route = `${ROOT}/native/src/app/choose-unit.tsx`;
  const exists = fs.existsSync(route);
  check('the /choose-unit route exists', exists, true);
  const page = exists ? fs.readFileSync(route, 'utf8') : '';
  check('it renders the shared chooser', /<ChooseUnitScreen/.test(page), true);
  check('onboarding leaves by REPLACE to the tabs', /router\.replace\('\/\(tabs\)'\)/.test(page), true);
  check('and it tells Profile what was saved', /emitMyUnitSaved\(/.test(page), true);
  const layout = fs.readFileSync(`${ROOT}/native/src/app/_layout.tsx`, 'utf8');
  check('the stack registers it', /name="choose-unit"/.test(layout), true);
  const signIn = fs.readFileSync(`${ROOT}/native/src/app/sign-in.tsx`, 'utf8');
  check('a new sign-up goes to the page with onboard=1', /router\.replace\('\/choose-unit\?onboard=1'/.test(signIn), true);
  // No modal left anywhere: a second chooser would drift from this one.
  const tsx = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsx(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []);
  const users = tsx(`${ROOT}/native/src`).filter((f) => /ChooseUnitModal/.test(fs.readFileSync(f, 'utf8')));
  check('nothing still mounts the old ChooseUnitModal', users, []);
}

/**
 * NO letterSpacing ON A NATIVE TextInput — EVER.
 *
 * iOS recycles a TextInput's native view once it unmounts, and kerning set on
 * it survives the recycle: the OTP box's `tracking-[8px]` came back as a spaced
 * "N e w  p a s s w o r d" placeholder on the very next screen, and later as
 * "N a m e ,  w a r d  o r  u n i t" in this chooser's search box. Neither of
 * those fields had any letterSpacing of its own, so a check on the field that
 * LOOKS wrong finds nothing; the only reliable rule is that no TextInput in the
 * app carries any.
 */
console.log('\n=== native: no TextInput carries letterSpacing (it leaks into the next field on iOS) ===');
{
  const tsx = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsx(path.join(dir, d.name)) : d.name.endsWith('.tsx') ? [path.join(dir, d.name)] : []);
  /** Every `<TextInput …/>` opening tag whose props space the letters. */
  const spaced = (src, file) => [...src.matchAll(/<TextInput\b[\s\S]*?\/>/g)]
    .filter((m) => /\btracking-|letterSpacing/.test(m[0]))
    .map((m) => `${file}:${src.slice(0, m.index).split('\n').length}`);
  const files = tsx(`${ROOT}/native/src`);
  const inputs = files.reduce((n, f) => n + (fs.readFileSync(f, 'utf8').match(/<TextInput\b/g) || []).length, 0);
  check('the scan actually sees the app\'s TextInputs', inputs, (n) => n >= 10);
  const bad = files.flatMap((f) => spaced(fs.readFileSync(f, 'utf8'), path.relative(`${ROOT}/native/src`, f)));
  check('no TextInput has tracking-* or letterSpacing', bad, []);
  // CONTROL: the old OTP box must be caught, or the pass above means nothing.
  const planted = '<TextInput\n  ref={otpRef}\n  className="text-2xl font-bold tracking-[8px] text-ink"\n  onChangeText={(s) => setOtp(s)}\n/>';
  check('CONTROL the scan flags the old tracking-[8px] OTP box', spaced(planted, 'planted').length, 1);
}

console.log('\n=== web: the chooser is a page, and sign-up lands on it ===');
{
  const app = fs.readFileSync(`${APP}/app.js`, 'utf8');
  // Scoped to afterVerified so an unrelated link elsewhere in app.js cannot
  // satisfy or mask it.
  const fn = app.slice(app.indexOf('function afterVerified('), app.indexOf('function resetAuthPane('));
  check('afterVerified is where the sweep looks', fn.length > 100, true);
  check('a new sign-up goes to the chooser with onboard=1, by replace',
    /location\.replace\('choose-unit\.html\?onboard=1'\)/.test(fn), true);
  // A navigation, not the word: the comment above the line names the old page.
  check('and no longer to the surveying page', /(location\.href\s*=|location\.replace\()\s*'map-unit\.html/.test(fn), false);
  check('CONTROL the pattern sees the old navigation',
    /(location\.href\s*=|location\.replace\()\s*'map-unit\.html/.test("location.href = 'map-unit.html?onboard=1';"), true);
  const sw = fs.readFileSync(`${APP}/sw.js`, 'utf8');
  check('the service worker precaches the page', /'\/choose-unit\.html'/.test(sw), true);
  const profile = fs.readFileSync(`${APP}/profile.html`, 'utf8');
  // One chooser. A second one on Profile would drift from this page.
  check('Profile no longer carries its own chooser modal', /id="unit-modal"/.test(profile), false);
}

console.log('\n=== web: same rule, driven in a browser ===');
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const posts = [];
let meHits = 0;
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (url.startsWith('/api/observers/me')) {
    meHits++;
    return json({ observerId: 1, createdAt: Date.now(), identityHash: 'abc', hasPassword: true,
      unit: { pu_code: '37-06-02-141', name: 'Wonderland Estate', ward: 'Garki', lga: 'Municipal', state: 'FCT' } });
  }
  if (url === '/api/observers/my-unit' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => { b += c; });
    return req.on('end', () => { posts.push(b); json({ ok: true }); });
  }
  if (url === '/api/register/search') {
    return json({ truncated: false, units: [{ pu_code: '37-06-01-105', name: 'No 20 Ogbomosho Street', ward: 'City Centre', lga: 'Municipal', state: 'FCT' }] });
  }
  if (url.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
// authgate.js is a real JWT check: it base64-decodes the payload and reads
// exp, so a placeholder string fails and the page REDIRECTS to sign-in — the
// page would be absent for a reason unrelated to what is tested here.
// REDUCED MOTION, for the harness: these checks cross real page navigations,
// and headless Chromium stops producing frames after a cross-document view
// transition (styles.css @view-transition), so every click after the first
// navigation waits forever for a "stable" element. Measured on incidents.html
// too — it is the harness, not this page. The site skips the transition for
// reduced-motion readers, so this is a real configuration, not a stub.
const ctxOpts = { viewport: { width: 390, height: 780 }, reducedMotion: 'reduce' };
const signedIn = async (ctx) => ctx.addInitScript(() => {
  const body = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }));
  localStorage.setItem('hawkeye_token', 'hdr.' + body + '.sig');
  localStorage.setItem('hawkeye_lang_prompted', '1');
});
{
  const ctx = await b.newContext(ctxOpts);
  await signedIn(ctx);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/profile.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);

  const before = await p.evaluate(() => {
    const card = [...document.querySelectorAll('.pcard')].find((c) => /My polling unit/i.test(c.textContent));
    return { hasCard: !!card, primaryIsPicker: !!card?.querySelector('#btn-pick-unit') };
  });
  check('the card is there', before.hasCard, true);
  check('its primary control is the picker', before.primaryIsPicker, true);

  await Promise.all([p.waitForURL(/choose-unit\.html/), p.click('#btn-pick-unit')]);
  await p.waitForTimeout(900);
  const after = await p.evaluate(() => ({
    path: location.pathname,
    current: new URLSearchParams(location.search).get('current'),
    // pu-search.js mounts its own input; if it is absent the page offers only
    // GPS, which is useless to anyone not standing at their unit.
    hasSearchInput: !!document.getElementById('pus-q'),
    hasNearTab: !!document.getElementById('tab-near'),
    hasRegTab: !!document.getElementById('tab-reg'),
    saveDisabled: document.getElementById('btn-unit-save')?.disabled ?? null,
    closeShown: document.getElementById('cu-close').getClientRects().length > 0,
    skipShown: document.getElementById('cu-skip').getClientRects().length > 0,
    bannerShown: document.getElementById('cu-banner').getClientRects().length > 0,
    eyebrow: document.getElementById('cu-eyebrow').textContent.trim(),
    header: document.querySelector('.gov-header .brand-text strong')?.textContent.trim(),
  }));
  check('tapping it opens the chooser page', after.path, '/choose-unit.html');
  check('carrying the saved unit', after.current, '37-06-02-141');
  check('and not the surveying page', /map-unit/.test(after.path), false);
  check('with the shared search input mounted', after.hasSearchInput, true);
  check('and both tabs', after.hasNearTab && after.hasRegTab, true);
  check('save is disabled until something is chosen', after.saveDisabled, true);
  check('from Profile it offers Close, not Skip', [after.closeShown, after.skipShown], [true, false]);
  check('and no sign-up banner', after.bannerShown, false);
  check('the eyebrow names the subject', after.eyebrow, 'Your polling unit');
  check('the header names where the reader is', after.header, 'My Profile');

  // Choose through search, the one route that works with no signal.
  await p.fill('#pus-q', 'ogbomosho');
  await p.waitForSelector('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await p.click('#unit-search-host .pu-option', { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(200);
  const chosen = await p.evaluate(() => ({
    save: document.getElementById('btn-unit-save').disabled,
    named: document.getElementById('unit-picked-name').textContent,
    painted: document.getElementById('unit-picked').getClientRects().length > 0,
  }));
  check('choosing a unit enables Save', chosen.save, false);
  check('and names it above Save', [chosen.painted, chosen.named], [true, 'No 20 Ogbomosho Street']);

  const meBefore = meHits;
  await Promise.all([p.waitForURL(/profile\.html/, { timeout: 5000 }).catch(() => {}), p.click('#btn-unit-save')]);
  await p.waitForTimeout(600);
  check('Save posts the chosen unit', posts.map((x) => JSON.parse(x).puCode), ['37-06-01-105']);
  check('and returns to Profile', await p.evaluate(() => location.pathname), '/profile.html');
  // Back may restore Profile from the bfcache, which skips its load(); the row
  // would then show the unit just replaced. It must ask the server again.
  check('which re-reads the saved unit', meHits > meBefore, true);
  check('no page error', errs.slice(0, 2), []);
  await ctx.close();
}

console.log('\n=== web: the sign-up step ===');
{
  const ctx = await b.newContext(ctxOpts);
  await signedIn(ctx);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  // A page before it in history, so "replace" is observable as history not growing.
  await p.goto(`${base}/observe.html`, { waitUntil: 'domcontentloaded' });
  await p.goto(`${base}/choose-unit.html?onboard=1`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const s = await p.evaluate(() => ({
    bannerShown: document.getElementById('cu-banner').getClientRects().length > 0,
    skipShown: document.getElementById('cu-skip').getClientRects().length > 0,
    closeShown: document.getElementById('cu-close').getClientRects().length > 0,
    eyebrow: document.getElementById('cu-eyebrow').textContent.trim(),
    header: document.querySelector('.gov-header .brand-text strong')?.textContent.trim(),
    len: history.length,
  }));
  check('the welcome banner shows', s.bannerShown, true);
  check('with Skip for now, and no Close', [s.skipShown, s.closeShown], [true, false]);
  check('the eyebrow says it is the last step', s.eyebrow, 'Last step');
  check('the header says the reader is creating an account', s.header, 'Create Your Account');
  await Promise.all([p.waitForURL(/index\.html/, { timeout: 5000 }).catch(() => {}), p.click('#cu-skip')]);
  await p.waitForTimeout(300);
  const out = await p.evaluate(() => ({ path: location.pathname, len: history.length }));
  check('Skip goes Home', out.path, '/index.html');
  check('by replace — history did not grow', out.len, s.len);
  check('no page error', errs.slice(0, 2), []);
  await ctx.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

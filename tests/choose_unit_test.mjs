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
  const profile = fs.readFileSync(`${ROOT}/native/src/app/profile.tsx`, 'utf8');
  const modal = fs.readFileSync(`${ROOT}/native/src/components/choose-unit.tsx`, 'utf8');
  // The row must no longer navigate. Scoped to the My Polling Unit row so an
  // unrelated /map-unit link elsewhere on the screen would not mask a regression.
  check('the row exists', profile.includes('label="My Polling Unit"'), true);
  // Whole file, not a window around the row: the row's comment explaining WHY it
  // changed is long enough that a fixed slice missed the handler below it, and
  // an absence check over the whole file is the stronger claim anyway — there
  // must be no route to the surveying screen from this screen at all.
  check('nothing on this screen pushes /map-unit', /router\.push\('\/map-unit'\)/.test(profile), false);
  check('the row opens the picker instead', /setPickUnit\(true\)/.test(profile), true);
  check('the picker is mounted on the screen', /<ChooseUnitModal/.test(profile), true);

  check('the picker reuses UnitSearch rather than a new one', /<UnitSearch/.test(modal), true);
  check('and the shared location helpers', /tryQuickFix|describeFixFailure/.test(modal), true);
  check('and the one saved-unit writer', /observers\/my-unit/.test(modal), true);
  // The distinction the whole change is about must be said to the user.
  check('it tells the reader they need not be there', /do not need to be there|don&apos;t need to be there|not need to be there/i.test(modal), true);

  // /map-unit must survive untouched — it is still the right screen for mapping.
  const mapUnit = fs.readFileSync(`${ROOT}/native/src/app/map-unit.tsx`, 'utf8');
  check('map-unit is still the surveying screen', /Map a polling unit/.test(mapUnit), true);
  check('and still asks for a GPS fix', /record fix|record one GPS fix/i.test(mapUnit), true);
}

console.log('\n=== web: same rule, driven in a browser ===');
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/observers/me')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ observerId: 1, createdAt: Date.now(), identityHash: 'abc', hasPassword: true }));
  }
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
  // authgate.js hides the whole page without a token, so the card would be
  // absent for a reason that has nothing to do with what is being tested.
  // authgate.js is a real JWT check: it base64-decodes the payload and reads
  // , so a placeholder string fails and the page REDIRECTS to sign-in —
  // the card was absent for a reason unrelated to what is tested here. Only
  // the shape matters client-side; the server is stubbed below regardless.
  await ctx.addInitScript(() => {
    const body = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }));
    localStorage.setItem('hawkeye_token', 'hdr.' + body + '.sig');
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${base}/profile.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);

  const before = await p.evaluate(() => {
    const card = [...document.querySelectorAll('.pcard')].find((c) => /My polling unit/i.test(c.textContent));
    return {
      hasCard: !!card,
      // The card may still LINK to map-unit — that is fine and deliberate, it is
      // the other job. What it must not do is make that the way to save.
      primaryIsPicker: !!card?.querySelector('#btn-pick-unit'),
      modalOpen: !document.getElementById('unit-modal')?.hidden,
    };
  });
  check('the card is there', before.hasCard, true);
  check('its primary control is the picker', before.primaryIsPicker, true);
  check('and the picker starts closed', before.modalOpen, false);

  await p.click('#btn-pick-unit');
  await p.waitForTimeout(600);
  const after = await p.evaluate(() => {
    const m = document.getElementById('unit-modal');
    const shown = m ? m.getClientRects().length > 0 : false;
    return {
      shown,
      hasNearMe: !!document.getElementById('btn-unit-near'),
      // pu-search.js mounts its own input; if it is absent the picker offers
      // only GPS, which is useless to anyone not standing at their unit.
      hasSearchInput: !!document.getElementById('pus-q'),
      saveDisabled: document.getElementById('btn-unit-save')?.disabled ?? null,
      navigatedAway: location.pathname.includes('map-unit'),
    };
  });
  check('tapping it opens the picker', after.shown, true);
  check('with a near-me control', after.hasNearMe, true);
  check('and the shared search input mounted', after.hasSearchInput, true);
  check('save is disabled until something is chosen', after.saveDisabled, true);
  check('and nothing navigated to map-unit', after.navigatedAway, false);
  check('no page error', errs.slice(0, 2), []);

  // Choosing enables the commit — the modal is useless if it never does.
  const enabled = await p.evaluate(() => {
    selectUnit({ pu_code: '01-01-01-001', name: 'Test Unit', ward: 'W', lga: 'L', state: 'S' });
    return document.getElementById('btn-unit-save')?.disabled;
  });
  check('choosing a unit enables Save', enabled, false);

  // Escape must close it, like the other dialog on this page.
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  check('Escape closes it', await p.evaluate(() => document.getElementById('unit-modal').hidden), true);
  await ctx.close();
}

console.log('\n=== control: the probe can see a closed dialog as closed ===');
{
  // Every "opens" assertion above would be vacuous if `shown` were always true.
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
  // authgate.js is a real JWT check: it base64-decodes the payload and reads
  // , so a placeholder string fails and the page REDIRECTS to sign-in —
  // the card was absent for a reason unrelated to what is tested here. Only
  // the shape matters client-side; the server is stubbed below regardless.
  await ctx.addInitScript(() => {
    const body = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }));
    localStorage.setItem('hawkeye_token', 'hdr.' + body + '.sig');
  });
  const p = await ctx.newPage();
  await p.goto(`${base}/profile.html`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  const shut = await p.evaluate(() => {
    const m = document.getElementById('unit-modal');
    return m ? m.getClientRects().length > 0 : null;
  });
  check('unopened, it reports NOT shown', shut, false);
  await ctx.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

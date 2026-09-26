/**
 * "CHOOSE YOUR POLLING UNIT", MEASURED — the page that replaced Profile's modal.
 *
 * The chooser was a modal on profile.html, and two bugs shipped in it in one
 * build, both invisible to a source read. It is a page now (choose-unit.html),
 * and both bugs have page-shaped versions, so the same questions are asked of
 * the page:
 *
 * 1. A GHOST BAR. The "Selected" block carries `hidden` until something is
 *    picked; a plain `display: block` rule outranks the UA sheet's
 *    `[hidden] { display: none }` and paints the EMPTY block. The check is
 *    getClientRects().length — "is it actually painted" — because a class or a
 *    computed style looked perfectly correct while the old one was on screen.
 *
 * 2. SAVE UNDER THE TAB BAR. In the Lite shell the bottom of the viewport is
 *    the tab bar and the page scrolls inside #page-scroll. Save is pinned
 *    (sticky) so a long ward or result list can never push it below the fold;
 *    this asserts what a thumb can reach, at a small phone size, in the shell.
 *
 * Plus the translation rule the page is written to: every dynamic line is
 * resolved at RENDER, so a reader in Hausa gets Hausa for text the script
 * paints after the bundle arrives, not the English it held at load.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const ME = { observerId: 2, createdAt: '2026-07-15T00:00:00Z', identityHash: 'ef3bbd06d5cfa472763699eed658d864a6dbf6e86019c69e36acd762a0155a30', hasPassword: true };
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (u === '/api/observers/me') return json(ME);
  if (u === '/api/observers/my-unit') return json({ ok: true });
  // THE REAL SHAPE. /api/polling-units answers an envelope, and a bare-array
  // stub would let the Array.isArray bug pass unnoticed — which is exactly how
  // it survived in three separate files.
  if (u === '/api/polling-units') return json({ radiusM: 500, maxRows: 20, capped: false, units: [
    { pu_code: '37-06-02-141', name: 'Wonderland Estate', ward: 'Garki', lga: 'Municipal', state: 'FCT', distanceM: 120, locationTier: 'verified' },
    { pu_code: '37-06-01-105', name: 'No 20 Ogbomosho Street', ward: 'City Centre', lga: 'Municipal', state: 'FCT', distanceM: 220, locationTier: 'verified' },
  ] });
  // And the second lookup's own shape: camelCase, no LGA or state.
  if (u === '/api/mapping/nearby') return json({ units: [
    { puCode: '37-06-02-141', name: 'Wonderland Estate', ward: 'Garki', lat: 9.03, lng: 7.49, distanceM: 120, status: 'verified' },
    { puCode: '37-06-02-150', name: 'Area 11 Junction', ward: 'Garki', lat: 9.04, lng: 7.5, distanceM: 610, status: 'approx' },
  ] });
  if (u.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (l, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;
const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** The Lite shell at a small phone size: native-app class, tab bar, #page-scroll. */
async function open(page = 'choose-unit.html?current=37-06-02-141', lang = null) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 780 },
    // Headless Chromium stops producing frames after a cross-document view
    // transition; the site skips it for reduced motion, so this is real.
    reducedMotion: 'reduce',
    permissions: ['geolocation'],
    geolocation: { latitude: 9.033, longitude: 7.49 },
  });
  await ctx.addInitScript(([t, l]) => {
    Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
    const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
    mark();
    document.addEventListener('readystatechange', mark);
    try {
      localStorage.setItem('hawkeye_token', t);
      localStorage.setItem('hawkeye_tour_seen', '1');
      localStorage.setItem('hawkeye_lang_prompted', '1');
      if (l) localStorage.setItem('hawkeye_lang', l);
    } catch (e) { /* ignore */ }
  }, [JWT(), lang]);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`${base}/${page}`);
  await p.waitForTimeout(1000);
  return { ctx, p, errs };
}

console.log('=== it renders in the Lite shell, with no errors ===');
{
  const { ctx, p, errs } = await open();
  const r = await p.evaluate(() => ({
    shell: document.documentElement.classList.contains('has-shell'),
    inPane: !!document.querySelector('#page-scroll main'),
    tabbar: !!document.querySelector('.tabbar'),
    search: !!document.getElementById('pus-q'),
  }));
  check('the shell wrapped the page into #page-scroll', r.shell && r.inPane);
  check('the tab bar is up', r.tabbar);
  check('the shared search mounted', r.search);
  // 404s for optional assets (fonts, register packs) are the harness, not the page.
  check('no page errors', errs.filter((e) => !/Failed to load resource/.test(e)), (e) => e.length === 0);
  await ctx.close();
}

console.log('\n=== nothing empty is painted above Save ===');
{
  const { ctx, p } = await open();
  const r = await p.evaluate(() => {
    const card = document.getElementById('unit-picked');
    return { hiddenAttr: card.hidden, painted: card.getClientRects().length > 0 };
  });
  check('the Selected block carries hidden before anything is picked', r.hiddenAttr, true);
  check('and the browser paints NO box for it', r.painted, false);
  await p.addStyleTag({ content: '#unit-picked { display: block !important; }' });
  await p.waitForTimeout(150);
  const painted = await p.evaluate(() => document.getElementById('unit-picked').getClientRects().length > 0);
  control('the paint detector catches a hidden element that still renders', !painted);
  await ctx.close();
}

console.log('\n=== gold marks what to do next ===');
{
  const { ctx, p } = await open();
  const bg = (sel) => p.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  check('no tab is open on arrival', await p.evaluate(() => [...document.querySelectorAll('[role="tab"]')].every((t) => t.getAttribute('aria-selected') === 'false')));
  check('so nothing is gold in the strip', await bg('#tab-near'), (c) => c !== 'rgb(245, 179, 1)');
  await p.click('#tab-reg');
  await p.waitForTimeout(200);
  check('the open tab is gold', await bg('#tab-reg'), 'rgb(245, 179, 1)');
  check('the other is not', await bg('#tab-near'), (c) => c !== 'rgb(245, 179, 1)');
  await p.click('#tab-reg');
  await p.waitForTimeout(150);
  check('tapping the open tab folds it away', await p.evaluate(() => document.getElementById('pane-reg').hidden));
  await p.focus('#pus-q');
  check('the focused search takes a gold border', await p.evaluate(() => getComputedStyle(document.getElementById('pus-q')).borderTopColor), 'rgb(245, 179, 1)');
  check('Save is grey while nothing is chosen', await bg('#btn-unit-save'), (c) => c !== 'rgb(245, 179, 1)');
  await ctx.close();
}

console.log('\n=== near me returns rows, and picking one enables a gold Save ===');
{
  const { ctx, p } = await open();
  await p.click('#tab-near');
  await p.waitForTimeout(1500);
  const near = await p.evaluate(() => ({
    status: document.getElementById('unit-near-status').textContent.trim(),
    names: [...document.querySelectorAll('#unit-near-results .pu-option strong')].map((s) => s.textContent),
    saved: [...document.querySelectorAll('#unit-near-results .cu-saved')].length,
  }));
  console.log(`      status="${near.status}" rows=${near.names.length}`);
  // The envelope bug reported "No units found near you" on a lookup that had
  // just returned rows. Assert the ROWS, not the message.
  check('near-me merges both lookups into rows', near.names.length, 3);
  check('located units come before an envelope-only one', near.names[near.names.length - 1], 'Area 11 Junction');
  check('the unit already saved is marked Saved', near.saved, 1);
  await p.click('#unit-near-results .pu-option >> nth=1');
  await p.waitForTimeout(250);
  const picked = await p.evaluate(() => ({
    painted: document.getElementById('unit-picked').getClientRects().length > 0,
    name: document.getElementById('unit-picked-name').textContent,
    save: !document.getElementById('btn-unit-save').disabled,
    gold: getComputedStyle(document.getElementById('btn-unit-save')).backgroundColor,
    rowOn: document.querySelectorAll('#unit-near-results .is-picked').length,
  }));
  check('picking a row paints the Selected block', picked.painted);
  check('naming the unit that was picked', picked.name, 'No 20 Ogbomosho Street');
  check('and the row itself is marked', picked.rowOn, 1);
  check('Save becomes available', picked.save);
  check('and gold', picked.gold, 'rgb(245, 179, 1)');
  await ctx.close();
}

console.log('\n=== Save is reachable, above the tab bar, however long the list ===');
{
  const { ctx, p } = await open();
  const measure = () => p.evaluate(() => {
    const bar = document.querySelector('.tabbar');
    const barTop = bar ? bar.getBoundingClientRect().top : innerHeight;
    const b = document.getElementById('btn-unit-save');
    const q = b.getBoundingClientRect();
    const mid = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    return {
      barTop: Math.round(barTop), top: Math.round(q.top), bottom: Math.round(q.bottom),
      clearOfBar: q.bottom <= barTop + 1, onScreen: q.top >= 0 && q.bottom <= innerHeight,
      hitsItself: !!mid && (mid === b || b.contains(mid)),
    };
  });
  // A long list: the case the modal lost its actions to.
  const fill = () => p.evaluate(() => {
    document.getElementById('pane-near').hidden = false;
    document.getElementById('unit-near-results').innerHTML = Array.from({ length: 40 }, (_, i) => `<div style="padding:14px">Unit ${i}</div>`).join('');
  });
  const toEnd = (y) => p.evaluate((to) => { const s = document.getElementById('page-scroll') || document.scrollingElement; s.scrollTop = to === 'end' ? s.scrollHeight : to; }, y);
  await fill();
  await toEnd(0);
  await p.waitForTimeout(200);
  const top = await measure();
  console.log(`      tab bar top=${top.barTop}  save top=${top.top} bottom=${top.bottom}`);
  check('Save sits above the tab bar at the top of a long list', top.clearOfBar && top.onScreen);
  check('and a tap on it lands on the button itself', top.hitsItself);
  await toEnd(600);
  await p.waitForTimeout(200);
  const mid = await measure();
  check('it does not travel with the scrolling list', Math.abs(mid.top - top.top) <= 2);
  check('and is still clear of the tab bar', mid.clearOfBar && mid.hitsItself);

  // CONTROL: un-pin it and the same measurement must fail at the top of the list.
  await p.addStyleTag({ content: '.cu-foot { position: static !important; }' });
  await toEnd(0);
  await p.waitForTimeout(200);
  const loose = await measure();
  console.log(`      with the pin removed -> save bottom=${loose.bottom} onScreen=${loose.onScreen}`);
  control('the measurement catches Save pushed below the fold', loose.clearOfBar && loose.onScreen);
  await ctx.close();
}

console.log('\n=== translated at render, not at load ===');
{
  const { ctx, p } = await open('choose-unit.html?current=37-06-02-141', 'ha');
  const ha = JSON.parse(fs.readFileSync(`${APP}/i18n/ha.json`, 'utf8'));
  await p.waitForTimeout(500);
  await p.click('#tab-near');
  await p.waitForTimeout(1500);
  const r = await p.evaluate(() => ({
    save: document.getElementById('btn-unit-save').textContent.trim(),
    eyebrow: document.getElementById('cu-eyebrow').textContent.trim(),
    tab: document.querySelector('#tab-near span').textContent.trim(),
    status: document.getElementById('unit-near-status').textContent.trim(),
    lang: document.documentElement.lang,
  }));
  check('precondition: the page is in Hausa', r.lang, 'ha');
  check('Save is in Hausa', r.save, ha['profile.save-this-unit']);
  check('the eyebrow is in Hausa', r.eyebrow, ha['choose-unit.your-polling-unit']);
  check('the tab is in Hausa', r.tab, ha['choose-unit.near-me']);
  // The line the SCRIPT writes after a fetch — the class of string that stays
  // English when it is resolved before the bundle lands.
  check('the near-me line the script paints is in Hausa', r.status, ha['choose-unit.tap-your-polling-unit']);
  control('the Hausa line differs from the English one', ha['choose-unit.tap-your-polling-unit'] === 'Tap your polling unit:');
  await ctx.close();
}

console.log('\n=== in sign-up, the header\'s close skips to Home ===');
{
  // A page underneath, so a plain history.back() would have somewhere to go
  // that is NOT Home — otherwise menu.js's own fallback passes this vacuously.
  const { ctx, p } = await open('faq.html');
  await p.goto(`${base}/choose-unit.html?onboard=1`);
  await p.waitForTimeout(900);
  check('precondition: the Lite header has its close button', await p.evaluate(() => !!document.querySelector('.gov-header .close-btn')));
  await Promise.all([p.waitForURL(/index\.html/, { timeout: 5000 }).catch(() => {}), p.click('.gov-header .close-btn')]);
  await p.waitForTimeout(300);
  check('it lands on Home, not back past the sign-in page', await p.evaluate(() => location.pathname), '/index.html');
  await ctx.close();
  // CONTROL: the same page OUTSIDE sign-up keeps menu.js's plain Back, so the
  // same click from the same history must land on the page underneath.
  const c = await open('faq.html');
  await c.p.goto(`${base}/choose-unit.html?current=x`);
  await c.p.waitForTimeout(900);
  await Promise.all([c.p.waitForURL(/faq\.html/, { timeout: 5000 }).catch(() => {}), c.p.click('.gov-header .close-btn')]);
  await c.p.waitForTimeout(300);
  control('the probe tells Back from Home', (await c.p.evaluate(() => location.pathname)) !== '/faq.html');
  await c.ctx.close();
}

console.log('\n=== the polling-unit chevron sits on the Password chevron\'s axis ===');
{
  const { ctx, p } = await open('profile.html');
  // Real content: three lines of value against a three-word label, which is
  // the case the stacked layout exists for.
  await p.evaluate(() => {
    document.getElementById('p-unit').textContent = 'Wonderland Estate\n37-06-02-141 · Garki ward, Municipal, FCT';
  });
  await p.waitForTimeout(200);
  const geom = () => p.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
    const pwC = r('#btn-pw-open .prow-c');
    const unC = r('#btn-pick-unit .prow-c');
    const unV = r('#btn-pick-unit .prow-v');
    return {
      pwRight: Math.round(pwC.right), unRight: Math.round(unC.right),
      besideValue: unC.left >= unV.right - 1,
      unLeft: Math.round(unC.left), valueRight: Math.round(unV.right),
    };
  });
  const g = await geom();
  console.log(`      password chevron right=${g.pwRight}  unit chevron right=${g.unRight}  unit chevron left=${g.unLeft} value right=${g.valueRight}`);
  check('both chevrons end on the same vertical axis', Math.abs(g.pwRight - g.unRight) <= 1);
  check('the unit chevron is beside the value, not under it', g.besideValue);
  await p.addStyleTag({ content: '.prow:has(.prow-stack) { display: block !important; }' });
  await p.waitForTimeout(150);
  const bad = await geom();
  control('the measurement catches the chevron dropping to its own line',
    Math.abs(bad.pwRight - bad.unRight) <= 1 && bad.besideValue);
  await ctx.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

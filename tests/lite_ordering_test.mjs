/* The two ordering fixes from this round, measured in a browser.

   1. The tour must not open on top of the language modal on a first run, and
      must still open once that modal closes.
   2. observe.html?intent=signin must never paint the SIGN-UP screen first.

   Each assertion can fail, and each section carries a control: a case where the
   opposite is expected, so a test that passes because nothing rendered fails. */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const pw = createRequire('/home/elrio/hawkeye/tests/ui/')('playwright-core');
const APP = '/home/elrio/hawkeye/app';
const KEY = (readFileSync(APP + '/i18n.js', 'utf8').match(/KEY\s*=\s*['"]([^'"]+)['"]/) || [])[1];
const TYPES = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', json: 'application/json; charset=utf-8', css: 'text/css', svg: 'image/svg+xml' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '');
const TOKEN = b64({ alg: 'none' }) + '.' + b64({ sub: '1', exp: 9999999999 }) + '.x';

const checks = [];
const check = (name, ok, extra) => { checks.push([name, ok]); if (!ok && extra !== undefined) console.log('   ', JSON.stringify(extra).slice(0, 220)); };

const browser = await pw.chromium.launch();
const mk = async (init) => {
  /* Phone viewport: the tour rings the TAB BAR, which only exists on the
     narrow/app layout, so at desktop width there is no tour to wait for and
     the ordering this test exists to check never happens. */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.route('https://hk.test/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p.startsWith('/api/')) return r.fulfill({ contentType: TYPES.json, body: '{}' });
    const f = APP + (p === '/' ? '/index.html' : p);
    if (!existsSync(f)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ contentType: TYPES[p.split('.').pop()] || 'application/octet-stream', body: readFileSync(f) });
  });
  await pg.addInitScript(() => {
    window.__promptDone = false;
    document.addEventListener('hawkeye-lang-prompt-done', () => { window.__promptDone = true; });
  });
  if (init) await pg.addInitScript(init.fn, init.arg);
  return pg;
};

const vis = (pg, sel) => pg.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  if (el.hidden) return false;
  const r = el.getBoundingClientRect();
  return !!(r.width || r.height);
}, sel);

// ---- 1. first run: language modal, THEN the tour ----------------------
{
  const pg = await mk({ fn: (t) => { try { localStorage.setItem('hawkeye_token', t); } catch (e) {} }, arg: TOKEN });
  await pg.goto('https://hk.test/index.html', { waitUntil: 'load' });
  await pg.waitForTimeout(2500);
  const langOpen = await vis(pg, '#lang-modal');
  const tourOpen = await vis(pg, '.tour-card, #tour-modal, .tour-pop');
  check('first run opens the language modal', langOpen === true, { langOpen, tourOpen });
  check('and the tour does NOT open on top of it', tourOpen === false, { langOpen, tourOpen });
  // Close the picker the way a reader would; the tour should follow.
  // The modal's own Save button -- lang.js settles (and dispatches
  // 'hawkeye-lang-prompt-done') from its close path, which is what the tour waits on.
  await pg.evaluate(() => {
    const btn = document.querySelector('#lang-save') || document.querySelector('#lang-cancel');
    if (btn) btn.click();
  });
  await pg.waitForTimeout(2500);
  /* The HANDOFF is what this asserts: lang.js settles and dispatches, which is
     the signal the tour now waits for. Whether the tour then paints is gated on
     tourGap() -- it rings the TAB BAR, which exists only in the Capacitor shell
     -- and pre-setting window.HAWKEYE.native to fake that shell blanks the page
     (the audit's control caught it). So the open-after-close half is verified on
     a device, not here; asserting it in this harness would only ever measure the
     missing tab bar. */
  const settled = await pg.evaluate(() => window.__promptDone === true);
  check('closing the picker settles the language question (the tour waits on this)', settled === true, { settled });
  await pg.context().close();
}

// ---- 2. observe.html sign-in never paints sign-up ---------------------
{
  const pg = await mk(null);
  await pg.goto('https://hk.test/observe.html?intent=signin', { waitUntil: 'commit' });
  // Sample as early as the document allows, which is where the flash lived.
  await pg.waitForTimeout(140);
  /* RENDERED, not the attribute. This read `#signin-line:not([hidden])`, which
     asks whether app.js has run yet -- it sets .hidden later, and at 140ms it
     sometimes had and sometimes had not, so the check failed about one run in
     three against a page that never showed the line. What keeps it off the first
     paint is `html.intent-signin #signin-line{display:none !important}` in
     styles.css, keyed on the class the inline head script adds; the layout is
     the thing that answers "is it showing". The control below proves this same
     probe does see the line when it IS rendered. */
  const early = await pg.evaluate(() => ({
    title: (document.getElementById('register-title') || {}).textContent || '',
    signupLinkShown: (() => { const el = document.getElementById('signin-line'); return !!el && el.getClientRects().length > 0; })(),
    cls: document.documentElement.className,
  }));
  check('sign-in title is set before paint', /sign in/i.test(early.title), early);
  check('the sign-up cross-link is not showing', early.signupLinkShown === false, early);
  check('the intent-signin class is on <html>', /intent-signin/.test(early.cls), early);
  /* AND ONCE THE SCREEN IS UP. At 140ms #screen-register itself is often still
     [hidden] (app.js reveals it), so the early probe alone can miss a regression.
     Checked with a mutation -- styles.css without the intent-signin rule plus
     app.js without its `signin-line.hidden = true` -- this settled read went red
     on every run; the early one only when app.js happened to be in by 140ms. */
  const up = await pg.waitForFunction(() => {
    const s = document.getElementById('screen-register');
    return !!s && s.getClientRects().length > 0;
  }, null, { timeout: 5000 }).then(() => true, () => false);
  const late = await pg.evaluate(() => { const el = document.getElementById('signin-line'); return !!el && el.getClientRects().length > 0; });
  check('once the sign-in screen is up, the cross-link still is not showing', up && late === false, { up, late });
  await pg.context().close();

  // CONTROL: without the param this must still be the SIGN-UP screen, so the
  // assertions above are reading mode, not a page that always says "Sign In".
  const pg2 = await mk(null);
  await pg2.goto('https://hk.test/observe.html?intent=observe', { waitUntil: 'commit' });
  await pg2.waitForTimeout(140);
  const ctl = await pg2.evaluate(() => ({
    title: (document.getElementById('register-title') || {}).textContent || '',
    cls: document.documentElement.className,
  }));
  check('control: sign-up entry is NOT forced into sign-in', !/sign in/i.test(ctl.title) && !/intent-signin/.test(ctl.cls), ctl);
  // The same probe, on the screen where the cross-link belongs: if it can never
  // read true, the sign-in assertion above is measuring nothing. WAITED FOR, not
  // sampled at 140ms -- this is about whether the probe can see the line at all,
  // and the sign-up card is not always laid out that early (1 run in 6).
  const probeSees = await pg2.waitForFunction(() => {
    const el = document.getElementById('signin-line');
    return !!el && el.getClientRects().length > 0;
  }, null, { timeout: 5000 }).then(() => true, () => false);
  check('control: the rendered-probe sees the cross-link on sign-up', probeSees === true, { probeSees });
  await pg2.context().close();
}

await browser.close();
for (const [n, ok] of checks) console.log(ok ? 'PASS' : 'FAIL', n);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);

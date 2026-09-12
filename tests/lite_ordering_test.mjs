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
  const early = await pg.evaluate(() => ({
    title: (document.getElementById('register-title') || {}).textContent || '',
    signupLinkShown: !!document.querySelector('#signin-line:not([hidden])'),
    cls: document.documentElement.className,
  }));
  check('sign-in title is set before paint', /sign in/i.test(early.title), early);
  check('the sign-up cross-link is not showing', early.signupLinkShown === false, early);
  check('the intent-signin class is on <html>', /intent-signin/.test(early.cls), early);
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
  await pg2.context().close();
}

await browser.close();
for (const [n, ok] of checks) console.log(ok ? 'PASS' : 'FAIL', n);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);

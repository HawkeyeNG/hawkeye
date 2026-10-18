/**
 * SIGN-OUT DELETES THE SIGNING KEY, FROM EVERY ENTRY POINT, AND SAYS WHAT IS
 * STILL WAITING (menu.js window.HawkeyeSignOut; review L1, owner decision
 * 18 Oct 2026).
 *
 * profile.html's sign-out used to keep the device key while the menu's deleted
 * it: on an offline shared phone /resume could then sign the first account
 * back in. Both now run ONE implementation. Because a queued report is signed
 * with that key (it can never verify once the key is gone), the confirm says
 * how many reports are waiting, so the observer can stay signed in.
 *
 * Driven in Chromium against the real profile.html (no outbox.js on that page,
 * so the count is read straight from the outbox store). CONTROL: on the code
 * before this change, "confirm deletes the key" fails.
 *
 *   node tests/sign_out_key_test.mjs
 */
import { jwt, launch, serveApp, tally } from './helpers/harness.mjs';

const { base, close } = await serveApp((u, _req, _res, json) => {
  // Keep any seeded report queued if something tries to send it.
  if (u === '/api/submissions') return json({ error: 'busy' }, 503);
  return false;
});
const { check, finish } = tally();
const browser = await launch();

/** Open profile.html signed in, with a device key and `queued` waiting reports. */
async function profileWith(queued) {
  const ctx = await browser.newContext();
  await ctx.addInitScript((tok) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('hawkeye_token', tok);
      localStorage.setItem('hawkeye_tour_seen', '1');
      sessionStorage.setItem('seeded', '1');
    }
  }, jwt());
  const p = await ctx.newPage();
  await p.goto(`${base}/profile.html`);
  await p.waitForFunction(() => typeof document.getElementById('btn-signout')?.onclick === 'function', null, { timeout: 12000 });
  await p.evaluate(async (n) => {
    const open = (name, ver, up) => new Promise((res, rej) => {
      const r = indexedDB.open(name, ver);
      r.onupgradeneeded = () => up(r.result);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const put = (db, store, v, k) => new Promise((res) => {
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(v, k);
      t.oncomplete = res;
    });
    const kv = await open('hawkeye', 1, (db) => { if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); });
    await put(kv, 'kv', { publicJwk: { kty: 'EC' }, privateKey: 'test-key' }, 'keypair');
    kv.close();
    if (n) {
      const ob = await open('hawkeye-outbox', 1, (db) => db.createObjectStore('reports', { keyPath: 'id', autoIncrement: true }));
      for (let i = 0; i < n; i++) await put(ob, 'reports', { fields: { puCode: `30-05-07-00${i}` } });
      ob.close();
    }
  }, queued);
  return { ctx, p };
}
/** Profile's own handler (the button stays hidden until /api/observers/me fills the page). */
const tapSignOut = (p) => p.evaluate(() => { document.getElementById('btn-signout').onclick(); });
/** Replace the dialog with a recorder that answers `yes`. */
const answer = (p, yes) => p.evaluate((y) => {
  window.__asked = null;
  window.hkConfirm = async (body, opts) => { window.__asked = { body, title: opts && opts.title }; return y; };
}, yes);
const state = (p) => p.evaluate(async () => {
  const key = await new Promise((res) => {
    const r = indexedDB.open('hawkeye', 1);
    r.onupgradeneeded = () => {};
    r.onsuccess = () => {
      try {
        const g = r.result.transaction('kv', 'readonly').objectStore('kv').get('keypair');
        g.onsuccess = () => { r.result.close(); res(!!g.result); };
      } catch { r.result.close(); res(false); }
    };
    r.onerror = () => res(null);
  });
  return { token: !!localStorage.getItem('hawkeye_token'), key, page: location.pathname };
});

// 1. Reports waiting, observer cancels: nothing is touched, and the count was shown.
{
  const { ctx, p } = await profileWith(2);
  await answer(p, false);
  await tapSignOut(p);
  await p.waitForFunction(() => window.__asked !== null, null, { timeout: 8000 });
  const asked = await p.evaluate(() => window.__asked);
  check('2 reports waiting: the confirm says how many and that they could never be sent',
    asked, (a) => /: 2\./.test(a.body) && /never be sent/.test(a.body));
  await p.waitForTimeout(400);
  check('...cancel keeps the token AND the key, on the same page', await state(p), (s) => s.token && s.key && s.page.endsWith('/profile.html'));
  await ctx.close();
}

// 2. Reports waiting, observer confirms: token AND key gone, landed on index.html.
{
  const { ctx, p } = await profileWith(2);
  await answer(p, true);
  await Promise.all([p.waitForURL(/index\.html/, { timeout: 10000 }), tapSignOut(p)]);
  check('profile sign-out, confirmed: token removed, signing key DELETED, on index.html',
    await state(p), (s) => !s.token && s.key === false && s.page.endsWith('/index.html'));
  await ctx.close();
}

// 3. Nothing waiting: the ordinary confirm, and the key still goes.
{
  const { ctx, p } = await profileWith(0);
  await answer(p, true);
  await Promise.all([p.waitForURL(/index\.html/, { timeout: 10000 }), tapSignOut(p)]);
  check('nothing waiting: the key is deleted too', await state(p), (s) => !s.token && s.key === false);
  await ctx.close();
}
{
  const { ctx, p } = await profileWith(0);
  await answer(p, false);
  await tapSignOut(p);
  await p.waitForFunction(() => window.__asked !== null, null, { timeout: 8000 });
  check('nothing waiting: the ordinary confirm ("Your reports are unaffected")',
    await p.evaluate(() => window.__asked.body), (b) => /unaffected/.test(b) && !/never be sent/.test(b));
  await ctx.close();
}

await browser.close();
close();
finish();

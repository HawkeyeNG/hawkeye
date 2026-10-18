/**
 * A SIGNED REPORT IS NEVER LEFT ON "SUBMITTING…" AND NEVER SHOWN AS SAVED WHEN
 * IT WAS NOT (pre-election review). observe.html, as the website — the Lite app
 * runs the same app.js.
 *
 *   1. A link that stalls mid-upload. fetch() has no timeout, and the submit
 *      post had none either, so "Submitting…" stayed up with Submit disabled and
 *      the signed report in neither the ledger nor the outbox. Now it is parked
 *      after a deadline, like any offline report.
 *   2. The same during the silent session refresh after a 401 (resume, then the
 *      resend): "Refreshing your session…" stayed up for good.
 *   3. The outbox could not save it (storage full / refused). The failure was
 *      swallowed and the screen said "Saved on your phone" while the photos were
 *      dropped — a report that existed nowhere, shown as safe. Now it says the
 *      report did not go, keeps the photos and leaves Submit live.
 *   4. The same when the store fails at COMMIT (how quota is reported): the
 *      outbox never answered, so the screen hung.
 * CONTROL: offline with a working store is still "Saved on your phone", queued.
 *
 *   node tests/submit_never_stuck_test.mjs
 */
import { jwt, launch, serveApp, tally } from './helpers/harness.mjs';

/** What /api/submissions and /api/observers/resume do in this case. */
let submit = 'hang';
let resume = 'hang';
const { base, close } = await serveApp((u, req, res, json) => {
  if (u === '/api/parties') return json([{ code: 'ZZZ', name: 'Served Party' }]);
  if (u === '/api/contests') return json([{ code: 'GOV', name: 'Governorship', states: ['Osun'], reportingOpen: true }]);
  if (u === '/api/submissions') {
    if (submit === 'hang') return true; // never answers
    if (submit === 'drop') { req.socket.destroy(); return true; }
    if (submit === '401') return json({ error: 'invalid_token' }, 401);
  }
  return u === '/api/observers/resume' && resume === 'hang';
});
const { check, finish } = tally();
const browser = await launch();
const UNIT = { pu_code: '30-05-07-001', name: 'Akepe Street', ward: 'Ward 5', lga: 'Ede North', state: 'Osun', lat: 7.7, lng: 4.4, tier: 'verified' };

/**
 * Sign in, fill a report and press Submit. `store`: 'ok', 'refuse' (the add
 * request errors) or 'commit' (the add succeeds, the transaction aborts — only
 * 'abort' fires). `clock`: install a fake clock so a deadline can be crossed.
 */
async function submitOnce({ store = 'ok', clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 850 } });
  if (clock) await ctx.clock.install();
  await ctx.addInitScript(([tok, store]) => {
    localStorage.setItem('hawkeye_token', tok);
    localStorage.setItem('hawkeye_tour_seen', '1');
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: (ok) => ok({ coords: { latitude: 7.7, longitude: 4.4, accuracy: 5 }, timestamp: Date.now() }),
      watchPosition: () => 0, clearWatch: () => {} } });
    if (store !== 'ok') {
      const add = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...a) {
        if (this.name !== 'reports') return add.apply(this, a);
        const t = this.transaction;
        const r = add.apply(this, a);
        if (store === 'refuse') setTimeout(() => { try { t.abort(); } catch (e) { /* done */ } }, 0);
        else r.addEventListener('success', () => { try { t.abort(); } catch (e) { /* done */ } });
        return r;
      };
    }
  }, [jwt(), store]);
  const p = await ctx.newPage();
  await p.goto(`${base}/observe.html`);
  await p.waitForFunction(() => typeof document.getElementById('btn-submit').onclick === 'function' && !!window.HawkeyeOutbox, null, { timeout: 12000 });
  await p.waitForTimeout(800);
  await p.evaluate((u) => {
    enterReportFlow(); selectUnit(u);
    shots.sheet = { blob: new Blob(['sheet-bytes']), capturedAt: Date.now(), lat: 7.7, lng: 4.4 };
    shots.venue = { blob: new Blob(['venue-bytes']), capturedAt: Date.now(), lat: 7.7, lng: 4.4 };
  }, UNIT);
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    document.getElementById('sel-contest').value = 'GOV';
    document.querySelectorAll('#vote-inputs input').forEach((i) => { i.value = '5'; });
    document.getElementById('btn-submit').onclick();
  });
  return { ctx, p };
}
const state = (p) => p.evaluate(async () => ({
  status: document.getElementById('submit-status').textContent,
  submitLive: !document.getElementById('btn-submit').disabled,
  result: document.getElementById('screen-result').hidden ? null : document.getElementById('result-title').textContent,
  photosKept: !!(shots.sheet && shots.venue),
  queued: await Promise.race([window.HawkeyeOutbox.count(), new Promise((r) => setTimeout(() => r('count hung'), 1500))]),
}));

console.log('=== 1. the upload stalls ===');
{
  submit = 'hang';
  const { ctx, p } = await submitOnce({ clock: true });
  await p.waitForTimeout(1500);
  const before = await state(p);
  check('while it is out: Submitting…, nothing parked yet', [before.result, before.queued], [null, 0]);
  await p.clock.fastForward('02:05');
  await p.waitForTimeout(2000);
  const s = await state(p);
  check('past the deadline the report is parked in the outbox', s.queued, 1);
  check('...and the screen says it is saved on the phone', s.result, 'Saved on your phone');
  await ctx.close();
}

console.log('\n=== 2. the session refresh after a 401 stalls ===');
{
  submit = '401'; resume = 'hang';
  const { ctx, p } = await submitOnce({ clock: true });
  await p.waitForTimeout(1500);
  await p.clock.fastForward('02:05');
  await p.waitForTimeout(2000);
  const s = await state(p);
  check('not left on "Refreshing your session…": the saved screen is up', s.result, 'Saved on your phone');
  check('...the signed report is kept in the outbox', s.queued, 1);
  resume = 'ok';
  await ctx.close();
}

console.log('\n=== 3-4. offline, and the outbox cannot save it ===');
for (const [label, store] of [['the store refuses it', 'refuse'], ['the store fails at commit (quota)', 'commit']]) {
  submit = 'drop';
  const { ctx, p } = await submitOnce({ store });
  await p.waitForTimeout(4000);
  const s = await state(p);
  check(`${label}: NOT shown as saved`, s.result, null);
  check(`${label}: the screen says it did not go`, s.status, (v) => /offline/i.test(v));
  check(`${label}: Submit is live again`, s.submitLive, true);
  check(`${label}: the photos are still here to send`, s.photosKept, true);
  await ctx.close();
}

console.log('\n=== CONTROL: offline with a working store ===');
{
  submit = 'drop';
  const { ctx, p } = await submitOnce();
  await p.waitForTimeout(4000);
  const s = await state(p);
  check('CONTROL: "Saved on your phone", one report queued', [s.result, s.queued], ['Saved on your phone', 1]);
  await ctx.close();
}

await browser.close();
close();
finish();

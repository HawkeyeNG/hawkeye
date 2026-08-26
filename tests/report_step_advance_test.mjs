/**
 * CHOOSING A POLLING UNIT MUST ADVANCE THE REPORT.
 *
 * The shipped report flow broke in a way no observer could diagnose: tapping a
 * polling unit painted the unit's name and then did nothing. No error, no
 * message, no next step. The cause was one undefined identifier —
 * paintSubmitFacts() called `esc()`, which exists only as a closure-local const
 * inside menu.js / practice.js / pu-search.js / race.js and is therefore not a
 * global. The ReferenceError escaped updateSubmitState(), then bindUnit(), so
 * selectUnit() never reached setStepDone(1, …) and step 3 never opened.
 *
 * Two properties are guarded here, because either one alone would have missed it:
 *
 *   1. Step 3 actually OPENS when a unit is chosen. A silent throw looks exactly
 *      like a flow that decided not to advance.
 *   2. ZERO page errors while the report screen loads and a unit is chosen. The
 *      throw was real and uncaught the whole time; nothing was watching for it.
 *
 * Both are driven through the REAL shipped selectUnit(), from a real click
 * handler — the same `btn.onclick = () => selectUnit(u)` the nearby-unit list
 * installs — so an exception surfaces the way it surfaces in the field, as an
 * uncaught error, rather than being swallowed by the harness's own try/catch.
 *
 * Then the geo-msg contract (app/geo-msg.js), because the same screen's other
 * complaint was a 43-word location-failure paragraph, and the fix is a shared
 * helper three pages call. Every branch must be ONE short sentence, and the old
 * address-bar paragraph must be unreachable from any of them.
 *
 * CONTROLS: every assertion below is paired with a case that must FAIL. The
 * step-advance detector is re-run against a deliberately re-broken
 * paintSubmitFacts, and the copy predicate is re-run against the exact old
 * paragraph. A checker that cannot fail is not a checker.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// SHAPE MATTERS. app.js only accepts /api/contests when `Array.isArray(body)`
// (see prepareReportUI) — a {contests:[...]} envelope is silently discarded and
// the picker falls back to the cached list, i.e. empty. Mocked wrong, the race
// half of the submit-facts card can never paint and section 1c below would be
// asserting nothing.
const CONTESTS = [
  { code: 'GOV', name: 'Governorship', states: ['Osun'], reportingOpen: true },
  { code: 'PRES', name: 'Presidential', reportingOpen: true },
];
const PARTIES = [{ code: 'APC', name: 'APC' }, { code: 'PDP', name: 'PDP' }];
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (x) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
  if (u === '/api/contests') return json(CONTESTS);
  if (u === '/api/parties') return json(PARTIES);
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/**
 * Open observe.html the way Hawkeye Lite opens it.
 *
 * The `html.native-app` class is what app/native.js sets inside Capacitor, and
 * this bug was reported from Lite. It is applied with the repo's guarded mark()
 * pattern: an init script runs BEFORE <html> exists, so a bare
 * `document.documentElement.classList.add(...)` throws a null-classList
 * TypeError of the harness's own making and then never applies the class at all.
 */
async function openReport({ geoMsg = false, geoError = null } = {}) {
  const p = await b.newPage({ viewport: { width: 390, height: 850 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await p.addInitScript(() => {
    const mark = () => document.documentElement && document.documentElement.classList.add('native-app');
    mark();
    document.addEventListener('readystatechange', mark);
  });
  if (geoError) {
    await p.addInitScript((code) => {
      const err = { code, message: 'stubbed', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (_ok, bad) => bad && bad(err),
          watchPosition: (_ok, bad) => { if (bad) bad(err); return 1; },
          clearWatch: () => {},
        },
      });
    }, geoError);
  }
  /**
   * PRESENT vs ABSENT, AND WHY THIS IS A ROUTE AND NOT AN INJECTION.
   *
   * When this file was written, observe.html did not yet carry
   * `<script src="geo-msg.js">`, so "present" meant injecting the helper and
   * "absent" meant doing nothing. The pin pass then added the real tag — at
   * which point "absent" stopped being absent, `window.HAWKEYE_GEO` was truthy
   * in BOTH runs, and the loop silently exercised the helper twice while
   * claiming to cover app.js's inline fallback. It surfaced only because the
   * `helper is absent` assertion went red; the three checks after it went on
   * passing, against the wrong branch.
   *
   * So the page now always ships its own tag, and absence is produced by
   * intercepting the request and serving an EMPTY 200. That leaves
   * `window.HAWKEYE_GEO` undefined — exactly the state app.js's fallback exists
   * for — without the console noise an abort or a 404 would add to `errors`.
   */
  if (!geoMsg) {
    await p.route('**/geo-msg.js*', (r) =>
      r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  }
  await p.goto(`${base}/observe.html`);
  await p.waitForTimeout(600);
  return { p, errors };
}

const UNIT = {
  // A name carrying markup on purpose: the old code escaped it by hand with a
  // function that did not exist. Nothing may render as an element, and nothing
  // may throw.
  pu_code: '30-05-07-001',
  name: 'Akepe Street <img src=x onerror="window.__xss=1">',
  ward: 'Ward 5', lga: 'Ede North', state: 'Osun',
  lat: 7.7, lng: 4.4, tier: 'verified',
};

/** Tap a unit exactly as app.js's nearby list does, and read the flow's state. */
const drive = (p, unit) => p.evaluate((u) => {
  const fold = (id) => { const e = document.getElementById(id); return e ? { open: e.open, locked: e.classList.contains('locked'), done: e.classList.contains('done') } : null; };
  // The real handler shape from app.js: `btn.onclick = () => selectUnit(u)`.
  // Dispatched as a CLICK so a throw is reported as an uncaught page error
  // instead of propagating back into this evaluate() and being hidden.
  const btn = document.createElement('button');
  btn.onclick = () => window.selectUnit(u);
  document.body.appendChild(btn);
  btn.click();
  btn.remove();
  const facts = document.getElementById('submit-facts');
  return {
    race: fold('race-fold'),
    unit: fold('unit-fold'),
    unitState: (document.getElementById('unit-fold-state') || {}).textContent || '',
    name: (document.getElementById('submit-pu-name') || {}).textContent || '',
    factsHidden: facts ? facts.hidden : null,
    factsText: facts ? facts.textContent : '',
    factsImgs: facts ? facts.querySelectorAll('img').length : -1,
    xss: window.__xss === 1,
  };
}, unit);

// ---------------------------------------------------------------- 1. the fix
{
  const { p, errors } = await openReport();
  // If the Lite class silently failed to apply, this is the website test wearing
  // the Lite test's name — and Lite is where the bug was reported.
  check('the page is rendering as Hawkeye Lite', await p.evaluate(() => document.documentElement.classList.contains('native-app')));
  check('observe.html exposes the real selectUnit()', await p.evaluate(() => typeof window.selectUnit), 'function');
  check('observe.html exposes the real paintSubmitFacts()', await p.evaluate(() => typeof window.paintSubmitFacts), 'function');

  const r = await drive(p, UNIT);
  console.log('        state after selectUnit:', JSON.stringify(r));

  check('step 3 (choose the election) OPENS', r.race && r.race.open === true && r.race.locked === false);
  check('step 2 (polling unit) is marked done', r.unit && r.unit.done === true);
  check('step 2 summary confirms the unit', r.unitState.startsWith('✔'));
  check('the unit name is on the submit card', r.name.includes('30-05-07-001'));
  check('the submit-facts card is shown', r.factsHidden, false);
  check('submit-facts names the unit and its place', r.factsText.includes('Akepe Street') && r.factsText.includes('Ede North'));
  check('submit-facts renders markup as TEXT, not elements', r.factsImgs === 0 && r.xss === false);
  check('ZERO page errors during load + unit selection', errors, []);
  await p.close();
}

// ------------------------------------------------- 1b. CONTROL for the above
// Re-break paintSubmitFacts exactly the way it shipped — an `esc()` that is not
// defined anywhere in app.js — and require BOTH detectors above to notice. If
// this control passes silently, the test is decorative.
{
  const { p, errors } = await openReport();
  await p.evaluate(() => {
    // eslint-disable-next-line no-undef
    window.paintSubmitFacts = function () { const box = document.getElementById('submit-facts'); box.innerHTML = esc('x'); };
  });
  const r = await drive(p, UNIT);
  check('CONTROL: the broken esc() call throws an uncaught page error', errors.some((e) => /esc is not defined/.test(e)));
  check('CONTROL: with the bug present, step 3 stays shut', !(r.race && r.race.open));
  check('CONTROL: with the bug present, the unit name still paints', r.name.includes('30-05-07-001'));
  await p.close();
}

// ------------------------- 1c. the card names the RACE, not just the unit
/**
 * The card exists to say WHAT IS ABOUT TO BE SIGNED, and half of that is the
 * election. This drives the real flow far enough for the election list to load
 * (enterReportFlow -> prepareReportUI -> fillContests) and then reads the
 * rendered card, because the race line is painted from a DIFFERENT event than
 * the unit line: sel-contest's change handler reaches paintSubmitFacts only
 * indirectly, via updateScopeNotice -> updateSubmitState. A card that names the
 * unit and stays silent about the race would pass every check in section 1.
 */
{
  const { p, errors } = await openReport();
  // ORDER MATTERS: fillContests() returns immediately while `selectedPu` is
  // null, so the picker stays empty until a unit is bound. prepareReportUI()
  // re-fills it when /api/contests lands, which is what this waits for.
  await p.evaluate(() => window.enterReportFlow());
  await p.evaluate((u) => window.selectUnit(u), UNIT);
  await p.waitForFunction(() => {
    const s = document.getElementById('sel-contest');
    return s && [...s.options].some((o) => o.value === 'GOV' && !o.disabled);
  }, null, { timeout: 8000 });

  const read = () => p.evaluate(() => {
    const box = document.getElementById('submit-facts');
    const race = box.querySelector('.sf-race');
    return { hidden: box.hidden, race: race ? race.textContent : null, text: box.textContent };
  });
  const pick = (v) => p.evaluate((code) => {
    const s = document.getElementById('sel-contest');
    s.value = code;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }, v);

  const before = await read();
  check('with no election chosen, the card carries no race line', before.race, null);

  await pick('GOV');
  const gov = await read();
  console.log('        card after choosing an election:', JSON.stringify(gov));
  check('choosing an election names it on the submit card', gov.race, 'Governorship');
  check('the unit is still named alongside it', gov.text.includes('Ede North'));

  await pick('PRES');
  check('changing the election updates the card', (await read()).race, 'Presidential');

  // CONTROL: clearing the election must clear the line. If the card only ever
  // grew, a stale race would sit there describing a choice already undone —
  // which is worse than saying nothing on a screen that signs permanently.
  await pick('');
  check('CONTROL: clearing the election clears the race line', (await read()).race, null);
  check('ZERO page errors while choosing elections', errors, []);
  await p.close();
}

// ------------------------------------------------- 2. the geo-msg contract
/**
 * ONE SENTENCE, and none of what made the old line unreadable.
 *
 * The bar is deliberately mechanical: a single terminal full stop, no
 * parentheses (the old line hid its instructions in a bracketed aside), a length
 * a status line can hold, and none of the address-bar vocabulary.
 */
const OLD_LINE = 'Location denied or unavailable — Hawkeye cannot work without it. If you denied it, allow Location for this site (tap the padlock/ⓘ icon by the address bar → Permissions) and try again.';
function oneShortSentence(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.length > 90) return false;
  if (!s.endsWith('.')) return false;
  if ((s.match(/[.!?](\s|$)/g) || []).length !== 1) return false;
  if (/[()]/.test(s)) return false;
  if (/padlock|address bar|permissions|cannot work without/i.test(s)) return false;
  return true;
}
check('CONTROL: the predicate REJECTS the old paragraph', oneShortSentence(OLD_LINE), false);
check('CONTROL: the predicate ACCEPTS a well-formed line', oneShortSentence('Could not get a GPS fix — try again.'), true);

{
  const { p, errors } = await openReport({ geoMsg: true });
  check('geo-msg.js publishes the agreed contract', await p.evaluate(() => (
    !!(window.HAWKEYE_GEO && typeof window.HAWKEYE_GEO.line === 'function' && typeof window.HAWKEYE_GEO.code === 'function')
  )));

  const branches = await p.evaluate(() => {
    const mk = (code) => (code === null ? null : { code, message: 'stubbed' });
    const out = {};
    for (const [name, code] of [['denied', 1], ['unavailable', 2], ['timeout', 3], ['none', null], ['garbage', 99]]) {
      out[name] = { line: window.HAWKEYE_GEO.line(mk(code)), code: window.HAWKEYE_GEO.code(mk(code)) };
    }
    return out;
  });
  for (const [name, v] of Object.entries(branches)) {
    console.log(`        ${name.padEnd(12)} ${v.code.padEnd(22)} ${JSON.stringify(v.line)}`);
    check(`geo line "${name}" is one short sentence`, oneShortSentence(v.line));
    check(`geo line "${name}" is not the old paragraph`, v.line !== OLD_LINE);
  }
  check('geo codes mirror native', [branches.denied.code, branches.unavailable.code, branches.timeout.code, branches.none.code],
    ['permission_denied', 'position_unavailable', 'gps_timeout', 'location_error']);
  // Native's rule, ported: a TIMEOUT has permission already. Saying "denied" or
  // "allow" there sends someone to a settings screen that is already correct.
  check('a TIMEOUT never blames permission', !/permit|permission|denied|blocked|allow/i.test(branches.timeout.line));
  check('denied and timeout do not share a sentence', branches.denied.line !== branches.timeout.line);
  check('no page errors from loading geo-msg.js', errors, []);
  await p.close();
}

// -------------------------------------- 3. app.js actually uses the new line
for (const [label, geoMsg] of [['with geo-msg.js', true], ['fallback, geo-msg.js absent', false]]) {
  const { p } = await openReport({ geoMsg, geoError: 3 });
  // The two runs must genuinely take different branches of geoLine(). observe.html
  // ships the tag, so the second run blanks it at the network (see openReport)
  // and takes app.js's inline fallback. The `helper is present/absent` assertion
  // below is what proves the two runs really did diverge — without it this loop
  // can quietly test the same branch twice, which is what it did once already.
  check(`the helper is ${geoMsg ? 'present' : 'absent'} (${label})`, await p.evaluate(() => !!window.HAWKEYE_GEO), geoMsg);
  await p.evaluate(() => document.getElementById('btn-locate').click());
  await p.waitForTimeout(300);
  const status = await p.evaluate(() => document.getElementById('locate-status').textContent);
  console.log(`        near-me status (${label}): ${JSON.stringify(status)}`);
  check(`near-me failure is one short sentence (${label})`, oneShortSentence(status));
  check(`near-me failure is not the old paragraph (${label})`, status !== OLD_LINE);
  check(`near-me TIMEOUT does not blame permission (${label})`, !/permission|denied|padlock/i.test(status));
  await p.close();
}
// CONTROL for section 3: the same check, run against a status line forced back
// to the old copy, must fail. Proves the assertion reads the real element and
// is not passing on a stale or empty string.
{
  const { p } = await openReport({ geoMsg: true, geoError: 3 });
  const forced = await p.evaluate((old) => {
    const el = document.getElementById('locate-status');
    el.textContent = old;
    return el.textContent;
  }, OLD_LINE);
  check('CONTROL: the old copy on the real status line FAILS the check', oneShortSentence(forced), false);
  await p.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nAll checks passed');
process.exit(fail ? 1 : 0);

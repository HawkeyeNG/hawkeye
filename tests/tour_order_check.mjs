/* THE TOUR MUST NOT OPEN ON TOP OF THE LANGUAGE PROMPT — INCLUDING LATE.

   tests/tour_test.mjs already asserts the handover (case 12), but it looks 1.5
   seconds in, and the bug was 12 seconds in: menu.js opens the tour on a timer
   as a backstop for lang.js being absent, and that timer did not care that the
   picker was on screen. A reader taking longer than twelve seconds over four
   languages got the tour dropped on the question. Reported twice from a phone.

   Kept as its own file because tour_test.mjs currently dies in loadTour() —
   it evals menu.js's tour block outside a browser and menu.js now reaches for
   the i18n module — so an assertion added there would not run today.

   The fixture is the Lite shell, forced the way tour_test forces it: the tab
   bar only exists in the shell, and the tour is gated on the tab bar.

   Its own control: the tour MUST appear once the prompt is answered. Without
   that, a run where nothing rendered at all would pass. */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const pw = createRequire('/home/elrio/hawkeye/tests/ui/')('playwright-core');
const APP = '/home/elrio/hawkeye/app';
const TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json' };

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
await ctx.addInitScript(() => {
  /* The Capacitor shell: window.HAWKEYE.native is what menu.js reads, and
     html.native-app is added by hand because native.js only adds it when the
     Capacitor bridge is really there. */
  Object.defineProperty(window, 'HAWKEYE', {
    value: { native: true, apiBase: '' }, writable: false, configurable: false,
  });
  const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
  mark();
  document.addEventListener('readystatechange', mark);
  // Signed in, never asked about language, tour never seen: a first run.
  try {
    const body = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }));
    localStorage.setItem('hawkeye_token', 'x.' + body + '.y');
  } catch (e) { /* private mode */ }
});
const pg = await ctx.newPage();
pg.on('dialog', (d) => d.dismiss().catch(() => {}));
await pg.route('https://hk.test/**', (r) => {
  const p = new URL(r.request().url()).pathname;
  if (p.startsWith('/api/')) return r.fulfill({ contentType: TYPES.json, body: '{}' });
  const f = APP + (p === '/' ? '/index.html' : p);
  if (!existsSync(f)) return r.fulfill({ status: 404, body: '' });
  return r.fulfill({ contentType: TYPES[p.split('.').pop()] || 'application/octet-stream', body: readFileSync(f) });
});

/* offsetParent is null for a fixed-position element and both of these are
   fixed, so visibility is measured, not inferred. */
const shown = (sel) => pg.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}, sel);

let bad = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('PASS  ' + label); return; }
  console.log('FAIL  ' + label + '\n        got   ' + got + '\n        want  ' + want);
  bad++;
};

await pg.goto('https://hk.test/index.html', { waitUntil: 'load' });
await pg.waitForTimeout(2500);
check('the language picker is up on a first run', await shown('#lang-modal'), true);
check('and the tour is not', await shown('.tour-card'), false);

await pg.waitForTimeout(13000);
check('still no tour once the 12s backstop has passed', await shown('.tour-card'), false);
check('and the picker is still up', await shown('#lang-modal'), true);

await pg.click('#lang-cancel');
await pg.waitForTimeout(1200);
check('dismissing the picker closes it', await shown('#lang-modal'), false);
check('CONTROL: and hands over to the tour', await shown('.tour-card'), true);

await browser.close();
console.log(bad ? '\n' + bad + ' failed' : '\nall passed');
process.exit(bad ? 1 : 0);

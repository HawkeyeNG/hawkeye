/**
 * THE TOUR MUST DESCRIBE THE APP THAT EXISTS.
 *
 * A first-run tour is the one screen nobody on the team ever sees again after
 * the first launch, so it is the first thing to go stale — a tab gets renamed or
 * reordered and the tour keeps confidently pointing at it. This holds the tour's
 * steps against the REAL tab bar in (tabs)/_layout.tsx: same five, same order,
 * same icons.
 *
 * It also runs the shipped storage gate against a stubbed AsyncStorage, because
 * the gate has exactly one job — show it once — and its failure mode (a throw)
 * must open, not repeat.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = '/home/elrio/hawkeye';
const require_ = createRequire(`${ROOT}/native/`);
const { transform } = require_('sucrase');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ---- load the shipped tour module, with AsyncStorage stubbed --------------
const SRC = `${ROOT}/native/src/lib/tour.ts`;
const code = transform(fs.readFileSync(SRC, 'utf8'), {
  transforms: ['typescript', 'imports'],
  filePath: SRC,
}).code;

function loadTour(store) {
  const module_ = { exports: {} };
  const fakeRequire = (id) =>
    id.includes('async-storage') ? { default: store, __esModule: true } : {};
  new Function('require', 'module', 'exports', 'process', code)(
    fakeRequire, module_, module_.exports, { env: {} },
  );
  return module_.exports;
}

const memStore = () => {
  const m = new Map();
  return {
    getItem: async (k) => (m.has(k) ? m.get(k) : null),
    setItem: async (k, v) => void m.set(k, v),
    removeItem: async (k) => void m.delete(k),
    _map: m,
  };
};
const brokenStore = {
  getItem: async () => { throw new Error('storage is gone'); },
  setItem: async () => { throw new Error('storage is gone'); },
  removeItem: async () => { throw new Error('storage is gone'); },
};

console.log('=== the tour describes the tab bar that exists ===');
const layout = fs.readFileSync(`${ROOT}/native/src/app/(tabs)/_layout.tsx`, 'utf8');
// Pull the real tabs out of the layout, in the order they are declared.
const tabs = [...layout.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]);
const tabIcons = [...layout.matchAll(/tabBarIcon:[^\n]*Feather name="([^"]+)"/g)].map((m) => m[1]);
check('the layout still declares five tabs', tabs, ['Home', 'Results', 'Report', 'Alerts', 'More']);

const tour = loadTour(memStore());
const steps = tour.TOUR_STEPS;
check('one step per tab', steps.length, tabs.length);
check(
  'each step names its tab, in tab order',
  steps.map((s) => s.title.split(' —')[0]),
  tabs,
);
// Icons: the four navigable tabs render theirs through tabBarIcon; Report's is
// drawn by hand inside its custom raised button, so it is asserted separately.
check('step icons match the tab bar icons', steps.filter((_, i) => i !== 2).map((s) => s.icon), tabIcons);
check('the Report step uses the camera the raised button draws',
  steps[2].icon === 'camera' && /name="camera"/.test(layout), true);

console.log('\n=== what the tour is allowed to say ===');
const all = steps.map((s) => `${s.title} ${s.body}`).join(' ');
// The one claim this product must never make, anywhere.
check('no step claims an INEC or government relationship',
  /\b(official|on behalf of|in partnership with|authoris|authoriz)/i.test(all), false);
check('every step has a body', steps.every((s) => s.body && s.body.length > 20), true);
// The green button is the whole point of the app; if the tour says nothing else
// it must say that.
check('the middle button is explained', /green button/i.test(all), true);

console.log('\n=== the gate shows it once ===');
{
  const store = memStore();
  const t = loadTour(store);
  check('a fresh device sees it', await t.shouldShowTour(), true);
  await t.markTourSeen();
  check('and not again', await t.shouldShowTour(), false);
  check('skipping and finishing write the same flag', store._map.get('hawkeye_tour_seen'), '1');
  await t.resetTour();
  check('More -> Take the tour can replay it', await t.shouldShowTour(), true);
}

console.log('\n=== dismissing it is effective IMMEDIATELY, not eventually ===');
{
  /**
   * THE BUG THIS EXISTS FOR. AsyncStorage is asynchronous and the dismissal is
   * not. Closing the tour re-renders the screen it sits on, and a re-render that
   * remounts the component re-runs shouldShowTour() — which, with the write
   * still in flight, read `null` and REOPENED THE TOUR AT STEP ONE. Seen in the
   * running app: the flag ended up written and the first card was back.
   *
   * A store whose write never resolves reproduces that window exactly.
   */
  const pending = {
    getItem: async () => null,           // storage still says "never seen"
    setItem: () => new Promise(() => {}), // ...and the write never lands
    removeItem: async () => {},
  };
  const t = loadTour(pending);
  check('a fresh device sees it', await t.shouldShowTour(), true);
  void t.markTourSeen();                  // not awaited — the app does not await it
  check('and a remount mid-write does NOT reopen it', await t.shouldShowTour(), false);
  // Replay must still clear the in-memory flag, not just the stored one.
  await t.resetTour();
  check('and Take the tour still replays after that', await t.shouldShowTour(), true);
}

console.log('\n=== and fails CLOSED, never repeating ===');
{
  const t = loadTour(brokenStore);
  // The dangerous direction is `true`: with a broken store the write also fails,
  // so a gate that opened on error would show the tour on every single launch,
  // forever, to everybody.
  check('an unreadable flag shows nobody the tour', await t.shouldShowTour(), false);
  let threw = false;
  try { await t.markTourSeen(); await t.resetTour(); } catch { threw = true; }
  check('and no storage error ever escapes', threw, false);
}

console.log('\n=== control: the assertions can fail ===');
{
  // If the tab scrape returned nothing, every comparison above would be
  // comparing two empty lists and passing vacuously.
  check('the layout scrape actually found tabs', tabs.length > 0 && tabIcons.length > 0, true);
  check('and the step list is not empty', steps.length > 0, true);
  // A deliberately wrong tour must be rejected by the same rule.
  const wrong = [...steps.map((s) => s.title.split(' —')[0])].reverse();
  check('a reordered tour would be caught', JSON.stringify(wrong) === JSON.stringify(tabs), false);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

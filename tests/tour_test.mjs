/**
 * THE TOUR MUST DESCRIBE THE APP THAT EXISTS — IN BOTH CLIENTS.
 *
 * A first-run tour is the one screen nobody on the team ever sees again after
 * the first launch, so it is the first thing to go stale — a tab gets renamed or
 * reordered and the tour keeps confidently pointing at it. That was already true
 * of one client. It is twice as true now that the tour ships in two: the React
 * Native app and Hawkeye Lite, the Capacitor shell that bundles app/ verbatim
 * and builds its tour in app/menu.js.
 *
 * PART ONE — NATIVE. Holds the tour's steps against the REAL tab bar in
 * (tabs)/_layout.tsx: same five, same order, same icons, each step pointing at
 * the tab it claims to describe. It also runs the shipped storage gate against a
 * stubbed AsyncStorage, because the gate has exactly one job — show it once —
 * and its failure mode (a throw) must show nobody, not everybody.
 *
 * PART TWO — LITE. Renders app/index.html in headless chromium with the Lite
 * shell forced on and checks what a reader actually sees. Its load-bearing
 * assertion is that the five cards' titles and bodies are IDENTICAL to
 * TOUR_STEPS as loaded from native/src/lib/tour.ts in Part One — the real
 * exported array, not a copy typed into this file. Reword one client and this
 * goes red; reword both and it stays green, which is the only definition of
 * "the same tour" that survives contact with two codebases.
 *
 * Everything else in Part Two is measured off the RENDERED page rather than read
 * out of the source, because each of those behaviours is something a reader can
 * see and a source-reading test cannot: the gold ring is detected by the
 * COMPUTED box-shadow on the real tab, "the tab bar is not dimmed" is proved in
 * PIXELS (an unlit tab must render byte-identically with the scrim there and
 * with it removed), and every colour on the card is read back computed and
 * compared with the palette parsed out of native/src/global.css.
 *
 * NOT DIMMED IS NOT THE SAME AS LIVE, and this file used to conflate them. It
 * asserted that elementFromPoint over each tab returned the tab — i.e. that the
 * bar was still tappable through the gap — and that was wrong twice over. It is
 * not what native does (its tour is an RN <Modal>, a separate full-screen window
 * whose unpainted strip is visible but takes no touches — modal-card.tsx: "no
 * scrim, no touch capture"), and it shipped three bugs: a tab tap navigated away
 * mid-tour with the seen flag unwritten, the ringed Report circle opened the
 * report sheet UNDERNEATH the scrim, and More opened the menu panel behind it.
 * The assertion is now the pair the brief actually asks for: the bar is UNDIMMED
 * and the bar is SEALED.
 *
 * CONTROLS. This repo has a documented history of checkers that could not fail,
 * so both parts end by firing their load-bearing detectors at deliberately wrong
 * values, which must come back red. A control that passes is itself a failure.
 *
 * Run: node tests/tour_test.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = '/home/elrio/hawkeye';
/** sucrase lives in the app's own tree; playwright in the UI-test tree. */
const requireNative = createRequire(`${ROOT}/native/`);
const requireUi = createRequire(`${ROOT}/tests/ui/`);
const { transform } = requireNative('sucrase');
const { chromium } = requireUi('playwright-core');

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`
    + (ok ? '' : `\n        got   ${JSON.stringify(got)}\n        want  ${JSON.stringify(want)}`));
};
/**
 * A control asserts that a check CAN go red. `passed` is the result of running
 * the same comparison the real check runs, against a value that is deliberately
 * wrong; it must be false. A control that comes back true means the detector is
 * a no-op.
 */
const control = (label, passed) => {
  if (passed) { fail++; console.log(`FAIL  CONTROL ${label} — the detector accepted a deliberately WRONG value`); }
  else console.log(`PASS  CONTROL ${label} — the detector rejects a deliberately wrong value`);
};

/* ==========================================================================
   PART ONE — NATIVE
   ========================================================================== */

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
/** The `name=` each Tabs.Screen is registered under — what a step's `route` is. */
const layoutRoutes = [...layout.matchAll(/<Tabs\.Screen\s+name="([a-z]+)"/g)].map((m) => m[1]);
/**
 * The four navigable tabs now render their glyph through the local <Glyph>
 * wrapper (it is what draws the tour's ring), so the icon name sits on that tag
 * rather than on a bare <Feather>. Report's is still drawn by hand inside its
 * custom raised button, so it is filled in separately.
 */
const glyphs = new Map(
  [...layout.matchAll(/<Glyph route="([a-z]+)" name="([^"]+)"/g)].map((m) => [m[1], m[2]]),
);
const tabIcons = layoutRoutes.map((r) => (
  glyphs.has(r) ? glyphs.get(r) : (/name="camera"/.test(layout) ? 'camera' : null)
));
check('the layout still declares five tabs', tabs, ['Home', 'Results', 'Report', 'Alerts', 'More']);
check('and registers them under the five routes the tour names',
  layoutRoutes, ['index', 'results', 'report', 'alerts', 'more']);

const tour = loadTour(memStore());
const steps = tour.TOUR_STEPS;
check('one step per tab', steps.length, tabs.length);
check(
  'each step names its tab, in tab order',
  steps.map((s) => s.title.split(' —')[0]),
  tabs,
);
check('step icons match the tab bar icons', steps.map((s) => s.icon), tabIcons);
check('the Report step uses the camera the raised button draws',
  steps[2].icon === 'camera' && /name="camera"/.test(layout), true);
/**
 * EACH STEP POINTS AT THE TAB IT DESCRIBES. Positional order used to be the only
 * link between the two, which meant reordering the steps silently pointed every
 * one of them at the wrong tab; `route` is now explicit, and this is the check
 * that keeps it honest against the layout.
 */
check('each step carries the route of the tab it is about', steps.map((s) => s.route), layoutRoutes);
check('exactly one step is flagged as the CTA, and it is Report',
  steps.filter((s) => s.cta).map((s) => s.route), ['report']);

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

console.log('\n=== control: the native assertions can fail ===');
{
  // If the tab scrape returned nothing, every comparison above would be
  // comparing two empty lists and passing vacuously.
  check('the layout scrape actually found tabs', tabs.length > 0 && layoutRoutes.length > 0, true);
  check('and actually found the glyph names', glyphs.size, 4);
  check('and the step list is not empty', steps.length > 0, true);
  // A deliberately wrong tour must be rejected by the same rule.
  const wrong = [...steps.map((s) => s.title.split(' —')[0])].reverse();
  check('a reordered tour would be caught', JSON.stringify(wrong) === JSON.stringify(tabs), false);
  control('route parity — a step pointing at the wrong tab must go red',
    JSON.stringify([...steps.map((s) => s.route)].reverse()) === JSON.stringify(layoutRoutes));
}

/* ==========================================================================
   PART TWO — HAWKEYE LITE (app/menu.js + app/styles.css, rendered)
   ========================================================================== */

/**
 * The nonpartisan paragraph is JSX prose rather than an export, so it is the one
 * string here that has to be scraped instead of imported. Whitespace-collapsed,
 * because JSX wraps it across four source lines and renders it as one.
 */
function nativeNote() {
  const src = fs.readFileSync(`${ROOT}/native/src/components/tour.tsx`, 'utf8');
  const m = /text-faint">\s*([\s\S]*?)\s*<\/Text>/.exec(src);
  if (!m) throw new Error('the nonpartisan paragraph was not found in tour.tsx');
  return m[1].replace(/\s+/g, ' ').trim();
}
const NOTE = nativeNote();

/**
 * The only translation in this file: native names its tabs by the `name=` of
 * each Tabs.Screen, Lite names them by the tab's href in app/menu.js. Kept
 * explicit and tiny so a reader can see the two shells are being asked about the
 * same five tabs in the same order.
 */
const HREF = { index: 'index.html', results: 'results.html', report: 'observe.html', alerts: 'notifications.html', more: '#more' };

console.log('\n=== Lite: the specification it must match ===');
check('the nonpartisan paragraph parsed out of tour.tsx and names INEC',
  NOTE, (v) => v.length > 80 && v.includes('INEC'));
for (const s of steps) console.log(`        ${s.route.padEnd(8)} ${JSON.stringify(s.title)}`);

/* ------------------------------------------------------------------ server */
const APP = `${ROOT}/app`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  if (u.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/**
 * Open index.html the way a reader meets it.
 *
 * `lite` forces the Capacitor shell: window.HAWKEYE.native is what menu.js's
 * isAppShell() reads, and it is defined NON-WRITABLE so app/native.js's own
 * `window.HAWKEYE = {...}` (which would set native:false in a browser) is a
 * silent no-op — native.js then returns at its `if (!native) return`, so none of
 * the Capacitor-only machinery runs. html.native-app is added by hand because
 * that is the one line of native.js this skips.
 *
 * A token is seeded because index.html in the shell is TWO screens: signed out
 * it is the welcome/auth screen, which hides the tab bar, and the tour's five
 * cards are about that bar. Signed in it is the observer home — the web twin of
 * native's (tabs)/index, and the screen the tour is specified to open on.
 *
 * It has to be a WELL-FORMED JWT with a future exp, not a placeholder string:
 * app/authgate.js decodes the payload and, in the app shell, redirects
 * index.html to the sign-in funnel for anything it cannot parse. A test seeded
 * with "test-token" never reaches Home at all — it lands on observe.html and
 * every assertion below reports the absence of a tour on the wrong page.
 */
const JWT = () => {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64');
  return `x.${body}.y`;
};

async function shell({ lite = true, seen = false, faultStorage = false, width = 390 } = {}) {
  const ctx = await b.newContext({ viewport: { width, height: 780 } });
  await ctx.addInitScript((o) => {
    if (o.lite) {
      Object.defineProperty(window, 'HAWKEYE', {
        value: { native: true, apiBase: '' }, writable: false, configurable: false,
      });
      const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
      mark();
      document.addEventListener('readystatechange', mark);
    }
    try { localStorage.setItem('hawkeye_token', o.token); } catch (e) { /* ignore */ }
    if (o.seen) { try { localStorage.setItem('hawkeye_tour_seen', '1'); } catch (e) { /* ignore */ } }
    if (o.faultStorage) {
      // ONLY the tour's own key. A globally throwing getItem would take out
      // menu.js's very first line (the theme read) and abort the whole script,
      // and "the tour did not open" would then be true for the wrong reason.
      const real = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) {
        if (k === 'hawkeye_tour_seen') throw new Error('storage fault (test)');
        return real.call(this, k);
      };
    }
  }, { lite, seen, faultStorage, token: JWT() });
  const p = await ctx.newPage();
  await p.goto(`${base}/index.html`);
  await p.waitForTimeout(500);
  return { ctx, p };
}

/** What the open card says. null when no card is showing. */
const card = (p) => p.evaluate(() => {
  const t = document.querySelector('.tour');
  if (!t || t.hidden) return null;
  const q = (s) => t.querySelector(s);
  const note = q('.tour-note');
  const chip = q('.tour-chip');
  const glyph = q('.tour-chip svg');
  const skip = q('.tour-skip');
  const next = q('.tour-next');
  return {
    title: q('#tour-title').textContent,
    name: q('.tour-name').textContent,
    body: q('.tour-text').textContent,
    note: note.hidden ? '' : note.textContent.replace(/\s+/g, ' ').trim(),
    skip: skip.textContent,
    next: next.textContent,
    dots: [...t.querySelectorAll('.tour-dots span')].map((d) => d.classList.contains('on')),
    chipBg: getComputedStyle(chip).backgroundColor,
    chipInk: glyph ? getComputedStyle(glyph).color : '(no glyph)',
    skipW: Math.round(skip.getBoundingClientRect().width),
    nextW: Math.round(next.getBoundingClientRect().width),
  };
});

/**
 * WHICH TABS ARE RINGED, read off the rendered page.
 *
 * The gold ring is a computed box-shadow on the tab's own icon slot, so this
 * looks for the colour rather than for a class — a class name is a claim, a
 * computed shadow is what the reader sees.
 */
const ringed = (p) => p.evaluate(() => {
  const GOLD = 'rgb(245, 179, 1)';
  return [...document.querySelectorAll('.tabbar .tab')].map((t) => {
    const ti = t.querySelector('.ti');
    return ti && getComputedStyle(ti).boxShadow.includes(GOLD) ? t.getAttribute('href') : null;
  }).filter(Boolean);
});

/**
 * IS THE TAB BAR SEALED OFF? A hit test at the centre of every tab, plus one two
 * pixels below the top of the raised Report circle — the pixel the scrim would
 * clip first if the gap forgot the CTA's overhang. Each answer is true when the
 * pointer meets the TOUR there, which is what native's modal window does with
 * the same strip: the reader can see the bar, and cannot press it.
 */
const barSealed = (p) => p.evaluate(() => {
  const bar = document.querySelector('.tabbar');
  if (!bar) return ['(no tab bar)'];
  const at = (x, y) => {
    const el = document.elementFromPoint(Math.round(x), Math.round(y));
    return !!(el && el.closest && el.closest('.tour'));
  };
  const out = [...bar.querySelectorAll('.tab')].map((t) => {
    const r = t.getBoundingClientRect();
    return at(r.left + r.width / 2, r.top + r.height / 2);
  });
  const cta = bar.querySelector('.tab-cta .ti');
  if (cta) { const r = cta.getBoundingClientRect(); out.push(at(r.left + r.width / 2, r.top + 2)); }
  return out;
});

/**
 * DOES THE SCRIM STOP SHORT OF THE BAR? Geometry, per card, because --tour-gap
 * is recomputed on every paint: the dimmed layer's bottom edge must sit above
 * the bar AND above the raised Report circle, whose ring overhangs it.
 */
const scrimClear = (p) => p.evaluate(() => {
  const sc = document.querySelector('.tour-backdrop').getBoundingClientRect();
  const bar = document.querySelector('.tabbar').getBoundingClientRect();
  const cta = document.querySelector('.tabbar .tab-cta .ti').getBoundingClientRect();
  return { aboveTheBar: sc.bottom <= bar.top, clearOfTheCtaRing: sc.bottom <= cta.top };
});

/** A real tap at the centre of a real tab, bypassing Playwright's actionability
 *  checks — the point is precisely what happens when something is in the way. */
const tapTab = async (p, href) => {
  const r = await p.evaluate((h) => {
    const b = document.querySelector(`.tabbar .tab[href="${h}"]`).getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  }, href);
  await p.mouse.click(r.x, r.y);
  await p.waitForTimeout(250);
};

/** What has focus, and what it is painting. */
const focusState = (p) => p.evaluate(() => {
  const a = document.activeElement;
  const cs = getComputedStyle(a);
  return { on: a.className || a.tagName, outline: cs.outlineStyle, colour: cs.outlineColor };
});

/** Every colour the tour paints, computed, plus the ring's two on the live bar. */
const inks = async (p, dark) => {
  await p.evaluate((d) => {
    if (d) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }, dark);
  return p.evaluate(() => {
    const t = document.querySelector('.tour');
    const cs = (s) => getComputedStyle(t.querySelector(s));
    const ring = getComputedStyle(document.querySelector('.tabbar .tab.tour-lit .ti'));
    return {
      chipBg: cs('.tour-chip').backgroundColor,
      chipInk: cs('.tour-chip svg').color,
      dotOn: cs('.tour-dots span.on').backgroundColor,
      dotOff: cs('.tour-dots span:not(.on)').backgroundColor,
      nextBg: cs('.tour-next').backgroundColor,
      nextInk: cs('.tour-next').color,
      ringBg: ring.backgroundColor,
      ringInk: ring.color,
    };
  });
};

/**
 * NATIVE'S PALETTE, PARSED — never retyped, for the same reason the strings are
 * parsed: two clients drift silently otherwise. The values are RGB triplets so
 * Tailwind can apply opacity modifiers, which makes them trivial to turn into
 * the `rgb(r, g, b)` a computed style returns.
 */
function nativeTokens(theme) {
  const src = fs.readFileSync(`${ROOT}/native/src/global.css`, 'utf8');
  const block = theme === 'dark'
    ? /\.theme-dark\s*\{([\s\S]*?)\n\}/.exec(src)
    : /:root,\s*\.theme-light\s*\{([\s\S]*?)\n\}/.exec(src.replace(/,\s*\n\s*\./g, ', .'));
  if (!block) throw new Error(`native's ${theme} palette was not found in global.css`);
  const out = {};
  for (const m of block[1].matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    out[m[1]] = `rgb(${m[2]}, ${m[3]}, ${m[4]})`;
  }
  return out;
}
/** BRAND.green / BRAND.gold, from the app's own constants, as computed colours. */
function brand() {
  const src = fs.readFileSync(`${ROOT}/native/src/lib/api.ts`, 'utf8');
  const b = /export const BRAND = \{([\s\S]*?)\}/.exec(src);
  if (!b) throw new Error('BRAND was not found in api.ts');
  const out = {};
  for (const m of b[1].matchAll(/(\w+):\s*'#([0-9a-f]{6})'/gi)) {
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(m[2].slice(i, i + 2), 16));
    out[m[1]] = `rgb(${r}, ${g}, ${bl})`;
  }
  return out;
}
const BRAND = brand();

/** The menu panel's "Learn & about" group, as rendered. */
const learnGroup = (p) => p.evaluate(() => {
  const panel = document.getElementById('menu-panel');
  const head = [...panel.querySelectorAll('.menu-group')].find((h) => h.textContent.trim() === 'Learn & about');
  if (!head) return { group: false };
  const rows = [];
  for (let el = head.nextElementSibling; el && !el.classList.contains('menu-group'); el = el.nextElementSibling) {
    rows.push({ text: el.textContent.trim(), href: el.getAttribute && el.getAttribute('href') });
  }
  return { group: true, rows, anyTourAnchor: !!panel.querySelector('a[href="#tour"]') };
});

const openMenu = (p) => p.evaluate(() => {
  const panel = document.getElementById('menu-panel');
  if (panel) panel.hidden = false;
});

/* ========================= before anything opens: a CLOSED tour is out of the way */
/**
 * THE PRICE OF SEALING THE BAR. The layer is built on EVERY page of the shell
 * and now catches pointers, so it is only harmless while `.tour[hidden]
 * { display: none }` outranks `.tour` — the scoped-display trap this codebase
 * has hit before. If that ever flipped, the whole app would be dead under an
 * invisible sheet, and every other check in this file would miss it: they all
 * run with the tour OPEN.
 *
 * FIRST in Part Two, deliberately. That regression makes every click anywhere
 * time out, so a later placement would end the run in a Playwright stack trace
 * with nothing reported. Here it produces three red lines and a name.
 */
console.log('\n=== Lite: a closed tour intercepts nothing ===');
{
  const { ctx, p } = await shell({ seen: true });
  const hits = () => p.evaluate(() => ({
    display: getComputedStyle(document.querySelector('.tour')).display,
    tabs: [...document.querySelectorAll('.tabbar .tab')].map((tab) => {
      const r = tab.getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return el && el.closest('.tour') ? 'tour' : (el && el.closest('.tabbar') ? 'tab' : 'elsewhere');
    }),
    centre: (() => {
      const el = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      return el && el.closest('.tour') ? 'tour' : 'page';
    })(),
  }));
  const shut = { display: 'none', tabs: ['tab', 'tab', 'tab', 'tab', 'tab'], centre: 'page' };
  check('on Home with the flag set: nothing of the tour is in the way', await hits(), shut);
  await p.goto(`${base}/results.html`);
  await p.waitForTimeout(400);
  check('nor on another shell page, where the layer is built but never opens', await hits(), shut);
  await tapTab(p, 'notifications.html');
  check('and a tab tap with no tour open still navigates, as it always did',
    await p.evaluate(() => location.pathname), '/notifications.html');
  // Shown in its own tick, then measured after a frame: Chromium's hit-test
  // tree lags a style flip made in the SAME evaluate — elementFromPoint answers
  // <html> for a moment, which would make this control look like a product
  // fact. (It never affects the real checks above: those run on a tour that has
  // been on screen for half a second.)
  await p.evaluate(() => { document.querySelector('.tour').hidden = false; });
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await p.waitForTimeout(500);
  const forced = await hits();
  control('the same hit test must go red the moment the layer really is showing',
    JSON.stringify(forced) === JSON.stringify(shut));
  check('control sanity: shown, it covers every tab and the page behind',
    forced, { display: 'flex', tabs: ['tour', 'tour', 'tour', 'tour', 'tour'], centre: 'tour' });
  await ctx.close();
}

/* ============================================================ first run */
console.log('\n=== Lite, first run ===');
{
  const { ctx, p } = await shell();
  check('precondition: on Home, in the Lite shell, with the tab bar rendered',
    await p.evaluate(() => ({
      page: location.pathname,
      lite: document.documentElement.classList.contains('native-app') && !!(window.HAWKEYE && window.HAWKEYE.native),
      barShown: !!document.querySelector('.tabbar') && getComputedStyle(document.querySelector('.tabbar')).display !== 'none',
      tabs: [...document.querySelectorAll('.tabbar .tab')].map((t) => t.getAttribute('href')),
    })),
    {
      page: '/index.html',
      lite: true,
      barShown: true,
      tabs: ['index.html', 'results.html', 'observe.html', 'notifications.html', '#more'],
    });

  const c1 = await card(p);
  check('1. the tour opens by itself, unprompted', !!c1);
  check('1. its title is "Welcome to Hawkeye"', c1 && c1.title, 'Welcome to Hawkeye');
  check('1. it opens on card 1 (first dot lit)', c1 && c1.dots, [true, false, false, false, false]);

  for (let i = 0; i < steps.length; i += 1) {
    const want = steps[i];
    const c = await card(p);
    const n = i + 1;
    check(`2. card ${n} title is native's TOUR_STEPS[${i}].title, verbatim`, c && c.name, want.title);
    check(`2. card ${n} body is native's TOUR_STEPS[${i}].body, verbatim`, c && c.body, want.body);
    check(`2. card ${n} of five is marked as such`, c && c.dots, steps.map((_, k) => k === i));
    check(`3. the nonpartisan paragraph is ${i === 0 ? 'on card 1' : `absent from card ${n}`}`,
      c && c.note, i === 0 ? NOTE : '');
    check(`5. card ${n} rings exactly the ${want.route} tab, and only it`,
      await ringed(p), [HREF[want.route]]);
    check(`6. card ${n}: the scrim stops above the bar and clear of the CTA's ring`,
      await scrimClear(p), { aboveTheBar: true, clearOfTheCtaRing: true });
    check(`6. card ${n}: and the bar is sealed — every tab, and the CTA's overhang, meets the tour`,
      await barSealed(p), [true, true, true, true, true, true]);
    if (want.cta) {
      check('7. the Report chip is hawk green', c && c.chipBg, 'rgb(0, 66, 37)');
      check('7. the Report chip glyph is BRAND.gold', c && c.chipInk, 'rgb(245, 179, 1)');
    } else {
      check(`7. card ${n} keeps the neutral chip (not the green CTA)`, c && c.chipBg !== 'rgb(0, 66, 37)');
    }
    const last = i === steps.length - 1;
    check(`4. card ${n} buttons read ${last ? '"Close" / "Start observing"' : '"Skip tour" / "Next"'}`,
      c && [c.skip, c.next], last ? ['Close', 'Start observing'] : ['Skip tour', 'Next']);
    check(`4. card ${n} buttons are equal width`, c && Math.abs(c.skipW - c.nextW) <= 1);
    if (!last) await p.click('.tour-next');
  }

  // --- CONTROLS ----------------------------------------------------------
  // Three detectors carry this block: the ring, the string parity and the seal.
  // Each is now fired at a deliberately wrong value, running the SAME comparison
  // the real check runs, and each must come back red. (The fourth, "not dimmed",
  // is a pixel comparison and carries its own control where it is made.)
  console.log('\n=== control: the Lite assertions can fail ===');
  await p.click('.tour-skip');                    // "Close" on card 5 → shut, flag written
  await openMenu(p);
  await p.click('#menu-panel a[href="#tour"]');   // a genuine, freshly painted card 1
  const good = await card(p);
  check('control setup: a real card 1 is open and ringing the Home tab',
    [good && good.name, await ringed(p)], [steps[0].title, [HREF.index]]);

  await p.evaluate(() => {
    document.querySelectorAll('.tabbar .tab').forEach((x) => x.classList.remove('tour-lit'));
    document.querySelector('.tabbar .tab[href="results.html"]').classList.add('tour-lit');
  });
  const wrongRing = await ringed(p);
  control('ring — "card 1 rings index.html" must go red when a different tab is lit',
    JSON.stringify(wrongRing) === JSON.stringify([HREF.index]));
  check('control sanity: the detector reports the tab that is actually lit', wrongRing, ['results.html']);

  control('string parity — the same comparison against a reworded native body must go red',
    good.body === `${steps[0].body} (reworded)`);
  check('control sanity: it does still match the unaltered native body', good.body, steps[0].body);

  await p.evaluate(() => { document.querySelector('.tour').style.pointerEvents = 'none'; });
  const leaky = await barSealed(p);
  control('the seal — a layer that lets pointers through to the bar must go red',
    leaky.every(Boolean));
  check('control sanity: with the layer made transparent to pointers the bar really is exposed',
    leaky.some((v) => v === false));

  await ctx.close();
}

/* ============================== the bar is shown, not handed over */
/**
 * THE THREE BUGS THE OLD "still reachable through the scrim" ASSERTION REQUIRED.
 * A live tab bar under an open tour is not a smaller version of native's; it is
 * a different thing, and each of these was reproduced before the fix.
 */
console.log('\n=== Lite: the bar is SHOWN, not handed over ===');
{
  const { ctx, p } = await shell();
  check('precondition: card 1 is open on Home', ((await card(p)) || {}).name, steps[0].title);

  await tapTab(p, 'results.html');
  check('tapping a tab does not navigate away mid-tour',
    await p.evaluate(() => location.pathname), '/index.html');
  check('...the card is still the one that was open', ((await card(p)) || {}).name, steps[0].title);
  check('...and nothing has written the seen flag, because nothing was dismissed',
    await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen')), null);

  // Advance only while there is something to advance. A regression here CLOSES
  // the tour (the old build let a tab tap navigate away), and clicking a hidden
  // button would end the run in a Playwright timeout — the later checks would
  // then be missing rather than red, which is the worse of the two failures.
  const nextCard = async () => {
    if (await p.evaluate(() => !document.querySelector('.tour').hidden)) await p.click('.tour-next');
  };
  await nextCard();
  await nextCard();
  check('precondition: the Report card, ringing the green button', ((await card(p)) || {}).name, steps[2].title);
  await tapTab(p, 'observe.html');
  check('tapping the ringed Report circle does NOT open the report sheet behind the scrim',
    await p.evaluate(() => document.querySelector('.report-sheet').hidden), true);
  check('...and the tour is still the thing on screen',
    [(await card(p)) !== null, await ringed(p)], [true, [HREF.report]]);

  await tapTab(p, '#more');
  check('tapping More does NOT open the menu panel behind the scrim',
    await p.evaluate(() => document.getElementById('menu-panel').hidden), true);

  // Every exit still releases the page's scroll — and only it. Guarded for the
  // same reason as nextCard above.
  if (await p.evaluate(() => !document.querySelector('.tour').hidden)) await p.click('.tour-skip');
  check('and when the tour does close, the page gets its scroll back',
    await p.evaluate(() => [document.querySelector('.tour').hidden, document.body.style.overflow]),
    [true, '']);
  await ctx.close();
}

/* ================================================ not dimmed, in pixels */
/**
 * THE OTHER HALF OF THE SAME RULE. Sealed is easy to get by covering the bar;
 * the requirement is sealed AND undimmed, so this compares the RENDERED PIXELS
 * of a tab the tour is not ringing, with the scrim present and with it removed.
 * Identical means the scrim never reached it. The comparison is done on an unlit
 * tab so the ring itself cannot be what makes the two differ.
 */
console.log('\n=== Lite: the tab bar is not dimmed ===');
{
  const { ctx, p } = await shell();
  const clip = await p.evaluate(() => {
    const r = document.querySelector('.tabbar .tab[href="#more"]').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  check('precondition: card 1 is open and it is the HOME tab that is ringed, not this one',
    [((await card(p)) || {}).name, await ringed(p)], [steps[0].title, [HREF.index]]);
  const withScrim = await p.screenshot({ clip });
  await p.evaluate(() => { document.querySelector('.tour-backdrop').style.display = 'none'; });
  const withoutScrim = await p.screenshot({ clip });
  check('6. an unlit tab renders IDENTICALLY with the scrim in place and with it gone',
    withScrim.equals(withoutScrim), true);

  await p.evaluate(() => {
    const t = document.querySelector('.tour');
    t.querySelector('.tour-backdrop').style.display = '';
    t.style.setProperty('--tour-gap', '0px');      // a full-bleed scrim
  });
  const fullBleed = await p.screenshot({ clip });
  control('not dimmed — the same pixel comparison must go red for a full-bleed scrim',
    fullBleed.equals(withoutScrim));
  await ctx.close();
}

/* ============================================ no second gold ring */
/**
 * THE CARD POINTS AT A GOLD RING. It must not paint a louder one on itself.
 * This sheet's focus ring is `button:focus`, not `:focus-visible`, so TAPPING
 * Next — the only way to reach cards 2-5 — left a 3px #ffdd00 outline burning on
 * the button, loudest on the Report card. Both halves are asserted here: gone
 * for the pointer, still there for the keyboard, which is who it is for.
 */
console.log('\n=== Lite: the tour never paints a second gold ring ===');
{
  const { ctx, p } = await shell();
  check('the CARD holds focus when the tour opens, not a button',
    (await focusState(p)).on, 'tour-card');
  await p.click('.tour-next');
  const tapped = await focusState(p);
  check('TAPPING Next leaves no outline on it', [tapped.on, tapped.outline], ['tour-next', 'none']);
  await p.click('.tour-next');
  const onReport = await focusState(p);
  check('nor on the Report card, where it would fight the ring the card points at',
    [((await card(p)) || {}).name, onReport.outline], [steps[2].title, 'none']);

  await p.keyboard.press('Tab');
  const kb = await focusState(p);
  check('but a KEYBOARD user still gets the focus ring',
    [kb.on, kb.outline, kb.colour], ['tour-skip', 'solid', 'rgb(255, 221, 0)']);
  await p.keyboard.press('Tab');
  check('and Tab stays inside the dialog — it claims aria-modal', (await focusState(p)).on, 'tour-next');
  await p.keyboard.press('Tab');
  check('cycling rather than escaping into the page it is covering', (await focusState(p)).on, 'tour-skip');
  await p.keyboard.press('Shift+Tab');
  check('Shift+Tab too', (await focusState(p)).on, 'tour-next');
  await ctx.close();
}

/* ==================================================== exits and the flag */
console.log('\n=== Lite: exits, the seen flag, and the ring after ===');
{
  const { ctx, p } = await shell();
  await p.click('.tour-skip');
  check('8. Skip closes the tour', await card(p), null);
  check('8. Skip clears the ring — no tab is left lit', await ringed(p), []);
  check("8. Skip writes 'hawkeye_tour_seen'",
    await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen')), '1');
  await p.reload();
  await p.waitForTimeout(500);
  check('8. a reload does NOT reopen it', await card(p), null);
  check('8. and no ring is burning after the reload', await ringed(p), []);
  await ctx.close();
}
{
  const { ctx, p } = await shell();
  // Top-left of the scrim, well clear of the card — Playwright's default is the
  // element's centre, which is behind the card and is not a tap any reader makes.
  await p.click('.tour-backdrop', { position: { x: 6, y: 6 } });
  check('8. a backdrop tap behaves exactly like Skip: closed', await card(p), null);
  check('8. a backdrop tap behaves exactly like Skip: flag written',
    await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen')), '1');
  check('8. a backdrop tap behaves exactly like Skip: ring cleared', await ringed(p), []);
  await ctx.close();
}
{
  const { ctx, p } = await shell();
  for (let i = 0; i < steps.length; i += 1) await p.click('.tour-next');   // ... "Start observing"
  check('8. finishing the tour also closes it', await card(p), null);
  check('8. finishing writes the same flag as skipping',
    await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen')), '1');
  check('8. finishing clears the ring', await ringed(p), []);
  await ctx.close();
}
{
  /**
   * LEAVING THE PAGE IS AN EXIT TOO. Android's hardware Back is a navigation,
   * not a control this dialog can see: native routes it through
   * `<Modal onRequestClose>` into the same finish(), the WebView just tears the
   * document down. Without a write on the way out the tour reopens on the next
   * visit to Home, which is the one thing the flag exists to prevent.
   */
  const { ctx, p } = await shell();
  check('8. precondition: a card is open and nothing has written the flag yet',
    [(await card(p)) !== null, await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen'))],
    [true, null]);
  await p.goto(`${base}/results.html`);
  await p.waitForTimeout(300);
  check('8. navigating away mid-tour writes the same flag every other exit writes',
    await p.evaluate(() => localStorage.getItem('hawkeye_tour_seen')), '1');
  await p.goto(`${base}/index.html`);
  await p.waitForTimeout(500);
  check('8. so coming back to Home does not start it over', await card(p), null);
  await ctx.close();
}

/* =========================================================== the menu row */
console.log('\n=== Lite: the "Take the tour" menu row ===');
{
  const { ctx, p } = await shell({ seen: true });
  check('9. with the flag already set, nothing opens by itself', await card(p), null);
  await openMenu(p);
  const g = await learnGroup(p);
  check('9. "Learn & about" exists in the panel', g.group, true);
  check('9. "Take the tour" is its FIRST row',
    g.rows && g.rows[0], { text: 'Take the tour', href: '#tour' });
  check('9. and it sits directly above "How Hawkeye Works" (native puts it above Ask Hawkeye, which Lite has no page for)',
    g.rows && g.rows[1] && g.rows[1].text, 'How Hawkeye Works');
  await p.click('#menu-panel a[href="#tour"]');
  const c = await card(p);
  check('9. clicking it replays the tour even though the flag is set', !!c);
  check('9. and it replays from card 1', c && [c.name, c.dots[0]], [steps[0].title, true]);
  check('9. replaying rings the first tab again', await ringed(p), [HREF.index]);
  await ctx.close();
}

/* ======================================================= website mode */
console.log('\n=== the website (no Lite shell) is untouched ===');
{
  const { ctx, p } = await shell({ lite: false });
  check('10. no tab bar on the website at this width (precondition)',
    await p.evaluate(() => {
      const bar = document.querySelector('.tabbar');
      return !bar || getComputedStyle(bar).display === 'none';
    }), true);
  check('10. no tour element is built at all',
    await p.evaluate(() => !!document.querySelector('.tour')), false);
  check('10. nothing opens by itself', await card(p), null);
  await openMenu(p);
  const g = await learnGroup(p);
  check('10. no "#tour" anchor anywhere in the panel', g.anyTourAnchor, false);
  check('10. "Learn & about" still leads with "How Hawkeye Works"',
    g.rows && g.rows[0] && g.rows[0].text, 'How Hawkeye Works');
  check('10. the group is otherwise untouched',
    g.rows && g.rows.map((r) => r.href),
    ['how.html', 'guide.html', 'faq.html', 'about.html', 'support.html', 'privacy.html', 'terms.html']);
  await ctx.close();
}
{
  /**
   * Desktop width, still Lite: `.tabbar { display: none }` above 899px, and
   * isAppShell() is true for an INSTALLED DESKTOP PWA — so this is a real
   * reader, not a contrivance. Neither door may open five cards about a bar that
   * is not on screen: not the first-run trigger, and not the replay row, which
   * used to have no such gate at all.
   */
  const { ctx, p } = await shell({ width: 1280 });
  check('10. Lite at a desktop width (no rendered bar) does not auto-open', await card(p), null);
  await openMenu(p);
  check('10. and the "Take the tour" row is not on offer there',
    await p.evaluate(() => {
      const a = document.querySelector('#menu-panel a[href="#tour"]');
      return a ? getComputedStyle(a).display : '(no row at all)';
    }), 'none');
  // ...and firing its click by hand, past the hiding, still opens nothing.
  await p.evaluate(() => document.querySelector('#menu-panel a[href="#tour"]').click());
  await p.waitForTimeout(250);
  check('10. and the replay itself refuses, even when the row is clicked anyway',
    await card(p), null);
  await ctx.close();
}
{
  // CONTROL for the two checks above: the same row, measured the same way, at a
  // width where the bar IS rendered. If it read "none" here too, the desktop
  // assertions would be passing on a row that is simply never visible.
  const { ctx, p } = await shell({ seen: true });
  await openMenu(p);
  const shown = await p.evaluate(() => getComputedStyle(document.querySelector('#menu-panel a[href="#tour"]')).display);
  control('the desktop gate — the same measurement against a rendered bar must go red', shown === 'none');
  check('control sanity: at a phone width the row really is displayed', shown, 'block');
  await ctx.close();
}

/* ================================================== a storage fault */
console.log('\n=== Lite: localStorage.getItem throwing on the tour key ===');
{
  const { ctx, p } = await shell({ faultStorage: true });
  check('11. the read really does throw (precondition)',
    await p.evaluate(() => { try { localStorage.getItem('hawkeye_tour_seen'); return 'no throw'; } catch (e) { return 'threw'; } }),
    'threw');
  check('11. the rest of the shell still built — this is not passing because the page died',
    await p.evaluate(() => document.querySelectorAll('.tabbar .tab').length), 5);
  check('11. the tour element exists (so the gate, not a crash, is what stopped it)',
    await p.evaluate(() => !!document.querySelector('.tour')), true);
  check('11. it FAILS CLOSED, the same direction native does: the tour does not open',
    await card(p), null);
  check('11. and no ring is lit', await ringed(p), []);
  await ctx.close();
}

/* ============================================ the card's colours are native's */
/**
 * NATIVE'S PALETTE, NOT A LOOKALIKE — parsed out of native/src/global.css and
 * native/src/lib/api.ts at test time, the same policy as the strings.
 *
 * The two clients name their tokens differently and the overlap is a trap:
 * native's `--surface` is the SCREEN background, which this stylesheet calls
 * `--bg`, while `--surface` here means the card. The card also draws TWO greens
 * that are only the same colour in dark mode — the bar's active tint
 * (BRAND.green in light) rings the tab, and `--good-ink` (#0b6b3a in light) inks
 * the chip glyph, the live dot and the Next label. One variable used to do both,
 * which put the ring's #004225 on the card in light mode.
 */
console.log('\n=== Lite: the card wears native\'s colours, in both themes ===');
{
  const palette = { light: nativeTokens('light'), dark: nativeTokens('dark') };
  check('native\'s palette really parsed out of global.css (not an empty object)',
    ['good', 'good-ink', 'surface', 'line'].every((k) => /^rgb\(/.test(palette.light[k] || '') && /^rgb\(/.test(palette.dark[k] || '')),
    true);
  check('and BRAND parsed out of api.ts', [BRAND.green, BRAND.gold], ['rgb(0, 66, 37)', 'rgb(245, 179, 1)']);

  const { ctx, p } = await shell();
  for (const theme of ['light', 'dark']) {
    const want = palette[theme];
    const got = await inks(p, theme === 'dark');
    check(`${theme}: the chip is bg-surface with a good-ink glyph`,
      [got.chipBg, got.chipInk], [want.surface, want['good-ink']]);
    check(`${theme}: the live dot is good-ink, the rest are --line`,
      [got.dotOn, got.dotOff], [want['good-ink'], want.line]);
    check(`${theme}: Next is bg-good with a good-ink label`,
      [got.nextBg, got.nextInk], [want.good, want['good-ink']]);
    check(`${theme}: the ring sits on bg-good and inks its glyph with the bar's ACTIVE tint`,
      [got.ringBg, got.ringInk], [want.good, theme === 'dark' ? want['good-ink'] : BRAND.green]);
  }
  const light = await inks(p, false);
  control('colour parity — the ring\'s green is NOT the card\'s ink in light, and the same comparison must go red',
    light.chipInk === BRAND.green);
  check('control sanity: the two greens really are different values in light',
    palette.light['good-ink'] !== BRAND.green, true);
  await ctx.close();
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

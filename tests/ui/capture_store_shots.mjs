/**
 * Capture raw store screenshots from the REAL React Native app.
 *
 *   node capture_store_shots.mjs --token <dev-session-jwt> --out /tmp/raw
 *   node capture_store_shots.mjs --token <jwt> --explore /practice
 *
 * The app runs through react-native-web on the Metro dev server, so these are
 * captures of the shipping RN code — not the PWA twin, and not a mockup. Feed
 * the output to backend/scripts/make_store_screenshots.mjs, which adds the
 * caption and device frame.
 *
 * Auth is injected as an init script rather than typed into the sign-in form:
 * lib/secure-store.ts routes to localStorage on web, so setting those two keys
 * before the first script runs IS a signed-in session. Mint the token with
 * backend/scripts/dev_session.mjs, which refuses to run against production.
 *
 * deviceScaleFactor 3 because the compositor draws the device 885px wide; a
 * 1x capture of a 440px viewport would be upscaled and visibly soft.
 *
 * TWO THINGS ARE STRIPPED, and both are dev-server artefacts rather than parts
 * of the app: Metro's red error toast (react-dom warns about RN-only props like
 * onStartShouldSetResponder on every render, which LogBox then stacks into a
 * banner across the bottom of every capture) and the floating Ask Hawkeye
 * button, which sits mid-scroll on top of whatever is behind it and reads as a
 * rendering fault rather than a feature. Neither appears in a release build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i > -1 ? argv[i + 1] : d;
};

const BASE = arg('base', 'http://localhost:8092');
const TOKEN = arg('token');
const OBSERVER = arg('observer', '111');
const OUT = arg('out', '/tmp/raw');
const EXPLORE = arg('explore');
const ONLY = arg('only');
const DRIVE = arg('drive');

if (!TOKEN) {
  console.error('need --token (from: node backend/scripts/dev_session.mjs --observer 111)');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'en-NG',
  // DARK. It is the app's default look: the theme preference ships as 'system'
  // (lib/theme-pref.tsx), and these shots stand for what someone opening the app
  // actually sees. The light captures were an artefact of this line, not a
  // choice — a store listing showing a palette most users never meet is a
  // listing about a different app.
  colorScheme: 'dark',
});

await ctx.addInitScript(
  ([token, observer]) => {
    try {
      localStorage.setItem('hawkeye.auth.token', token);
      localStorage.setItem('hawkeye.auth.observer', observer);
      localStorage.removeItem('hawkeye.auth.optedOut');
      // THE FIRST-RUN TOUR, which a fresh profile always gets. It opens as a
      // modal over the home screen, and a store frame showing it is a picture of
      // an interruption sitting on top of the thing being advertised — the home
      // shot came back with "Welcome to Hawkeye" covering the live feed. The
      // flag is AsyncStorage, which IS localStorage on web, and lib/tour.ts
      // treats any non-null value as seen.
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch {
      /* storage blocked - the page will simply appear signed out */
    }
    // Silence react-dom's RN-prop warnings BEFORE the app loads, so LogBox
    // never collects them and the red banner is never rendered.
    const drop = () => {};
    console.error = drop;
    console.warn = drop;

    // Belt and braces: the dev error overlay is re-created for each new batch
    // of warnings, so hiding it once is not enough — one can appear between
    // the last clean-up and the screenshot. It is the ONLY thing on the page
    // using shadow DOM (react-native-web does not), which makes that a precise
    // signal. Watch for it and hide it the moment it is attached.
    const kill = (n) => {
      if (n && n.nodeType === 1 && n.shadowRoot && n.style) {
        n.style.setProperty('display', 'none', 'important');
      }
    };
    const start = () => {
      document.querySelectorAll('*').forEach(kill);
      new MutationObserver((muts) => {
        for (const m of muts) m.addedNodes.forEach(kill);
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  },
  [TOKEN, OBSERVER],
);

const page = await ctx.newPage();

/** Metro serves a bundling placeholder first; wait for real content. */
async function settle(ms = 2500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * Remove dev-only chrome that a release build never shows.
 *
 * The error toast lives in a SHADOW ROOT, which is why silencing console and
 * querying the light DOM both miss it — it has to be found by walking hosts.
 */
async function clean() {
  await page.evaluate(() => {
    // HIDE, never remove. Both of these sit inside React's tree or next to it,
    // and detaching a node React still owns crashes the next render — the
    // screen turns into "This screen hit a problem / Cannot convert undefined
    // or null to object", which is a far worse screenshot than the toast.
    const hide = (el) => {
      if (el && el.style) el.style.setProperty('display', 'none', 'important');
    };
    for (const host of Array.from(document.querySelectorAll('*'))) {
      const sr = host.shadowRoot;
      if (!sr) continue;
      if (/Unknown event handler|Warning:/.test(sr.textContent || '')) hide(host);
    }
    for (const el of Array.from(document.querySelectorAll('[aria-label]'))) {
      if (/ask hawkeye/i.test(el.getAttribute('aria-label') || '')) hide(el);
    }
    // The FAB's caption is a sibling of the button, not a child, so hiding the
    // button alone leaves the words "Ask Hawkeye" floating over the content.
    for (const el of Array.from(document.querySelectorAll('div, span'))) {
      if ((el.textContent || '').trim() === 'Ask Hawkeye' && el.children.length === 0) {
        hide(el.parentElement || el);
      }
    }
  });
}

/**
 * Scroll the app's own scroll container, not the window: react-native-web puts
 * every ScrollView in an overflow div, so window.scrollTo is a no-op here.
 */
async function scrollTo(px) {
  await page.evaluate((y) => {
    const scrollers = Array.from(document.querySelectorAll('div')).filter((d) => {
      const s = getComputedStyle(d);
      return (
        (s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 40
      );
    });
    const target = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (target) target.scrollTop = y;
    else window.scrollTo(0, y);
  }, px);
  await page.waitForTimeout(700);
}

/**
 * Scroll so a known piece of copy sits at the top of the frame. Pixel offsets
 * drift with every layout change — anchoring on the text does not, and the
 * whole point of the shot is which card is showing.
 */
/**
 * Wait for copy to appear. The declared-result card is fetched, not bundled, so
 * on a cold route it is not in the DOM when the page first settles — anchoring
 * on it immediately silently misses and the shot ends up wherever the scroll
 * happened to be.
 */
async function waitForText(needle, timeout = 20000) {
  try {
    await page.waitForFunction(
      (t) => (document.body.innerText || document.body.textContent || '').toLowerCase().includes(t),
      needle.toLowerCase(),
      { timeout, polling: 500 },
    );
    return true;
  } catch {
    console.log('    (never saw "' + needle + '")');
    return false;
  }
}

async function scrollToText(needle, offset = 24) {
  const ok = await page.evaluate(
    ([text, off]) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const needle = text.toLowerCase();
      let n;
      while ((n = w.nextNode())) {
        // Case-INSENSITIVE: these labels are uppercased by CSS, so the DOM
        // holds "Declared result" while the screen reads "DECLARED RESULT".
        if (!(n.textContent || '').toLowerCase().includes(needle)) continue;
        const el = n.parentElement;
        if (!el) continue;
        let p = el;
        while (p && p !== document.body) {
          const s = getComputedStyle(p);
          if (
            (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
            p.scrollHeight > p.clientHeight + 40
          ) {
            p.scrollTop += el.getBoundingClientRect().top - p.getBoundingClientRect().top - off;
            return true;
          }
          p = p.parentElement;
        }
      }
      return false;
    },
    [needle, offset],
  );
  await page.waitForTimeout(700);
  if (!ok) console.log('    (could not anchor on "' + needle + '")');
  return ok;
}

/**
 * 90s, not the 30s default: expo-router server-renders each route on first
 * request and the dev server is doing a cold bundle, which regularly runs past
 * half a minute on the first hit of a screen.
 */
async function go(route) {
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await settle();
  await clean();
}

async function shot(file) {
  await clean();
  const dest = path.join(OUT, file);
  await page.screenshot({ path: dest });
  console.log('  wrote ' + dest + ' (' + Math.round(fs.statSync(dest).size / 1024) + ' KB)');
}

/**
 * innerText comes back EMPTY on these screens — react-native-web nests text in
 * elements whose layout makes innerText skip them — so walk text nodes instead.
 */
async function text(limit = 1800) {
  const t = await page.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const out = [];
    let n;
    while ((n = w.nextNode())) {
      const s = (n.textContent || '').trim();
      if (s) out.push(s);
    }
    return out.join(' | ');
  });
  return t.slice(0, limit);
}

/** Every tappable thing on screen, so a flow can be driven by label. */
async function buttons() {
  return page.evaluate(() => {
    const sel = 'button, [role="button"], [tabindex]';
    return Array.from(document.querySelectorAll(sel))
      .map((el) => ({
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        aria: el.getAttribute('aria-label'),
        vis: el.getBoundingClientRect().height > 0,
      }))
      .filter((b) => b.vis && (b.text || b.aria));
  });
}

/**
 * Try each label in turn. Long option lists are windowed, so a specific entry
 * may not be in the DOM at all — fall through to one that is rather than
 * failing the whole run over which state got picked.
 */
async function tapAny(labels) {
  for (const l of labels) {
    try {
      await tap(l, { timeout: 4000 });
      console.log('    tapped "' + l + '"');
      return l;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('none of these were tappable: ' + labels.join(', '));
}

/** Click the first visible element whose text matches, and let RN re-render. */
async function tap(label, { exact = false, timeout = 10000 } = {}) {
  const loc = page.getByText(label, { exact }).first();
  await loc.waitFor({ state: 'attached', timeout });
  // Long option lists (36 states) render inside a ScrollView, so the target is
  // attached but clipped. Wait for ATTACHED and scroll it in, rather than for
  // visible, which never becomes true on its own.
  await loc.scrollIntoViewIfNeeded({ timeout });
  await page.waitForTimeout(250);
  await loc.click();
  await page.waitForTimeout(900);
  await clean();
}

if (EXPLORE) {
  await go(EXPLORE);
  console.log('--- ' + EXPLORE + ' ---');
  console.log(await text(5000));
  console.log('--- buttons ---');
  console.log(JSON.stringify(await buttons(), null, 1).slice(0, 4000));
  await shot('explore.png');
  await browser.close();
  process.exit(0);
}

const want = (n) => !ONLY || ONLY.split(',').includes(String(n));

/**
 * Walk the PRACTICE flow — the only path to a populated capture-and-file
 * sequence without a camera, a printed sheet, or publishing anyone real.
 * "Use a sample" substitutes both photos, and everything it produces lands on
 * the separate practice chain, so the receipt is genuine without being a claim
 * about a real polling unit.
 */
async function drivePractice(stopAfter = 99) {
  await go('/practice');
  const at = async (n, note) => {
    console.log('[' + n + '] ' + note + ' :: ' + (await text(320)));
    if (n >= stopAfter) {
      console.log('--- buttons ---');
      console.log(JSON.stringify(await buttons(), null, 1).slice(0, 2500));
      await shot('drive-' + n + '.png');
      await browser.close();
      process.exit(0);
    }
  };

  // CAPTURE FIRST. Practice mirrors report/result now — sheet, venue, THEN unit
  // and race — so the run opens on the camera rather than the unit picker. The
  // two "Use a sample" taps are the camera's extraAction, which renders whether
  // or not this harness has a camera device.
  await at(0, 'sheet step');
  await tap('Use a sample');
  await at(1, 'venue step');

  await tapAny(['Use a sample', 'Continue']);
  await at(2, 'unit step');

  await tap('Continue without a unit');
  await at(3, 'race step');

  await tap('Governorship');
  await at(4, 'state list');

  const state = await tapAny(['Osun', 'Lagos', 'Abia']);
  await at(5, 'state chosen');

  // Choosing the state only FILTERS; the race row itself still has to be
  // selected before Continue does anything.
  await tapAny([state + ' Governorship', 'Governorship (2027)', 'rehearsal']);
  await at(6, 'race selected');

  await tap('Continue to the figures');
  await at(7, 'votes step');

  // Nominal counts. These are PRACTICE parties (Party A-D) on the practice
  // chain, so no real candidate is being given a number here.
  const nums = ['312', '204', '118', '47', '23', '9'];
  const inputs = page.locator('input[inputmode], input[type="text"], input');
  const n = await inputs.count();
  for (let i = 0; i < n && i < nums.length; i++) {
    await inputs.nth(i).fill(nums[i]);
  }
  await page.waitForTimeout(400);
  await clean();
  await at(8, 'counts entered (' + n + ' inputs)');
  // 6 - the flow mid-run: the sheet is photographed, the counts are being
  // typed, the step rail across the top shows how much is left. Answers "what
  // do I do with this between elections", which is also the retention story.
  await shot('6-practice.png');

  await tap('Review');
  await at(9, 'review step');
  await clean();
  // 7 - the review step: what is about to be signed, with the GPS fix beside it.
  // This is the middle beat of the trust story — capture, THEN sign where you
  // stand, THEN publish — and it was the one step no frame actually showed.
  // 3-published states it in prose after the fact; this shows it happening.
  await shot('7-signed.png');

  await tap('Sign & submit (practice)');
  await page.waitForTimeout(3500);
  await clean();
  await at(10, 'receipt');
  // 3 - the receipt: entry hash and anchor, on the practice chain. Real and
  // populated without publishing anything about a real polling unit.
  await shot('3-published.png');
}

if (DRIVE) await drivePractice(Number(DRIVE));
if (want(3) || want(6)) await drivePractice();

// 4 - the completed Osun race page. Scrolled PAST the state outline to the
// declared result: the map is the part of this page that reads as empty, and
// the INEC-declared figures are the part that reads as real.
if (want(4)) {
  await go('/osun');
  await waitForText('Declared result');
  // Anchor on the NOTICE, not the result, and let the declared figures fall
  // below it — at 2868px tall both fit. Anchoring on 'DECLARED RESULT' scrolled
  // the notice out of frame, which on a page of INEC-declared figures is the one
  // thing this listing cannot afford to crop.
  await scrollToText('Not government or INEC affiliated', 24);
  console.log('/osun ->', (await text(120)).replace(/\n/g, ' | '));
  await shot('4-result.png');
}

// 2 - Home. The app's front door: what is coming, and the one action that
// matters on the day. It replaced an entry-step shot that was a near-duplicate
// of 6-practice — two pictures of the same screen is one wasted slot in a list
// most people never scroll past.
if (want(2)) {
  await go('/');
  await page.waitForTimeout(2500);
  await clean();
  console.log('/ ->', (await text(200)).replace(/\n/g, ' | '));
  await shot('2-home.png');
}

// 5 - Political Data. The Senate and House hemicycles are the most populated
// screen the app has on any day of the year, and they ship in the bundle.
if (want(5)) {
  await go('/political');
  await waitForText('Who holds power now');
  // NO SCROLL. This used to anchor on the heading with a negative offset, which
  // put the hemicycle at the top of the frame and pushed the compliance notice
  // off it. Both Play rejections were for showing government information without
  // a visible source, and a reviewer screenshotted a board exactly like this
  // one — so on the screen that carries NASS rosters and INEC seat data, the
  // notice staying in frame is worth more than a few pixels of dead space.
  await scrollToText('Not government or INEC affiliated', 24);
  console.log('/political ->', (await text(120)).replace(/\n/g, ' | '));
  await shot('5-map.png');
}

await browser.close();
console.log('done');

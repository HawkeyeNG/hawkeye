/**
 * THE RACE PAGE'S ASK MUST NOT BE SCROLL-ONLY.
 *
 * A race page runs to a stat bar, a map, a declared result, a note and a
 * candidate list that on the presidential page is nineteen names. "Report from
 * your unit" sat under all of it. The house rule is that no primary action is
 * reachable only by scrolling.
 *
 * This asserts the RULE, not the CSS: it loads a real race page at a phone
 * viewport, scrolls to the top, and checks the button is inside the viewport.
 * A test that grepped for `position: sticky` would pass on a bar pinned
 * underneath the tab bar, which is the exact failure this rule already had once.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** Render a race offline through the real race.js, at a phone viewport. */
async function render(race, { nativeApp = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, isMobile: true });
  const p = await ctx.newPage();
  await p.goto(`${base}/race.html?contest=NONE`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(300);
  const out = await p.evaluate(([r, native]) => {
    if (native) document.documentElement.classList.add('native-app');
    const m = document.getElementById('race-main');
    m.innerHTML = '';
    window.mountRace(m, r, {}, {});
    /**
     * The filler goes BEFORE the bar, which is the whole point.
     *
     * Appended after it, the bar's natural position is still on screen — a
     * sticky-bottom element only pins when it would otherwise fall BELOW the
     * viewport, so with short content it just scrolls and every assertion here
     * measures nothing. 2400px above it reproduces the real page: a stat bar, a
     * map, a declared result and nineteen candidates.
     */
    const cta0 = m.querySelector('.race-cta');
    const filler = document.createElement('div');
    filler.style.height = '2400px';
    if (cta0) m.insertBefore(filler, cta0);
    else m.appendChild(filler);
    window.scrollTo({ top: 0, behavior: 'instant' });
    const cta = m.querySelector('.race-cta');
    const btn = m.querySelector('[data-cta="observe"]');
    const r2 = cta?.getBoundingClientRect();
    return {
      label: btn?.textContent?.trim() ?? null,
      href: btn?.getAttribute('href') ?? null,
      pinnedClass: !!cta?.classList.contains('race-cta-pinned'),
      position: cta ? getComputedStyle(cta).position : null,
      // THE ACTUAL QUESTION: with the page scrolled to the very top and 2400px
      // of content below, is the bar on screen?
      inViewAtTop: !!r2 && r2.top < window.innerHeight && r2.bottom > 0,
      viewportH: window.innerHeight,
      ctaBottom: r2 ? Math.round(r2.bottom) : null,
      // Scroll and re-measure. A STICKY bar holds its viewport position; a
      // static one travels up by however far the page moved. This is the
      // discriminator the whole test rests on, so it is measured rather than
      // inferred from a computed style.
      travelOnScroll: (() => {
        // `behavior: 'instant'` because styles.css sets `scroll-behavior: smooth`
        // on <html>. A plain scrollTo ANIMATES, so measuring on the next line
        // reads the position before the page has moved — which reported 0 travel
        // for both a pinned and an unpinned bar and made this probe useless.
        const el = m.querySelector('.race-cta');
        const before = el?.getBoundingClientRect().top ?? null;
        window.scrollTo({ top: 400, behavior: 'instant' });
        const after = el?.getBoundingClientRect().top ?? null;
        window.scrollTo({ top: 0, behavior: 'instant' });
        return before === null || after === null ? null : Math.round(before - after);
      })(),
    };
  }, [race, nativeApp]);
  await ctx.close();
  return out;
}

const LIVE = {
  office: 'Senator — Abia Central',
  election: 'Abia State · Senate',
  date: '2027-02-27',
  stats: { lgas: 5, wards: 52, pollingUnits: 1073 },
  candidates: [], others: [],
  join: { contest: 'SEN', level: 'senatorial', value: 'Abia Central', state: 'Abia', lgas: ['Ikwuano'] },
};
// Yesterday, so statusOf() reads completed without depending on a fixed date.
const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const DONE = { ...LIVE, date: past };

console.log('=== a live race: the ask is pinned and reachable ===');
{
  const r = await render(LIVE);
  check('the button says what it does', r.label, 'Report from your unit');
  check('and still goes to the report route', r.href, 'observe.html?intent=observe');
  check('the bar is marked pinned', r.pinnedClass, true);
  check('and is actually sticky', r.position, 'sticky');
  check('REACHABLE with the page scrolled to the top', r.inViewAtTop, true);
  check('and sits within the viewport, not below it', r.ctaBottom <= r.viewportH + 1, true);
}

console.log('\n=== inside the app shell it clears the tab bar ===');
{
  const r = await render(LIVE, { nativeApp: true });
  check('still reachable', r.inViewAtTop, true);
  // .tabbar is 66px + inset; the bar must end above where it begins.
  check('and ends clear of the 66px tab bar', r.ctaBottom <= r.viewportH - 66, true);
}

console.log('\n=== A FINISHED RACE ASKS FOR NOTHING ===');
{
  const r = await render(DONE);
  check('no report button at all', r.label, null);
  check('and the bar is NOT pinned', r.pinnedClass, false);
  check('so it scrolls away like any other content', r.position, 'static');
}

console.log('\n=== control: the harness can tell pinned from not ===');
{
  /**
   * Every "REACHABLE" assertion above would be vacuous if the probe could not
   * also report NOT-pinned. Scrolling 400px is the discriminator: a sticky bar
   * holds its place in the viewport, a static one travels the full distance.
   *
   * (The first version of this control asserted the completed bar was off
   * screen at the top. It is not — a completed race page is short enough to fit
   * a 780px viewport — so the control failed for a reason that said nothing
   * about pinning. Measuring travel asks the actual question.)
   */
  const live = await render(LIVE);
  const done = await render(DONE);
  check('the pinned bar barely moves when scrolled', Math.abs(live.travelOnScroll) < 40, true);
  check('the unpinned one travels the full scroll', done.travelOnScroll, 400);
  check('so the two are distinguishable', live.travelOnScroll !== done.travelOnScroll, true);
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

/**
 * EVERY VERTICAL GAP ON THE OBSERVER HOME IS THE SAME GAP.
 *
 * This has been reported three times and "fixed" twice, which is the real
 * subject of this file. The spacing was expressed in three mechanisms at once —
 * a grid `gap`, a block `margin`, and an inline `style` attribute on one card —
 * so "make sure they all match" was never one check. The last pass normalised
 * every number in the page's <style> block to 20px and left the My Activity card
 * at `style="margin-top: 14px"`, 150 lines below, where nothing reading CSS
 * would see it. The gap between Latest Alerts and My Activity was 14 and every
 * other gap on the page was 20.
 *
 * FOURTH REPORT, SAME SHAPE AGAIN: the list of gaps this file measured started
 * at .qa-grid, so the distance ABOVE it — green .home-hero bottom to the first
 * row of quick-action cards — was never in the comparison. On the website it
 * happened to be right; in Lite it rendered at 34, because app/styles.css adds
 * `html.native-app main.wrap { padding-top: 14px }` on top of .qa-grid's own
 * `margin: var(--home-gap) 0`. A gap the test does not look at is a gap that is
 * free to be wrong, so the hero gap is now simply the FIRST entry in the same
 * every-gap-is-identical list, and the page is measured in BOTH modes.
 *
 * So this does not read the source. It RENDERS the page and measures the actual
 * distance between one block's bottom and the next block's top, which is the
 * only thing a reader can see and the only thing that cannot be satisfied by
 * tidy CSS with an override hiding somewhere else.
 *
 * Any new mechanism — a margin, a padding, a spacer div, a border — either keeps
 * every gap equal or fails here.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
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

let fail = 0;
const check = (label, got, want = true) => {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

/** The one pin. Both modes, both widths, every gap, the hero gap included. */
const HOME_GAP = 20;

/**
 * Measure the gaps in ONE COLUMN, which is where the problem is visible. The
 * desktop breakpoint puts the cards side by side, and a horizontal neighbour has
 * no vertical gap to get wrong.
 *
 * `lite` renders what Hawkeye Lite renders (html.native-app, set by app/native.js
 * inside Capacitor); without it this is the plain website. The two do NOT lay out
 * the same — Lite carries app chrome the website has no equivalent for — so both
 * are measured, or half the product is untested.
 *
 * `sabotage` is extra CSS injected before measuring, used only by the control
 * cases to prove these numbers can actually come out wrong.
 */
async function gaps(width, { lite = true, sabotage = '' } = {}) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  if (lite) {
    await p.addInitScript(() => {
      const mark = () => document.documentElement && document.documentElement.classList.add('native-app');
      mark();
      document.addEventListener('readystatechange', mark);
    });
  }
  await p.goto(`${base}/index.html`);
  await p.waitForTimeout(400);
  // The observer home is behind a signed-in check the API stub cannot satisfy,
  // so it is revealed directly. This is a LAYOUT test; the auth path has its own.
  const out = await p.evaluate((css) => {
    document.documentElement.classList.add('obs-home');
    const obs = document.querySelector('.home-obs');
    if (obs) obs.style.display = 'block';
    if (css) {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
    }
    // Every block in the home column, in document order: the green hero header,
    // then the action grid, then each card. These are the edges a reader sees
    // between sections — and the hero is one of them, which is the whole point
    // of this revision.
    //
    // THE GRID IS NOT A BLOCK — MEASURE THE CARDS THEMSELVES.
    //
    // This listed `.qa-grid` as one atom, which hid two different faults at
    // once. First, the grid paints nothing — no background, no border — so its
    // box edge is not an edge any reader can see; a padding-top on it moved the
    // cards down while the box stayed put, rendering 26 where the test still
    // reported 20 and passed. Second, and worse, the gap BETWEEN ITS TWO ROWS
    // was *inside* the atom, so the test could never see it — and it was 12px
    // while every other gap on the page was 20, through two separate passes
    // whose whole purpose was to make every gap match.
    //
    // Listing the four cards individually removes both possibilities rather
    // than correcting them: every edge compared below is a border a reader can
    // actually see, and no gap on the page is inside anything.
    const blocks = [
      document.querySelector('.home-hero'),
      ...document.querySelectorAll('.qa'),
      ...document.querySelectorAll('.home-card'),
    ].filter(Boolean);
    const rects = blocks.map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.className, top: r.top, bottom: r.bottom };
    });
    // Only consecutive blocks that are actually STACKED — same column. A pair
    // sitting side by side has no vertical gap to compare.
    const g = [];
    for (let i = 1; i < rects.length; i++) {
      if (rects[i].top < rects[i - 1].bottom) continue; // overlapping = side by side
      g.push(Math.round(rects[i].top - rects[i - 1].bottom));
    }
    return { count: rects.length, hero: g[0], gaps: g };
  }, sabotage);
  await p.close();
  return out;
}

/** The assertion itself, so the control cases exercise the SAME predicate. */
const allIdentical = (g) => new Set(g).size === 1;

for (const [name, lite] of [['website', false], ['Lite (html.native-app)', true]]) {
  for (const width of [390, 360]) {
    console.log(`\n=== ${name} @ ${width}px: hero -> cards -> cards, every gap identical ===`);
    const r = await gaps(width, { lite });
    console.log(`      blocks: ${r.count}   hero->first card: ${r.hero}   all gaps: ${r.gaps.join(', ')}`);
    check('the hero gap is in the list, plus the gaps between cards', r.gaps.length, (n) => n >= 4);
    check('and every one of them is the same number', allIdentical(r.gaps), true);
    // Pinned to the token, so a change to --home-gap is a deliberate edit here
    // too rather than something that quietly drifts.
    check('which is the --home-gap token', r.gaps[0], HOME_GAP);
    check('measured from the bottom of the green hero', r.hero, HOME_GAP);
  }
}

console.log('\n=== CONTROL: the hero measurement can fail ===');
{
  // Re-add, inside the page, exactly the shared rule the fix cancels
  // (styles.css `html.native-app main.wrap { padding-top: 14px }`). If the hero
  // distance were still outside the comparison — or measured from the wrong
  // edge — this would sail through as "all gaps identical".
  const r = await gaps(390, { lite: true, sabotage: 'html.native-app .home-obs main.wrap { padding-top: 14px !important; }' });
  console.log(`      sabotaged gaps: ${r.gaps.join(', ')}`);
  check('a padding above the grid changes the hero gap', r.hero, HOME_GAP + 14);
  check('and the every-gap-identical assertion rejects it', allIdentical(r.gaps), false);
}

console.log('\n=== CONTROL: padding INSIDE the transparent grid is caught too ===');
{
  // The grid paints nothing, so this pushes the first card 6px further from the
  // hero while leaving .qa-grid's own box exactly where it was. Measuring the
  // box would report 20 and pass; measuring the card reports 26 and fails.
  // Without this control the test has a hole exactly the width of the bug it
  // was written to catch.
  const r = await gaps(390, { lite: true, sabotage: '.qa-grid { padding-top: 6px !important; }' });
  console.log(`      sabotaged gaps: ${r.gaps.join(', ')}`);
  check('padding inside the grid moves the first card away from the hero', r.hero, HOME_GAP + 6);
  check('and the every-gap-identical assertion rejects that too', allIdentical(r.gaps), false);
}

console.log('\n=== CONTROL: the gap BETWEEN THE TWO ROWS OF ACTION CARDS can fail ===');
{
  // THE EXACT BUG THIS REVISION EXISTS FOR, put back.
  //
  // `row-gap: 12px` is what the page actually shipped, twice, through two
  // separate "make every gap match" passes. It survived both because the old
  // block list treated .qa-grid as one atom, so this gap lived INSIDE a
  // measured thing and was never compared to anything. Restoring it must turn
  // the run red — if this control ever passes, the row gap has fallen back out
  // of the comparison and the page is free to drift again.
  const r = await gaps(390, { lite: true, sabotage: '.qa-grid { row-gap: 12px !important; }' });
  console.log(`      sabotaged gaps: ${r.gaps.join(', ')}`);
  check('the row gap is inside the comparison', r.gaps.includes(12), true);
  check('and the every-gap-identical assertion rejects it', allIdentical(r.gaps), false);
  // The hero distance is untouched by a row gap, so this also proves the two
  // measurements are independent rather than one number reported twice.
  check('while the hero gap is unaffected', r.hero, HOME_GAP);
}

console.log('\n=== no card spaces itself — there is one mechanism, not three ===');
{
  const html = fs.readFileSync(`${APP}/index.html`, 'utf8');
  const home = html.slice(html.indexOf('<div class="home-obs">'), html.indexOf('<!-- APP-ONLY welcome screen'));
  // THE EXACT SHAPE OF THE BUG: an inline margin on a card, which every previous
  // fix missed because it is not in the stylesheet.
  check('no inline margin on a home card', /class="home-card"[^>]*style="[^"]*margin/.test(home), false);
  check('the gap comes from one token', /--home-gap:\s*20px/.test(html));
  check('and the stacked column uses it', /\.home-stack \{[^}]*gap: var\(--home-gap\)/.test(html));
  // CONTROL: prove the regex above can actually catch the thing it is looking
  // for, rather than passing because it never matches anything.
  check('the inline-margin detector works', /class="home-card"[^>]*style="[^"]*margin/.test(
    '<div class="home-card" style="margin-top: 14px">'), true);

  // The Lite hero gap must be fixed by CANCELLING the shared rule, not by
  // guessing a negative margin that happens to come out at 20 today. A negative
  // margin renders identically and would pass every measurement above, so this
  // one is read from the source on purpose.
  const style = html.slice(html.indexOf('/* ---- Observer Home'), html.indexOf('</style>'));
  const negMargin = /margin[a-z-]*:\s*(?:[^;]*\s)?-\d/;
  check('no negative margin compensating the shared app padding', negMargin.test(style), false);
  check('the negative-margin detector works', negMargin.test('.qa-grid { margin-top: -14px; }'), true);
}

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

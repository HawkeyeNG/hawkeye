// Layout, contrast and visual-regression guards, in a real browser.
//
// Each assertion here corresponds to something that actually shipped broken:
//   * the hero overflowed a phone by 207px and a 1280x800 laptop by 25px
//   * the notifications bell computed to rgb(0,0,238) (UA link blue) on dark green
//   * the menu panel ran under the APK tab bar, hiding "Sign out"
//   * the sample ledger cards vanished on a 1366x768 laptop
//   * .steps/.trust-grid silently went multi-column on tall phones
const { test, expect } = require('@playwright/test');
const {
  stubApi, freezeMotion, waitForChromeVars, simulateNativeShell, contrast,
} = require('./helpers');

// Fold budget: the landing hero must land exactly on one screen. Phones get the
// grid measured (the stats band deliberately sits just below the fold there);
// desktops include the band.
const VIEWPORTS = [
  { name: 'phone-small', width: 360, height: 640, mobile: true },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'laptop-1280', width: 1280, height: 800, mobile: false },
  { name: 'laptop-1366', width: 1366, height: 768, mobile: false },
  { name: 'laptop-1440', width: 1440, height: 900, mobile: false },
];

async function openPage(page, url) {
  await stubApi(page);
  await page.addInitScript(() => localStorage.clear());   // always the signed-out view
  await page.goto(url, { waitUntil: 'load' });
  await freezeMotion(page);
  await waitForChromeVars(page);
}
const openLanding = (page) => openPage(page, '/index.html');

test.describe('landing hero fits one screen', () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openLanding(page);
      const sel = vp.mobile ? '.hero-fold .hero-grid' : '.hero-fold';
      const overflow = await page.evaluate((s) => {
        const el = document.querySelector(s);
        return Math.round(el.getBoundingClientRect().bottom) - window.innerHeight;
      }, sel);
      // <= 0 fits; allow 1px for subpixel rounding.
      expect(overflow, `${sel} overflows the fold by ${overflow}px`).toBeLessThanOrEqual(1);
    });
  }

  test('sample ledger cards stay visible on short laptops', async ({ page }) => {
    // A max-height rule once hid these on 1366x768 — an ordinary PC.
    await page.setViewportSize({ width: 1366, height: 700 });
    await openLanding(page);
    await expect(page.locator('.hero-fold .ledger-stack')).toBeVisible();
    expect(await page.locator('.hero-fold .lcard').count()).toBeGreaterThanOrEqual(3);
  });

  test('mobile sections stay single-column on a tall phone', async ({ page }) => {
    // Splitting a media block once orphaned these into a max-height tier.
    await page.setViewportSize({ width: 390, height: 844 });
    await openLanding(page);
    for (const sel of ['.steps', '.trust-grid']) {
      const cols = await page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).gridTemplateColumns.split(' ').length : 1;
      }, sel);
      expect(cols, `${sel} should be one column on a phone`).toBe(1);
    }
  });
});

test.describe('header controls', () => {
  test('signed out shows Sign in, not a bell, and it is legible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLanding(page);
    await expect(page.locator('a.signin-btn')).toHaveCount(1);
    await expect(page.locator('a.bell-btn')).toHaveCount(0);
    const { fg, bg } = await page.evaluate(() => {
      const a = document.querySelector('a.signin-btn');
      return { fg: getComputedStyle(a).color, bg: getComputedStyle(document.querySelector('.gov-header')).backgroundColor };
    });
    expect(fg, 'must not be the UA default link blue').not.toBe('rgb(0, 0, 238)');
    expect(contrast(fg, bg), `contrast ${contrast(fg, bg).toFixed(2)}:1 against the header`).toBeGreaterThanOrEqual(4.5);
  });

  test('signing in swaps Sign in for a legible bell without a reload', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLanding(page);
    await page.evaluate(() => localStorage.setItem('hawkeye_token', 'x.y.z'));
    await expect(page.locator('a.bell-btn')).toHaveCount(1);
    await expect(page.locator('a.signin-btn')).toHaveCount(0);
    const { fg, bg } = await page.evaluate(() => ({
      fg: getComputedStyle(document.querySelector('a.bell-btn')).color,
      bg: getComputedStyle(document.querySelector('.gov-header')).backgroundColor,
    }));
    expect(fg, 'bell must not inherit link blue').not.toBe('rgb(0, 0, 238)');
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    // and the account links appear in the panel, live
    await expect(page.locator('#menu-panel a.sign-out')).toHaveCount(1);
  });
});

test.describe('menu panel', () => {
  // NOT the landing page: #menu-panel lives inside .gov-header, and in the app the
  // welcome screen deliberately hides that header — so on index.html the panel is
  // hidden and every measurement reads 0 (which is how this test first failed,
  // passing its tab-bar check spuriously against zeros). results.html keeps its
  // header and tab bar in the shell, which is where the menu actually gets used.
  test('fits above the app tab bar, targets >= 44px, cue shows when cut off', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPage(page, '/results.html');
    await simulateNativeShell(page, 66);
    await page.evaluate(() => { document.getElementById('menu-panel').hidden = false; });
    await page.waitForTimeout(350);

    const m = await page.evaluate(() => {
      const p = document.getElementById('menu-panel');
      const links = [...p.querySelectorAll('a')];
      const fade = p.querySelector('.menu-fade');
      // Derive the limit from the bar that is ACTUALLY shown, so this stays true
      // on any page/shell rather than assuming a 66px bar exists.
      const bar = document.querySelector('.tabbar');
      const barH = bar && getComputedStyle(bar).display !== 'none'
        ? Math.round(bar.getBoundingClientRect().height) : 0;
      return {
        panelVisible: getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 0,
        barH,
        bottom: Math.round(p.getBoundingClientRect().bottom),
        limit: window.innerHeight - barH,
        minTarget: Math.min(...links.map((a) => Math.round(a.getBoundingClientRect().height))),
        scrollable: p.classList.contains('is-scrollable'),
        fadeShown: fade ? getComputedStyle(fade).display !== 'none' : false,
        groups: [...p.querySelectorAll('.menu-group')].map((g) => g.textContent.trim()),
      };
    });
    // Guard against the zero-measurement trap: if the panel is hidden, every
    // assertion below would pass meaninglessly.
    expect(m.panelVisible, 'the menu panel must actually be rendered to measure it').toBe(true);
    expect(m.barH, 'the simulated tab bar should be present on this page').toBeGreaterThan(0);
    expect(m.bottom, 'panel must not run under the tab bar').toBeLessThanOrEqual(m.limit);
    expect(m.minTarget, 'WCAG 2.5.5 touch target').toBeGreaterThanOrEqual(44);
    expect(m.groups.length, 'menu should be grouped, not a flat list').toBeGreaterThanOrEqual(3);
    // The scroll cue is only expected when the list is genuinely cut off.
    if (m.scrollable) expect(m.fadeShown, 'cut-off list must show the scroll cue').toBe(true);
  });

  test('scroll cue clears at the end of the list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });   // force a cut-off list
    await openPage(page, '/results.html');
    await page.evaluate(() => { document.getElementById('menu-panel').hidden = false; });
    await page.waitForTimeout(300);
    const res = await page.evaluate(async () => {
      const p = document.getElementById('menu-panel');
      if (!p.classList.contains('is-scrollable')) return { skipped: true };
      p.scrollTop = p.scrollHeight;
      await new Promise((r) => setTimeout(r, 200));
      const fade = p.querySelector('.menu-fade');
      return { skipped: false, atEnd: p.classList.contains('at-end'), fadeHidden: getComputedStyle(fade).display === 'none' };
    });
    if (!res.skipped) {
      expect(res.atEnd).toBe(true);
      expect(res.fadeHidden, 'cue should clear once the end is reached').toBe(true);
    }
  });
});

test.describe('theme', () => {
  test('the toggle beats system dark', async ({ page }) => {
    // Our CSS never follows prefers-color-scheme; a UA auto-dark pass was
    // repainting the site and making the toggle look broken.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 390, height: 844 });
    await openLanding(page);
    const out = await page.evaluate(() => {
      const root = () => getComputedStyle(document.documentElement);
      const read = () => ({ cs: root().colorScheme, bg: root().getPropertyValue('--bg').trim() });
      const def = read();
      document.documentElement.dataset.theme = 'dark';
      const dark = read();
      document.documentElement.dataset.theme = 'light';
      return { def, dark, light: read() };
    });
    expect(out.def.cs, 'must opt out of UA auto-dark with "only"').toContain('only');
    expect(out.def.bg, 'system dark must NOT repaint the default theme').toBe('#f7f8f6');
    expect(out.dark.bg).toBe('#0c1310');
    expect(out.light.bg, 'forcing light under system dark must hold').toBe('#f7f8f6');
  });
});

test.describe('app welcome screen (native shell)', () => {
  test('owns the whole window: no header, no tab bar, fits one screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLanding(page);
    await simulateNativeShell(page, 66);
    const m = await page.evaluate(() => {
      const aw = document.querySelector('.app-welcome');
      const r = aw.getBoundingClientRect();
      const btns = [...aw.querySelectorAll('.aw-actions a')];
      const gone = (s) => { const e = document.querySelector(s); return !e || getComputedStyle(e).display === 'none'; };
      return {
        welcomeShown: getComputedStyle(aw).display !== 'none',
        heroHidden: gone('.hero'),
        headerHidden: gone('.gov-header'),
        tabBarHidden: gone('.tabbar'),
        bottom: Math.round(r.bottom),
        viewport: window.innerHeight,
        labels: btns.map((b) => b.textContent.trim()),
        minBtn: Math.min(...btns.map((b) => Math.round(b.getBoundingClientRect().height))),
        // The feature bullets were removed on purpose — app users already know
        // what the app does, so the screen stays a clean auth step.
        hasFeatureBullets: !!aw.querySelector('.aw-points'),
      };
    });
    expect(m.welcomeShown).toBe(true);
    expect(m.heroHidden, 'the web marketing hero must be hidden in the app').toBe(true);
    expect(m.headerHidden, 'welcome screen must not show the site header').toBe(true);
    expect(m.tabBarHidden, 'welcome screen must not show the bottom tab bar').toBe(true);
    expect(m.hasFeatureBullets, 'welcome screen should stay copy-light').toBe(false);
    expect(m.bottom, 'welcome screen must fit one screen').toBeLessThanOrEqual(m.viewport + 1);
    expect(m.labels.join(' | ')).toMatch(/Create an account.*Sign in/);
    expect(m.minBtn, 'WCAG 2.5.5 touch target').toBeGreaterThanOrEqual(44);
  });
});

test.describe('show/hide password', () => {
  test('every password field gets an accessible reveal toggle', async ({ page }) => {
    await stubApi(page);
    await page.goto('/observe.html?intent=signin', { waitUntil: 'load' });
    await freezeMotion(page);
    const m = await page.evaluate(() => {
      const input = document.getElementById('pw-signin-input');
      const btn = input.parentElement.querySelector('.pw-eye');
      const before = input.type;
      btn.click();
      const afterFirst = { type: input.type, pressed: btn.getAttribute('aria-pressed'), label: btn.getAttribute('aria-label') };
      btn.click();
      return {
        wrapped: input.parentElement.classList.contains('pw-wrap'),
        buttonType: btn.type,               // must be "button", never submit
        before,
        afterFirst,
        afterSecond: { type: input.type, pressed: btn.getAttribute('aria-pressed') },
        size: [Math.round(btn.getBoundingClientRect().width), Math.round(btn.getBoundingClientRect().height)],
        fieldsWithToggle: document.querySelectorAll('.pw-wrap .pw-eye').length,
      };
    });
    expect(m.wrapped).toBe(true);
    expect(m.buttonType, 'must not submit the form').toBe('button');
    expect(m.before).toBe('password');
    expect(m.afterFirst.type, 'first tap reveals').toBe('text');
    expect(m.afterFirst.pressed).toBe('true');
    expect(m.afterFirst.label).toMatch(/hide/i);
    expect(m.afterSecond.type, 'second tap hides again').toBe('password');
    expect(m.afterSecond.pressed).toBe('false');
    expect(Math.min(...m.size), 'WCAG 2.5.5 touch target').toBeGreaterThanOrEqual(44);
    expect(m.fieldsWithToggle, 'both password fields on this page').toBeGreaterThanOrEqual(2);
  });
});

test.describe('visual regression', () => {
  // Baselines must be generated ON the runner (fonts and GPU differ from a dev
  // machine). Until they're committed these SKIP rather than fail: a missing
  // baseline is a setup step, not a regression, and a red build for it trains
  // people to ignore red. Generate with the workflow's update_snapshots input.
  const fs = require('fs');
  const path = require('path');
  const SNAP_DIR = path.join(__dirname, 'layout.spec.js-snapshots');
  const shots = [
    { name: 'landing-phone', width: 390, height: 844 },
    { name: 'landing-laptop', width: 1366, height: 768 },
  ];
  for (const s of shots) {
    test(s.name, async ({ page }, testInfo) => {
      const baseline = path.join(SNAP_DIR, `${s.name}-${testInfo.project.name}-linux.png`);
      const updating = testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
      test.skip(!updating && !fs.existsSync(baseline),
        'No committed baseline yet — run the UI checks workflow with update_snapshots=true, '
        + 'then commit tests/ui/layout.spec.js-snapshots/.');
      await page.setViewportSize({ width: s.width, height: s.height });
      await openLanding(page);
      await expect(page).toHaveScreenshot(`${s.name}.png`, {
        // Counters and any live figure would flap the diff.
        mask: [page.locator('.stats-row strong')],
        fullPage: false,
      });
    });
  }
});

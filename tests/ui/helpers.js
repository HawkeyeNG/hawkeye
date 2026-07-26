// Shared setup for the UI guards.
const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '../../app');

// Fixed API responses. The static server has no backend, and real data would
// make screenshots flap, so every /api/** call is answered from here.
// `{}` is deliberate for assistant/health: `enabled` stays falsy so the floating
// assistant never mounts and can't drift into a screenshot.
const API_FIXTURES = {
  '/api/contests': { contests: [] },
  '/api/assistant/health': {},
  '/api/notifications': { unread: 0, notifications: [] },
  '/api/mapping/stats': { located: 0, total: 176846, wards: 9307 },
  '/api/ledger/entries': { entries: [] },
  '/api/incidents': { incidents: [] },
  '/api/observers/resume': {},
};

async function stubApi(page) {
  await page.route('**/api/**', (route) => {
    const { pathname } = new URL(route.request().url());
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(API_FIXTURES[pathname] ?? {}),
    });
  });
}

// Kill animation/transition timing so screenshots and measurements are stable
// (the hero has a pulsing live dot and the stat figures count up).
async function freezeMotion(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation: none !important; transition: none !important;
      scroll-behavior: auto !important;
    }`,
  });
}

// menu.js publishes --hdr-h/--bar-h from measured chrome. Wait for it rather
// than assuming a header height — that assumption is what broke the menu panel
// and the hero fold before.
async function waitForChromeVars(page) {
  await page.waitForFunction(() => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--hdr-h');
    return v && v.trim().endsWith('px');
  }, null, { timeout: 15000 });
}

// Reproduce the Capacitor shell: native-app class + a real bottom tab bar, then
// let menu.js re-measure. Used to prove the app welcome screen and the menu
// panel both clear the tab bar without needing an actual device.
async function simulateNativeShell(page, barHeight = 66) {
  await page.evaluate((h) => {
    document.documentElement.classList.add('native-app');
    if (!document.querySelector('.tabbar')) {
      const bar = document.createElement('nav');
      bar.className = 'tabbar';
      bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${h}px;`
        + 'background:#fff;border-top:1px solid #ccc;z-index:95';
      document.body.appendChild(bar);
      document.body.classList.add('has-tabbar');
    }
    const hdr = document.querySelector('.gov-header');
    document.documentElement.style.setProperty('--hdr-h', Math.round(hdr.getBoundingClientRect().height) + 'px');
    document.documentElement.style.setProperty('--bar-h', h + 'px');
    window.dispatchEvent(new Event('resize'));
  }, barHeight);
  await page.waitForTimeout(250);
}

// WCAG relative luminance + contrast ratio, for 1.4.3 / 1.4.11 assertions.
function luminance([r, g, b]) {
  const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function parseRgb(s) {
  const m = String(s).match(/-?\d+(\.\d+)?/g);
  if (!m) throw new Error(`cannot parse colour: ${s}`);
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}
function contrast(fg, bg) {
  const a = luminance(parseRgb(fg));
  const b = luminance(parseRgb(bg));
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const readApp = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
const appFileExists = (rel) => fs.existsSync(path.join(APP_DIR, rel.replace(/^\//, '').split('?')[0]));

module.exports = {
  APP_DIR, API_FIXTURES, stubApi, freezeMotion, waitForChromeVars,
  simulateNativeShell, contrast, readApp, appFileExists,
};

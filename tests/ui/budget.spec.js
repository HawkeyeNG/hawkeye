// Asset + wiring guards. No browser needed — these read app/ straight off disk,
// so they run in about a second and catch the regressions that actually bit us:
//
//  * precache grew to ~1.5 MB and every deploy re-downloaded it (slow taps)
//  * a 404 in SHELL would abort cache.addAll() atomically -> client caches NOTHING
//  * a stale ?v= pin serves the previous build from the CDN edge
//  * Privacy & Data (and 4 other pages) became unreachable in the APK
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { APP_DIR, readApp, appFileExists } = require('./helpers');

// Budgets. Raise deliberately, with a reason — that's the whole point.
const PRECACHE_BUDGET_KB = 700;   // was 1510 KB before the split; now ~560 KB
const SHELL_ITEM_MAX_KB = 100;    // anything bigger belongs in LAZY

function parseArray(src, name) {
  const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];'));
  if (!m) throw new Error(`${name} not found in sw.js`);
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

const sw = readApp('sw.js');
const SHELL = parseArray(sw, 'SHELL');
const LAZY = parseArray(sw, 'LAZY');
const htmlFiles = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.html'));

test.describe('service worker precache', () => {
  test('every SHELL entry exists on disk', () => {
    // cache.addAll() is atomic: one 404 and the client caches nothing at all,
    // silently falling back to the network forever.
    const missing = SHELL.filter((u) => u !== '/' && !appFileExists(u));
    expect(missing, `SHELL entries with no file in app/: ${missing.join(', ')}`).toEqual([]);
  });

  test(`precache stays under ${PRECACHE_BUDGET_KB} KB`, () => {
    let total = 0;
    const sizes = [];
    for (const u of SHELL) {
      const rel = (u === '/' ? 'index.html' : u.replace(/^\//, '')).split('?')[0];
      const p = path.join(APP_DIR, rel);
      if (!fs.existsSync(p)) continue;
      const kb = fs.statSync(p).size / 1024;
      total += kb;
      sizes.push([rel, kb]);
    }
    const worst = sizes.sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, kb]) => `${n} ${kb.toFixed(0)}KB`).join(', ');
    expect(Math.round(total), `precache ${total.toFixed(0)}KB. Largest: ${worst}`)
      .toBeLessThanOrEqual(PRECACHE_BUDGET_KB);
  });

  test(`no single SHELL entry over ${SHELL_ITEM_MAX_KB} KB (put heavies in LAZY)`, () => {
    const fat = [];
    for (const u of SHELL) {
      const rel = (u === '/' ? 'index.html' : u.replace(/^\//, '')).split('?')[0];
      const p = path.join(APP_DIR, rel);
      if (fs.existsSync(p) && fs.statSync(p).size / 1024 > SHELL_ITEM_MAX_KB) {
        fat.push(`${rel} ${(fs.statSync(p).size / 1024).toFixed(0)}KB`);
      }
    }
    expect(fat, `too heavy to precache: ${fat.join(', ')}`).toEqual([]);
  });

  test('LAZY entries exist and are not also precached', () => {
    const missing = LAZY.filter((u) => !appFileExists(u));
    expect(missing, `LAZY entries with no file: ${missing.join(', ')}`).toEqual([]);
    const both = LAZY.filter((u) => SHELL.includes(u));
    expect(both, `listed in BOTH SHELL and LAZY: ${both.join(', ')}`).toEqual([]);
  });
});

test.describe('cache-busting pins', () => {
  // Every ?v= pin a page requests must match the pin sw.js precaches, or the SW
  // caches one URL while browsers request another — and reusing a pin after
  // changing the file serves the old bytes from the CDN edge.
  test('pinned assets referenced by pages match sw.js SHELL', () => {
    const shellPins = new Map();
    for (const u of SHELL) {
      const [file, q] = u.split('?');
      if (q) shellPins.set(file.replace(/^\//, ''), q);
    }
    const mismatches = [];
    for (const f of htmlFiles) {
      const html = readApp(f);
      for (const m of html.matchAll(/(?:src|href)="([a-z0-9_\-./]+\.(?:js|css))\?(v=\d+)"/gi)) {
        const [, file, pin] = m;
        if (!shellPins.has(file)) continue;          // not precached: nothing to match
        if (shellPins.get(file) !== pin) {
          mismatches.push(`${f}: ${file}?${pin} but sw.js has ?${shellPins.get(file)}`);
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  test('pinned files all exist', () => {
    const missing = new Set();
    for (const f of htmlFiles) {
      for (const m of readApp(f).matchAll(/(?:src|href)="([a-z0-9_\-./]+\.(?:js|css))\?v=\d+"/gi)) {
        if (!appFileExists(m[1])) missing.add(`${f} -> ${m[1]}`);
      }
    }
    expect([...missing], [...missing].join('\n')).toEqual([]);
  });
});

test.describe('reachability', () => {
  test('every internal page link resolves to a real file', () => {
    const broken = new Set();
    for (const f of htmlFiles) {
      for (const m of readApp(f).matchAll(/href="([a-z0-9_\-]+\.html)(?:[?#][^"]*)?"/gi)) {
        if (!appFileExists(m[1])) broken.add(`${f} -> ${m[1]}`);
      }
    }
    expect([...broken], [...broken].join('\n')).toEqual([]);
  });

  test('the app keeps a route to the footer-only pages (incl. Privacy)', () => {
    // The APK hides .gov-footer and its "More" tab just reopens the menu panel,
    // so pages pulled out of the menu had no entry point at all in the shell —
    // and an unreachable Privacy policy is a Play listing problem.
    const menu = readApp('menu.js');
    expect(menu, 'menu.js must gate FOOTER_ONLY on the footer actually being shown')
      .toContain('footerCarriesThem');
    for (const href of ['privacy.html', 'guide.html', 'faq.html', 'how.html', 'about.html']) {
      expect(menu, `${href} must be groupable back into the menu for the app`).toContain(href);
    }
  });
});

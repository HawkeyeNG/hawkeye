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
//
// 2026-09-19: 700 KB was set in July against a 572 KB / 37-entry shell. The app
// has since grown past 40 pages and the shell reached 1867 KB, at which point
// this test had been failing on every push for a day and nobody was reading it.
// Two things were done before this number moved, in that order:
//
//   1. The three translation catalogues (461 KB of ha/ig/yo) came OUT. Every
//      visitor was downloading all three, including the majority who read
//      English; they are served network-first with a cache fallback, so the
//      language a reader picks is cached when they pick it.
//   2. The reading surfaces (results, races, race.js, integrity, dashboard,
//      how/faq/guide, osun — 304 KB) moved to LAZY. A precache exists so
//      somebody at a polling unit with no signal can still FILE; a cached
//      results page is worse than a blank one, because it shows yesterday's
//      numbers with today's confidence. LAZY still caches them on first use.
//
// What is left is the filing path (862 KB) plus the self-hosted fonts (239 KB),
// which stay because offline typography includes the naira sign this project
// has been bitten by before. 1101 KB measured, 1150 budgeted.
//
// TO RAISE THIS AGAIN: do the audit first, in that order, and say what is in
// the number. A budget nobody can account for is not a budget.
const PRECACHE_BUDGET_KB = 1150;

// Per-item cap. NOT raised to fit — the three files that exceed it ARE the
// shell (the stylesheet, the site script and the menu), and nothing is gained
// by making them lazy: every page loads all three, so a lazy one is a blank
// screen on the first offline visit instead of a cached one. Naming them keeps
// the guard sharp for a NEW heavy file, which is what it was written to catch.
const SHELL_ITEM_MAX_KB = 100;    // anything bigger belongs in LAZY
const SHELL_ITEM_EXEMPT = ['styles.css', 'menu.js', 'app.js'];

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
      if (SHELL_ITEM_EXEMPT.includes(rel)) continue;
      const p = path.join(APP_DIR, rel);
      if (fs.existsSync(p) && fs.statSync(p).size / 1024 > SHELL_ITEM_MAX_KB) {
        fat.push(`${rel} ${(fs.statSync(p).size / 1024).toFixed(0)}KB`);
      }
    }
    expect(fat, `too heavy to precache: ${fat.join(', ')}`).toEqual([]);
  });

  // The exemption list is the part that rots: one more name each time somebody
  // wants a red test green, and the cap protects nothing. Three is the shell.
  test('the per-item exemption list stays short and is really the shell', () => {
    expect(SHELL_ITEM_EXEMPT.length, 'exempting a fourth file needs a reason in the comment above')
      .toBeLessThanOrEqual(3);
    const notInShell = SHELL_ITEM_EXEMPT.filter(
      (f) => !SHELL.some((u) => u.replace(/^\//, '').split('?')[0] === f),
    );
    expect(notInShell, `exempted but not precached: ${notInShell.join(', ')}`).toEqual([]);
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

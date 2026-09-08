/**
 * THE SHARED CHROME MUST TRANSLATE — the footer, the ☰ panel, the header page
 * name, the tab bar, the skip link.
 *
 * The bug this exists to prevent: menu.js REBUILDS the canonical footer with
 * `foot.innerHTML = '<a href="about.html">About</a>…'`, overwriting each page's
 * already-keyed <nav> with unkeyed anchors. Every page's markup was translated
 * and every page's rendered footer was English, because the last writer wins and
 * the last writer was menu.js. The same shape covered the ☰ panel's injected
 * links, its group headings, the header page-name and the skip link — none of
 * which exist in any page's markup, so no amount of keying HTML could reach them.
 *
 * ASSERTED FROM THE RENDERED DOM, NOT THE SOURCE. A data-i18n attribute in
 * menu.js proves only that somebody typed one; whether i18n.js's apply() pass
 * ever reached the node depends on WHEN the node was built (before that pass, or
 * on a later click), and that is exactly what kept getting this wrong. Read what
 * a Hausa reader actually sees.
 *
 * EVERY CHECK CARRIES A CONTROL. The whole suite runs twice — once in English,
 * once in Hausa — and each string must DIFFER between the two runs. A check that
 * only asserts "the Hausa page contains Hausa somewhere" passes on a page that
 * is 95% English; a check that asserts "this element is not what English shows"
 * cannot. The English run is also the control for the control: it proves the
 * selectors resolve at all, so a typo'd selector fails loudly instead of
 * reporting a difference it never measured.
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
const BASE = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

const browser = await chromium.launch();

/**
 * Read the chrome in one language.
 *
 * The language is written to localStorage BEFORE the first script runs
 * (addInitScript), because i18n.js reads it during its own evaluation — setting
 * it after load would measure the page that was already painted in English.
 * A token is set too: the footer's My Profile row and the ☰ "Your account"
 * group only exist for a signed-in reader.
 */
async function readChrome(lang, page = 'index.html', shell = false) {
  const ctx = await browser.newContext({ viewport: shell ? { width: 390, height: 850 } : { width: 900, height: 1000 } });
  await ctx.addInitScript((o) => {
    const code = o.code;
    // The app shell (installed PWA / Capacitor) is a different chrome: it grows
    // a tab bar and moves the theme toggle into the ☰ panel. Both are painted
    // by menu.js, so both need reading.
    if (o.shell) {
      Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
      const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
      mark();
      document.addEventListener('readystatechange', mark);
    }
    try {
      localStorage.setItem('hawkeye_lang', code);
      localStorage.setItem('hawkeye_token', 'test-token');
      localStorage.setItem('hawkeye_lang_prompt_done', '1');
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch (e) { /* private mode */ }
  }, { code: lang, shell });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/${page}`, { waitUntil: 'networkidle' });
  // i18n.js resolves a non-English bundle through fetch().then(); networkidle
  // covers it, but the apply() pass runs one microtask later.
  await p.waitForTimeout(250);
  const out = await p.evaluate(() => {
    const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
    const all = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.trim());
    return {
      htmlLang: document.documentElement.lang,
      footer: all('.gov-footer nav a'),
      headerName: txt('.gov-header .brand-text strong'),
      skip: txt('.skip-link'),
      groups: all('#menu-panel .menu-group'),
      accordions: all('#menu-panel .menu-acc span'),
      panelLinks: all('#menu-panel a'),
      tabs: all('.tabbar .tl'),
      themeRow: txt('#menu-panel .menu-theme'),
      disclaimerMore: txt('.gov-disc-more'),
    };
  });
  await ctx.close();
  return out;
}

console.log('=== the chrome renders in English (control: every selector resolves) ===');
const en = await readChrome('en');
check('html lang is en', en.htmlLang === 'en', en.htmlLang);
check('the footer rebuilt with 8 links', en.footer.length === 8, en.footer);
check('  ...and they are the English labels', en.footer.join('|') === 'About|How Hawkeye Works|Privacy Policy|Terms of Service|FAQ|Observer Guide|Support|My Profile', en.footer);
check('the header names the page', en.headerName === 'HAWKEYE', en.headerName);
check('the skip link exists', en.skip === 'Skip to content', en.skip);
check('the ☰ panel has group headings', en.groups.length >= 4, en.groups);
check('  ...including "Take part"', en.groups.includes('Take part'), en.groups);
check('the ☰ panel has a Report accordion', en.accordions.includes('Report'), en.accordions);
check('the ☰ panel injected its links', en.panelLinks.includes('My Profile') && en.panelLinks.includes('Practice Run'), en.panelLinks);
// The theme ROW only exists where the header carries no theme BUTTON — i.e.
// everywhere but Home — and the disclaimer bar only on the results-style pages
// in NEEDS_DISCLAIMER. Read both where they actually render.
const enR = await readChrome('en', 'results.html', true);
const haR = await readChrome('ha', 'results.html', true);
check('the theme row reads in English', enR.themeRow === 'Switch to light mode' || enR.themeRow === 'Switch to dark mode', enR.themeRow);
const enW = await readChrome('en', 'results.html');
const haW = await readChrome('ha', 'results.html');
check('the disclaimer offers Details', enW.disclaimerMore === 'Details ›', enW.disclaimerMore);

console.log('\n=== the same chrome in Hausa — every string must MOVE ===');
const ha = await readChrome('ha');
check('html lang is ha', ha.htmlLang === 'ha', ha.htmlLang);

/**
 * The real assertion. Not "is there Hausa on the page" — "is THIS element
 * different from what the English run put there". Only that catches a footer
 * that menu.js rebuilt in English after the translation was applied.
 */
const moved = (name, a, b) => check(name, a !== b && !!b, { en: a, ha: b });

check('the footer still has 8 links', ha.footer.length === 8, ha.footer);
for (let i = 0; i < en.footer.length; i++) {
  moved(`footer[${i}] "${en.footer[i]}" translated`, en.footer[i], ha.footer[i]);
}
// Home's header name IS the wordmark and must NOT be translated.
check('the wordmark stays HAWKEYE', ha.headerName === 'HAWKEYE', ha.headerName);
moved('the skip link translated', en.skip, ha.skip);
moved('the theme row translated', enR.themeRow, haR.themeRow);
moved('"Details ›" translated', enW.disclaimerMore, haW.disclaimerMore);
check('the shell grew a tab bar', enR.tabs.length === 5, enR.tabs);
for (let i = 0; i < enR.tabs.length; i++) moved(`tab "${enR.tabs[i]}" translated`, enR.tabs[i], haR.tabs[i]);
for (let i = 0; i < en.groups.length; i++) {
  moved(`☰ group "${en.groups[i]}" translated`, en.groups[i], ha.groups[i]);
}
for (let i = 0; i < en.accordions.length; i++) {
  moved(`☰ accordion "${en.accordions[i]}" translated`, en.accordions[i], ha.accordions[i]);
}
check('no ☰ panel link is left in English',
  ha.panelLinks.every((t, i) => t !== en.panelLinks[i] || !/[a-z]{2}/.test(t)),
  ha.panelLinks.filter((t, i) => t === en.panelLinks[i] && /[a-z]{2}/.test(t)));

/**
 * HAWKEYE is the wordmark and stays HAWKEYE. Assert the header on a page whose
 * name IS prose, so the header-name path is actually exercised.
 */
console.log('\n=== a page whose header name is prose, not the wordmark ===');
const enD = await readChrome('en', 'dashboard.html');
const haD = await readChrome('ha', 'dashboard.html');
check('English names it "Reports Log"', enD.headerName === 'Reports Log', enD.headerName);
moved('the header page name translated', enD.headerName, haD.headerName);

/**
 * CONTROL FOR THE WHOLE FILE. Plant the exact defect this test exists to catch —
 * a footer rebuilt in English AFTER the translation pass — and require it to be
 * caught. Without this, a test that silently stopped reading the footer would
 * report "all passed" forever.
 */
console.log('\n=== CONTROL: the same test, against a deliberately broken footer ===');
{
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('hawkeye_lang', 'ha'); localStorage.setItem('hawkeye_token', 't'); } catch (e) {}
  });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(250);
  // Exactly the old bug: overwrite the keyed nav with unkeyed English.
  await p.evaluate(() => {
    const f = document.querySelector('.gov-footer nav');
    f.innerHTML = '<a href="about.html">About</a><a href="how.html">How Hawkeye Works</a>';
  });
  const broken = await p.evaluate(() => [...document.querySelectorAll('.gov-footer nav a')].map((a) => a.textContent.trim()));
  const caught = broken[0] === en.footer[0];
  check('CONTROL an English-rebuilt footer is detected as untranslated', caught, broken);
  await ctx.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

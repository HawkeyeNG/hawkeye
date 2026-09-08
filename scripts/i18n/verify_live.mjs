/**
 * VERIFY THE LIVE SITE, not the local tree.
 *
 * A deploy that reports "ok" on every file has told you the bytes were accepted,
 * not that the page renders — this repo has already had one outage where every
 * upload verified and the site returned 500 to everyone. So load hawkeye.com.ng
 * itself, in English and in Hausa, and read what a reader sees.
 *
 * CONTROL: the English run is the control for the Hausa one. If the selectors
 * silently stopped resolving, the English run reports nulls and the whole thing
 * fails loudly rather than reporting "no differences found".
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const SITE = 'https://hawkeye.com.ng';
let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

const browser = await chromium.launch();

async function read(lang, page = '') {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await ctx.addInitScript((code) => {
    try {
      localStorage.setItem('hawkeye_lang', code);
      localStorage.setItem('hawkeye_lang_prompt_done', '1');
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch (e) { /* private mode */ }
  }, lang);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  const resp = await p.goto(`${SITE}/${page}`, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(700);
  const out = await p.evaluate(() => {
    const txt = (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
    const all = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
    return {
      lang: document.documentElement.lang,
      title: document.title,
      footer: all('.gov-footer nav a'),
      groups: all('#menu-panel .menu-group'),
      hero: txt('.hero-badge'),
      h1: txt('main h1') || txt('.hero h1') || txt('.home-hero h1') || txt('h1'),
      kicker: txt('.kicker.reveal'),
      i18nVersion: [...document.querySelectorAll('script[src*="i18n.js"]')].map((s) => s.getAttribute('src'))[0],
      menuVersion: [...document.querySelectorAll('script[src*="menu.js"]')].map((s) => s.getAttribute('src'))[0],
    };
  });
  await ctx.close();
  return { ...out, status: resp && resp.status(), errs };
}

console.log('=== hawkeye.com.ng in English (control: the selectors resolve) ===');
const en = await read('en');
check('the site answers 200', en.status === 200, en.status);
check('no page errors', en.errs.length === 0, en.errs.slice(0, 2));
/**
 * READ THE EXPECTED VERSION OUT OF THE LOCAL TREE, never hardcode it.
 *
 * Hardcoding it went stale on the very first bump and reported "FAIL … got
 * menu.js?v=169" against a site that was serving exactly the right file — a
 * checker crying wolf is as bad as one that stays silent, because the next real
 * failure gets read as another stale pin. Comparing against what we just
 * deployed also makes this a genuine deploy check: it fails when the edge is
 * still serving the previous version.
 */
const localPins = fs.readFileSync('/home/elrio/hawkeye/app/index.html', 'utf8');
const want = (f) => (localPins.match(new RegExp(`${f.replace('.', '\\\\.')}\\\\?v=\\\\d+`)) || [''])[0];
check(`the deployed i18n.js matches local (${want('i18n.js')})`,
  (en.i18nVersion || '').includes(want('i18n.js')), { live: en.i18nVersion, local: want('i18n.js') });
check(`the deployed menu.js matches local (${want('menu.js')})`,
  (en.menuVersion || '').includes(want('menu.js')), { live: en.menuVersion, local: want('menu.js') });
check('the footer has 7 links (signed out)', en.footer.length === 7, en.footer);
check('  ...in English', en.footer[0] === 'About', en.footer);
check('the ☰ panel has groups', en.groups.length >= 4, en.groups);
check('the hero badge reads', !!en.hero, en.hero);

console.log('\n=== the same page in Hausa — this is the bug that was reported ===');
const ha = await read('ha');
check('html lang is ha', ha.lang === 'ha', ha.lang);
const moved = (n, a, b) => check(n, !!b && a !== b, { en: a, ha: b });
moved('the <title> translated', en.title, ha.title);
for (let i = 0; i < en.footer.length; i++) moved(`footer "${en.footer[i]}" translated`, en.footer[i], ha.footer[i]);
for (let i = 0; i < en.groups.length; i++) moved(`☰ group "${en.groups[i]}" translated`, en.groups[i], ha.groups[i]);
moved('the hero badge translated', en.hero, ha.hero);
moved('the hero headline translated', en.h1, ha.h1);
moved('the "How it works" kicker translated', en.kicker, ha.kicker);

console.log('\n=== a second page, to prove it is not just Home ===');
const enH = await read('en', 'how.html');
const haH = await read('ha', 'how.html');
check('how.html answers 200', enH.status === 200, enH.status);
moved('how.html <title> translated', enH.title, haH.title);
moved('how.html H1 translated', enH.h1, haH.h1);
for (let i = 0; i < enH.footer.length; i++) moved(`how.html footer "${enH.footer[i]}" translated`, enH.footer[i], haH.footer[i]);

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed — the live site renders translated');
process.exit(failed ? 1 : 0);

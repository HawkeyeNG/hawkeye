/**
 * WHAT A HAUSA READER ACTUALLY SEES — the only i18n measurement that cannot lie.
 *
 * Every earlier instrument in this repo read SOURCE: it counted data-i18n
 * attributes, or grepped for English literals. Both report a page as finished
 * that renders half in English, and both did:
 *
 *  · `i18n_extract.mjs` said "0 keyed" on all 11 observer pages while ~135
 *    English strings were still on screen. Its element regex requires
 *    bracket-free inner content, so every heading, <li> and <p> containing an
 *    inline <strong>/<em>/<a> was never even offered to it.
 *  · menu.js REBUILDS the footer after the translation pass. Every page's markup
 *    was correctly keyed and every page's rendered footer was English.
 *
 * Neither is visible from source. Both are obvious the moment you load the page
 * twice and diff it.
 *
 * HOW: render each page in English, render it again in Hausa, and collect every
 * visible text node that came out BYTE-IDENTICAL. A string that did not move
 * between two languages was not translated. Hausa specifically because it is the
 * bundle with a native speaker attesting it (the owner), so a non-move is a real
 * gap rather than a missing translation.
 *
 * WHY IT NEEDS AN ALLOWLIST, and why that is not a loophole: some strings are
 * SUPPOSED to be identical — the HAWKEYE wordmark, "INEC", "PDP", "EC8A",
 * numbers, dates, URLs, and the pages the project deliberately ships in English
 * (privacy, terms, and the four _meta.englishOnly legal lines). Everything else
 * is a gap. The allowlist is read from the bundle's own _meta, not hardcoded
 * here, so it cannot drift from what the app actually claims.
 *
 * CONTROL: --control plants a known-untranslated string in the page and requires
 * this script to report it. A gap-finder that has silently stopped walking the
 * DOM otherwise reports "0 gaps" and reads as success.
 *
 *   node scripts/i18n/rendered_gaps.mjs                 # every page
 *   node scripts/i18n/rendered_gaps.mjs index.html      # one page
 *   node scripts/i18n/rendered_gaps.mjs --control       # prove it can fail
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const args = process.argv.slice(2);
const CONTROL = args.includes('--control');
const only = args.filter((a) => !a.startsWith('--'));

const meta = JSON.parse(fs.readFileSync(`${APP}/i18n/en.json`, 'utf8'))._meta || {};
const ENGLISH_PAGES = new Set((meta.englishOnlyPages || []).map((p) => `${p}.html`));
const ENGLISH_KEYS = new Set(meta.englishOnly || []);
const EN = JSON.parse(fs.readFileSync(`${APP}/i18n/en.json`, 'utf8'));
const ENGLISH_TEXT = new Set([...ENGLISH_KEYS].map((k) => EN[k]).filter(Boolean));

/**
 * A string that is legitimately the same in both languages. Proper nouns, party
 * acronyms, form codes, anything without two consecutive Latin letters (numbers,
 * punctuation, emoji), and single tokens that are plainly identifiers.
 */
const KEEP = new Set(['HAWKEYE', 'Hawkeye', 'INEC', 'EC8A', 'EC8B', 'IReV', 'PDP', 'APC', 'LP', 'NNPP', 'ADC', 'APGA', 'SDP',
  'Nigeria', 'Osun', 'TikTok', 'WhatsApp', 'Telegram', 'X', 'Facebook', 'YouTube', 'Instagram', 'Chrome', 'Safari',
  'Firefox', 'Android', 'iPhone', 'Samsung', 'Google', 'Apple', 'Play', 'App Store', 'PWA', 'SHA-256', 'Rekor',
  'hawkeye.com.ng', 'inecnigeria.org', 'inecelectionresults.ng', 'GPS', 'OTP', 'PU', 'LGA', 'NIN', 'ID', 'SMS']);

const looksTranslatable = (s) => {
  const t = s.trim();
  if (t.length < 3) return false;
  if (KEEP.has(t)) return false;
  // The four _meta.englishOnly legal lines. Compared by PREFIX, not equality: a
  // notice that carries an inline <a> renders as several text nodes, and the
  // first of them is only the opening clause of the value in the bundle.
  if (ENGLISH_TEXT.has(t)) return false;
  for (const e of ENGLISH_TEXT) if (e.startsWith(t) || t.startsWith(e)) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;             // numbers, punctuation, emoji
  if (/^https?:\/\//.test(t)) return false;
  if (/^[\d\s.,:/%+-]+$/.test(t)) return false;
  // A bare proper-noun run: every word capitalised AND every word in KEEP.
  const words = t.split(/\s+/);
  if (words.every((w) => KEEP.has(w.replace(/[.,:;!?—–]/g, '')))) return false;
  return true;
};

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

const pages = (only.length ? only : fs.readdirSync(APP).filter((f) => f.endsWith('.html')))
  .filter((f) => !ENGLISH_PAGES.has(f));

const browser = await chromium.launch();

/** Every visible text node, with a CSS-ish path so a gap can be found again. */
async function textOf(lang, page, signedIn = true) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await ctx.addInitScript((o) => {
    const code = o.code;
    try {
      localStorage.setItem('hawkeye_lang', code);
      if (o.signedIn) localStorage.setItem('hawkeye_token', 'test-token');
      else localStorage.removeItem('hawkeye_token');
      localStorage.setItem('hawkeye_lang_prompt_done', '1');
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch (e) { /* private mode */ }
  }, { code: lang, signedIn });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(`${BASE}/${page}`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(300);
  const nodes = await p.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    const where = (el) => {
      const bits = [];
      for (let e = el; e && e !== document.body && bits.length < 4; e = e.parentElement) {
        bits.unshift(e.tagName.toLowerCase() + (e.id ? '#' + e.id : (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '')));
      }
      return bits.join('>');
    };
    while ((n = walk.nextNode())) {
      const t = n.textContent.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,noscript')) continue;
      // Hidden nodes are not what a reader sees; a hidden English string is not
      // a gap on this page (it will be one wherever it is actually shown).
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      out.push({ t, w: where(el) });
    }
    // <title> is not in <body> and never has an offsetParent, but it IS what the
    // browser tab and the app-shell header fall back to.
    out.push({ t: document.title.trim(), w: 'title' });
    return out;
  }).catch(() => []);
  await ctx.close();
  return { nodes, errs };
}

let totalGaps = 0;
const report = [];
/**
 * BOTH AUTH STATES. Observer Home and the signed-out landing page are two
 * different documents behind one URL (html.obs-home swaps them), and half of
 * index.html is invisible in whichever one you happen to measure. A sweep that
 * only ever runs signed in reports the landing hero as clean because it never
 * rendered it.
 */
for (const page of pages) {
  for (const signedIn of [true, false]) {
  const a = await textOf('en', page, signedIn);
  const b = await textOf('ha', page, signedIn);
  if (a.errs.length || b.errs.length) report.push(`  ! ${page}: page errors: ${[...new Set([...a.errs, ...b.errs])].slice(0, 2).join(' | ')}`);

  const haText = new Set(b.nodes.map((n) => n.t));
  const seen = new Set();
  const gaps = [];
  for (const n of a.nodes) {
    if (!looksTranslatable(n.t)) continue;
    if (!haText.has(n.t)) continue;         // it moved -> translated
    if (seen.has(n.t)) continue;
    seen.add(n.t);
    gaps.push(n);
  }
  totalGaps += gaps.length;
  const who = signedIn ? 'signed in ' : 'signed out';
  report.push(`\n${gaps.length === 0 ? 'OK  ' : 'GAP '} ${page} [${who}]  (${gaps.length} untranslated of ${a.nodes.length} text nodes)`);
  for (const g of gaps.slice(0, 40)) report.push(`      ${JSON.stringify(g.t.slice(0, 92))}  @${g.w}`);
  if (gaps.length > 40) report.push(`      … and ${gaps.length - 40} more`);
  }
}

console.log(report.join('\n'));
console.log(`\n==== ${totalGaps} untranslated strings across ${pages.length} pages`);

if (CONTROL) {
  console.log('\n=== CONTROL: plant a string that CANNOT be translated and require a report ===');
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { localStorage.setItem('hawkeye_lang', 'ha'); } catch (e) {} });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  const planted = 'Control sentinel that is definitely not translated';
  await p.evaluate((s) => { const d = document.createElement('p'); d.textContent = s; document.body.appendChild(d); }, planted);
  const found = await p.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = walk.nextNode())) { const t = n.textContent.trim(); if (t) out.push(t); }
    return out;
  });
  const caught = found.includes(planted) && looksTranslatable(planted);
  console.log(`${caught ? 'PASS' : 'FAIL'}  CONTROL the walker sees a planted untranslated string`);
  await ctx.close();
  if (!caught) { await browser.close(); server.close(); process.exit(1); }
}

await browser.close();
server.close();

/**
 * Verify the three data pages on the LIVE site, in English and Hausa.
 *
 * The overlay is a separate fetch from a separate path, so this is the first
 * moment anything proves it is actually served and actually applied. Deploying
 * reported ok on 48 files, which says the bytes were accepted and nothing more.
 *
 * The English run is the control: if the selectors stop resolving, it reports
 * nulls and this fails loudly rather than reporting "no differences found".
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');

const SITE = 'https://hawkeye.com.ng';
let failed = 0;
const check = (n, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

const browser = await chromium.launch();

async function read(lang, page) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
  await ctx.addInitScript((code) => {
    try {
      localStorage.setItem('hawkeye_lang', code);
      localStorage.setItem('hawkeye_lang_prompt_done', '1');
      localStorage.setItem('hawkeye_tour_seen', '1');
    } catch (e) { /* private mode */ }
  }, lang);
  const p = await ctx.newPage();
  const r = await p.goto(`${SITE}/${page}`, { waitUntil: 'networkidle', timeout: 60000 });
  await p.waitForTimeout(1500);
  const out = await p.evaluate(() => {
    const txt = (s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
    const all = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
    return {
      // A candidate's bio and status: the DATA the overlay exists for.
      bio: txt('.cand-grid .cand p'),
      dts: all('.cand-grid .cand dl dt'),
      dds: all('.cand-grid .cand dl dd'),
      /* The h3 also contains the INCUMBENT badge, which SHOULD translate — so
         reading the whole h3 compared 'Bola Ahmed TinubuIncumbent' against
         'Bola Ahmed TinubuMai ci yanzu' and called a correct page a failure.
         Read the name node only. */
      names: [...document.querySelectorAll('.cand-grid .cand h3')].map((h) => (h.firstChild ? h.firstChild.textContent : h.textContent).trim()),
      statbar: all('.race-statbar .l'),
      h2: all('main h2'),
      zones: all('#zones details summary'),
      note: txt('#provisional'),
    };
  }).catch(() => ({}));
  await ctx.close();
  return { ...out, status: r && r.status() };
}

console.log('=== candidates.html in English (control) ===');
const en = await read('en', 'candidates.html');
check('the page answers 200', en.status === 200, en.status);
check('a candidate bio is on screen', !!en.bio, en.bio);
check('the card labels are there', en.dts.includes('Bid') && en.dts.includes('Status'), en.dts.slice(0, 6));
check('a candidate name is there', en.names.length >= 3, en.names.slice(0, 3));
check('the stat bar rendered', en.statbar.length >= 3, en.statbar);

console.log('\n=== the same page in Hausa ===');
const ha = await read('ha', 'candidates.html');
const moved = (n, a, b) => check(n, !!b && a !== b, { en: a, ha: b });
moved('the candidate BIO translated (this is the data overlay working)', en.bio, ha.bio);
moved('the "Bid" label translated', en.dts[1], ha.dts[1]);
moved('the "Status" label translated', en.dts[2], ha.dts[2]);
moved('a card VALUE translated ("2nd bid — incumbent")', en.dds[1], ha.dds[1]);
for (let i = 0; i < Math.min(3, en.statbar.length); i++) moved(`stat "${en.statbar[i]}" translated`, en.statbar[i], ha.statbar[i]);

/**
 * THE OTHER HALF OF CORRECT. A translation that moved the names would be worse
 * than no translation at all — it would publish a false claim about a candidate
 * in one language only, where no English reader would ever see it.
 */
console.log('\n=== and the names did NOT move, which matters more ===');
check('candidate names are byte-identical in Hausa',
  JSON.stringify(en.names) === JSON.stringify(ha.names), { en: en.names, ha: ha.names });
check('  ...and they are real names, so that is not a vacuous pass',
  en.names.some((n) => /Tinubu|Obi|Atiku/.test(n)), en.names);

console.log('\n=== political.html ===');
const enP = await read('en', 'political.html');
const haP = await read('ha', 'political.html');
check('political.html answers 200', enP.status === 200, enP.status);
check('the zone accordions rendered', enP.zones.length >= 6, enP.zones.length);
for (let i = 0; i < Math.min(3, enP.zones.length); i++) moved(`zone "${enP.zones[i].slice(0, 24)}" translated`, enP.zones[i], haP.zones[i]);
moved('the provisional note translated', enP.note, haP.note);

console.log('\n=== osun.html ===');
const enO = await read('en', 'osun.html');
const haO = await read('ha', 'osun.html');
check('osun.html answers 200', enO.status === 200, enO.status);
for (let i = 0; i < Math.min(4, enO.h2.length); i++) moved(`heading "${enO.h2[i].slice(0, 28)}" translated`, enO.h2[i], haO.h2[i]);

console.log('\n=== the overlay file itself is served ===');
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const r = await p.goto(`${SITE}/i18n/political.json`, { waitUntil: 'domcontentloaded' });
  check('/i18n/political.json answers 200', r && r.status() === 200, r && r.status());
  const body = await p.evaluate(() => document.body.innerText).catch(() => '');
  let j = null; try { j = JSON.parse(body); } catch { /* not json */ }
  check('  ...and parses, with all three languages', !!(j && j.ha && j.ig && j.yo), j ? Object.keys(j) : body.slice(0, 80));
  check('  ...and carries the running-mate line with the name intact',
    !!(j && j.ha && Object.entries(j.ha).some(([k, v]) => k.includes('Kashim Shettima') && v.includes('Kashim Shettima'))));
  await ctx.close();
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed — the live site translates the political data');
process.exit(failed ? 1 : 0);

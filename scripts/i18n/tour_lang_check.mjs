/* Does the first-run tour actually render translated? It is painted by JS, not
   by data-i18n attributes, so the attribute sweep says nothing about it. Same
   fixture tests/tour_test.mjs uses: forced Lite shell, a valid-looking token,
   the language chosen up front. */
import { createRequire } from 'node:module';
const { chromium } = createRequire('/home/elrio/hawkeye/tests/ui/')('playwright-core');
import { spawn } from 'node:child_process';

const base = 'http://127.0.0.1:8430';
const JWT = () => 'x.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64') + '.y';

const server = spawn('node', ['src/server.js'], {
  cwd: '/home/elrio/hawkeye/backend',
  env: { ...process.env, SMS_PROVIDER: 'console', PORT: '8430' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 2500));

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const results = {};
for (const lang of ['en', 'ha', 'yo']) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript((o) => {
    Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
    const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
    mark();
    document.addEventListener('readystatechange', mark);
    try {
      localStorage.setItem('hawkeye_token', o.token);
      localStorage.removeItem('hawkeye_tour_seen');
      localStorage.setItem('hawkeye_lang_prompted', '1');
      if (o.lang === 'en') localStorage.removeItem('hawkeye_lang');
      else localStorage.setItem('hawkeye_lang', o.lang);
    } catch (e) { /* ignore */ }
  }, { token: JWT(), lang });
  const p = await ctx.newPage();
  await p.goto(base + '/index.html');
  await p.waitForTimeout(1800);

  const open = await p.evaluate(() => { const t = document.querySelector('.tour'); return !!t && !t.hidden; });
  if (!open) { results[lang] = { open: false }; await ctx.close(); continue; }

  const read = () => p.evaluate(() => ({
    heading: document.querySelector('#tour-title')?.textContent,
    name: document.querySelector('.tour-name')?.textContent,
    text: document.querySelector('.tour-text')?.textContent,
    note: document.querySelector('.tour-note')?.textContent || '',
    back: document.querySelector('.tour-skip')?.textContent,
    next: document.querySelector('.tour-next')?.textContent,
    close: document.querySelector('.tour-x')?.getAttribute('aria-label'),
  }));
  const cards = [await read()];
  for (let i = 0; i < 4; i++) { await p.click('.tour-next'); await p.waitForTimeout(160); cards.push(await read()); }
  results[lang] = { open: true, cards };
  await ctx.close();
}
await b.close();
server.kill();

/* Compare against the ENGLISH RUN, not against ASCII. "Report — the green
   button" and the nonpartisan note both contain an em dash, so an ascii-only
   test calls correct English "translated" and proves nothing. */
const FIELDS = ['heading', 'name', 'text', 'note', 'back', 'next', 'close'];
const en = results.en;

for (const [lang, r] of Object.entries(results)) {
  if (!r.open) { console.log(lang + ': TOUR DID NOT OPEN'); continue; }
  console.log('\n=== ' + lang + ' ===');
  r.cards.forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c.name + ' | ' + (c.text || '').slice(0, 58)));
  console.log('  chrome: heading=' + JSON.stringify(r.cards[0].heading)
    + ' back=' + JSON.stringify(r.cards[0].back) + ' next=' + JSON.stringify(r.cards[0].next)
    + ' last=' + JSON.stringify(r.cards[4].next) + ' close=' + JSON.stringify(r.cards[0].close));
  console.log('  note on card 1 only: ' + (!!r.cards[0].note && r.cards.slice(1).every((c) => !c.note)));
  if (lang !== 'en' && en.open) {
    const same = [];
    r.cards.forEach((c, i) => FIELDS.forEach((f) => {
      if ((c[f] || '') && c[f] === en.cards[i][f]) same.push('card' + (i + 1) + '.' + f);
    }));
    console.log('  STILL ENGLISH: ' + (same.length ? same.join(', ') : 'nothing'));
  }
}

/* CONTROL: every field must differ from English in both languages, and the
   English run must of course match itself. A check that only asked "is
   anything translated" would pass on the bug this found — cards 2-5 translated
   while card 1, painted before the dictionary landed, stayed English. */
const stillEnglish = (r) => {
  const out = [];
  r.cards.forEach((c, i) => FIELDS.forEach((f) => { if ((c[f] || '') && c[f] === en.cards[i][f]) out.push(f); }));
  return out;
};
const ha = stillEnglish(results.ha), yo = stillEnglish(results.yo);
const selfMatch = stillEnglish(results.en).length;   // must be > 0: proves the comparison detects sameness
console.log('\ncontrol: comparing English against itself finds ' + selfMatch + ' identical fields (must be > 0)');
console.log('Hausa fields still English: ' + ha.length + '   Yoruba: ' + yo.length);
const ok = selfMatch > 0 && ha.length === 0 && yo.length === 0;
console.log(ok ? 'TOUR TRANSLATION OK' : 'TOUR TRANSLATION NOT PROVEN');
process.exitCode = ok ? 0 : 1;

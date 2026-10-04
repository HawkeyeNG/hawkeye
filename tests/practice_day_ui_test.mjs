/**
 * National Practice Day — the home card (index.html) and the results page
 * (practice-day.html) in every state, against a stubbed /api/practice-days.
 *
 * What is proven, and the control for each:
 *  - each state paints its own words and links; the null and error states
 *    HIDE the card (control: the same page with a day shows it);
 *  - translation happens at PAINT time: the page loads in Hausa, then switches
 *    to Yorùbá without a reload, and the card follows (control: the English
 *    run shows English, so the Hausa check is not reading a default);
 *  - no page errors and no console errors in any state.
 *
 * The Hausa/Yorùbá strings come from scripts/i18n/batches/practiceday_web.json
 * merged over the shipped bundle — exactly what the merge will ship.
 *
 *   node tests/practice_day_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const BATCH = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/scripts/i18n/batches/practiceday_web.json', 'utf8'));
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const H = 3_600_000;
const DEC = { date: '2026-12-12', startsAt: Date.parse('2026-12-12T08:00:00+01:00'), endsAt: Date.parse('2026-12-12T18:00:00+01:00') };
const JAN = { date: '2027-01-09', startsAt: Date.parse('2027-01-09T08:00:00+01:00'), endsAt: Date.parse('2027-01-09T18:00:00+01:00') };
const dayOf = (d, phase) => ({ ...d, phase, resultsUntil: d.endsAt + 5 * 24 * H, window: { start: '08:00', end: '18:00' }, timezone: 'Africa/Lagos', utcOffset: '+01:00' });
const totals = (a, b) => ['A', 'B', 'C', 'D', 'E', 'F'].map((x, i) => ({ party: `Party ${x}`, color: '#2e7d32', votes: i === 0 ? a : i === 1 ? b : 0 }));
const results = (n, a = 0, b = 0) => ({ participants: n, runs: n, tallied: n, totals: totals(a, b), asOf: Date.now() });
const STATES = {
  before: { day: dayOf(DEC, 'before'), results: null, next: JAN, days: [{ ...DEC, phase: 'before' }, { ...JAN, phase: 'before' }], now: Date.now() },
  live0: { day: dayOf(DEC, 'live'), results: results(0), next: JAN, days: [], now: Date.now() },
  live1: { day: dayOf(DEC, 'live'), results: results(1, 212, 188), next: JAN, days: [], now: Date.now() },
  live: { day: dayOf(DEC, 'live'), results: results(1234, 261_000, 232_000), next: JAN, days: [{ ...DEC, phase: 'live' }, { ...JAN, phase: 'before' }], now: Date.now() },
  after: { day: dayOf(DEC, 'after'), results: results(1234, 261_000, 232_000), next: JAN, days: [{ ...DEC, phase: 'after' }, { ...JAN, phase: 'before' }], now: Date.now() },
  none: { day: null, next: null, days: [], now: Date.now() },
};
let state = 'before';
let lastPracticeDaysUrl = '';

const merged = (lang) => {
  const b = JSON.parse(fs.readFileSync(path.join(APP, 'i18n', lang + '.json'), 'utf8'));
  for (const [k, v] of Object.entries(BATCH)) b[k] = v[lang];
  return b;
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/practice-days') {
    lastPracticeDaysUrl = req.url;
    if (state === 'error') return json({ error: 'practice_days_unavailable' }, 500);
    return json(STATES[state]);
  }
  // A SAVED UNIT, so Home's next step ("Choose your polling unit", #home-next)
  // does not take the hero slot — since flow walkthrough FA-HOME-1 it outranks
  // the Practice Day card (tests/practice_nudge_ui_test.mjs holds the control).
  if (url === '/api/observers/me') return json({ observerId: 7, reports: [], collation: [], incidents: [], subscriptions: [],
    unit: { pu_code: '24-16-05-007', name: '17, Oziegbe St.', ward: 'Aguda', lga: 'Surulere', state: 'Lagos' } });
  if (url === '/api/notifications') return json({ items: [] });
  if (url === '/api/mapping/stats') return json({ total: 0, verified: 0, crowdMapped: 0 });
  if (url.startsWith('/api/')) return json([]);
  const m = /^\/i18n\/(ha|ig|yo)\.json$/.exec(url);
  if (m) return json(merged(m[1]));
  const f = path.join(APP, decodeURIComponent(url === '/' ? '/index.html' : url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
// A token-shaped value with a future exp: index.html shows the Observer Home only when one is stored.
const TOKEN = 'x.' + Buffer.from(JSON.stringify({ sub: '7', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url') + '.y';

async function open(page, st, { lang = 'en', path: p = '/index.html', wait = '#pday-card' } = {}) {
  state = st;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([tok, l]) => {
    try { localStorage.setItem('hawkeye_token', tok); localStorage.setItem('hawkeye_lang', l); localStorage.setItem('hawkeye_tour_done', '1'); } catch (e) {}
  }, [TOKEN, lang]);
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await pg.goto(base + p, { waitUntil: 'networkidle' });
  await pg.waitForSelector(wait, { state: 'attached', timeout: 10000 });
  await pg.waitForTimeout(300);
  return { pg, ctx, errs };
}
const card = (pg) => pg.evaluate(() => {
  const c = document.getElementById('pday-card');
  return {
    hidden: c.hidden || c.offsetParent === null,
    text: c.innerText.replace(/\s+/g, ' ').trim(),
    links: [...c.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    phase: c.dataset.phase || null,
  };
});

/* ---------- home card ---------- */
let r = await open(null, 'before');
let c = await card(r.pg);
check('before: card is shown', c.hidden, false);
check('before: title, date and window', c.text, (t) => t.startsWith('National Practice Day') && t.includes('Saturday, 12 December · 08:00–18:00 WAT'));
check('before: the one line', c.text, (t) => t.includes('Everyone runs the mock election on the same day'));
check('before: "Practise now" opens the practice flow', c.links, ['practice.html']);
check('before: no provisional / to-be-confirmed wording', /provisional|to be confirmed|tbc/i.test(c.text), false);
check('before: no page or console errors', r.errs, []);
// CONTROL: the error capture is live — a console.error on this page is seen.
await r.pg.evaluate(() => console.error('control-error'));
await r.pg.waitForTimeout(50);
check('CONTROL the console-error capture sees an error', r.errs.some((e) => e.includes('control-error')), true);
if (process.env.PDAY_SHOTS) await r.pg.locator('#pday-card').screenshot({ path: `${process.env.PDAY_SHOTS}/card-before.png` });
await r.ctx.close();

r = await open(null, 'live0'); c = await card(r.pg);
check('live, nobody yet: a first-to-practise line, not "0 observers"', c.text, (t) => t.includes('It’s Practice Day') && t.includes('Be the first') && !/\b0 observers/.test(t));
await r.ctx.close();
r = await open(null, 'live1'); c = await card(r.pg);
check('live, one: singular sentence', c.text, (t) => t.includes('1 observer has practised today.'));
await r.ctx.close();
r = await open(null, 'live'); c = await card(r.pg);
check('live: "N observers have practised today", grouped', c.text, (t) => t.includes('1,234 observers have practised today.'));
check('live: links to the count and to practise', c.links, ['practice-day.html?day=2026-12-12', 'practice.html']);
check('live: no errors', r.errs, []);
if (process.env.PDAY_SHOTS) await r.pg.locator('#pday-card').screenshot({ path: `${process.env.PDAY_SHOTS}/card-live.png` });
await r.ctx.close();

r = await open(null, 'after'); c = await card(r.pg);
check('after: results title, the shared count, and the next day', c.text,
  (t) => t.startsWith('Practice Day results') && t.includes('1,234 observers practised on Saturday, 12 December.') && t.includes('Next Practice Day: Saturday, 9 January'));
check('after: links to the results page for THAT day', c.links, ['practice-day.html?day=2026-12-12']);
check('after: no errors', r.errs, []);
// IN THE HERO NOW (flow walkthrough FA-HOME-1 — .home-stack is gone): the card
// sits above the greeting, and ends exactly its own bottom margin above it, so
// the hidden next-step and nudge cards beside it take no space.
const gaps = await r.pg.evaluate(() => {
  const vis = [...document.querySelectorAll('.home-hero .home-card')].filter((el) => el.getClientRects().length);
  const greet = document.getElementById('home-greet').getBoundingClientRect().top;
  return vis.map((el) => [el.id, Math.round(greet - el.getBoundingClientRect().bottom), Math.round(parseFloat(getComputedStyle(el).marginBottom))]);
});
check('visible card: the only card in the hero, one margin above the greeting', gaps, (g) => g.length === 1 && g[0][0] === 'pday-card' && g[0][1] === g[0][2] && g[0][2] > 0);
if (process.env.PDAY_SHOTS) await r.pg.screenshot({ path: `${process.env.PDAY_SHOTS}/home-after.png`, fullPage: false });
await r.ctx.close();

r = await open(null, 'none'); c = await card(r.pg);
check('no day: card hidden', c.hidden, true);
check('no day: no errors', r.errs, []);
await r.ctx.close();
r = await open(null, 'error'); c = await card(r.pg);
check('API error: card hidden (home is not the place to report it)', c.hidden, true);
// The 500 itself is logged by the browser as a failed resource; that is the stub, not the page.
check('API error: no page errors', r.errs.filter((e) => !/status of 500/.test(e)), []);
await r.ctx.close();

/* ---------- translated at paint time ---------- */
r = await open(null, 'before', { lang: 'ha' });
await r.pg.waitForFunction(() => /Ranar Atisaye/.test(document.getElementById('pday-card').innerText), null, { timeout: 5000 }).catch(() => {});
c = await card(r.pg);
check('Hausa: title and weekday/month in Hausa', c.text, (t) => t.includes('Ranar Atisaye ta Ƙasa') && t.includes('Asabar, 12 Disamba'));
check('Hausa: button in Hausa', c.text, (t) => t.includes('Yi atisaye yanzu'));
await r.pg.evaluate(() => window.HawkeyeI18n.set('yo'));
await r.pg.waitForFunction(() => /Àdánwò/.test(document.getElementById('pday-card').innerText), null, { timeout: 5000 }).catch(() => {});
c = await card(r.pg);
check('switch to Yorùbá without reload: the card repaints', c.text, (t) => t.includes('Ọjọ́ Àdánwò Orílẹ̀-èdè') && t.includes('Ọjọ́ Àbámẹ́ta') && !t.includes('Ranar'));
check('language switch: no errors', r.errs, []);
await r.ctx.close();

/* ---------- results page ---------- */
const pageInfo = (pg) => pg.evaluate(() => {
  const s = document.getElementById('pday-page');
  return {
    text: s.innerText.replace(/\s+/g, ' ').trim(),
    bars: s.querySelectorAll('.pday-bar').length,
    widths: [...s.querySelectorAll('.pday-fill')].map((f) => f.style.width),
    buttons: [...s.querySelectorAll('a.btn-accent')].map((a) => a.getAttribute('href')),
    dayLinks: [...s.querySelectorAll('.pday-days a')].map((a) => a.getAttribute('href')),
  };
});
r = await open(null, 'live', { path: '/practice-day.html?day=2026-12-12', wait: '#pday-page .pday-stat' });
let p = await pageInfo(r.pg);
check('page asks the API for the day in its URL', lastPracticeDaysUrl, '/api/practice-days?day=2026-12-12');
check('page live: count, open-until line, six bars', [p.text.includes('1,234 observers practised'), p.text.includes('Open now until 18:00 WAT'), p.bars], [true, true, 6]);
check('page live: bars scale to the leader', p.widths.slice(0, 3), ['100%', '89%', '0%']);
check('page live: practise button, and a link to the other day', [p.buttons, p.dayLinks], [['practice.html'], ['practice-day.html?day=2027-01-09']]);
check('page live: the method line says who is counted', p.text.includes('Hawkeye team accounts are left out'), true);
check('page live: no errors', r.errs, []);
if (process.env.PDAY_SHOTS) await r.pg.screenshot({ path: `${process.env.PDAY_SHOTS}/page-live.png`, fullPage: true });
await r.ctx.close();

r = await open(null, 'after', { path: '/practice-day.html?day=2026-12-12', wait: '#pday-page .pday-stat' });
p = await pageInfo(r.pg);
check('page after: closed line, no practise button', [p.text.includes('Closed. Final count for Saturday, 12 December.'), p.buttons], [true, []]);
await r.ctx.close();

r = await open(null, 'before', { path: '/practice-day.html', wait: '#pday-page .pday-status' });
p = await pageInfo(r.pg);
check('page before: opens line, no numbers yet', [p.text.includes('Opens Saturday, 12 December, 08:00–18:00 WAT'), p.bars, /observers practised/.test(p.text)], [true, 0, false]);
await r.ctx.close();

r = await open(null, 'none', { path: '/practice-day.html', wait: '#pday-page .pday-empty' });
p = await pageInfo(r.pg);
check('page none: empty state', p.text, 'No Practice Day is scheduled right now.');
check('page none: no errors', r.errs, []);
await r.ctx.close();

r = await open(null, 'error', { path: '/practice-day.html', wait: '#pday-page .pday-error' });
p = await pageInfo(r.pg);
check('page error: says so, with a retry', p.text, (t) => t.includes('Could not load the Practice Day count') && t.includes('Try again'));
state = 'live';
await r.pg.click('#pday-retry');
await r.pg.waitForSelector('#pday-page .pday-stat', { timeout: 5000 }).catch(() => {});
p = await pageInfo(r.pg);
check('page error -> retry recovers', p.bars, 6);
check('page error: no page errors', r.errs.filter((e) => !/status of 500/.test(e)), []);
await r.ctx.close();

r = await open(null, 'after', { lang: 'ig', path: '/practice-day.html?day=2026-12-12', wait: '#pday-page .pday-stat' });
await r.pg.waitForFunction(() => /Emechiela/.test(document.getElementById('pday-page').innerText), null, { timeout: 5000 }).catch(() => {});
p = await pageInfo(r.pg);
check('page Igbo: status and date in Igbo', p.text, (t) => t.includes('Emechiela') && t.includes('Satọdee, 12 Disemba'));
await r.ctx.close();

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

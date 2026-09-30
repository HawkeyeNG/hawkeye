/**
 * THE "NEW ROOM" FORM, as the owner met it on 2026-09-30.
 *
 * 1. "Which election" offered the 19 September by-elections, three weeks after
 *    they were declared. Asserted: an election is gone from the list once the
 *    day after its polls has passed (WAT) — whether the server flagged it
 *    `over` or the client worked it out from the date alone — while the 2027
 *    races stay. Control: the stub SERVES all four.
 *
 * 2. A State House of Assembly room was given a STATE as its race. Asserted:
 *    SHA asks for the state, then its state constituencies, with "All
 *    constituencies in <state>" as its own choice, and the chosen seat's key
 *    ("State|Seat") is what is sent.
 *
 * 3. A campaign could be set up with "Not saying" as its party, and so never
 *    reached the owner's Room requests. Asserted: the party is required (no
 *    request leaves the page without one), a civil-society room shows the
 *    organisation check instead, and the server's refusal for a past election
 *    comes back as a sentence, not a code.
 *
 * Plus a Hausa run: the new strings are translated, not English fallbacks.
 *
 *   node tests/room_setup_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg' };

const CONTESTS = [
  { code: 'PRES', name: 'Presidential', date: '2027-01-16', over: false },
  { code: 'SHA', name: 'State House of Assembly', date: '2027-02-06', over: false },
  // Flagged by the server.
  { code: 'REP_BYE_GOMBE_2026', name: 'House of Representatives By-Election', date: '2026-09-19', over: true },
  // NOT flagged (an older /api/contests): the client's own date check must catch it.
  { code: 'SHA_BYE_DELTA_UDU_2026', name: 'State House of Assembly By-Election (Udu)', date: '2026-09-19' },
];
const LAGOS = {
  kind: 'state_constituency', column: 'state_constituency', states: ['Kano', 'Lagos'],
  races: ['Lagos|Agege I', 'Lagos|Ikeja I', 'Lagos|Ikeja II'],
  labels: { 'Lagos|Agege I': 'Agege I', 'Lagos|Ikeja I': 'Ikeja I', 'Lagos|Ikeja II': 'Ikeja II' },
  shared: ['Lagos|Ikeja I', 'Lagos|Ikeja II'],
  stateWide: 'Lagos',
};

let posts = [];
const server = http.createServer((req, res) => {
  const [url, qs] = req.url.split('?');
  const q = new URLSearchParams(qs || '');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/groups' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      posts.push(b);
      // The server's own refusal, to see it come back as a sentence.
      json({ error: 'election_over' }, 400);
    });
    return undefined;
  }
  if (url === '/api/groups') return json({ managing: [], member: [] });
  if (url === '/api/contests') return json(CONTESTS);
  if (url === '/api/group-races') {
    const c = q.get('contest');
    if (c === 'PRES') return json({ kind: 'national', column: '', states: [], races: [] });
    if (c === 'SHA') return json(q.get('state') === 'Lagos' ? LAGOS : { ...LAGOS, races: [], labels: {}, shared: [], stateWide: undefined });
    return json({ kind: 'state', column: 'state', states: ['Lagos'], races: ['Lagos'] });
  }
  if (url.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(url));
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

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

async function open(lang) {
  const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.addInitScript((l) => {
    const enc = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    try {
      localStorage.setItem('hawkeye_lang', l);
      localStorage.setItem('hawkeye_token', enc({ alg: 'none' }) + '.' + enc({ sub: 1, exp: 4102444800 }) + '.x');
    } catch (e) { /* private mode */ }
  }, lang);
  await p.goto(`${base}/situation-room.html`, { waitUntil: 'networkidle' });
  await p.waitForSelector('#mk-contest option', { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(300);
  return { p, errs };
}
const alertText = async (p) => {
  const m = p.locator('.hk-dlg-msg');
  await m.first().waitFor({ timeout: 3000 }).catch(() => {});
  const t = (await m.count()) ? (await m.first().textContent()).trim() : null;
  if (t !== null) await p.locator('.hk-dlg-ok').first().click().catch(() => {});
  await p.waitForTimeout(150);
  return t;
};
const options = (p, id) => p.$$eval(`#${id} option`, (os) => os.map((o) => ({ v: o.value, t: o.textContent.trim() })));

try {
  const { p, errs } = await open('en');

  /* --- 1. past elections are not offered ---------------------------------- */
  console.log('=== 1. which election ===');
  const codes = (await options(p, 'mk-contest')).map((o) => o.v);
  check('the 2027 races are offered', codes.includes('PRES') && codes.includes('SHA'), true);
  check('the by-election the server flagged is not', codes.includes('REP_BYE_GOMBE_2026'), false);
  check('nor the one only its DATE says is over', codes.includes('SHA_BYE_DELTA_UDU_2026'), false);

  /* --- 3. a campaign must pick its party --------------------------------- */
  console.log('\n=== 3. a campaign names its party; a CSO its organisation ===');
  const party = await options(p, 'mk-party');
  check('"Not saying" is gone: the first option only asks for a choice', [party[0].v, /not saying/i.test(party[0].t), /choose/i.test(party[0].t)], ['', false, true]);
  check('the party check is explained', await p.isVisible('#mk-party-row'), true);
  await p.fill('#mk-name', 'Adaeze 2027');
  await p.click('#mk button[type="submit"]');
  const noParty = await alertText(p);
  check('submitting with no party is stopped with a sentence', noParty, (t) => /party/i.test(t || ''));
  check('and NOTHING was sent', posts.length, 0);
  await p.selectOption('#mk-kind', 'cso');
  check('a civil-society room hides the party', await p.isVisible('#mk-party-row'), false);
  check('and asks for its organisation instead', await p.isVisible('#mk-org-row'), true);
  const orgs = await options(p, 'mk-org');
  check('the list is the manifest\'s organisations, then Other',
    [orgs[0].v, orgs.some((o) => o.v === 'yiaga' && o.t === 'Yiaga Africa'), orgs[orgs.length - 1].v], ['', true, '__other']);
  check('it says a listing is not an endorsement', (await p.textContent('#mk-org-row')), (t) => /not a partnership/i.test(t) && /endorsement/i.test(t));
  await p.click('#mk button[type="submit"]');
  check('submitting with no organisation is stopped', await alertText(p), (t) => /organisation/i.test(t || ''));
  check('and nothing was sent', posts.length, 0);
  await p.selectOption('#mk-org', 'cdd');
  check('a listed organisation with no logo shows its initials', (await p.textContent('#mk-org-mark .sr-org-badge') || '').trim(), 'CDD');
  check('the Other name box stays hidden', await p.isVisible('#mk-org-other'), false);
  await p.selectOption('#mk-org', '__other');
  check('Other opens a box for the name', await p.isVisible('#mk-org-other'), true);
  check('CONTROL: a campaign hides the organisation picker', await (async () => { await p.selectOption('#mk-kind', 'campaign'); return p.isVisible('#mk-org-row'); })(), false);

  /* --- 2. SHA: state, then constituency ---------------------------------- */
  console.log('\n=== 2. a state assembly race is a state constituency ===');
  await p.selectOption('#mk-contest', 'SHA');
  await p.waitForTimeout(250);
  check('SHA asks for a state', await p.isVisible('#mk-state-row'), true);
  check('and no seat until one is chosen', await p.isVisible('#mk-race-row'), false);
  await p.selectOption('#mk-state', 'Lagos');
  await p.waitForTimeout(250);
  check('then its state constituencies', await p.isVisible('#mk-race-row'), true);
  check('under a "State constituency" label', (await p.textContent('#mk-race-label')).trim(), 'State constituency');
  const seats = await options(p, 'mk-race');
  check('"All constituencies in Lagos" is its own choice', seats.find((o) => o.v === 'Lagos')?.t, 'All constituencies in Lagos');
  check('each seat by its own name', seats.find((o) => o.v === 'Lagos|Ikeja I')?.t, 'Ikeja I');
  await p.selectOption('#mk-race', 'Lagos|Ikeja I');
  await p.waitForTimeout(100);
  check('a seat sharing its LGA says the figures are the LGA\'s', (await p.textContent('#mk-race-note')).trim(), (t) => /local government/i.test(t));
  await p.selectOption('#mk-race', 'Lagos');
  await p.waitForTimeout(100);
  check('the state-wide choice says it counts every seat', (await p.textContent('#mk-race-note')).trim(), (t) => /every state constituency in Lagos/i.test(t));
  await p.selectOption('#mk-race', 'Lagos|Ikeja I');
  await p.selectOption('#mk-party', { index: 1 });
  await p.click('#mk button[type="submit"]');
  const refused = await alertText(p);
  check('the chosen seat\'s KEY is what is sent, with the party', posts[0] && [posts[0].contest, posts[0].scope, !!posts[0].party], ['SHA', 'Lagos|Ikeja I', true]);
  check('the server\'s "election_over" reads as a sentence', refused, (t) => /over/i.test(t || '') && !/election_over/.test(t || ''));
  check('no page errors', errs, []);
  await p.close();

  /* --- Hausa --------------------------------------------------------------- */
  console.log('\n=== Hausa ===');
  const h = await open('ha');
  await h.p.selectOption('#mk-contest', 'SHA');
  await h.p.waitForTimeout(250);
  await h.p.selectOption('#mk-state', 'Lagos');
  await h.p.waitForTimeout(250);
  const ha = await options(h.p, 'mk-race');
  const wide = ha.find((o) => o.v === 'Lagos')?.t || '';
  check('"All constituencies in Lagos" is Hausa, with the state kept', [wide.includes('Lagos'), /All constituencies/.test(wide), wide.length > 0], [true, false, true]);
  const label = (await h.p.textContent('#mk-race-label')).trim();
  check('the seat label is Hausa', label !== 'State constituency' && label.length > 0, true);
  const first = (await options(h.p, 'mk-party'))[0].t;
  check('the party prompt is Hausa', /Choose/i.test(first), false);
  check('no page errors (Hausa)', h.errs, []);
  await h.p.close();
} catch (e) {
  fail += 1;
  console.log('FAIL  threw: ' + (e.stack || e));
} finally {
  await b.close();
  server.close();
}
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

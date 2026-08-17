// FOLLOWING HAS TWO SIZES AND MUST SAY WHICH ONE IT IS.
//
// A subscription row is (contest, region), and an empty region means every
// region. Only the empty form was ever reachable, labelled "Follow this race" —
// so a reader on the Senate board who wanted their own senator signed up for
// reports from all 109 districts. This test holds the fix: the category board
// says "all Senate races", a seat's own page follows that seat alone, and the
// two surfaces use the same words for the same thing.
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const APP = `${ROOT}/app`;
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml' };
const CONTESTS = JSON.parse(fs.readFileSync(`${ROOT}/backend/src/data/contests.json`, 'utf8'));

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${typeof want === 'function' ? '(predicate)' : JSON.stringify(want)}`}`);
};

// ── 1. The two platforms must use the same words ──────────────────────────────
// Not a style point: the same button on the website and in the app describing
// the same subscription differently is how a reader ends up unsure what they
// signed up for. Both files carry the map deliberately (no shared runtime
// between a browser page and a React Native bundle), so the test is the seam.
console.log('=== wording is shared between web and native ===');
const pluralsIn = (src) => {
  const body = src.match(/CONTEST_PLURAL[^{]*\{([^}]*)\}/s);
  if (!body) return null;
  const out = {};
  for (const m of body[1].matchAll(/(\w+)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2];
  return out;
};
const webPlural = pluralsIn(fs.readFileSync(`${APP}/follow.js`, 'utf8'));
const nativePlural = pluralsIn(fs.readFileSync(`${ROOT}/native/src/components/follow-race.tsx`, 'utf8'));
check('web names every contest', webPlural, { GOV: 'governorship', SEN: 'Senate', REP: 'House of Reps', SHA: 'State Assembly' });
check('native says exactly the same', nativePlural, webPlural);
// PRES is absent from both on purpose — it is one national race, so an empty
// region there IS the single race and "all Presidential races" would be a lie.
check('neither claims a plural for the presidency', [webPlural.PRES, nativePlural.PRES], [undefined, undefined]);

// ── the stub backend ──────────────────────────────────────────────────────────
let SUBS = [];            // what /api/observers/me reports
const posted = [];        // every /api/subscriptions call, in order
const server = http.createServer((req, res) => {
  const [url] = req.url.split('?');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url === '/api/contests') return json(CONTESTS.map((c) => ({ ...c, open: false, opensAt: `${c.date}T08:30:00+01:00`, election: `2027 ${c.name}` })));
  if (url === '/api/observers/me') return json({ subscriptions: SUBS });
  if (url === '/api/subscriptions') {
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', () => { posted.push({ method: req.method, body: JSON.parse(body || '{}') }); json({ ok: true }); });
  }
  if (url.startsWith('/api/national/')) {
    return json({
      contest: url.split('/').pop(), level: 'senatorial', scope: null, subunits: null,
      updatedAt: Date.now(), unitsReporting: 0, inDispute: 0, national: [], regions: [],
    });
  }
  if (url.startsWith('/api/coverage/')) return json({ missing: [], unit: 'senatorial district', unitPlural: 'senatorial districts', statesTotal: 109 });
  const f = path.join(APP, decodeURIComponent(url));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const errs = [];
const openPage = async (signedIn) => {
  const p = await b.newPage({ viewport: { width: 900, height: 1100 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  if (signedIn) await p.addInitScript(() => localStorage.setItem('hawkeye_token', 'TEST'));
  return p;
};
const followBtn = (p) => p.$eval('#race-follow-btn', (e) => e.textContent.trim()).catch(() => null);

// ── 2. A seat's own page follows THAT SEAT ────────────────────────────────────
console.log('\n=== a race page follows one race ===');
{
  const p = await openPage(true);
  for (const [label, url, want] of [
    ['governorship follows its state', 'race.html?contest=GOV&state=Kano', { contest: 'GOV', state: 'Kano' }],
    ['senate follows its district', 'race.html?contest=SEN&seat=Kano%20Central', { contest: 'SEN', state: 'Kano Central' }],
    ['reps follows its constituency', 'race.html?contest=REP&seat=Aba%20North%2FAba%20South', { contest: 'REP', state: 'Aba North/Aba South' }],
  ]) {
    SUBS = [];
    posted.length = 0;
    await p.goto(`${base}/${url}`, { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#race-follow-btn', { timeout: 10000 });
    check(`${label} — offered`, await followBtn(p), '🔔 Follow this race');
    await p.click('#race-follow-btn');
    await p.waitForFunction(() => document.getElementById('race-follow-btn').textContent.includes('Following'), { timeout: 5000 });
    // The region posted is the seat's own — exactly the key
    // subscriptions.js:reportScope buckets a report by for this contest.
    check(`${label} — posts its own region`, posted.at(-1), { method: 'POST', body: want });
    check(`${label} — button flips`, await followBtn(p), '🔔 Following this race');
  }
  await p.close();
}

// ── 3. A finished race asks for nothing ───────────────────────────────────────
console.log('\n=== a completed race offers no follow ===');
{
  const p = await openPage(true);
  await p.goto(`${base}/race.html?race=raceOsun2026`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.race-cta', { timeout: 10000 });
  // Same standing rule as "Become an Observer": past polling day there will be
  // no further reports, so an alert subscription has nothing to alert about.
  check('no follow button', await p.$('#race-follow-btn'), (v) => v === null);
  check('and still no recruitment CTA', await p.$('[data-cta="observe"]'), (v) => v === null);
  await p.close();
}

// ── 4. Signed out, it explains rather than fails ──────────────────────────────
console.log('\n=== signed out ===');
{
  const p = await openPage(false);
  posted.length = 0;
  await p.goto(`${base}/race.html?contest=GOV&state=Kano`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#race-follow-btn', { timeout: 10000 });
  await p.click('#race-follow-btn');
  check('says how to become able to follow', await p.$eval('#race-follow-msg', (e) => e.textContent), (t) => /verify your phone/i.test(t));
  check('and sends nothing', posted.length, 0);
  await p.close();
}

// ── 5. A whole-election row already covers a seat ─────────────────────────────
// The subtle one. The backend pings an empty-region row for EVERY region, so a
// seat page under such a row must not claim "not following" — and unfollowing
// has to delete the row that is actually doing the work. Deleting
// (SEN, 'Kano Central') here would match nothing and leave the alerts on while
// telling the reader they were off.
console.log('\n=== already covered by a follow-everything row ===');
{
  const p = await openPage(true);
  SUBS = [{ contest: 'SEN', state: '' }];
  posted.length = 0;
  await p.goto(`${base}/race.html?contest=SEN&seat=Kano%20Central`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#race-follow-btn', { timeout: 10000 });
  await p.waitForFunction(() => document.getElementById('race-follow-btn').textContent.includes('Following'), { timeout: 5000 });
  check('reads as already following', await followBtn(p), '🔔 Following this race');
  await p.click('#race-follow-btn');
  await p.waitForFunction(() => !document.getElementById('race-follow-btn').textContent.includes('Following'), { timeout: 5000 });
  check('unfollow deletes the row that was covering it', posted.at(-1), { method: 'DELETE', body: { contest: 'SEN', state: '' } });
  await p.close();
}

// ── 6. The category board follows the category ────────────────────────────────
console.log('\n=== the leaderboard says which election it would follow ===');
{
  const p = await openPage(true);
  const label = () => p.$eval('#btn-follow', (e) => e.textContent.trim());
  const pick = async (v) => p.$eval('#sel-scope', (e, val) => { e.value = val; e.dispatchEvent(new Event('change')); }, v);

  await p.goto(`${base}/results.html?contest=SEN`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.getElementById('btn-follow').textContent.includes('Follow all'), { timeout: 10000 });
  check('Senate board offers the whole election', await label(), '🔔 Follow all Senate races');
  await pick('Kano Central');
  check('a chosen district names itself', await label(), '🔔 Follow Kano Central');
  await pick('');
  check('and back', await label(), '🔔 Follow all Senate races');

  for (const [code, want] of [['GOV', '🔔 Follow all governorship races'], ['REP', '🔔 Follow all House of Reps races'], ['SHA', '🔔 Follow all State Assembly races'], ['PRES', '🔔 Follow this race']]) {
    await p.goto(`${base}/results.html?contest=${code}`, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => /Follow \S/.test(document.getElementById('btn-follow').textContent), { timeout: 10000 });
    // The presidency is ONE race, so its board is the race — no "all of them".
    check(`${code} board`, await label(), want);
  }
  await p.close();
}

check('no page errors anywhere', errs, []);

await b.close();
server.close();
console.log(fail ? `\n${fail} check(s) failed` : '\nall passed');
process.exit(fail ? 1 : 0);

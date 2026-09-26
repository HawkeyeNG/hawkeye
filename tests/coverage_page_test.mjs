/**
 * OBSERVER COVERAGE — the public page (coverage.html) and the admin panel,
 * against a stubbed API.
 *
 * What it pins:
 *   - the public page renders national + state rows, ranks ties together,
 *     drills to one state's LGAs and STOPS there (no control below LGA, and it
 *     never asks the API for a ward or calls an admin route);
 *   - failure and unknown-state paths say so instead of spinning;
 *   - strings resolve at PAINT time: switching language on an open page
 *     repaints it, and switching back restores the English (control);
 *   - no horizontal overflow on a 320px phone;
 *   - the admin panel walks states → LGAs → wards → uncovered units, sending
 *     the console passphrase;
 *   - no page errors and no console errors anywhere.
 *
 * The Hausa bundle is the shipped ha.json plus the pending batch
 * (scripts/i18n/batches/coverage_web.json), because the batch is not merged
 * into app/i18n yet.
 *
 *   node tests/coverage_page_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const BATCH = JSON.parse(fs.readFileSync('/home/elrio/hawkeye/scripts/i18n/batches/coverage_web.json', 'utf8'));
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const STATES = [
  { state: 'Lagos', units: 13325, covered: 12, pct: 0.09 },
  { state: 'Federal Capital Territory', units: 2822, covered: 1, pct: 0.04 },
  { state: 'Abia', units: 4062, covered: 0, pct: 0 },
  { state: 'Kano', units: 11222, covered: 0, pct: 0 },
];
const NATIONAL = { units: 176846, covered: 13, pct: 0.01 };
const LAGOS = [
  { lga: 'Lagos Island', units: 389, covered: 12, pct: 3.08 },
  { lga: 'Agege', units: 696, covered: 0, pct: 0 },
];
const at = Date.UTC(2026, 8, 26, 12, 0);

const seen = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname.startsWith('/api/')) seen.push({ path: u.pathname, q: [...u.searchParams.keys()], secret: req.headers['x-admin-secret'] || null });
  if (u.pathname === '/api/coverage') {
    const st = (u.searchParams.get('state') || '').toLowerCase();
    if (!st) return json({ updatedAt: at, national: NATIONAL, level: 'state', states: STATES });
    if (st === 'lagos') return json({ updatedAt: at, national: NATIONAL, level: 'lga', state: 'Lagos', units: 13325, covered: 12, pct: 0.09, lgas: LAGOS });
    if (st === 'kano') return json({ updatedAt: at, national: NATIONAL, level: 'lga', state: 'Kano', units: 11222, covered: 0, pct: 0, lgas: [{ lga: 'Dala', units: 500, covered: 0, pct: 0 }] });
    if (st === 'boom') return json({ error: 'internal_error' }, 500);
    return json({ error: 'unknown_state' }, 404);
  }
  if (u.pathname === '/api/admin/coverage') {
    if (req.headers['x-admin-secret'] !== 'test') return json({ error: 'bad_passphrase' }, 401);
    const s = u.searchParams.get('state'), l = u.searchParams.get('lga'), w = u.searchParams.get('ward');
    const base = { updatedAt: at, national: NATIONAL };
    if (!s) return json({ ...base, level: 'state', states: STATES });
    if (!l) return json({ ...base, level: 'lga', state: 'Lagos', units: 13325, covered: 12, pct: 0.09, lgas: LAGOS });
    if (!w) return json({ ...base, level: 'ward', state: 'Lagos', lga: 'Lagos Island', units: 389, covered: 12, pct: 3.08,
      wards: [{ ward: 'Olowogbowo/Elegbata', units: 23, covered: 12, pct: 52.17 }, { ward: 'Agarawu/Obadina', units: 2, covered: 2, pct: 100 }] });
    if (w === 'Agarawu/Obadina') return json({ ...base, level: 'unit', state: 'Lagos', lga: 'Lagos Island', ward: w, units: 2, covered: 2, pct: 100, uncovered: [] });
    return json({ ...base, level: 'unit', state: 'Lagos', lga: 'Lagos Island', ward: w, units: 23, covered: 12, pct: 52.17,
      uncovered: [{ pu_code: '24-10-01-003', name: 'Open Space <b>Olowogbowo</b>' }, { pu_code: '24-10-01-007', name: "St. Peter's School" }] });
  }
  if (u.pathname === '/i18n/ha.json') {
    const ha = JSON.parse(fs.readFileSync(`${APP}/i18n/ha.json`, 'utf8'));
    for (const [k, v] of Object.entries(BATCH)) ha[k] = v.ha;
    return json(ha);
  }
  if (u.pathname.startsWith('/api/')) return json({ ok: true, observers: [], incidents: [], labels: [], stats: {}, rows: [], items: [] });
  const f = path.join(APP, decodeURIComponent(u.pathname));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const errs = [];
/* Resource errors this test causes ON PURPOSE (the unknown-state and server-
   failure cases), plus the admin Labels panel's /training/*.json, which the
   backend serves and this static server does not. Anything else is a failure. */
const EXPECTED = [/\/api\/coverage\?state=(Atlantis|Boom)$/, /\/training\/[a-z]+\.json(\?|$)/];
const watch = (p) => {
  p.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const u = (m.location() && m.location().url) || '';
    if (/Failed to load resource/.test(m.text()) && EXPECTED.some((r) => r.test(u))) return;
    errs.push('console: ' + m.text() + (u ? ' @ ' + u : ''));
  });
};
const settle = (p) => p.waitForTimeout(500);

/* ======================= PUBLIC PAGE ================================== */
console.log('=== coverage.html (phone) ===');
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(() => { try { localStorage.setItem('hawkeye_lang_prompted', '1'); } catch (e) { /* about:blank */ } });
const p = await ctx.newPage();
watch(p);
await p.goto(`${base}/coverage.html`, { waitUntil: 'networkidle' });
await settle(p);

check('signed-out visitors are not bounced to sign-in', p.url(), (u) => /coverage\.html$/.test(u));
check('national figure', await p.textContent('#nat-pct'), '0.01%');
check('national line', await p.textContent('#nat-line'), '13 of 176,846 polling units covered');
check('states-at-goal line', await p.textContent('#nat-goal'), '0 of 4 states have reached 1%');
const rowsNow = () => p.$$eval('#rows tr', (trs) => trs.map((tr) => ({
  rank: tr.querySelector('.rank')?.textContent, name: tr.querySelector('.cov-name')?.textContent,
  pct: tr.querySelector('.pct b')?.textContent, btn: !!tr.querySelector('.cov-row-btn'),
  aria: tr.querySelector('.cov-row-btn')?.getAttribute('aria-label') || null,
})));
let rows = await rowsNow();
check('one row per state, ranked as served', rows.map((r) => r.name), STATES.map((s) => s.state));
check('ties share a rank', rows.map((r) => r.rank), ['1', '2', '3', '3']);
check('percent formatting', rows.map((r) => r.pct), ['0.09%', '0.04%', '0%', '0%']);
check('every state row is a named button', rows.every((r) => r.btn && /^Show local governments in /.test(r.aria)), true);
check('the CTA sends a signed-out visitor to sign-up', await p.getAttribute('#cta-unit', 'href'), 'observe.html?intent=observe');
check('the table has an accessible name', await p.getAttribute('#tbl', 'aria-label'), 'Polling-unit coverage by state');

// drill to Lagos
await p.click('#rows .cov-row-btn[data-state="Lagos"]');
await settle(p);
check('drill-down puts the state in the URL', new URL(p.url()).search, '?state=Lagos');
check('LGA view title', await p.textContent('#tbl-title'), 'Lagos: local governments');
rows = await rowsNow();
check('LGA rows', rows.map((r) => r.name), ['Lagos Island', 'Agege']);
check('LGA rows do NOT drill further (public floor)', rows.some((r) => r.btn), false);
check('the breadcrumb shows', await p.isVisible('#crumbs'), true);
check('the name column says Local government', await p.textContent('#th-name'), 'Local government');

// back via the browser
await p.goBack();
await settle(p);
check('Back returns to the states view', (await rowsNow()).length, STATES.length);

// Kano: nothing covered → the empty-state line
await p.click('#rows .cov-row-btn[data-state="Kano"]');
await settle(p);
check('a state with nothing covered says so', await p.textContent('#tbl-hint'), 'No polling units are covered here yet. Yours could be the first.');
await p.click('#crumb-all');
await settle(p);
check('All states crumb returns', new URL(p.url()).search, '');

// deep link, lower case → answered in the register's spelling
await p.goto(`${base}/coverage.html?state=lagos`, { waitUntil: 'networkidle' });
await settle(p);
check('a lower-case deep link is rewritten to the register spelling', new URL(p.url()).search, '?state=Lagos');

// unknown state and a server failure
await p.goto(`${base}/coverage.html?state=Atlantis`, { waitUntil: 'networkidle' });
await settle(p);
check('unknown state says so', await p.textContent('#tbl-status'), (t) => /That state is not in the register\./.test(t));
check('…with no retry button', await p.$('#retry'), null);
const before = seen.filter((s) => s.path === '/api/coverage').length;
await p.goto(`${base}/coverage.html?state=Boom`, { waitUntil: 'networkidle' });
await settle(p);
check('a server failure says so', await p.textContent('#tbl-status'), (t) => /Could not load coverage/.test(t));
await p.click('#retry');
await settle(p);
check('Try again refetches', seen.filter((s) => s.path === '/api/coverage').length - before, 2);

// the page never asks for more than the public floor
check('public page never calls an admin route', seen.some((s) => s.path.startsWith('/api/admin')), false);
check('public page only ever sends ?state=', seen.filter((s) => s.path === '/api/coverage').every((s) => s.q.every((k) => k === 'state')), true);

// ---- i18n: switch on the open page, then back (control) --------------
await p.goto(`${base}/coverage.html`, { waitUntil: 'networkidle' });
await settle(p);
const EN_TITLE = await p.textContent('#tbl-title');
await p.evaluate(() => window.HawkeyeI18n.set('ha'));
await p.waitForTimeout(800);
check('Hausa: table title repainted', await p.textContent('#tbl-title'), BATCH['coverage.states-by-coverage'].ha);
check('Hausa: national line repainted', await p.textContent('#nat-line'),
  BATCH['coverage.n-of-m-units-covered'].ha.replace('{covered}', '13').replace('{units}', '176,846'));
check('Hausa: CTA repainted', await p.textContent('#cta-unit'), BATCH['coverage.save-your-unit'].ha);
check('Hausa: static markup translated', await p.textContent('.cov-cta h2'), BATCH['coverage.stay-for-the-count'].ha);
check('Hausa: row aria-label repainted', await p.getAttribute('#rows .cov-row-btn', 'aria-label'),
  BATCH['coverage.open-state-aria'].ha.replace('{state}', 'Lagos'));
await p.evaluate(() => window.HawkeyeI18n.set('en'));
await p.waitForTimeout(500);
check('CONTROL: back to English restores the title', await p.textContent('#tbl-title'), EN_TITLE);
check('CONTROL: …and the static markup', await p.textContent('.cov-cta h2'), 'Stay for the count');

// ---- the menu links here ---------------------------------------------
check('the menu carries an Observer Coverage link', await p.$$eval('#menu-panel a[href="coverage.html"]', (a) => a.map((x) => x.textContent.trim())), ['Observer Coverage']);

// ---- 320px: nothing overflows ------------------------------------------
await p.setViewportSize({ width: 320, height: 760 });
await p.goto(`${base}/coverage.html`, { waitUntil: 'networkidle' });
await settle(p);
check('no horizontal overflow at 320px', await p.evaluate(() => {
  const els = [document.documentElement, document.getElementById('page-scroll')].filter(Boolean);
  return els.map((e) => e.scrollWidth - e.clientWidth);
}), (d) => d.every((x) => x <= 1));
await ctx.close();

/* ======================= ADMIN PANEL ================================== */
console.log('\n=== admin.html → Coverage ===');
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';
const actx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await actx.addInitScript((t) => {
  try {
    localStorage.setItem('hawkeye_token', t); localStorage.setItem('hawkeye_lang_prompted', '1');
    sessionStorage.setItem('hawkeye_admin', 'test'); localStorage.setItem('hawkeye_admin', 'test');
  } catch (e) { /* about:blank */ }
}, jwt);
const a = await actx.newPage();
watch(a);
seen.length = 0;
// A collapsible section of the Reach panel, not a header tab: the tab strip is
// pinned to one row by admin_header / admin_standalone.
await a.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
await a.waitForTimeout(700);
check('no Coverage tab was added to the header strip', await a.$('#panelbar .tab[data-p="coverage"]'), null);
check('the section sits in the Reach panel', await a.evaluate(() => !!document.querySelector('.panel[data-p="reach"] #cov-wrap')), true);
check('it does not load until it is opened', seen.some((s) => s.path === '/api/admin/coverage'), false);
await a.click('#cov-wrap > summary');
await a.waitForTimeout(600);
check('opening it loads it', await a.evaluate(() => document.getElementById('cov-wrap').open), true);
check('admin sends the console passphrase', seen.filter((s) => s.path === '/api/admin/coverage').every((s) => s.secret === 'test') && seen.some((s) => s.path === '/api/admin/coverage'), true);
const go = async (label) => { await a.click(`#cov-out .cov-adm-go:text-is("${label}")`); await a.waitForTimeout(400); };
check('states listed', await a.$$eval('#cov-out tbody tr', (t) => t.length), STATES.length);
await go('Lagos');
check('LGAs of the state', await a.$$eval('#cov-out tbody .cov-adm-go', (t) => t.map((x) => x.textContent)), ['Lagos Island', 'Agege']);
await go('Lagos Island');
check('wards of the LGA', await a.textContent('#cov-out h2'), 'Lagos Island, Lagos: wards');
await go('Olowogbowo/Elegbata');
check('uncovered units, code + name', await a.$$eval('#cov-out tbody tr', (t) => t.map((r) => [...r.cells].map((c) => c.textContent))),
  [['24-10-01-003', 'Open Space <b>Olowogbowo</b>'], ['24-10-01-007', "St. Peter's School"]]);
check('a unit name is text, never markup', await a.$('#cov-out tbody b'), null);
check('breadcrumb has every level', await a.$$eval('#cov-crumbs button, #cov-crumbs [aria-current]', (e) => e.map((x) => x.textContent)),
  ['All states', 'Lagos', 'Lagos Island', 'Olowogbowo/Elegbata']);
await a.click('#cov-crumbs .cov-adm-go:text-is("Lagos Island")');
await a.waitForTimeout(400);
await go('Agarawu/Obadina');
check('a fully covered ward says so', await a.textContent('#cov-out .status'), 'Every unit in this ward has an observer.');
await a.click('#cov-crumbs .cov-adm-go:text-is("All states")');
await a.waitForTimeout(400);
check('All states crumb returns to the top', await a.$$eval('#cov-out tbody tr', (t) => t.length), STATES.length);
// no passphrase → says so, and never calls the API
await a.evaluate(() => sessionStorage.removeItem('hawkeye_admin'));
const n0 = seen.length;
await a.click('#cov-refresh');
await a.waitForTimeout(300);
check('without a passphrase it asks to unlock', await a.textContent('#cov-out'), 'Unlock the console first.');
check('…and sends nothing', seen.slice(n0).some((s) => s.path === '/api/admin/coverage'), false);
await actx.close();

check('no page errors or console errors', errs, []);
await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

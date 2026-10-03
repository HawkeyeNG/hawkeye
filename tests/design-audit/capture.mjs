/**
 * DESIGN AUDIT CAPTURE — every screen x viewport x theme x language, on web,
 * Lite and native, plus axe on every web/Lite page and DOM design checks on all.
 *
 *   node capture.mjs --surface web|lite|native|all [--only id,id] [--dry-run]
 *                    [--vps s360,s390,d1366] [--themes light,dark] [--langs en,ha,ig,yo]
 *                    [--workers 4] [--no-axe] [--no-scroll] [--no-states]
 *
 * Output (out/<surface>/):
 *   shots/<id>/<vp>-<theme>-<lang>.png         the fold (what a phone shows first)
 *   shots/<id>/<vp>-<theme>-en-s1..s4.png      further screens down the page (EN only)
 *   shots/<id>/<vp>-<theme>-en-<action>.png    menu / report sheet open
 *   shots/<id>/<vp>-<theme>-en-state-<x>.png   offline, slow (loading) and empty states
 *   results.json                                checks, axe, bounces, errors per shot
 *
 * READ-ONLY against production: see lib.mjs installGuard. Service workers blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium, CHROME, SITE, PAGES, OUT, HERE, NATIVE_DIR, VIEWPORTS, LANGS, THEMES, SAFETY, installGuard, contextOptions, webInit, nativeInit, startStatic, sleep, log } from './lib.mjs';
import { SURFACES, DRY_RUN } from './inventory.mjs';
import { pageChecks, findScroller } from './checks.mjs';
import { makeFixtures } from './fixtures.mjs';

const require_ = createRequire(HERE + '/');
const axeMod = require_('@axe-core/playwright');
const AxeBuilder = axeMod.default || axeMod.AxeBuilder || axeMod;

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const list = (n, d) => (arg(n) ? arg(n).split(',') : d);

const surfaces = arg('surface', 'all') === 'all' ? ['web', 'lite', 'native'] : arg('surface').split(',');
const dry = flag('dry-run');
const smoke = flag('smoke'); // every screen, one combination (pass --vps s360 --themes dark --langs en): a harness check, not the audit
const TAG = dry ? '-dry' : smoke ? '-smoke' : '';
const only = dry ? DRY_RUN : list('only', null);
const WORKERS = Number(arg('workers', 4));
const THEME_LIST = list('themes', THEMES);
const LANG_LIST = list('langs', LANGS);
const DO_AXE = !flag('no-axe');
const DO_SCROLL = !flag('no-scroll');
const DO_STATES = !flag('no-states');
const MAX_SCROLL = 4;

/* States captured once per screen (EN, 360, dark) on top of the matrix. */
const STATE_SCREENS = {
  offline: ['home', 'results', 'race-declared', 'alerts', 'report-result', 'signup', 'groups', 'profile', 'landing'],
  slow: ['home', 'results', 'race-declared', 'alerts', 'groups', 'profile', 'landing'],
  empty: ['home', 'alerts', 'groups', 'profile', 'ready', 'report-result'],
};

const servers = {};
async function baseFor(surface) {
  if (surface !== 'native') return PAGES;
  if (!servers.native) servers.native = await startStatic(NATIVE_DIR);
  return `http://127.0.0.1:${servers.native.address().port}`;
}

/* --retry-failed: re-run only the records whose load or screenshot failed (a
   network blip on this machine's link), replacing them in results.json. */
const RETRY = flag('retry-failed');
const failed = (r) => r.fatal || (r.errors || []).some((e) => /^(goto|shot):/.test(e)) || /^(about:blank|chrome-error)/.test(r.finalUrl || '');
function retryJobs(surface) {
  const file = path.join(OUT, surface, 'results.json');
  const prev = JSON.parse(fs.readFileSync(file, 'utf8')).results;
  const byId = Object.fromEntries(SURFACES[surface].screens.map((s) => [s.id, s]));
  return prev.filter(failed).map((r) => ({ surface, screen: byId[r.id], vp: r.vp, theme: r.theme, lang: r.lang, kind: r.kind, state: r.state || undefined }));
}

function jobsFor(surface) {
  if (RETRY) return retryJobs(surface);
  const { screens, viewports } = SURFACES[surface];
  const vps = list('vps', viewports).filter((v) => viewports.includes(v));
  const jobs = [];
  for (const s of screens) {
    if (only && !only.includes(s.id)) continue;
    for (const vp of vps) for (const theme of THEME_LIST) for (const lang of LANG_LIST) {
      jobs.push({ surface, screen: s, vp, theme, lang, kind: 'matrix' });
    }
    if (DO_STATES && !dry && !smoke) {
      for (const [state, ids] of Object.entries(STATE_SCREENS)) {
        if (!ids.includes(s.id)) continue;
        if (state === 'empty' && s.auth !== 'in') continue;
        for (const theme of state === 'empty' ? ['dark', 'light'] : ['dark']) {
          jobs.push({ surface, screen: s, vp: 's360', theme, lang: 'en', kind: 'state', state });
        }
      }
    }
  }
  return jobs;
}

async function settle(page, surface) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  if (surface === 'native') {
    await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 20, null, { timeout: 20000 }).catch(() => {});
    await sleep(2200);
  } else {
    await sleep(1300);
  }
}

async function runAxe(page) {
  try {
    const r = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
      samples: v.nodes.slice(0, 4).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(1, 2).join(' ').slice(0, 160), html: n.html.slice(0, 120) })),
    }));
  } catch (e) {
    return [{ id: 'axe-error', impact: null, help: String(e.message || e).slice(0, 200), nodes: 0, samples: [] }];
  }
}

async function doAction(page, surface, screen, action) {
  if (surface === 'native') {
    if (action === 'report-sheet') {
      const b = page.locator('[role="tab"], [role="button"], a').filter({ hasText: /^Report$/ }).last();
      if (await b.count()) { await b.click({ timeout: 5000 }).catch(() => {}); await sleep(1500); return true; }
    }
    return false;
  }
  const lite = surface === 'lite';
  if (action === 'menu') {
    const sel = lite ? '[data-more]' : '.menu-btn';
    const b = page.locator(sel).first();
    if (!(await b.count()) || !(await b.isVisible().catch(() => false))) return false;
    await b.click({ timeout: 5000 }).catch(() => {});
    await sleep(900);
    return true;
  }
  if (action === 'report-sheet') {
    const b = page.locator('[data-report]').first();
    if (!(await b.count()) || !(await b.isVisible().catch(() => false))) return false;
    await b.click({ timeout: 5000 }).catch(() => {});
    await sleep(900);
    return true;
  }
  return false;
}

/**
 * ONE PERSISTENT PROFILE PER WORKER (mobile + desktop), one fresh PAGE per job.
 * This machine's link is slow (~0.3-0.6 Mbit/s measured by the e2e run), and a
 * fresh context re-downloads every stylesheet, script, font and image — 10-20 s
 * a shot. A shared HTTP cache makes the second visit to a page cost only the
 * HTML. Isolation per job comes from the init script (localStorage cleared and
 * re-seeded on every navigation), a new tab (fresh sessionStorage) and
 * page-level routes. Service workers stay blocked.
 */
async function profileFor(worker, surface, mobile) {
  const key = `${surface}-${mobile ? 'm' : 'd'}`;
  if (worker.ctx[key]) return worker.ctx[key];
  const dir = path.join('/tmp/hawkeye-design-audit-profiles', `${key}-${worker.n}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const opts = contextOptions(mobile ? VIEWPORTS.s390 : VIEWPORTS.d1366, { theme: 'dark', mobile });
  worker.ctx[key] = await chromium.launchPersistentContext(dir, { executablePath: CHROME, args: ['--font-render-hinting=none', '--disable-dev-shm-usage'], ...opts });
  return worker.ctx[key];
}

async function runJob(worker, job) {
  const { surface, screen, vp: vpKey, theme, lang, kind, state } = job;
  const vp = VIEWPORTS[vpKey];
  const base = await baseFor(surface);
  const dir = path.join(OUT, surface, 'shots', screen.id);
  fs.mkdirSync(dir, { recursive: true });
  const stem = kind === 'state' ? `${vpKey}-${theme}-${lang}-state-${state}` : `${vpKey}-${theme}-${lang}`;
  const rec = { surface, id: screen.id, title: screen.title, area: screen.area, vp: vpKey, theme, lang, kind, state: state || null, shot: path.relative(OUT, path.join(dir, stem + '.png')), extra: [], errors: [], console: [] };
  const ctx = await profileFor(worker, surface, vp.width < 900);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  const signedIn = screen.auth === 'in';
  await installGuard(page, { signedIn, crossOrigin: surface === 'native', fixtures: makeFixtures(state === 'empty' ? 'empty' : 'populated') });
  if (state === 'offline') {
    // The API is unreachable (no data connection): every /api call fails. App files still load,
    // as they would from Lite's bundle, the SW cache or the native binary.
    await page.route(/^https?:\/\/(hawkeye\.com\.ng|127\.0\.0\.1:\d+)\/api\//, (r) => r.abort('internetdisconnected'));
  }
  if (state === 'slow') {
    // A slow line: every API answer takes 12 s. The shot is taken at 3.5 s — the loading state.
    await page.route(/^https?:\/\/(hawkeye\.com\.ng|127\.0\.0\.1:\d+)\/api\//, async (r) => { await sleep(12000); return r.fallback().catch(() => {}); });
  }
  const init = surface === 'native' ? nativeInit({ signedIn, lang, theme }) : webInit({ lite: surface === 'lite', signedIn, lang, theme });
  await page.addInitScript(init.script, init.arg);
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => rec.errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') rec.console.push(m.text().slice(0, 200)); });
  const url = base + screen.path;
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: state === 'slow' ? 'domcontentloaded' : 'load', timeout: 60000 });
  } catch (e) { rec.errors.push('goto: ' + String(e.message || e).split('\n')[0]); }
  if (state === 'slow') await sleep(3500); else await settle(page, surface);
  rec.loadMs = Date.now() - t0;
  rec.finalUrl = page.url().replace(base, '');
  const want = screen.path.split('?')[0].replace(/\/$/, '');
  const got = rec.finalUrl.split('?')[0].replace(/\.html$/, '').replace(/\/$/, '');
  rec.bounced = !(got === want.replace(/\.html$/, '') || (want === '' && /^(\/index)?$/.test(got)) || (surface === 'native' && want === '/results' && got === '/results'));
  try { await page.screenshot({ path: path.join(dir, stem + '.png'), timeout: 30000 }); } catch (e) { rec.errors.push('shot: ' + e.message.split('\n')[0]); rec.shot = null; }
  rec.checks = await page.evaluate(pageChecks).catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
  if (kind === 'matrix' && lang === 'en') {
    if (DO_AXE && surface !== 'native' && (vpKey === 's390' || vpKey === 'd1366')) rec.axe = await runAxe(page);
    for (const action of screen.actions || []) {
      if (vpKey === 'd1366' && action === 'report-sheet') continue;
      const ok = await doAction(page, surface, screen, action);
      if (ok) {
        const f = `${stem}-${action}.png`;
        await page.screenshot({ path: path.join(dir, f) }).then(() => rec.extra.push(path.relative(OUT, path.join(dir, f)))).catch(() => {});
        await page.keyboard.press('Escape').catch(() => {});
        await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        await settle(page, surface);
      }
    }
    if (DO_SCROLL) {
      const sc = await page.evaluate(findScroller).catch(() => null);
      if (sc && sc.h > sc.ch + 40) {
        rec.screens = Math.round((sc.h / sc.ch) * 10) / 10;
        for (let i = 1; i <= MAX_SCROLL; i++) {
          const moved = await page.evaluate((i) => {
            const s = window.__daScroller;
            const before = s.scrollTop;
            s.scrollTop = Math.min(s.scrollHeight - s.clientHeight, before + s.clientHeight * 0.85);
            if (s === document.scrollingElement || s === document.documentElement) window.scrollTo(0, s.scrollTop);
            return s.scrollTop - before;
          }, i).catch(() => 0);
          if (moved < 30) break;
          await sleep(500);
          const f = `${stem}-s${i}.png`;
          await page.screenshot({ path: path.join(dir, f) }).then(() => rec.extra.push(path.relative(OUT, path.join(dir, f)))).catch(() => {});
        }
      }
    }
  }
  await page.close().catch(() => {});
  return rec;
}

async function runSurface(surface) {
  const jobs = jobsFor(surface);
  log(`[${surface}] ${jobs.length} jobs, ${WORKERS} workers`);
  const workers = Array.from({ length: Math.min(WORKERS, jobs.length) }, (_, n) => ({ n, ctx: {} }));
  const results = [];
  let next = 0, done = 0;
  const t0 = Date.now();
  const worker = async (w) => {
    while (next < jobs.length) {
      const job = jobs[next++];
      let rec;
      try { rec = await runJob(w, job); } catch (e) {
        rec = { surface, id: job.screen.id, vp: job.vp, theme: job.theme, lang: job.lang, kind: job.kind, state: job.state, fatal: String(e.message || e).slice(0, 300) };
      }
      results.push(rec);
      done++;
      if (done % 20 === 0 || done === jobs.length) {
        const per = (Date.now() - t0) / done;
        log(`[${surface}] ${done}/${jobs.length}  ~${Math.round(per * (jobs.length - done) / 1000 / 60)} min left`);
      }
    }
  };
  await Promise.all(workers.map(worker));
  for (const w of workers) for (const c of Object.values(w.ctx)) await c.close().catch(() => {});
  const file = path.join(OUT, surface, `results${TAG}.json`);
  let prev = [];
  if (RETRY && fs.existsSync(file)) {
    const key = (r) => [r.id, r.vp, r.theme, r.lang, r.kind, r.state || ''].join('|');
    const redone = new Set(results.filter((r) => !failed(r)).map(key));
    prev = JSON.parse(fs.readFileSync(file, 'utf8')).results.filter((r) => !redone.has(key(r)));
  } else if (!dry && !smoke && only && fs.existsSync(file)) {
    // a partial (--only) run merges into the full results instead of replacing them
    prev = JSON.parse(fs.readFileSync(file, 'utf8')).results.filter((r) => !only.includes(r.id));
  }
  fs.writeFileSync(file, JSON.stringify({ surface, at: new Date().toISOString(), base: await baseFor(surface), nativeExport: surface === 'native' ? fs.statSync(path.join(NATIVE_DIR, 'welcome.html')).mtime.toISOString() : null, results: [...prev, ...results] }, null, 1));
  log(`[${surface}] wrote ${file} (${results.length} records)`);
  return results;
}

fs.mkdirSync(OUT, { recursive: true });
for (const s of surfaces) await runSurface(s);
for (const s of Object.values(servers)) s.close();
fs.writeFileSync(path.join(OUT, `safety${TAG}.json`), JSON.stringify({ ...SAFETY, unknownAuth: [...SAFETY.unknownAuth] }, null, 1));
log('safety', JSON.stringify({ passGet: SAFETY.passGet, fixtures: SAFETY.fixtures, blockedWrites: SAFETY.blockedWrites.length, sentry: SAFETY.sentry, beacons: SAFETY.beacons, unknownAuth: [...SAFETY.unknownAuth] }));
process.exit(0); // an HTTP keep-alive socket or the static server must not hold the run open

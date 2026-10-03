/**
 * FLOW STATES the matrix cannot reach by URL: the practice run end to end
 * (camera, counts with the keyboard up, the done screen and the RECEIPT CARD),
 * the sign-up error line, and the first-run tour — on web, Lite and native.
 *
 *   node flows.mjs [--surface web,lite,native] [--langs en,ha] [--themes dark,light]
 * Output: out/<surface>/flows/<flow>/<vp>-<theme>-<lang>-<NN>-<step>.png + out/flows.json
 *
 * Safety: lib.mjs installGuard. Practice submit is answered by a fixture (never
 * reaches the practice chain). The ONE write let through is the sign-up request
 * with a number the server refuses BY FORMAT before any lookup, write or send
 * (the rule tests/e2e/first_time_observer.mjs uses) — so the real error line shows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, CHROME, SITE, OUT, REPO, NATIVE_DIR, VIEWPORTS, installGuard, contextOptions, webInit, nativeInit, startStatic, sleep, log } from './lib.mjs';
import { makeFixtures } from './fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const surfaces = arg('surface', 'web,lite,native').split(',');
const LANGS_ = arg('langs', 'en,ha').split(',');
const THEMES_ = arg('themes', 'dark,light').split(',');
const VP = VIEWPORTS[arg('vp', 's360')];
const vpKey = arg('vp', 's360');
const NI18N = Object.fromEntries(['en', 'ha', 'ig', 'yo'].map((l) => [l, JSON.parse(fs.readFileSync(path.join(REPO, `native/src/lib/i18n/${l}.json`), 'utf8'))]));
const nt = (lang, key) => NI18N[lang][key] || NI18N.en[key];

const BAD_NUMBER = '0123 456 7890'; // not a Nigerian mobile: refused by format, nothing looked up or sent
const refusedByFormat = (raw) => {
  const p = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^\+?888/.test(p)) return true;
  return !(/^0[789][01]\d{8}$/.test(p) || /^\+234[789][01]\d{8}$/.test(p));
};

const out = [];
let server = null;
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--font-render-hinting=none'] });

async function newPage(surface, { signedIn, lang, theme, tourSeen = true }) {
  const ctx = await browser.newContext({ ...contextOptions(VP, { theme }), permissions: ['geolocation', 'camera'] });
  await installGuard(ctx, { signedIn, crossOrigin: surface === 'native', fixtures: makeFixtures('populated') });
  // the sign-up request, ONLY with a number refused by format
  await ctx.route(/^https:\/\/hawkeye\.com\.ng\/api\/observers\/(register|wa-start)$/, async (route) => {
    const req = route.request();
    let phone = '';
    try { phone = JSON.parse(req.postData() || '{}').phone; } catch { /* not JSON */ }
    if (req.method() === 'POST' && refusedByFormat(phone)) {
      const r = await fetch(req.url(), { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'hawkeye-design-audit' }, body: req.postData() });
      return route.fulfill({ status: r.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: Buffer.from(await r.arrayBuffer()) });
    }
    return route.fallback();
  });
  const init = surface === 'native' ? nativeInit({ signedIn, lang, theme }) : webInit({ lite: surface === 'lite', signedIn, lang, theme, tourSeen });
  if (surface === 'native' && !tourSeen) {
    await ctx.addInitScript(init.script, init.arg);
    await ctx.addInitScript(() => { try { localStorage.removeItem('hawkeye_tour_seen'); } catch (e) { /* */ } });
  } else await ctx.addInitScript(init.script, init.arg);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  return { ctx, page };
}

function shooter(surface, flow, theme, lang) {
  const dir = path.join(OUT, surface, 'flows', flow);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const rec = { surface, flow, theme, lang, steps: [] };
  out.push(rec);
  return {
    rec,
    async shot(page, step, opts = {}) {
      const f = `${vpKey}-${theme}-${lang}-${String(++n).padStart(2, '0')}-${step}.png`;
      await page.screenshot({ path: path.join(dir, f), ...opts }).catch(() => {});
      rec.steps.push({ step, img: path.relative(OUT, path.join(dir, f)) });
    },
  };
}

// ------------------------------------------------------------ web / Lite practice
async function webPractice(surface, theme, lang) {
  const { ctx, page } = await newPage(surface, { signedIn: false, lang, theme });
  const S = shooter(surface, 'practice', theme, lang);
  try {
    await page.goto(`${SITE}/practice.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await sleep(1200);
    await S.shot(page, 'start');
    await page.click('#btn-cam-sheet', { timeout: 10000 }).catch(() => {});
    const cam = await page.waitForFunction(() => { const o = document.getElementById('camera-overlay'); const v = document.getElementById('video'); return o && !o.hidden && v && v.readyState >= 2; }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    await sleep(800);
    await S.shot(page, cam ? 'camera' : 'camera-unavailable');
    if (cam) {
      await page.click('#btn-capture', { timeout: 8000 }).catch(() => {});
      await page.waitForSelector('#preview-sheet:not([hidden])', { timeout: 15000 }).catch(() => {});
      await sleep(600);
      await S.shot(page, 'sheet-captured');
    } else {
      await page.click('#btn-cancel-camera', { timeout: 4000 }).catch(() => {});
      await page.click('#btn-skip-sheet', { timeout: 4000 }).catch(() => {});
    }
    await page.click('#btn-skip-venue', { timeout: 8000 }).catch(() => {});
    await sleep(600);
    await S.shot(page, 'photos-done');
    const inputs = page.locator('#vote-inputs input');
    const n = await inputs.count();
    const counts = [212, 188, 41, 9, 3, 0];
    for (let i = 0; i < n; i++) await inputs.nth(i).fill(String(counts[i] ?? 0)).catch(() => {});
    await inputs.first().scrollIntoViewIfNeeded().catch(() => {});
    await S.shot(page, 'counts');
    // keyboard up: a phone keyboard takes ~42% of a 740px screen
    await inputs.nth(Math.min(2, Math.max(0, n - 1))).focus().catch(() => {});
    await page.setViewportSize({ width: VP.width, height: Math.round(VP.height * 0.58) });
    await sleep(500);
    await inputs.nth(Math.min(2, Math.max(0, n - 1))).scrollIntoViewIfNeeded().catch(() => {});
    await S.shot(page, 'counts-keyboard-up');
    await page.setViewportSize({ width: VP.width, height: VP.height });
    await page.evaluate(() => document.activeElement && document.activeElement.blur()).catch(() => {});
    await sleep(400);
    await page.click('#btn-submit', { timeout: 8000 }).catch(() => {});
    const done = await page.waitForSelector('#done:not([hidden])', { timeout: 25000 }).then(() => true).catch(() => false);
    S.rec.done = done;
    await page.waitForSelector('#receipt-img[src^="data:"]', { timeout: 15000 }).catch(() => {});
    await sleep(800);
    await S.shot(page, done ? 'done' : 'submit-failed');
    if (done) {
      await page.locator('#receipt-wrap').scrollIntoViewIfNeeded().catch(() => {});
      await sleep(400);
      await S.shot(page, 'receipt-card');
      await page.locator('#prac-preview').scrollIntoViewIfNeeded().catch(() => {});
      await sleep(300);
      await S.shot(page, 'preview-card');
      const r = await page.locator('#receipt-img').boundingBox().catch(() => null);
      if (r) await S.shot(page, 'receipt-image', { clip: r });
    }
  } catch (e) { S.rec.error = String(e.message || e).slice(0, 200); }
  await ctx.close();
}

// ------------------------------------------------------------ native practice
async function nativePractice(theme, lang, base) {
  const { ctx, page } = await newPage('native', { signedIn: false, lang, theme });
  const S = shooter('native', 'practice', theme, lang);
  const L = (k) => nt(lang, k);
  const order = ['n.app.practice.use-a-sample', 'n.app.practice.yes-use-this-unit', 'n.app.practice.continue-without-a-unit',
    'n.app.practice.continue-to-the-figures', 'n.app.practice.review', 'n.app.practice.sign-submit-practice', 'n.app.practice.continue'].map(L);
  try {
    await page.goto(`${base}/practice`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout: 20000 }).catch(() => {});
    await sleep(2500);
    const tried = [];
    for (let i = 0; i < 16; i++) {
      await S.shot(page, `step${String(i).padStart(2, '0')}`);
      if (await page.getByText(L('n.app.practice.practice-complete'), { exact: true }).first().isVisible().catch(() => false)) {
        S.rec.done = true;
        // scroll down the done screen for the receipt card
        for (let k = 1; k <= 3; k++) {
          await page.mouse.move(VP.width / 2, VP.height / 2);
          await page.mouse.wheel(0, VP.height * 0.8);
          await sleep(700);
          await S.shot(page, `done-s${k}`);
        }
        break;
      }
      const filled = await page.evaluate(() => {
        let n = 0;
        for (const inp of document.querySelectorAll('input')) {
          if (!inp.getClientRects().length || inp.value) continue;
          if (inp.inputMode === 'numeric' || inp.type === 'number' || /^0$/.test(inp.placeholder || '')) {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            set.call(inp, String(10 + n * 7)); inp.dispatchEvent(new Event('input', { bubbles: true })); n++;
          }
        }
        return n;
      }).catch(() => 0);
      if (filled) await sleep(500);
      let clicked = null;
      for (const label of order) {
        const loc = page.getByText(label, { exact: true });
        const cnt = await loc.count();
        for (let j = 0; j < cnt; j++) {
          const l = loc.nth(j);
          if (!(await l.isVisible().catch(() => false))) continue;
          if (label !== L('n.app.practice.use-a-sample') && tried.includes(label)) continue;
          await l.click({ timeout: 6000 }).catch(() => {});
          clicked = label; tried.push(label);
          break;
        }
        if (clicked) break;
      }
      if (!clicked || clicked === L('n.app.practice.continue-to-the-figures')) {
        // The race step is DATA, not copy: first the election row, then the
        // race option ("… (2027)"). Each chosen once, the first one on screen.
        const opt = page.getByText(/\(2027\)\s*$/).first();
        if (!tried.includes('race') && await opt.isVisible().catch(() => false)) {
          await opt.click().catch(() => {}); tried.push('race'); clicked = 'race';
          await sleep(800);
          const go = page.getByText(L('n.app.practice.continue-to-the-figures'), { exact: true }).first();
          if (await go.isVisible().catch(() => false)) await go.click().catch(() => {});
        } else if (!tried.includes('election')) {
          const cont = L('n.app.practice.continue-to-the-figures');
          const box = await page.evaluate((cont) => {
            const rows = [...document.querySelectorAll('[tabindex="0"],[role="button"]')].filter((el) => {
              const r = el.getBoundingClientRect();
              const t = (el.innerText || '').trim();
              return r.height > 56 && r.top > 300 && r.bottom < innerHeight - 120 && t && !t.includes(cont) && /\d/.test(t);
            });
            const r = rows[0] && rows[0].getBoundingClientRect();
            return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
          }, cont).catch(() => null);
          if (box) { await page.mouse.click(box.x, box.y); tried.push('election'); clicked = 'election'; }
        }
      }
      if (!clicked) break;
      await sleep(1300);
    }
  } catch (e) { S.rec.error = String(e.message || e).slice(0, 200); }
  await ctx.close();
}

// ------------------------------------------------------------ sign-up error line
async function signupError(surface, theme, lang, base) {
  const { ctx, page } = await newPage(surface, { signedIn: false, lang, theme });
  const S = shooter(surface, 'signup-error', theme, lang);
  try {
    if (surface === 'native') {
      await page.goto(`${base}/sign-in?intent=signup`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction(() => document.body.innerText.trim().length > 20, null, { timeout: 20000 }).catch(() => {});
      await sleep(2000);
      await page.locator('input').first().fill(BAD_NUMBER).catch(() => {});
      await page.getByText('Telegram', { exact: true }).first().click().catch(() => {});
      await sleep(400);
      await page.getByText(nt(lang, 'n.app.profile.send-code'), { exact: true }).first().click().catch(() => {});
    } else {
      await page.goto(`${SITE}/observe.html?intent=observe`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await sleep(1000);
      await page.locator('input[type=tel]').first().fill(BAD_NUMBER).catch(() => {});
      await page.locator('input[name=otp-channel][value=telegram]').first().check({ force: true }).catch(() => {});
      await sleep(300);
      await page.locator('#btn-auth').first().click().catch(() => {});
    }
    await sleep(3500);
    await S.shot(page, 'bad-number');
  } catch (e) { S.rec.error = String(e.message || e).slice(0, 200); }
  await ctx.close();
}

// ------------------------------------------------------------ first-run tour
async function tour(surface, theme, lang, base) {
  const { ctx, page } = await newPage(surface, { signedIn: true, lang, theme, tourSeen: false });
  const S = shooter(surface, 'tour', theme, lang);
  try {
    await page.goto(surface === 'native' ? `${base}/` : `${SITE}/`, { waitUntil: 'load', timeout: 60000 });
    await sleep(4500);
    await S.shot(page, 'step1');
    const next = surface === 'native' ? page.getByText(nt(lang, 'tour.next'), { exact: true }).first() : page.locator('.tour-next, button:has-text("Next")').first();
    for (let i = 2; i <= 3; i++) {
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click().catch(() => {});
      await sleep(1200);
      await S.shot(page, `step${i}`);
    }
  } catch (e) { S.rec.error = String(e.message || e).slice(0, 200); }
  await ctx.close();
}

for (const surface of surfaces) {
  let base = SITE;
  if (surface === 'native') { server = server || await startStatic(NATIVE_DIR); base = `http://127.0.0.1:${server.address().port}`; }
  for (const theme of THEMES_) for (const lang of LANGS_) {
    log(surface, theme, lang);
    if (surface === 'native') await nativePractice(theme, lang, base); else await webPractice(surface, theme, lang);
    await signupError(surface, theme, lang, base);
    if (lang === 'en' || theme === 'dark') await tour(surface, theme, lang, base);
  }
}
await browser.close();
if (server) server.close();
fs.writeFileSync(path.join(OUT, 'flows.json'), JSON.stringify(out, null, 1));
log('flows', out.map((r) => `${r.surface}/${r.flow}/${r.theme}/${r.lang}: ${r.steps.length} shots${r.done === false ? ' NOT DONE' : ''}${r.error ? ' ERR ' + r.error : ''}`).join('\n'));
process.exit(0);

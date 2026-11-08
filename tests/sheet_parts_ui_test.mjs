/**
 * SEVERAL PHOTOS OF ONE SHEET — the web / Lite report page and practice page.
 *
 *   node tests/sheet_parts_ui_test.mjs
 *
 * A wall poster (Form EC60E) too big for one readable photo, or printed across
 * sheets, is shot in parts and joined top to bottom on the phone before it is
 * hashed and signed (app/sheet-parts.js). Drives the SHIPPED pages from a local
 * mirror of app/, signed in with the design-audit fixtures and its write guard
 * (nothing is written anywhere), with the shell's camera stubbed to hand back
 * three distinct test frames.
 *
 * Under test, each with a CONTROL:
 *   - join(): the 1500 x 2250 box (the GPU reader's budget), the dark band
 *     between parts, and the 2..3 range;
 *   - observe.html: "Add the next part" appears only after a sheet photo; each
 *     part re-joins from the original frames; the count reads "N photos joined";
 *     the button goes at 3; the FIRST photo's time and place stand for the
 *     sheet; the submit form carries sheetParts; Retake starts again from one;
 *   - practice.html: the same, in lockstep.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
let fails = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || got === undefined ? '' : `\n        got ${JSON.stringify(got)?.slice(0, 400)}`}`);
  if (!ok) fails += 1;
};

// The local mirror: started first, because lib.mjs reads AUDIT_PAGES at import.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(APP, url === '/' ? 'index.html' : url);
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.AUDIT_PAGES = BASE;
process.env.DA_FIXTURE_MS = '0';
const { chromium, CHROME, installGuard, contextOptions, webInit, VIEWPORTS } = await import('./design-audit/lib.mjs');
const { makeFixtures } = await import('./design-audit/fixtures.mjs');

const browser = await chromium.launch({ executablePath: CHROME });

/** A page with the shell camera stubbed: each capture hands back the next test frame. */
async function open(file) {
  const ctx = await browser.newContext({ ...contextOptions(VIEWPORTS.s390, { theme: 'light' }) });
  await installGuard(ctx, { signedIn: true, fixtures: makeFixtures('populated') });
  const init = webInit({ signedIn: true, lang: 'en', theme: 'light' });
  await ctx.addInitScript(init.script, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(`${BASE}/${file}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    // Frames 1600 x 1200, a different colour each, so a join shows its parts.
    const colours = ['#c8e6c9', '#bbdefb', '#ffe0b2', '#f8bbd0'];
    let n = 0;
    window.__frames = [];
    window.HAWKEYE = window.HAWKEYE || {};
    Object.assign(window.HAWKEYE, {
      native: true,
      capabilities: { ...(window.HAWKEYE.capabilities || {}), camera: true },
      capturePhoto: async () => {
        const c = document.createElement('canvas');
        c.width = 1600; c.height = 1200;
        const g = c.getContext('2d');
        g.fillStyle = colours[n % colours.length]; g.fillRect(0, 0, 1600, 1200);
        g.fillStyle = '#000'; g.font = 'bold 160px sans-serif'; g.fillText(`PART ${n + 1}`, 120, 640);
        n += 1;
        const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
        window.__frames.push(b);
        return b;
      },
    });
  });
  return { ctx, page, errors };
}
const dims = (page, sel) => page.evaluate(async (s) => {
  const img = document.querySelector(s);
  if (!img || !img.src) return null;
  await img.decode().catch(() => {});
  return { w: img.naturalWidth, h: img.naturalHeight };
}, sel);
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && !e.closest('[hidden]'); }, sel);

try {
  /* ── join(): the box, the band, the range ─────────────────────────────── */
  {
    const { ctx, page } = await open('observe.html');
    const r = await page.evaluate(async () => {
      const P = window.HAWKEYE_SHEETPARTS;
      const frame = async (w, h, colour) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, w, h);
        return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      };
      const size = async (b) => { const i = await createImageBitmap(b); const s = { w: i.width, h: i.height }; i.close(); return s; };
      const two = await P.join([await frame(1600, 1200, '#ffffff'), await frame(1600, 1200, '#ffffff')]);
      const three = await P.join([await frame(1200, 1600, '#ffffff'), await frame(1200, 1600, '#ffffff'), await frame(1200, 1600, '#ffffff')]);
      // the band: sample the row between the two parts of `two`
      const bmp = await createImageBitmap(two);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const L = P.layout([{ w: 1600, h: 1200 }, { w: 1600, h: 1200 }]);
      const bandY = L.rows[0].h + Math.floor(P.BAND / 2);
      const px = (y) => Array.from(g.getImageData(Math.floor(bmp.width / 2), y, 1, 1).data.slice(0, 3));
      let one = null; let four = null;
      try { await P.join([await frame(10, 10, '#fff')]); } catch (e) { one = e.message; }
      try { await P.join([1, 2, 3, 4].map(() => 'data:,')); } catch (e) { four = e.message; }
      return { two: await size(two), three: await size(three), band: px(bandY), paper: px(Math.floor(L.rows[0].h / 2)), one, four, max: P.MAX };
    });
    check('join: two landscape parts fit the 1500 x 2250 box', r.two.w <= 1500 && r.two.h <= 2250 && r.two.w >= 1400, r.two);
    check('join: three portrait parts are shrunk, never cropped, to 2250 tall', r.three.h <= 2250 && r.three.h >= 2240 && r.three.w < 1000, r.three);
    check('join: the band between parts is dark', r.band.every((v) => v < 60), r.band);
    check('CONTROL: the paper either side of it is not', r.paper.every((v) => v > 200), r.paper);
    check('join: one part, or more than 3, is refused', /2\.\.3/.test(r.one || '') && /2\.\.3/.test(r.four || '') && r.max === 3, { one: r.one, four: r.four });
    await ctx.close();
  }

  /* ── observe.html ─────────────────────────────────────────────────────── */
  {
    const { ctx, page, errors } = await open('observe.html');
    check('report: no "Add the next part" before a sheet photo', !(await visible(page, '#btn-add-part')));
    await page.click('#btn-cam-sheet');
    await page.waitForFunction(() => typeof shots !== 'undefined' && shots.sheet, null, { timeout: 20000 });
    const first = await page.evaluate(() => ({ at: shots.sheet.capturedAt, lat: shots.sheet.lat, parts: shots.sheet.parts || 1 }));
    check('report: after one photo, the Add button shows; no count yet', (await visible(page, '#btn-add-part')) && !(await visible(page, '#sheet-parts-count')) && first.parts === 1, first);
    const single = await dims(page, '#preview-sheet');
    check('CONTROL: one photo is the ordinary 1500 px sheet', single && Math.max(single.w, single.h) === 1500, single);

    await page.waitForTimeout(50);
    await page.click('#btn-add-part');
    await page.waitForFunction(() => shots.sheet && shots.sheet.parts === 2, null, { timeout: 20000 });
    const two = await page.evaluate(() => ({ at: shots.sheet.capturedAt, lat: shots.sheet.lat, parts: shots.sheet.parts, count: document.getElementById('sheet-parts-count').textContent }));
    check('report: two parts — the count reads "2 photos joined into one"', two.count === '2 photos joined into one' && (await visible(page, '#sheet-parts-count')), two);
    check('report: the FIRST photo\'s time and place stand for the sheet', two.at === first.at && two.lat === first.lat, { first, two });
    const d2 = await dims(page, '#preview-sheet');
    check('report: the joined photo is taller than one part and inside the box', d2 && d2.h > d2.w && d2.w <= 1500 && d2.h <= 2250, d2);
    // SHOTS=<dir>: a picture of the step for a human to look at.
    if (process.env.SHOTS) await page.locator('#slot-sheet').screenshot({ path: path.join(process.env.SHOTS, 'report-sheet-2-parts.png') }).catch(() => {});

    await page.click('#btn-add-part');
    await page.waitForFunction(() => shots.sheet && shots.sheet.parts === 3, null, { timeout: 20000 });
    check('report: at 3 parts the Add button goes', !(await visible(page, '#btn-add-part')));
    const frames = await page.evaluate(() => ({ kept: sheetPartFrames.length, same: sheetPartFrames.every((f, i) => f === window.__frames[i]) }));
    check('report: each join is made from the ORIGINAL frames, not a re-compressed join', frames.kept === 3 && frames.same, frames);

    // The submit form carries the count: the same lines the submit handler runs.
    const field = await page.evaluate(() => {
      const form = new FormData();
      if ((shots.sheet.parts || 1) >= 2) form.set('sheetParts', String(shots.sheet.parts));
      return form.get('sheetParts');
    });
    const src = fs.readFileSync(path.join(APP, 'app.js'), 'utf8');
    check('report: the submit form sends sheetParts = 3', field === '3' && /form\.set\('sheetParts', String\(shots\.sheet\.parts\)\)/.test(src), field);

    // Retake starts again from one photo.
    await page.click('#btn-cam-sheet');
    await page.waitForFunction(() => shots.sheet && !shots.sheet.parts && sheetPartFrames.length === 1, null, { timeout: 20000 });
    check('report: Retake starts the sheet again from one photo', (await visible(page, '#btn-add-part')) && !(await visible(page, '#sheet-parts-count')));
    check('report: no page errors', errors.length === 0, errors);
    await ctx.close();
  }

  /* ── practice.html, in lockstep ───────────────────────────────────────── */
  {
    const { ctx, page, errors } = await open('practice.html');
    check('practice: no "Add the next part" before a sheet photo', !(await visible(page, '#btn-add-part')));
    await page.click('#btn-cam-sheet');
    await page.waitForFunction(() => { const i = document.getElementById('preview-sheet'); return i && !i.hidden && i.src; }, null, { timeout: 20000 });
    await page.waitForTimeout(200);
    check('practice: after one photo, the Add button shows', await visible(page, '#btn-add-part'));
    await page.click('#btn-add-part');
    await page.waitForFunction(() => document.getElementById('sheet-parts-count').textContent === '2 photos joined into one', null, { timeout: 20000 });
    const d = await dims(page, '#preview-sheet');
    check('practice: two parts joined, inside the box', d && d.h > d.w && d.h <= 2250, d);
    await page.click('#btn-add-part');
    await page.waitForFunction(() => document.getElementById('sheet-parts-count').textContent === '3 photos joined into one', null, { timeout: 20000 });
    check('practice: at 3 parts the Add button goes', !(await visible(page, '#btn-add-part')));
    await page.click('#btn-cam-sheet');
    const restarted = await page.waitForFunction(() => {
      const c = document.getElementById('sheet-parts-count'); const a = document.getElementById('btn-add-part');
      return c && c.hidden && a && !a.hidden;
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    check('practice: Retake starts again from one photo', restarted && (await visible(page, '#btn-add-part')) && !(await visible(page, '#sheet-parts-count')));
    check('practice: no page errors', errors.length === 0, errors);
    await ctx.close();
  }

  /* ── the strings, in all four languages ───────────────────────────────── */
  for (const lang of ['en', 'ha', 'ig', 'yo']) {
    const d = JSON.parse(fs.readFileSync(path.join(APP, 'i18n', `${lang}.json`), 'utf8'));
    const keys = ['observe.result-sheet-or-poster', 'observe.ec8a-sheet-or-ec60e-poster', 'observe.capture-result', 'observe.parts-hint', 'observe.add-next-part', 'observe.parts-joined', 'observe.parts-join-failed'];
    const missing = keys.filter((k) => !d[k]);
    check(`strings: all 7 present in ${lang}${lang === 'en' ? '' : ', {n} kept'}`, !missing.length && d['observe.parts-joined'].includes('{n}'), missing);
  }
} catch (e) {
  fails += 1;
  console.log('FAIL  threw:', e && e.stack);
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nsheet_parts_ui: all passed');
process.exit(fails ? 1 : 0);

/**
 * THE PHOTO CHECKS on the web / Lite report page — node tests/sheet_checks_ui_test.mjs
 *
 * After the sheet photo is read (the 'hawkeye-sheet-ocr' event: Tesseract.js on
 * the web, ML Kit in the Lite shell), app.js paintSheetChecks warns when the
 * photo names another race's election, and lists the race's ballot parties it
 * could not find (sheet-counts.js sheetOffice / partiesSeen / partiesMissing).
 * Drives the SHIPPED observe.html from a local mirror of app/, signed in with
 * the design-audit fixtures and their write guard (nothing is written anywhere).
 *
 * Each warning has a CONTROL that must stay quiet: the right race's sheet, a
 * complete sheet, and a read too weak to judge.
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
const PRES = JSON.parse(fs.readFileSync(path.join(APP, 'ballots-2027.json'), 'utf8')).PRES;

async function open(file, lang = 'en') {
  const ctx = await browser.newContext({ ...contextOptions(VIEWPORTS.s390, { theme: 'light' }) });
  await installGuard(ctx, { signedIn: true, fixtures: makeFixtures('populated') });
  const init = webInit({ signedIn: true, lang, theme: 'light' });
  await ctx.addInitScript(init.script, init.arg);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  await page.goto(`${BASE}/${file}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}
/** Hand the page a sheet read, as the reader would. */
const read = (page, text) => page.evaluate((t) => {
  window.dispatchEvent(new CustomEvent('hawkeye-sheet-ocr', { detail: { text: t, tokens: (t.match(/\d+/g) || ['0']), lines: [] } }));
}, text);
const box = (page) => page.evaluate(() => { const e = document.getElementById('sheet-checks'); return e ? { shown: !e.hidden, text: e.textContent } : null; });
const race = (page, code) => page.evaluate((c) => {
  const s = document.getElementById('sel-contest');
  if (![...s.options].some((o) => o.value === c)) s.add(new Option(c, c));
  s.value = c;
  s.dispatchEvent(new Event('change'));
}, code);
const rows = (codes) => codes.map((c, i) => `${i + 1} ${c} ${10 + i}`).join('\n');

try {
  check(`the PRES ballot is real (${PRES.length} parties)`, Array.isArray(PRES) && PRES.length >= 10, PRES);

  const { ctx, page, errors } = await open('observe.html');
  check('the page loads the photo checks', await page.evaluate(() => typeof window.HAWKEYE_SHEETCOUNTS?.sheetOffice === 'function' && !!document.getElementById('sheet-checks')));
  check('the four-corners line is under the sheet slot', await page.evaluate(() => /four corners/.test(document.querySelector('#slot-sheet')?.textContent || '')));
  check('nothing shown before a photo is read', !(await box(page)).shown);

  // ── another race's sheet ────────────────────────────────────────────────
  await race(page, 'PRES');
  await read(page, 'INDEPENDENT NATIONAL ELECTORAL COMMISSION\nSENATORIAL DISTRICT: KADUNA CENTRAL\nName of Presiding Officer');
  let b = await box(page);
  check('a Senate sheet sent as Presidential: warned', b.shown && /looks like the Senate result, not Presidential/.test(b.text), b);
  await race(page, 'SEN');
  b = await box(page);
  check('CONTROL: the same sheet, race switched to Senate: quiet', !b.shown, b);
  await race(page, 'REP_BYE_GOMBE_2026');
  b = await box(page);
  check('a by-election takes its office (REP): Senate sheet warned', b.shown && /not House of Representatives/.test(b.text), b);
  await race(page, 'PRES');
  await read(page, 'PRESIDENTIAL ELECTION\nName of Presiding Officer');
  b = await box(page);
  check('CONTROL: a Presidential sheet sent as Presidential: quiet', !b.shown, b);

  // ── parties missing from the photo (needs a unit, for the ballot) ────────
  await page.evaluate(() => selectUnit({ pu_code: '19-08-04-001', name: 'Test unit', state: 'Kaduna', lga: 'Kaduna North', ward: 'Unguwan Sarki', senatorial: 'Kaduna Central', federal_constituency: 'Kaduna North' }));
  await page.waitForFunction(() => typeof ballots !== 'undefined' && ballots && Array.isArray(ballots.PRES), null, { timeout: 15000 });
  await race(page, 'PRES');
  const top = PRES.slice(0, Math.ceil(PRES.length / 2) + 2);
  const cut = PRES.slice(top.length);
  await read(page, `PRESIDENTIAL ELECTION\n${rows(top)}`);
  b = await box(page);
  check(`bottom rows cut off: the ${cut.length} missing parties are named`, b.shown && cut.every((c) => b.text.includes(c)) && /add the next part/.test(b.text), b);
  check('... and none of the parties that were found', !top.some((c) => new RegExp(`(^|[ ,:])${c}([ ,.]|$)`).test(b.text.replace(/^.*?:/, ''))), b);
  await read(page, `PRESIDENTIAL ELECTION\n${rows(PRES)}`);
  b = await box(page);
  check('CONTROL: every party on the photo: quiet', !b.shown, b);
  await read(page, `PRESIDENTIAL ELECTION\n${rows(PRES.slice(0, 2))}`);
  b = await box(page);
  check('CONTROL: a read too weak to judge (2 rows): quiet', !b.shown, b);

  // ── parts: a later part adds its rows to the first ────────────────────────
  await read(page, `PRESIDENTIAL ELECTION\n${rows(top)}`);
  await page.evaluate(() => { sheetAppending = true; });
  await read(page, rows(cut));
  b = await box(page);
  check('a second part with the missing rows clears the warning', !b.shown, b);
  await page.evaluate(() => { sheetAppending = false; });

  // ── both at once, and the reset ─────────────────────────────────────────
  await race(page, 'GOV');
  await race(page, 'PRES');
  await read(page, `GOVERNORSHIP ELECTION\n${rows(top)}`);
  b = await box(page);
  check('another race AND missing parties: both said', b.shown && /Governorship result, not Presidential/.test(b.text) && cut.every((c) => b.text.includes(c)), b);
  // SHOT_DIR=… to look at it (the counts step, with the warning above the parties).
  if (process.env.SHOT_DIR) {
    await page.evaluate(() => { const f = document.getElementById('sheet-checks'); f.closest('details')?.setAttribute('open', ''); f.scrollIntoView({ block: 'start' }); window.scrollBy(0, -60); });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(process.env.SHOT_DIR, 'sheet-checks-web.png') });
  }
  await page.evaluate(() => resetReportState());
  b = await box(page);
  check('a reset report clears it', !b.shown, b);
  check('no page errors', !errors.length, errors);
  await ctx.close();

  // ── the other languages ─────────────────────────────────────────────────
  {
    const { ctx: c2, page: p2 } = await open('observe.html', 'ha');
    await race(p2, 'PRES');
    await read(p2, 'SENATORIAL DISTRICT');
    const h = await box(p2);
    check('Hausa: the warning is in Hausa, with the race names', h.shown && /Majalisar Dattawa/.test(h.text) && /Shugaban ƙasa/.test(h.text) && !/looks like/.test(h.text), h);
    await c2.close();
  }
  {
    const { ctx: c3, page: p3 } = await open('practice.html');
    check('practice: the four-corners line is there too', await p3.evaluate(() => /four corners/.test(document.body.textContent)));
    await c3.close();
  }
} catch (e) {
  fails += 1;
  console.log('FAIL  threw:', e && e.stack);
} finally {
  await browser.close();
  server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nsheet_checks_ui: all passed');
process.exit(fails ? 1 : 0);

/**
 * The practice run ends by showing the PUBLIC reports-log card for itself,
 * built from the photo on this phone — and it sends nothing but counts.
 *
 * The privacy half is the one that matters, so it is asserted on the wire:
 * every request body the page sends is captured, and none may carry an image.
 * A CONTROL confirms the capture works by demanding it saw the counts.
 *
 *   node tests/practice_preview_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.json': 'application/json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const CFG = {
  // active: the page shows "practice is closed" and builds nothing without it.
  active: true,
  name: 'Practice Election', office: 'Governor',
  unit: { name: 'Sample Practice School', code: '99-01-01-001', ward: 'Sample Ward', lga: 'Sample LGA', state: 'FCT' },
  parties: [{ code: 'PA', name: 'Party A' }, { code: 'PB', name: 'Party B' }],
};
const bodies = [];
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST') bodies.push({ url, type: req.headers['content-type'] || '', body });
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url === '/api/practice') return json(CFG);
    if (url === '/api/practice/submit') return json({ ok: true, entryHash: 'f'.repeat(64), recordedAt: Date.now() });
    if (url.startsWith('/api/')) return json([]);
    const f = path.join(APP, decodeURIComponent(url));
    if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    return fs.createReadStream(f).pipe(res);
  });
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got ${JSON.stringify(got)}`}`);
};
// A tiny real JPEG, as the in-page camera would leave in #preview-sheet.
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

const b = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });

async function run(withPhoto) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('dialog', (d) => d.accept());
  await p.goto(`${base}/practice.html`, { waitUntil: 'networkidle' });
  /* THE REAL FIVE STEPS (flow walkthrough REP-PRAC-01): capture, which polling
     unit, which election, counts + Verify counts, sign — each locked until
     the one before it is done, exactly as observe.html. */
  await p.waitForSelector('#btn-skip-sheet', { timeout: 10000 });
  const locks = () => p.evaluate(() => ({
    locked: ['photo-fold', 'unit-fold', 'race-fold', 'counts-fold'].map((id) => document.getElementById(id).classList.contains('locked')),
    submit: document.getElementById('btn-submit').disabled,
  }));
  const start = await locks();
  if (withPhoto) {
    await p.evaluate((src) => { const i = document.getElementById('preview-sheet'); i.src = src; i.hidden = false; }, PHOTO);
  }
  // 1. capture (both slots: a sample here)
  await p.click('#btn-skip-sheet');
  await p.click('#btn-skip-venue');
  const afterPhotos = await locks();
  // 2. which polling unit: the practice unit
  await p.waitForSelector('#btn-prac-unit', { state: 'visible', timeout: 5000 });
  await p.click('#btn-prac-unit');
  // 3. which election
  await p.waitForSelector('#sel-contest', { state: 'visible', timeout: 5000 });
  await p.selectOption('#sel-contest', 'PRES');
  // 4. counts, then Verify counts
  await p.waitForSelector('#vote-inputs input', { state: 'visible', timeout: 10000 });
  const inputs = await p.$$('#vote-inputs input');
  await inputs[0].fill('212');
  if (inputs[1]) await inputs[1].fill('87');
  const beforeVerify = await locks();
  await p.click('#btn-verify-counts');
  const ready = await locks();
  // 5. sign & submit
  await p.click('#btn-submit');
  await p.waitForSelector('#done:not([hidden])', { timeout: 10000 });
  const out = await p.evaluate(() => ({
    previewVisible: !!document.getElementById('prac-preview') && document.getElementById('prac-preview').offsetParent !== null,
    name: document.getElementById('pv-name').textContent,
    meta: document.getElementById('pv-meta').textContent,
    votes: document.getElementById('pv-votes').textContent,
    thumbs: [...document.querySelectorAll('#pv-sheets img')].map((i) => i.getAttribute('src').slice(0, 22)),
    stripShown: !document.getElementById('pv-sheets-wrap').hidden,
    noPhotoShown: !document.getElementById('pv-no-photo').hidden,
    chip: document.querySelector('.prac-preview-chip').textContent,
  }));
  out.errs = errs;
  out.steps = { start, afterPhotos, beforeVerify, ready };
  await p.close();
  return out;
}

const a = await run(true);
// The locks walk forward one step at a time; sign stays off until all four are done.
check('five steps, locked in order: only capture open at the start, sign off',
  a.steps.start, { locked: [false, true, true, true], submit: true });
check('capture done -> the unit step opens, the rest stay locked', a.steps.afterPhotos, { locked: [false, false, true, true], submit: true });
check('CONTROL counts typed but not verified: sign still off', a.steps.beforeVerify, { locked: [false, false, false, false], submit: true });
check('Verify counts -> sign is on', a.steps.ready.submit, false);
check('with a photo: the preview card is on screen', a.previewVisible, true);
check('with a photo: it shows THIS unit and marks it PRACTICE', [a.name, a.meta.startsWith('[PRACTICE] 99-01-01-001')], ['Sample Practice School', true]);
check('with a photo: the vote line reads like the real log', a.votes, (v) => /212/.test(v) && /87/.test(v));
check('with a photo: the sheet thumbnail is the local photo, not a server URL', a.thumbs, ['data:image/jpeg;base64']);
check('with a photo: strip shown, no-photo note hidden', [a.stripShown, a.noPhotoShown], [true, false]);
check('the chip says it never leaves the phone', a.chip, (c) => /never uploaded/i.test(c));

const nb = await run(false);
check('with a sample: no thumbnail, and the note explains why', [nb.thumbs.length, nb.stripShown, nb.noPhotoShown], [0, false, true]);

// ON THE WIRE. Control first: the capture must have seen the counts it sent.
check('CONTROL: the submit bodies were captured and carry the counts', bodies.filter((x) => x.url === '/api/practice/submit').map((x) => /212/.test(x.body)), [true, true]);
check('each run sent the unit and the race the steps chose', bodies.filter((x) => x.url === '/api/practice/submit').map((x) => { const j = JSON.parse(x.body); return [j.puCode, j.contest]; }),
  [['99-01-01-001', 'PRES'], ['99-01-01-001', 'PRES']]);
check('nothing the page sent contains an image or a multipart upload',
  bodies.map((x) => ({ url: x.url, multipart: /multipart/i.test(x.type), image: /data:image|image\/jpeg|\/9j\//.test(x.body) })),
  (list) => list.length > 0 && list.every((x) => !x.multipart && !x.image));
check('no page errors in either run', [...a.errs, ...nb.errs], []);

await b.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall practice-preview checks passed');
process.exit(fail ? 1 : 0);

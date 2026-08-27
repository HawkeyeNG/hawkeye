/**
 * THE WEB INCIDENT FORM'S MEDIA RULES, DRIVEN IN A BROWSER.
 *
 * The server is the real gate, but by the time it answers, the observer has
 * already spent the mobile data to reach it — on election day, on a congested
 * cell, at a polling unit. So the client has to shrink what it can and refuse
 * what it must, BEFORE the upload.
 *
 * Two things are asserted, and both are about bytes rather than about markup:
 *   1. a photo is compressed before it is attached, so the size in the tray is
 *      the size that will be sent;
 *   2. a third video is refused with a message that says what to do instead.
 *
 * A canvas cannot re-encode video, so there is deliberately no "videos get
 * smaller" assertion here — that is the native build's job, and pretending
 * otherwise is how a test starts lying.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (u === '/api/observers/me') return json({ observerNo: 2, createdAt: '2026-07-15T00:00:00Z', idHash: 'a'.repeat(64) });
  // REAL SHAPES, not {}. A catch-all empty object made the page throw
  // "kinds.map is not a function" — a fault in the fixture that reads exactly
  // like a fault in the product, which is the whole reason page errors are
  // failures here.
  if (u === '/api/incidents/kinds') return json(['violence', 'vote_buying', 'intimidation', 'other']);
  if (u === '/api/incidents') return json({ incidents: [] });
  if (u === '/api/contests') return json([]);
  if (u === '/api/parties') return json([]);
  if (u.startsWith('/api/')) return json({});
  const f = path.join(APP, decodeURIComponent(u === '/' ? '/index.html' : u));
  if (!f.startsWith(APP) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  return fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok || !extra ? '' : `\n        ${extra}`}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

const JWT = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64')}.y`;
const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
await ctx.addInitScript((t) => {
  Object.defineProperty(window, 'HAWKEYE', { value: { native: true, apiBase: '' }, writable: false, configurable: false });
  const mark = () => { if (document.documentElement) document.documentElement.classList.add('native-app'); };
  mark();
  document.addEventListener('readystatechange', mark);
  try { localStorage.setItem('hawkeye_token', t); localStorage.setItem('hawkeye_tour_seen', '1'); } catch { /* ignore */ }
}, JWT());
const page = await ctx.newPage();
page.on('pageerror', (e) => { fail++; console.log('FAIL  page error: ' + String(e.stack || e).slice(0, 400)); });
await page.goto(`${base}/incidents.html`);
await page.waitForTimeout(1200);

console.log('=== the shrink helper is reachable from this page ===');
{
  const has = await page.evaluate(() => !!(window.HAWKEYE_CAPTURE && window.HAWKEYE_CAPTURE.shrink));
  check('capture.js exposes HAWKEYE_CAPTURE.shrink', has,
    'incidents.html loads capture.js but not app.js, so the helper must live in capture.js');
}

console.log('\n=== a large photo is compressed BEFORE it is attached ===');
{
  const r = await page.evaluate(async () => {
    // A big, noisy canvas: a flat colour would compress to nothing and prove nothing.
    const c = document.createElement('canvas');
    c.width = 3000; c.height = 2250;
    const g = c.getContext('2d');
    const img = g.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = Math.random() * 255; img.data[i + 1] = Math.random() * 255;
      img.data[i + 2] = Math.random() * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
    const file = new File([blob], 'evidence.jpg', { type: 'image/jpeg' });
    const out = await window.HAWKEYE_CAPTURE.shrink(file, 1280, 0.72);
    return { before: file.size, after: out.size, type: out.type, name: out.name || null };
  });
  console.log(`      ${(r.before / 1048576).toFixed(2)} MB -> ${(r.after / 1048576).toFixed(2)} MB`);
  check('the compressed photo is smaller', r.after < r.before, `${r.before} -> ${r.after}`);
  check('it is still a JPEG', r.type === 'image/jpeg', r.type);
  check('and it keeps a filename for the upload', !!r.name, String(r.name));
}

console.log('\n=== shrink never makes things worse ===');
{
  const r = await page.evaluate(async () => {
    // Already tiny: re-encoding would ADD bytes, so the original must come back.
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.5));
    const file = new File([blob], 'tiny.jpg', { type: 'image/jpeg' });
    const out = await window.HAWKEYE_CAPTURE.shrink(file, 1280, 0.72);
    return { same: out === file, before: file.size, after: out.size };
  });
  check('a tiny image is returned untouched, not inflated', r.same || r.after <= r.before,
    `${r.before} -> ${r.after}`);
  // CONTROL: a non-image must pass straight through rather than be mangled.
  const v = await page.evaluate(async () => {
    const f = new File([new Uint8Array(1024)], 'clip.mp4', { type: 'video/mp4' });
    const out = await window.HAWKEYE_CAPTURE.shrink(f, 1280, 0.72);
    return out === f;
  });
  control('a video handed to shrink is NOT altered', !v);
}

console.log('\n=== the third video is refused, with a way forward ===');
{
  const r = await page.evaluate(async () => {
    const mk = (n) => new File([new Uint8Array(2048)], `c${n}.mp4`, { type: 'video/mp4' });
    await addFiles([mk(1), mk(2), mk(3)]);
    return {
      attached: attachments.length,
      videos: attachments.filter((f) => /^video\//.test(f.type)).length,
      status: document.getElementById('status').textContent.trim(),
    };
  });
  console.log(`      attached=${r.attached} videos=${r.videos} status="${r.status}"`);
  check('only two videos are kept', r.videos === 2, `got ${r.videos}`);

  /**
   * A REFUSAL MUST BE ACKNOWLEDGED. Dropping the third video and writing a
   * status line reads as the attach silently not working — the file was
   * chosen, it vanished, and nothing demanded a response. So this asserts a
   * real modal is on screen, not just that some text changed somewhere.
   */
  const modal = await page.evaluate(() => {
    const box = document.querySelector('.hk-alert');
    return {
      exists: !!box,
      painted: box ? box.getClientRects().length > 0 : false,
      text: box ? box.textContent.replace(/\s+/g, ' ').trim() : '',
    };
  });
  console.log(`      modal painted=${modal.painted} "${modal.text.slice(0, 80)}"`);
  check('a modal is actually on screen', modal.painted, JSON.stringify(modal));
  check('and it says what to do instead', /second report|photos/i.test(modal.text), modal.text);
}

console.log('\n=== the video counter is silent until it is relevant ===');
{
  const r = await page.evaluate(async () => {
    const el = () => document.getElementById('video-count');
    const seen = {};
    // Start clean: the previous section left two videos attached.
    attachments.length = 0;
    renderPreview();
    seen.atZero = { hidden: el().hidden, text: el().textContent.trim() };

    await addFiles([new File([new Uint8Array(2048)], 'a.mp4', { type: 'video/mp4' })]);
    seen.atOne = { hidden: el().hidden, text: el().textContent.trim() };

    await addFiles([new File([new Uint8Array(2048)], 'b.mp4', { type: 'video/mp4' })]);
    seen.atTwo = { hidden: el().hidden, text: el().textContent.trim() };

    // A photo must not change the VIDEO count.
    await addFiles([new File([new Uint8Array(512)], 'p.jpg', { type: 'image/jpeg' })]);
    seen.afterPhoto = { hidden: el().hidden, text: el().textContent.trim() };
    return seen;
  });
  console.log(`      0 videos: hidden=${r.atZero.hidden}`);
  console.log(`      1 video : "${r.atOne.text}"`);
  console.log(`      2 videos: "${r.atTwo.text}"`);
  check('nothing is shown before any video is attached', r.atZero.hidden === true, JSON.stringify(r.atZero));
  check('after one video it says how many more', !r.atOne.hidden && /1 more/.test(r.atOne.text), r.atOne.text);
  check('at the cap it says photos only', !r.atTwo.hidden && /photos only/i.test(r.atTwo.text), r.atTwo.text);
  check('a photo does not change the video count', /2 of 2/.test(r.afterPhoto.text), r.afterPhoto.text);
}

console.log('\n=== an oversize file is refused by MODAL, and only from the library ===');
{
  const r = await page.evaluate(async () => {
    const big = () => new File([new Uint8Array(26 * 1024 * 1024)], 'big.mp4', { type: 'video/mp4' });
    const close = () => { const b = document.querySelector('#hk-alert-ok'); if (b) b.click(); };

    attachments.length = 0;
    close();
    // LIBRARY: the only place a size limit is the real bound.
    await addFiles([big()], 'library');
    const box = document.querySelector('.hk-alert');
    const fromLibrary = {
      attached: attachments.length,
      modal: box ? box.getClientRects().length > 0 : false,
      text: box ? box.textContent.replace(/\s+/g, ' ').trim() : '',
    };

    close();
    attachments.length = 0;
    // CAMERA: the recorder already stopped at the duration cap, so size must
    // NOT refuse it — the app would be overruling its own instruction.
    await addFiles([big()], 'camera');
    const box2 = document.querySelector('.hk-alert');
    const fromCamera = {
      attached: attachments.length,
      modal: box2 ? box2.getClientRects().length > 0 : false,
    };
    close();
    attachments.length = 0;
    renderPreview();
    return { fromLibrary, fromCamera };
  });
  console.log(`      library: attached=${r.fromLibrary.attached} modal=${r.fromLibrary.modal}`);
  console.log(`      camera : attached=${r.fromCamera.attached} modal=${r.fromCamera.modal}`);
  check('an oversize library file is refused', r.fromLibrary.attached === 0);
  check('and refused with a modal, not a status line', r.fromLibrary.modal, JSON.stringify(r.fromLibrary));
  check('the modal names the size and the limit',
    /MB/.test(r.fromLibrary.text) && /too large/i.test(r.fromLibrary.text), r.fromLibrary.text);
  check('a RECORDING of the same size is accepted', r.fromCamera.attached === 1,
    'the duration cap is the gate for recordings — a size refusal there overrules the app\'s own instruction');
  check('and raises no modal', r.fromCamera.modal === false);
}

console.log('\n=== a video thumbnail shows a real frame, not a grey box ===');
{
  const r = await page.evaluate(async () => {
    // A tiny real video, produced in-page so the decoder has something valid.
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(10);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start();
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = `hsl(${i * 30},90%,50%)`;
      ctx.fillRect(0, 0, 64, 48);
      await new Promise((res) => setTimeout(res, 30));
    }
    rec.stop();
    await stopped;
    const file = new File(chunks, 'clip.webm', { type: 'video/webm' });

    attachments.length = 0;
    await addFiles([file]);
    // grabFrame is asynchronous (loadeddata -> seeked); give it a moment.
    await new Promise((res) => setTimeout(res, 1500));
    const img = document.querySelector('#preview .vthumb');
    return {
      isImg: !!img && img.tagName === 'IMG',
      hasFrame: !!img && /^data:image\/jpeg/.test(img.src || ''),
      badge: !!document.querySelector('#preview .vbadge'),
      noVideoEl: !document.querySelector('#preview video'),
    };
  });
  console.log(`      img=${r.isImg} frame=${r.hasFrame} badge=${r.badge}`);
  check('the tile is an <img>, not a bare <video>', r.isImg && r.noVideoEl, JSON.stringify(r));
  check('a play badge marks it as a video', r.badge);
  check('and a real frame was drawn into it', r.hasFrame,
    'grabFrame did not paint — the tile would be a flat colour, which is the bug');
}

console.log('\n=== the progress bar never invents a percentage ===');
{
  const r = await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    return {
      // In the native shell there are no byte events, so the bar must be
      // indeterminate rather than driven by a timer pretending to be progress.
      hasIndeterminate: /indeterminate/.test(src),
      // The clamp: a replayed body can report more than was ever going to be
      // sent, and a bar past 100% reads as broken.
      clamps: /Math\.min\(e\.loaded, e\.total\)/.test(src),
    };
  });
  check('an indeterminate mode exists for where progress is unknown', r.hasIndeterminate);
  check('and real progress is clamped to the total', r.clamps);
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

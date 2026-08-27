/**
 * THE ADMIN REVIEWER MUST BE ABLE TO SEE THE EVIDENCE.
 *
 * A pending incident's video was rendered into a 160x120 box with
 * `object-fit: cover`. Two consequences, and the second is the one that made it
 * look like a codec fault:
 *
 *   1. cropped and far too small to judge what is happening;
 *   2. Chrome REDUCES its control set for a small video element — at 160px the
 *      overflow menu offered only Download and Playback speed, with no
 *      Fullscreen and no Mute. So there was no way to make it bigger either,
 *      and the same page behaved differently on a phone, where the element is a
 *      large fraction of the screen.
 *
 * Also asserts that a clip the server could not convert SAYS SO. `transcoded:
 * false` means the phone's original was kept, which on a recent handset is
 * HEVC: the AAC audio plays and the picture does not. A named warning beats a
 * black rectangle a reviewer has to diagnose.
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const INCIDENTS = [
  {
    id: 17, observer_id: 2, kind: 'other', description: '', lat: 9.03, lng: 7.49,
    pu_code: null, state: null, status: 'pending', created_at: Date.now(), ai: null,
    media: [{ file: 'incidents/converted.mp4', type: 'video', transcoded: true }],
  },
  {
    id: 18, observer_id: 2, kind: 'other', description: '', lat: null, lng: null,
    pu_code: null, state: null, status: 'pending', created_at: Date.now(), ai: null,
    media: [{ file: 'incidents/raw.mp4', type: 'video', transcoded: false, transcodeError: 'ffmpeg_absent' }],
  },
];

/** Flipped for the control run, so the same code path decides both outcomes. */
let HEALTHY = false;

const server = http.createServer((req, res) => {
  const [u] = req.url.split('?');
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (u === '/api/admin/incidents') return json({ incidents: INCIDENTS, counts: { pending: 2, published: 0, rejected: 0 } });
  if (u === '/api/admin/stats') {
    return json(HEALTHY
      ? { media: { ffmpeg: true, transcodeFailuresSinceBoot: 0, lastTranscodeFailure: null, untranscodedVideoReports: 0 } }
      : { media: { ffmpeg: false, transcodeFailuresSinceBoot: 0, lastTranscodeFailure: null, untranscodedVideoReports: 1 } });
  }
  if (u.startsWith('/uploads/')) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.alloc(64)); }
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

const browser = await chromium.launch({ executablePath: '/home/elrio/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome' });
// A DESKTOP viewport: this is the one that was broken, and the phone is the one
// that accidentally worked.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// admin.html is behind authgate.js, which replaces the whole body with a
// sign-in view when signed out — so without this the console markup is not in
// the DOM at all and every assertion below would fail on a null element.
// The ADMIN password is a separate gate and is never Claude's to type; this
// only gets the page rendered.
await ctx.addInitScript(() => {
  const jwt = `x.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }))}.y`;
  try {
    localStorage.setItem('hawkeye_token', jwt);
    // The console reads sessionStorage.hawkeye_admin and, when it is non-empty,
    // reveals itself and calls load(). This is a LOCAL flag, not a credential:
    // the real password is checked by the server, and the stub here accepts any
    // header. Setting it is what makes the page render its own list, which is
    // the whole point — the test must exercise admin.html's renderer, not a
    // copy of it written in the test.
    sessionStorage.setItem('hawkeye_admin', 'harness-not-a-real-secret');
  } catch { /* ignore */ }
});
const page = await ctx.newPage();
await page.goto(`${base}/admin.html`);
await page.waitForTimeout(400);

// Render the incident list directly. The console gates on an admin password,
// which is never Claude's to type and is not what this test is about.
/**
 * DRIVE THE PAGE'S OWN CODE, not a copy of it.
 *
 * The first version of this test re-implemented admin.html's media renderer
 * inside the test and then asserted against its own output — which would pass
 * happily while the real page stayed broken. The script is an IIFE, so nothing
 * is reachable from `window`; the way in is to reveal the console and click the
 * Incidents tab, letting the page fetch from the stub server and render itself.
 *
 * <section id="console"> is hidden until the admin password unlocks it, and a
 * panel inside a hidden section has NO LAYOUT — every measurement would read
 * 0x0 and the size assertion would fail for the wrong reason. The password
 * itself is never typed here.
 */
await page.evaluate(() => {
  const shell = document.getElementById('console');
  if (shell) shell.hidden = false;
});
await page.waitForTimeout(1200);
// The console opens on the Reach tab, and a panel that is `hidden` has no
// layout — the video measured 0x0 until this click, which would have read as a
// failing size assertion rather than a hidden panel.
await page.click('.tab[data-p="incidents"]');
await page.waitForTimeout(800);

console.log('=== the player is big enough to judge a clip by ===');
{
  const r = await page.evaluate(() => {
    const v = document.querySelector('.inc .m video');
    const q = v.getBoundingClientRect();
    return { w: Math.round(q.width), h: Math.round(q.height), fit: getComputedStyle(v).objectFit };
  });
  console.log(`      video renders ${r.w}x${r.h}, object-fit: ${r.fit}`);
  // 160px was the broken size, and is also roughly where Chrome starts dropping
  // controls. 320 is a floor with room to spare, not a magic number.
  check('the video is at least 320px wide', r.w >= 320, `got ${r.w}px`);
  check('it is not cropped (object-fit: contain)', r.fit === 'contain', r.fit);
  control('the old 160px box would fail that width check', 160 >= 320);
}

console.log('\n=== an unconverted clip says so ===');
{
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.inc')];
    return {
      warnings: cards.map((c) => !!c.querySelector('.noconv')),
      text: (cards[1].querySelector('.noconv') || {}).textContent || '',
      painted: cards[1].querySelector('.noconv')?.getClientRects().length > 0,
    };
  });
  console.log(`      warnings per card: ${JSON.stringify(r.warnings)}`);
  check('the converted clip carries NO warning', r.warnings[0] === false);
  check('the unconverted one does', r.warnings[1] === true);
  check('and the warning is actually painted', r.painted === true);
  check('it names the reason', /ffmpeg_absent/.test(r.text), r.text);
}

/* The page already painted this during load(). It lives inside an IIFE, so
   there is nothing to call — the DOM it produced IS the observable. */
console.log('\n=== the server states its own capability ===');
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('media-health');
    return { hidden: el.hidden, text: el.textContent.trim() };
  });
  console.log(`      "${r.text}"`);
  check('the media-health line is shown when ffmpeg is missing', r.hidden === false);
  check('and it names ffmpeg', /ffmpeg/i.test(r.text), r.text);
}

console.log('\n=== CONTROL: it stays quiet when everything is healthy ===');
{
  // Flip the stub and reload, rather than monkey-patching fetch inside the
  // page: the same code path has to run, or the control proves nothing.
  HEALTHY = true;
  await page.goto(`${base}/admin.html`);
  await page.waitForTimeout(1500);
  await page.click('.tab[data-p="incidents"]').catch(() => {});
  await page.waitForTimeout(600);
  const hidden = await page.evaluate(() => document.getElementById('media-health').hidden);
  control('a healthy server shows no warning line', hidden !== true);
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

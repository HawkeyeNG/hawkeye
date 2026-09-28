/**
 * The console's Telegram broadcast composer and the channel notice (admin.html,
 * Reach): the message box is big, and a greyed-out Send always says why.
 *
 * Headless Chromium against the real admin.html; every /api/admin call is
 * answered by this file's fake server, which records the sends. Each disabled
 * reason has its CONTROL: the one thing fixed, the reason moves on or the
 * button enables.
 *
 *   node tests/admin_tg_broadcast_ui_test.mjs
 */
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { chromium } = require_('playwright-core');
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP = '/home/elrio/hawkeye/app';
const OUT = '/home/elrio/hawkeye/tmp/admin_shots';
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/* What the fake server answers; each scenario sets it before loading the page. */
const S = { live: true, followers: 3, eligible: 0, running: false };
const sends = [];
const LANGS = ['en', 'ha', 'ig', 'yo'];
const broadcast = () => (S.running
  ? { id: 'cRUNNING01', state: 'running', targets: { channels: true, followers: true }, audience: 3, sent: 1, failed: 0, channelsPosted: 2, channelsPlanned: 2, delivered: 1, waiting: 0, unconfirmed: 0, runs: 1 }
  : null);
const previewBody = () => ({
  maxChars: 4096, channelsLive: S.live, channelsConfigured: true, ignored: [], problem: null,
  channels: LANGS.map((l) => ({ lang: l, link: l === 'en' || l === 'ha' ? `https://t.me/hk_${l}` : null })),
  followers: { total: S.followers, byLang: LANGS.map((l, i) => ({ lang: l, count: i === 0 ? S.followers : 0 })) },
  counts: { channelPosts: 2, followerDms: S.followers },
  broadcast: broadcast(), busy: { broadcast: S.running, notice: false },
});
const noticeBody = () => ({
  live: S.live, configured: true, enabled: S.live, stringsReady: true, ignored: [], run: null,
  eligible: S.eligible, alreadySent: 0, unconfirmed: 0,
  byLang: Object.fromEntries(LANGS.map((l) => [l, { eligible: 0, sent: 0 }])),
  texts: Object.fromEntries(LANGS.map((l) => [l, { channel: 'https://t.me/hk_en', text: 'moved' }])),
});

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.startsWith('/api/')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (u === '/api/admin/tg-broadcast/preview') return json(200, previewBody());
      if (u === '/api/admin/tg-broadcast/status') return json(200, { broadcast: broadcast(), busy: { broadcast: S.running, notice: false } });
      if (u === '/api/admin/tg-broadcast/send') {
        const body = JSON.parse(raw || '{}');
        sends.push({ u, body });
        return json(202, { started: true, id: body.id, broadcast: { id: body.id, state: 'done', targets: body.targets, audience: 0, sent: 0, failed: 0, channelsPosted: 2, channelsPlanned: 2, delivered: 0, waiting: 0, unconfirmed: 0, runs: 1 }, busy: { broadcast: false, notice: false } });
      }
      if (u === '/api/admin/tg-notice/preview' || u === '/api/admin/tg-notice/status') return json(200, noticeBody());
      if (u === '/api/admin/tg-notice/send') { sends.push({ u, body: JSON.parse(raw || '{}') }); return json(400, { refused: 'test' }); }
      return json(200, {});
    });
    return;
  }
  const f = path.join(APP, decodeURIComponent(u));
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
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.x';

async function open(width = 1280) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('hawkeye_token', t);
      sessionStorage.setItem('hawkeye_admin', 'test');
      localStorage.setItem('hawkeye_admin', 'test');
    } catch (e) {}
  }, jwt);
  const p = await ctx.newPage();
  await p.goto(`${base}/admin.html?p=reach`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(300);
  await p.evaluate(() => { document.getElementById('tgb-wrap').open = true; document.getElementById('tgn-wrap').open = true; });
  await p.waitForTimeout(400);
  return { p, ctx };
}
const state = (p) => p.evaluate(() => ({
  reason: document.getElementById('tgb-reason').textContent,
  disabled: document.getElementById('tgb-send').disabled,
  count: document.getElementById('tgb-count').textContent,
  over: document.getElementById('tgb-count').classList.contains('over'),
}));
const type = async (p, sel, text) => { await p.fill(sel, ''); await p.type(sel, text); };

console.log('=== the message box is big ===');
let { p, ctx } = await open();
const box = await p.evaluate(() => {
  const ta = document.getElementById('tgb-text-en');
  const wrap = document.getElementById('tgb-wrap');
  const r = ta.getBoundingClientRect();
  return { visible: r.height > 0, rows: ta.rows, w: r.width, wrapW: wrap.getBoundingClientRect().width, h: r.height,
    resize: getComputedStyle(ta).resize, tabs: [...document.querySelectorAll('#tgb-langs .tgb-lang')].map((x) => x.dataset.l),
    fields: document.querySelectorAll('#tgb-fields textarea').length, oldConfirmW: document.getElementById('tgn-confirm').getBoundingClientRect().width };
});
check('the English box is visible, at least 6 rows', { visible: box.visible, rows: box.rows }, (x) => x.visible && x.rows >= 6);
check('  ...full width of its section', box.w, (w) => w >= box.wrapW * 0.95);
check('  ...at least 6 lines tall and resizable', { h: box.h, resize: box.resize }, (x) => x.h >= 120 && /vertical|both/.test(x.resize));
check('  ...CONTROL: far wider than the notice\'s 120px confirm box', box.w, (w) => w > box.oldConfirmW * 3);
check('one tab and one field per language', [box.tabs, box.fields], [['en', 'ha', 'ig', 'yo'], 4]);
check('the confirm label says what it is', await p.textContent('label[for="tgb-confirm"]'), 'Type SEND to confirm');

console.log('\n=== Send says why it is disabled ===');
let s = await state(p);
check('nothing typed: disabled, "Type the English message first."', [s.disabled, s.reason], [true, 'Type the English message first.']);
await type(p, '#tgb-text-en', 'Hello');
await p.keyboard.press('Enter');
await p.keyboard.type('world');
s = await state(p);
check('CONTROL typed (channels ticked, live): moves on to "Type SEND in the box to confirm."', [s.disabled, s.reason], [true, 'Type SEND in the box to confirm.']);
check('  ...character count against 4,096', s.count, '11 / 4,096 characters');
const pre = await p.evaluate(() => [...document.querySelectorAll('#tgb-out .tgb-pre')].map((x) => x.textContent));
check('the preview keeps the line break, and ha/ig/yo show the English they will get', pre, ['Hello\nworld', 'Hello\nworld', 'Hello\nworld', 'Hello\nworld']);
check('  ...and says they are English because empty', await p.evaluate(() => document.getElementById('tgb-out').textContent.includes('English text: Hausa is empty')), true);
await p.uncheck('#tgb-t-channels');
s = await state(p);
check('no target ticked: "Choose where to send it…"', [s.disabled, s.reason], [true, 'Choose where to send it: our channels, followers, or both.']);
await p.check('#tgb-t-followers');
s = await state(p);
check('CONTROL followers ticked (3 followers): back to "Type SEND…"', s.reason, 'Type SEND in the box to confirm.');
await p.fill('#tgb-confirm', 'send');
s = await state(p);
check('"send" in lower case: still disabled', [s.disabled, s.reason], [true, 'Type SEND in the box to confirm.']);
await p.fill('#tgb-confirm', 'SEND');
s = await state(p);
check('CONTROL SEND typed: enabled, no reason', [s.disabled, s.reason], [false, '']);
await p.click('#tgb-tab-ha');
await p.fill('#tgb-text-ha', 'x'.repeat(4097));
s = await state(p);
check('Hausa over 4,096: disabled, says which', [s.disabled, s.reason, s.over], [true, 'The Hausa message is over 4,096 characters.', true]);
await p.fill('#tgb-text-ha', 'x'.repeat(4096));
s = await state(p);
check('CONTROL exactly 4,096: allowed', [s.disabled, s.over, s.count], [false, false, '4,096 / 4,096 characters']);
await p.fill('#tgb-text-ha', 'Sannu');
check('no send has gone anywhere yet', sends.length, 0);

await p.click('#tgb-send');
await p.waitForTimeout(400);
const sent = sends.find((x) => x.u.endsWith('/tg-broadcast/send'));
check('CONTROL Send: one POST with the texts as typed (line break kept), targets, max, id, SEND', sent && {
  en: sent.body.texts.en, ha: sent.body.texts.ha, targets: sent.body.targets, max: sent.body.max, confirm: sent.body.confirm, id: /^[A-Za-z0-9_-]{8,64}$/.test(sent.body.id),
}, { en: 'Hello\nworld', ha: 'Sannu', targets: { channels: false, followers: true }, max: 3, confirm: 'SEND', id: true });
s = await state(p);
check('  ...then the box is empty and Send is disabled again, with its reason', [await p.inputValue('#tgb-text-en'), s.disabled, s.reason], ['', true, 'Type the English message first.']);
await ctx.close();

console.log('\n=== 0 followers, channels not live, a send running ===');
S.followers = 0; S.live = false;
({ p, ctx } = await open());
await type(p, '#tgb-text-en', 'Hi');
await p.fill('#tgb-confirm', 'SEND');
s = await state(p);
check('channels ticked, not live: "Our Telegram channels are not live…"', [s.disabled, s.reason], [true, 'Our Telegram channels are not live, so nothing can be posted there.']);
await p.uncheck('#tgb-t-channels');
await p.check('#tgb-t-followers');
s = await state(p);
check('followers ticked, 0 followers: "No race-alert followers…"', [s.disabled, s.reason], [true, 'No race-alert followers are linked to Telegram, so there is nobody to message.']);
await ctx.close();
S.followers = 3; S.live = true; S.running = true;
({ p, ctx } = await open());
await type(p, '#tgb-text-en', 'Hi');
await p.fill('#tgb-confirm', 'SEND');
s = await state(p);
check('a broadcast running: "A send is already running."', [s.disabled, s.reason], [true, 'A send is already running.']);
await ctx.close();
S.running = false;

console.log('\n=== the fixed notice says why too ===');
S.eligible = 0;
({ p, ctx } = await open());
let n = await p.evaluate(() => ({ r: document.getElementById('tgn-reason').textContent, d: document.getElementById('tgn-send').disabled }));
check('0 waiting: disabled, "Nobody is waiting for this notice."', n, { r: 'Nobody is waiting for this notice.', d: true });
await ctx.close();
S.eligible = 3;
({ p, ctx } = await open());
n = await p.evaluate(() => ({ r: document.getElementById('tgn-reason').textContent, d: document.getElementById('tgn-send').disabled }));
check('CONTROL 3 waiting: the reason moves on to "Type SEND…"', n, { r: 'Type SEND in the box to confirm.', d: true });
await p.fill('#tgn-confirm', 'SEND');
n = await p.evaluate(() => ({ r: document.getElementById('tgn-reason').textContent, d: document.getElementById('tgn-send').disabled }));
check('CONTROL SEND typed: enabled, no reason', n, { r: '', d: false });
await ctx.close();
S.live = false;
({ p, ctx } = await open());
n = await p.evaluate(() => document.getElementById('tgn-reason').textContent);
check('channels not live: "Channel alerts are not live…"', n, 'Channel alerts are not live, so the notice cannot be sent.');
await ctx.close();
S.live = true;

console.log('\n=== a phone ===');
({ p, ctx } = await open(375));
await type(p, '#tgb-text-en', 'A long first line that keeps going and going so it has to wrap on a phone screen');
const ph = await p.evaluate(() => {
  const ta = document.getElementById('tgb-text-en').getBoundingClientRect();
  return { pageW: document.scrollingElement.scrollWidth, vw: innerWidth, taRight: Math.round(ta.right), taW: Math.round(ta.width) };
});
check('no sideways scroll; the box fits and stays wide', ph, (x) => x.pageW <= x.vw && x.taRight <= x.vw && x.taW >= 280);
await p.evaluate(() => document.getElementById('tgb-wrap').scrollIntoView());
await p.screenshot({ path: `${OUT}/tg-broadcast-phone.png`, fullPage: false });
await ctx.close();
({ p, ctx } = await open());
await type(p, '#tgb-text-en', 'Polls open at 8am.\nStay for the count.');
await p.evaluate(() => document.getElementById('tgb-wrap').scrollIntoView());
await p.screenshot({ path: `${OUT}/tg-broadcast-desktop.png`, fullPage: false });
await ctx.close();

check('the notice was never sent from these checks', sends.filter((x) => x.u.endsWith('/tg-notice/send')).length, 0);
await b.close(); server.close();
console.log(fail ? `\n${fail} FAILED` : '\nAll passed');
process.exit(fail ? 1 : 0);

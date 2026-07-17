// Hawkeye how-to video generator. Same proven pipeline as record_demo.mjs
// (Playwright records a self-contained 1080x1920 HTML clip -> ffmpeg H.264 MP4
// with a silent AAC track for TikTok/Meta). Each clip shares ONE brand engine so
// the whole set is visually consistent with the "Osun Decides" promo, and drives
// a faithful LIGHT-THEME phone mockup of the REAL app screens for each flow.
//
// Palette pulled from the live app + promo:
//   stage  #00251a -> #0a4632 (promo dark green),  accent #6fe3a5 (promo mint)
//   app screens (light gov theme): bg #f7f8f6, card #fff, header #00482b,
//   button #008751, mint #2ee59d, gold #f5c518, ink #14201a, muted #5b6b62
//
// Run from ~/hawkeye/audit so node_modules (playwright + ffmpeg-static) resolves:
//   node render_howto.mjs            # all clips
//   node render_howto.mjs signup     # one clip by slug
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const FFMPEG = path.join(__dir, 'node_modules', 'ffmpeg-static', 'ffmpeg');
const OUTDIR = path.join(__dir, 'howto', 'out');
const DL = '/mnt/c/Users/HP/Downloads';
fs.mkdirSync(OUTDIR, { recursive: true });

const LOGO = fs.readFileSync(path.join(ROOT, 'app', 'logo.svg')).toString('base64');
const LOGO_URI = `data:image/svg+xml;base64,${LOGO}`;

// Inline SVG icons — headless Chromium has no colour-emoji font, so 🦅📍⭐🔒✓
// render as tofu. These currentColor SVGs are crisp at any size and faithful.
const SVG = (p, o = {}) => `<svg class="ic" viewBox="0 0 24 24" width="1em" height="1em"${o.fill === false ? '' : ''}>${p}</svg>`;
const IC_PIN = SVG('<path d="M12 2c-3.9 0-7 3.1-7 7 0 5 7 13 7 13s7-8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" fill="currentColor"/>');
const IC_STAR = SVG('<path d="M12 2l2.9 6.3 6.9.7-5.1 4.6 1.4 6.8L12 17.8 5 20.4l1.4-6.8L1.3 9l6.9-.7z" fill="currentColor"/>');
const IC_CHECK = SVG('<path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>');
const IC_LOCK = SVG('<path d="M6 10V8a6 6 0 1112 0v2h1a1 1 0 011 1v9a1 1 0 01-1 1H5a1 1 0 01-1-1v-9a1 1 0 011-1zm2 0h8V8a4 4 0 10-8 0z" fill="currentColor"/>');
const IC_BELL = SVG('<path d="M12 2a7 7 0 00-7 7v4l-1.7 3.4a1 1 0 00.9 1.6h15.6a1 1 0 00.9-1.6L19 13V9a7 7 0 00-7-7zm-2.5 17a2.5 2.5 0 005 0z" fill="currentColor"/>');

// ---- app-screen mockup builders (faithful, simplified live screens) ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const hd = (sub) =>
  `<div class="ph-hd"><img class="ph-crest" src="${LOGO_URI}" alt=""><div class="ph-hdt"><b>HAWKEYE</b><span>${esc(sub)}</span></div><span class="ph-menu">&#9776;</span></div>`;
const scr = (sub, body) => `<div class="ph-screen">${hd(sub)}<div class="ph-body">${body}</div></div>`;
const h1 = (t) => `<div class="ph-h1">${esc(t)}</div>`;
const lede = (t) => `<div class="ph-lede">${esc(t)}</div>`;
const card = (inner, cls = '') => `<div class="ph-card ${cls}">${inner}</div>`;
const label = (t) => `<div class="ph-label">${esc(t)}</div>`;
const input = (ph, val = '') =>
  `<div class="ph-input${val ? ' filled' : ''}">${esc(val || ph)}</div>`;
const btn = (t, o = {}) =>
  `<button class="ph-btn${o.gold ? ' gold' : ''}${o.ghost ? ' ghost' : ''}${o.tap ? ' tapping' : ''}">${o.icon ? o.icon + ' ' : ''}${esc(t)}</button>`;
const otp = (digits) =>
  `<div class="ph-otp">${digits.replace(/\s/g, '').split('').map((d) => `<span${d === '_' ? '' : ' class="f"'}>${d === '_' ? '' : d}</span>`).join('')}</div>`;
const pu = (name, dist, sel = false) =>
  `<div class="ph-pu${sel ? ' sel' : ''}"><div><b>${esc(name)}</b><span>${esc(dist)}</span></div><span class="chev">›</span></div>`;
const select = (val, tap = false) =>
  `<div class="ph-sel${tap ? ' tapping' : ''}">${esc(val)}<span class="chev">▾</span></div>`;
const ok = (t, sub = '') =>
  `<div class="ph-ok"><span class="ph-okmark"></span><b>${esc(t)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
const cam = (docLabel, tap = false) =>
  `<div class="ph-cam"><div class="ph-scanbox"><span>${esc(docLabel)}</span></div><div class="ph-gps">${IC_PIN} GPS locked · ±6m</div><div class="ph-shutter${tap ? ' tapping' : ''}"></div></div>`;
const results = (rows) =>
  `<div class="ph-res">${rows.map(([p, n]) => `<div class="ph-resrow"><span class="ph-dot"></span><b>${esc(p)}</b><i></i><span class="ph-num">${esc(n)}</span></div>`).join('')}</div>`;
const chain = (rows) =>
  `<div class="ph-chain">${rows.map((r, i) => `<div class="ph-block"><span class="ph-bh">${esc(r)}</span><span class="ph-bok"></span></div>${i < rows.length - 1 ? '<div class="ph-link"></div>' : ''}`).join('')}</div>`;
const textarea = (t) => `<div class="ph-ta">${esc(t)}<span class="ph-caret"></span></div>`;
const photoTile = (tap = false) =>
  `<div class="ph-phototile${tap ? ' tapping' : ''}"><span class="ph-plus">+</span>Add Photo/Video <small>(optional)</small></div>`;
const miniMap = (pinLabel) =>
  `<div class="ph-map"><div class="ph-mgrid"></div><div class="ph-pin"><span class="ph-pinico">${IC_PIN}</span><span class="ph-pinlbl">${esc(pinLabel)}</span></div></div>`;
const tgAlert = (msgs) =>
  `<div class="ph-tg">${msgs.map((m) => `<div class="ph-tgmsg"><b>Hawkeye</b><span>${esc(m)}</span></div>`).join('')}</div>`;
const warn = (t) => `<div class="ph-warn">${esc(t)}</div>`;

// ---- the five clips ----------------------------------------------------------
const CLIPS = [
  {
    slug: 'signup',
    title: 'How to Sign Up',
    kicker: 'GET VERIFIED IN UNDER A MINUTE',
    steps: [
      { cap: 'Open Hawkeye and enter your Nigerian mobile number, then tap Request OTP.',
        screen: scr('Register your device', h1('Register your device') + lede('One verified phone number equals one observer identity.') + card(label('Nigerian mobile number') + input('e.g. 0803 123 4567', '0803 123 4567') + btn('Request OTP', { tap: true }))) },
      { cap: 'Get your one-time code on Telegram and type it in.',
        screen: scr('Verify', h1('Enter your code') + lede('We sent a 6-digit code to your Telegram.') + card(otp('4 9 2 7 1 _') + btn('Verify & continue', { tap: true }))) },
      { cap: 'Optional: add a password to sign in later without a code.',
        screen: scr('Register', h1('Faster sign-in') + card(`<label class="ph-check on"><span class="ph-box">${IC_CHECK}</span><span>Also create a password <small>(optional)</small></span></label>` + input('Choose a password (min 8)', '••••••••') + btn('Save', { tap: true }))) },
      { cap: 'Done. One device, one identity — your number is kept only as a one-way hash.',
        screen: scr('Verified', ok('Device verified', 'You can now report from this phone.') + card(`<div class="ph-fine">${IC_LOCK} Your number is stored as a one-way hash — never readable, never published.</div>`)) },
    ],
  },
  {
    slug: 'report-result',
    title: 'How to Report a Result',
    kicker: 'WITNESS YOUR POLLING UNIT',
    steps: [
      { cap: 'Find your polling unit — you must be standing at it.',
        screen: scr('Find your unit', h1('Find your polling unit') + card(btn('Find polling units near me', { tap: true })) + pu('PU 007 · Ward 04', '38 m away', true) + pu('PU 012 · Ward 04', '210 m away')) },
      { cap: 'Choose the election you are reporting.',
        screen: scr('Report a Result', h1('PU 007 · Ward 04') + card(label('Election being reported') + select('Osun Governorship', true)) + `<div class="ph-fine">One report per election — each needs its own photos.</div>`) },
      { cap: 'Photograph the announced EC8A results sheet — the scanner outlines it.',
        screen: scr('Evidence 1 of 2', h1('Photograph the EC8A sheet') + cam('EC8A', true) + `<div class="ph-fine">Live photo only — no gallery uploads, no screenshots.</div>`) },
      { cap: 'Photograph the polling unit / venue. Each photo is GPS-stamped.',
        screen: scr('Evidence 2 of 2', h1('Photograph the venue') + cam('VENUE', true)) },
      { cap: 'Check the counts read from the sheet match what was announced.',
        screen: scr('Confirm counts', h1('Confirm the figures') + card(results([['Party A', '320'], ['Party B', '215'], ['Party C', '96'], ['Party D', '41']])) + `<div class="ph-fine">Placeholder parties shown — figures come from your sheet.</div>`) },
      { cap: 'Sign & submit — it’s chained to the public ledger.',
        screen: scr('Sign & submit', h1('Sign on your device') + card(`<div class="ph-fine">Counts, photo fingerprints and location are signed with a key that never leaves your phone — then chained onto a public ledger, permanently.</div>` + btn('Sign & submit report', { tap: true }))) },
      { cap: 'Verified when others at your unit report matching counts.',
        screen: scr('Done', ok('Report recorded', 'Chained to the public ledger.') + card(`<div class="ph-fine">Marked <b>verified</b> once separate observers at your unit report matching figures.</div>`)) },
    ],
  },
  {
    slug: 'report-collation',
    title: 'How to Report a Collation Result',
    kicker: 'CHECK THE COUNT ON ITS WAY UP',
    steps: [
      { cap: 'At a ward, LGA or state collation centre? Pick the level and election.',
        screen: scr('Report a Collation Result', h1('Report a Collation Result') + card(label('Collation level') + select('Ward — form EC8B', true) + label('Election') + select('Osun Governorship')) + `<div class="ph-fine">Verified device required — sign up in Hawkeye first.</div>`) },
      { cap: 'Photograph the announced collation form — live and location-stamped.',
        screen: scr('Evidence 1 of 2', h1('Photograph the form') + cam('EC8B', true) + `<div class="ph-fine">Live photo only — auto-scanned the moment it is taken.</div>`) },
      { cap: 'Photograph the collation centre itself.',
        screen: scr('Evidence 2 of 2', h1('Photograph the centre') + cam('VENUE', true)) },
      { cap: 'Enter the announced totals from the form.',
        screen: scr('Announced totals', h1('Enter the totals') + card(results([['Party A', '8,320'], ['Party B', '6,914'], ['Party C', '2,107'], ['Party D', '988']])) + `<div class="ph-fine">Placeholder parties shown. Unofficial — INEC declares the official result.</div>`) },
      { cap: 'Sign & submit — recorded permanently, like every report.',
        screen: scr('Sign & submit', h1('Sign on your device') + card(`<div class="ph-fine">Signed on this device and reconciled against the polling-unit sheets underneath.</div>` + btn('Sign & submit collation report', { tap: true }))) },
      { cap: 'Totals that shrink on the way up get flagged — publicly.',
        screen: scr('Reconciled', ok('Report recorded', 'Checked against polling-unit evidence.') + warn('Ward total below the sum of its unit reports — flagged for public review.')) },
    ],
  },
  {
    slug: 'report-incident',
    title: 'How to Report an Incident',
    kicker: 'FLAG WHAT YOU SEE',
    steps: [
      { cap: 'Open “Report an Incident” from the menu.',
        screen: scr('Report an Incident', h1('Report an Incident') + lede('Saw violence, vote-buying, suppression or a technical failure? Put it on record.')) },
      { cap: 'Describe what happened — where, when, who was involved.',
        screen: scr('Report an Incident', h1('Describe the incident') + card(textarea('Voting delayed 2 hrs at PU 007 — BVAS device not working, INEC official absent…'))) },
      { cap: 'Add a photo or video if you have one, then submit.',
        screen: scr('Report an Incident', photoTile() + btn('Submit incident report', { tap: true })) },
      { cap: 'Your report joins the public incidents log for everyone to see.',
        screen: scr('Published incidents', ok('Incident published') + pu('Ward 04 · BVAS failure', 'just now') + pu('Ward 09 · Vote-buying', '12 min ago')) },
    ],
  },
  {
    slug: 'map-unit',
    title: 'How to Map a Polling Unit',
    kicker: 'PIN YOUR UNIT BEFORE ELECTION DAY',
    steps: [
      { cap: 'Open “Map a Polling Unit”. Most units have no verified GPS yet.',
        screen: scr('Map a Polling Unit', h1('Polling unit map & locator') + card(input('Search a ward or LGA…') + btn('Find', { ghost: true }))) },
      { cap: 'Find your unit — search, or tap “Near me”.',
        screen: scr('Map a Polling Unit', card(input('Osogbo, Ward 04') + btn('Near me', { tap: true, icon: IC_PIN })) + pu('PU 007 · Ward 04', 'location unverified', true)) },
      { cap: 'Stand at the polling unit itself.',
        screen: scr('PU 007 · Ward 04', miniMap('You are here') + `<div class="ph-fine">Accuracy improves the longer you stand still.</div>`) },
      { cap: 'Tap “Capture GPS at this unit”.',
        screen: scr('PU 007 · Ward 04', miniMap('PU 007') + card(`<div class="ph-gpsread">${IC_PIN} 7.771°N, 4.556°E · ±4m</div>` + btn('Capture GPS at this unit', { tap: true, icon: IC_PIN }))) },
      { cap: 'Save it — the location is locked in for every future observer.',
        screen: scr('PU 007 · Ward 04', card(btn('Save as my polling unit', { gold: true, tap: true, icon: IC_STAR })) + ok('Location captured', 'Now geofenced — reports must come from here.')) },
    ],
  },
  {
    slug: 'verify-result',
    title: 'How to Verify a Result',
    kicker: 'DON’T TRUST — CHECK',
    steps: [
      { cap: 'Open “Verify the Ledger”. No account needed — anyone can check.',
        screen: scr('Verify the Ledger', h1('Public transparency log') + pu('Report #12480 · PU 007', 'signed 14:22') + pu('Report #12479 · PU 013', 'signed 14:21') + pu('Report #12478 · PU 004', 'signed 14:20')) },
      { cap: 'Every report is hash-chained to a public transparency log.',
        screen: scr('Verify the Ledger', h1('One unbroken chain') + chain(['#12480 · a4f9…', '#12479 · 7c1b…', '#12478 · e0d2…'])) },
      { cap: 'Re-check the whole chain yourself, right in your browser.',
        screen: scr('Verify the Ledger', h1('Recompute the chain') + card(`<div class="ph-fine">Hashes are recomputed locally and matched against the public anchor.</div>` + btn('Verify chain', { tap: true }))) },
      { cap: 'Chain intact. If a single record changed, it would break — visibly.',
        screen: scr('Verify the Ledger', ok('Chain intact', '12,480 records checked · anchored to a public log') + `<div class="ph-fine">Tamper with any record and the maths stops adding up.</div>`) },
    ],
  },
  {
    slug: 'follow-race',
    title: 'How to Follow a Race',
    kicker: 'LIVE REPORTS · TELEGRAM ALERTS',
    steps: [
      { cap: 'Open the National Leaderboard — it builds live as reports come in.',
        screen: scr('National Leaderboard', h1('National Leaderboard') + card(results([['Party A', '41,203'], ['Party B', '33,881'], ['Party C', '12,406']])) + `<div class="ph-fine">Placeholder parties shown. Unofficial — INEC declares the official result.</div>`) },
      { cap: 'Pick the election and the area you care about.',
        screen: scr('National Leaderboard', h1('Choose your race') + card(label('Election') + select('Osun Governorship', true) + label('Area') + select('Osun'))) },
      { cap: 'Tap Follow — verify your phone once, then get Telegram alerts.',
        screen: scr('National Leaderboard', card(btn('Follow', { tap: true, icon: IC_BELL })) + ok('Following Osun', "You'll get a Telegram message on every new report.")) },
      { cap: 'Every new report lands in your Telegram, instantly.',
        screen: scr('Alerts', h1('Straight to Telegram') + tgAlert(['New report — PU 007, Ward 04 · Osun Governorship.', 'New report — PU 019, Ward 02 · Osun Governorship.'])) },
    ],
  },
];

// ---- timing ------------------------------------------------------------------
// Pacing: 3.7s/step (was 2.7 — too fast to read a 12-word caption + screen).
const INTRO = 2, STEP = 3.7, OUTRO = 3.7;
const totalOf = (c) => INTRO + c.steps.length * STEP + OUTRO;

// ---- HTML engine (shared brand system) --------------------------------------
function clipHTML(c) {
  const N = c.steps.length;
  const total = totalOf(c);
  // Long titles ("…Report a Collation Result") shrink so the step header stays
  // one line above the phone and the intro doesn't overflow its padding.
  const tSize = c.title.length > 26 ? 46 : 60;
  const iSize = c.title.length > 26 ? 78 : 104;
  const scrLayers = c.steps.map((s, i) => `<div class="scr" data-i="${i}"><div class="phone"><div class="phone-notch"></div>${s.screen}</div></div>`).join('');
  const capLayers = c.steps.map((s, i) => `<div class="cap" data-i="${i}">${esc(s.cap)}</div>`).join('');
  const ctrLayers = c.steps.map((_, i) => `<div class="ctr" data-i="${i}">STEP ${i + 1} <b>/ ${N}</b></div>`).join('');
  const timeline = [{ k: 'intro', d: INTRO }, ...c.steps.map((_, i) => ({ k: 'step', i, d: STEP })), { k: 'outro', d: OUTRO }];
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box;-webkit-font-smoothing:antialiased}
  html,body{width:1080px;height:1920px;overflow:hidden;background:#00251a;
    font-family:'Helvetica Neue',Arial,sans-serif;color:#fff}
  .stage{position:relative;width:1080px;height:1920px;
    background:radial-gradient(120% 80% at 50% 0%,#0a4632 0%,#00251a 62%)}
  /* brand header */
  .brand{position:absolute;top:64px;left:0;right:0;display:flex;gap:22px;align-items:center;justify-content:center}
  .brand img{width:84px;height:84px}
  .brand .wm{font-size:52px;font-weight:800;letter-spacing:4px}
  .brand .wm b{display:block;font-size:52px;line-height:1}
  .brand .wm span{display:block;font-size:22px;font-weight:700;letter-spacing:3px;color:#6fe3a5;margin-top:4px}
  .title{position:absolute;top:196px;left:60px;right:60px;text-align:center;font-size:60px;font-weight:800;line-height:1.1}
  .title .g{color:#6fe3a5}
  /* phone */
  .stepstage{position:absolute;inset:0;opacity:0;transition:opacity .4s}
  .stepstage.on{opacity:1}
  .scr{position:absolute;top:300px;left:0;right:0;display:flex;justify-content:center;opacity:0;transform:translateY(24px) scale(.985);transition:opacity .45s,transform .45s}
  .scr.on{opacity:1;transform:none}
  .phone{position:relative;width:560px;height:1064px;background:#0b1712;border-radius:60px;
    border:12px solid #14261c;box-shadow:0 40px 90px rgba(0,0,0,.55),inset 0 0 0 2px #04100a;overflow:hidden}
  .phone-notch{position:absolute;top:0;left:50%;transform:translateX(-50%);width:180px;height:34px;background:#14261c;border-radius:0 0 22px 22px;z-index:5}
  .ph-screen{position:absolute;inset:0;background:#f7f8f6;display:flex;flex-direction:column;color:#14201a}
  .ph-hd{background:#00482b;color:#fff;padding:52px 30px 20px;display:flex;align-items:center;gap:14px}
  .ph-crest{width:40px;height:40px;object-fit:contain;flex:none}
  .ic{vertical-align:-0.14em}
  .ph-box{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:#008751;color:#fff;border-radius:7px;font-size:20px;vertical-align:-9px;flex:none}
  .ph-pinico{color:#d4351c;font-size:52px;line-height:1}
  .ph-hdt b{font-size:28px;font-weight:800;letter-spacing:1px;display:block;line-height:1}
  .ph-hdt span{font-size:17px;color:#9fd3b6;display:block;margin-top:3px}
  .ph-menu{margin-left:auto;font-size:34px;color:#cfe6d9}
  .ph-body{padding:30px 30px;display:flex;flex-direction:column;gap:22px;overflow:hidden}
  .ph-h1{font-size:38px;font-weight:800;line-height:1.12}
  .ph-lede{font-size:24px;color:#5b6b62;line-height:1.35;margin-top:-6px}
  .ph-card{background:#fff;border:2px solid #dde4de;border-radius:20px;padding:26px;display:flex;flex-direction:column;gap:20px}
  .ph-label{font-size:22px;font-weight:700;color:#14201a}
  .ph-input{border:2px solid #b9c4bd;border-radius:14px;padding:22px 22px;font-size:26px;color:#8a978f;background:#fff}
  .ph-input.filled{color:#14201a;font-weight:600}
  .ph-btn{background:#008751;color:#fff;border:none;border-radius:999px;padding:24px 28px;font-size:28px;font-weight:800;text-align:center;position:relative}
  .ph-btn.gold{background:#f5c518;color:#3a2c00}
  .ph-btn.ghost{background:#eef5f0;color:#0a6b40;border:2px solid #cfe6d9}
  .ph-otp{display:flex;gap:12px;justify-content:space-between}
  .ph-otp span{flex:1;height:78px;border:2px solid #b9c4bd;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:800;color:#14201a}
  .ph-otp span.f{border-color:#008751;background:#e8f5ee}
  .ph-check{font-size:24px;font-weight:700;color:#14201a;display:flex;align-items:center;gap:12px}
  .ph-check small{color:#5b6b62;font-weight:400}
  .ph-fine{font-size:21px;line-height:1.4;color:#5b6b62}
  .ph-pu{background:#fff;border:2px solid #dde4de;border-radius:18px;padding:22px 24px;display:flex;align-items:center;justify-content:space-between}
  .ph-pu.sel{border-color:#008751;background:#e8f5ee}
  .ph-pu b{font-size:26px;font-weight:800;display:block}
  .ph-pu span{font-size:21px;color:#5b6b62}
  .ph-pu .chev{font-size:34px;color:#8a978f}
  .ph-sel{border:2px solid #b9c4bd;border-radius:14px;padding:22px 24px;font-size:28px;font-weight:700;display:flex;align-items:center;justify-content:space-between;background:#fff}
  .ph-sel .chev{color:#5b6b62}
  .ph-ok{background:#e8f5ee;border:2px solid #96d7b4;border-radius:20px;padding:30px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
  .ph-okmark{width:78px;height:78px;border-radius:50%;background:#008751;display:flex;align-items:center;justify-content:center}
  .ph-okmark::after{content:"";width:20px;height:38px;border:solid #fff;border-width:0 8px 8px 0;transform:rotate(45deg);margin-top:-6px}
  .ph-ok b{font-size:32px;font-weight:800;color:#00482b}
  .ph-ok span{font-size:22px;color:#3d6b52}
  .ph-cam{background:#0c0f0d;border-radius:20px;height:420px;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .ph-scanbox{width:74%;height:66%;border:4px dashed #6fe3a5;border-radius:12px;display:flex;align-items:flex-start;justify-content:flex-start}
  .ph-scanbox span{background:#6fe3a5;color:#04100a;font-size:20px;font-weight:800;padding:4px 12px;border-radius:0 0 10px 0}
  .ph-gps{position:absolute;top:18px;right:18px;background:rgba(0,0,0,.55);color:#6fe3a5;font-size:18px;padding:6px 12px;border-radius:999px}
  .ph-shutter{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);width:82px;height:82px;border-radius:50%;background:#fff;border:6px solid rgba(255,255,255,.5)}
  .ph-res{display:flex;flex-direction:column;gap:0}
  .ph-resrow{display:flex;align-items:center;gap:14px;padding:18px 4px;border-bottom:2px solid #eef2ef;font-size:26px}
  .ph-resrow:last-child{border-bottom:none}
  .ph-dot{width:20px;height:20px;border-radius:50%;background:#008751;flex:none}
  .ph-resrow b{font-weight:700}
  .ph-resrow i{flex:1;border-bottom:2px dotted #cfd8d1;height:1px}
  .ph-num{font-weight:800;font-variant-numeric:tabular-nums}
  .ph-chain{display:flex;flex-direction:column;align-items:center;gap:0;padding:6px 0}
  .ph-block{width:100%;background:#fff;border:2px solid #96d7b4;border-radius:16px;padding:22px 24px;display:flex;align-items:center;justify-content:space-between;font-size:24px;font-weight:700}
  .ph-bh{font-family:'Courier New',monospace;color:#0a6b40}
  .ph-bok{width:44px;height:44px;border-radius:50%;background:#008751;display:flex;align-items:center;justify-content:center;flex:none}
  .ph-bok::after{content:"";width:11px;height:20px;border:solid #fff;border-width:0 4px 4px 0;transform:rotate(45deg);margin-top:-3px}
  .ph-link{width:4px;height:26px;background:#96d7b4}
  .ph-ta{border:2px solid #b9c4bd;border-radius:14px;padding:22px;font-size:24px;line-height:1.4;color:#14201a;min-height:200px;position:relative}
  .ph-caret{display:inline-block;width:3px;height:28px;background:#008751;vertical-align:middle;margin-left:2px;animation:blink 1s steps(1) infinite}
  @keyframes blink{50%{opacity:0}}
  .ph-phototile{border:3px dashed #b9c4bd;border-radius:18px;padding:40px;text-align:center;font-size:26px;font-weight:700;color:#5b6b62;display:flex;flex-direction:column;align-items:center;gap:8px}
  .ph-phototile span{font-size:52px;color:#8a978f}
  .ph-phototile small{font-weight:400}
  .ph-map{background:#e9efe9;border-radius:20px;height:360px;position:relative;overflow:hidden}
  .ph-mgrid{position:absolute;inset:0;background:
    linear-gradient(#dbe6dc 2px,transparent 2px) 0 0/100% 60px,
    linear-gradient(90deg,#dbe6dc 2px,transparent 2px) 0 0/60px 100%}
  .ph-pin{position:absolute;top:42%;left:50%;transform:translate(-50%,-50%);text-align:center;display:flex;flex-direction:column;align-items:center}
  .ph-pin .ph-pinico{display:block}
  .ph-pin .ph-pinlbl{display:block;font-size:20px;font-weight:800;color:#00482b;background:#fff;padding:4px 12px;border-radius:999px;margin-top:6px;box-shadow:0 6px 16px rgba(0,0,0,.15)}
  .ph-gpsread{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;color:#00482b;text-align:center}
  .ph-tg{display:flex;flex-direction:column;gap:16px}
  .ph-tgmsg{background:#eef7ff;border:2px solid #b9d7f0;border-radius:6px 20px 20px 20px;padding:20px 22px;font-size:23px;line-height:1.35;color:#14201a}
  .ph-tgmsg b{display:block;color:#0a6b9f;font-size:21px;margin-bottom:5px}
  .ph-warn{background:#fbeaea;border:2px solid #d4351c;border-radius:18px;padding:22px 24px;font-size:23px;line-height:1.35;font-weight:700;color:#b3261e}
  /* tap ripple on any .tapping control */
  .tapping::after{content:"";position:absolute;top:50%;left:50%;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;border:5px solid #2ee59d;opacity:0;animation:tap 2.7s ease-out infinite}
  .ph-shutter.tapping::after{border-color:#fff}
  @keyframes tap{0%{transform:scale(.35);opacity:.9}45%{transform:scale(1);opacity:0}100%{opacity:0}}
  /* caption + counter */
  .ctr-wrap{position:absolute;top:1418px;left:0;right:0;text-align:center;height:60px}
  .ctr{position:absolute;left:0;right:0;opacity:0;transition:opacity .4s;display:inline-flex}
  .ctr.on{opacity:1}
  .ctr{justify-content:center}
  .ctr{font-size:0}
  .ctr-pill{}
  .ctr{color:#04100a}
  .ctr{}
  .ctr>i{display:none}
  .ctr{font-size:28px}
  .ctr{font-weight:800;letter-spacing:2px}
  .ctr{}
  .ctr{color:#6fe3a5}
  .ctr b{color:#7f9c8c;font-weight:800}
  .cap-wrap{position:absolute;top:1492px;left:90px;right:90px;height:280px;text-align:center}
  .cap{position:absolute;left:0;right:0;opacity:0;transform:translateY(12px);transition:opacity .45s,transform .45s;font-size:40px;font-weight:700;line-height:1.32;color:#eafff4}
  .cap.on{opacity:1;transform:none}
  /* intro + outro overlays */
  .over{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;opacity:0;transition:opacity .5s;background:radial-gradient(120% 80% at 50% 30%,#0a4632 0%,#00251a 62%)}
  .over.on{opacity:1}
  .intro img{width:210px;height:210px;margin-bottom:20px}
  .intro .kick{font-size:30px;font-weight:800;letter-spacing:4px;color:#6fe3a5;margin-bottom:26px}
  .intro .t{font-size:104px;font-weight:800;line-height:1.04;padding:0 70px}
  .intro .t .g{color:#6fe3a5}
  .outro .t{font-size:72px;font-weight:800;line-height:1.1;padding:0 80px}
  .outro .t .g{color:#6fe3a5}
  .outro .cta{margin-top:44px;display:inline-flex;align-items:center;gap:18px;background:rgba(111,227,165,.14);border:3px solid #6fe3a5;color:#6fe3a5;padding:26px 44px;border-radius:999px;font-size:46px;font-weight:800}
  .outro .cta .dot{width:22px;height:22px;border-radius:50%;background:#6fe3a5}
  .outro .disc{position:absolute;bottom:150px;left:80px;right:80px;font-size:26px;color:#9fd3b6;line-height:1.4}
  /* footer + progress */
  .foot{position:absolute;bottom:70px;left:0;right:0;text-align:center;font-size:34px;font-weight:800;color:#cfe6d9;letter-spacing:1px}
  .bar{position:absolute;bottom:0;left:0;height:12px;background:#6fe3a5;width:0}
  .bar.run{animation:fill ${total}s linear forwards}
  @keyframes fill{to{width:1080px}}
  </style></head><body>
  <div class="stage">
    <!-- steps -->
    <div class="stepstage" id="stepstage">
      <div class="brand"><img src="${LOGO_URI}"><div class="wm"><b>HAWKEYE</b><span>HOW-TO</span></div></div>
      <div class="title" style="font-size:${tSize}px">${c.title.replace(/^How to /, 'How to <span class="g">') + '</span>'}</div>
      <div class="scr-wrap">${scrLayers}</div>
      <div class="ctr-wrap">${ctrLayers}</div>
      <div class="cap-wrap">${capLayers}</div>
      <div class="foot">hawkeye.com.ng</div>
    </div>
    <!-- intro -->
    <div class="over intro" id="intro"><img src="${LOGO_URI}"><div class="kick">${esc(c.kicker)}</div>
      <div class="t" style="font-size:${iSize}px">${c.title.replace(/^How to /, 'How to<br><span class="g">') + '</span>'}</div></div>
    <!-- outro -->
    <div class="over outro" id="outro">
      <div class="t">Every phone<br>a <span class="g">witness.</span></div>
      <div class="cta"><span class="dot"></span>hawkeye.com.ng</div>
      <div class="disc">Beta · Independent · Nonpartisan. Hawkeye reports are unofficial — INEC declares the official result.</div>
    </div>
    <div class="bar" id="bar"></div>
  </div>
  <script>
    const TL = ${JSON.stringify(timeline)};
    const intro = document.getElementById('intro'), outro = document.getElementById('outro'),
      step = document.getElementById('stepstage'), bar = document.getElementById('bar');
    const scrs = [...document.querySelectorAll('.scr')], caps = [...document.querySelectorAll('.cap')], ctrs = [...document.querySelectorAll('.ctr')];
    bar.classList.add('run');
    let idx = 0;
    function show(f) {
      intro.classList.toggle('on', f.k === 'intro');
      outro.classList.toggle('on', f.k === 'outro');
      step.classList.toggle('on', f.k === 'step');
      if (f.k === 'step') { scrs.forEach((e,j)=>e.classList.toggle('on', j===f.i)); caps.forEach((e,j)=>e.classList.toggle('on', j===f.i)); ctrs.forEach((e,j)=>e.classList.toggle('on', j===f.i)); }
    }
    function run() { show(TL[idx]); const d = TL[idx].d * 1000; idx++; if (idx < TL.length) setTimeout(run, d); }
    run();
  </script>
  </body></html>`;
}

// ---- render loop -------------------------------------------------------------
const want = process.argv[2];
const jobs = CLIPS.filter((c) => !want || c.slug === want);
if (!jobs.length) { console.error('no clip matches', want); process.exit(1); }

// Playwright's recording starts before the page's first paint, leaving a white
// head of a few frames. Measure it (first frame darker than YAVG 100 — the
// stage bg is near-black green) and trim it in the mp4 conversion.
function whiteHead(webm) {
  const meta = '/tmp/howto_ss_meta.txt';
  execFileSync(FFMPEG, ['-y', '-i', webm, '-t', '3', '-vf', `signalstats,metadata=print:file=${meta}`, '-f', 'null', '-'], { stdio: 'ignore' });
  // Each frame prints a pts_time line followed by a BLOCK of stat lines
  // (YMIN, YLOW, YAVG, ...) — pair YAVG with the last-seen pts_time.
  const lines = fs.readFileSync(meta, 'utf8').split('\n');
  let cur = 0;
  for (const line of lines) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) { cur = parseFloat(m[1]); continue; }
    const y = line.match(/YAVG=([\d.]+)/);
    if (y && parseFloat(y[1]) < 100) return cur;
  }
  return 0; // never went dark (shouldn't happen) — trim nothing
}

const b = await chromium.launch();
for (const c of jobs) {
  const total = totalOf(c);
  const htmlPath = path.join(OUTDIR, `${c.slug}.html`);
  fs.writeFileSync(htmlPath, clipHTML(c));
  const ctx = await b.newContext({ viewport: { width: 1080, height: 1920 }, recordVideo: { dir: OUTDIR, size: { width: 1080, height: 1920 } } });
  const p = await ctx.newPage();
  await p.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
  await p.waitForTimeout((total + 0.4) * 1000);
  await ctx.close();
  const webm = fs.readdirSync(OUTDIR).filter((f) => f.endsWith('.webm')).map((f) => path.join(OUTDIR, f))
    .sort((a, z) => fs.statSync(z).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const mp4Dl = path.join(DL, `hawkeye-howto-${c.slug}.mp4`);
  const mp4Repo = path.join(OUTDIR, `${c.slug}.mp4`);
  const head = whiteHead(webm);
  execFileSync(FFMPEG, [
    '-y', '-i', webm,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-ss', String(head.toFixed(3)), '-t', String(total.toFixed(2)), '-r', '30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
    mp4Repo,
  ], { stdio: 'ignore' });
  fs.copyFileSync(mp4Repo, mp4Dl);
  // poster frame ~ first step for QA
  execFileSync(FFMPEG, ['-y', '-ss', String(INTRO + STEP * 0.5), '-i', mp4Repo, '-frames:v', '1', path.join(OUTDIR, `${c.slug}.jpg`)], { stdio: 'ignore' });
  fs.rmSync(webm, { force: true });
  const kb = Math.round(fs.statSync(mp4Repo).size / 1024);
  console.log(`OK ${c.slug}  ${total.toFixed(1)}s  ${kb}KB  -> ${mp4Dl}`);
}
await b.close();
console.log('done', jobs.length, 'clip(s)');

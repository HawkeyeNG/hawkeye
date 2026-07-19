// Build the product-in-a-phone hero composition. Reuses the REAL Hawkeye app
// screens from audit/render_howto.mjs (same builders/CSS) so the phone matches
// the live UI exactly. Writes index.html in this dir. No CSS animations (all
// motion via the GSAP timeline) — HyperFrames determinism.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const LOGO_URI = `data:image/svg+xml;base64,${fs.readFileSync(path.join(__dir, 'assets', 'logo.svg')).toString('base64')}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const SVG = (p) => `<svg class="ic" viewBox="0 0 24 24" width="1em" height="1em">${p}</svg>`;
const IC_PIN = SVG('<path d="M12 2c-3.9 0-7 3.1-7 7 0 5 7 13 7 13s7-8 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z" fill="currentColor"/>');
const hd = (sub) => `<div class="ph-hd"><img class="ph-crest" src="assets/logo.svg" alt=""><div class="ph-hdt"><b>HAWKEYE</b><span>${esc(sub)}</span></div><span class="ph-menu">&#9776;</span></div>`;
const scr = (sub, body) => `<div class="ph-screen">${hd(sub)}<div class="ph-body">${body}</div></div>`;
const h1 = (t) => `<div class="ph-h1">${esc(t)}</div>`;
const lede = (t) => `<div class="ph-lede">${esc(t)}</div>`;
const card = (inner) => `<div class="ph-card">${inner}</div>`;
const label = (t) => `<div class="ph-label">${esc(t)}</div>`;
const input = (ph, val = '') => `<div class="ph-input${val ? ' filled' : ''}">${esc(val || ph)}</div>`;
const btn = (t) => `<button class="ph-btn">${esc(t)}</button>`;
const fine = (t) => `<div class="ph-fine">${esc(t)}</div>`;
const cam = (docLabel) => `<div class="ph-cam"><div class="ph-scanbox"><span>${esc(docLabel)}</span></div><div class="ph-gps">${IC_PIN} GPS locked · ±6m</div><div class="ph-shutter"></div></div>`;
const results = (rows) => `<div class="ph-res">${rows.map(([p, n]) => `<div class="ph-resrow"><span class="ph-dot"></span><b>${esc(p)}</b><i></i><span class="ph-num">${esc(n)}</span></div>`).join('')}</div>`;
const ok = (t, sub) => `<div class="ph-ok"><span class="ph-okmark"></span><b>${esc(t)}</b><span>${esc(sub)}</span></div>`;

const phone = (screenHTML, id) => `<div class="heroPhone" id="${id}"><div class="phone"><div class="phone-notch"></div>${screenHTML}</div></div>`;

// The five real screens
const SCR_LEADER = scr('National Leaderboard', h1('Live results') + card(results([['Party A', '41,203'], ['Party B', '33,881'], ['Party C', '12,406']])) + fine('Placeholder parties. Unofficial — INEC declares the official result.'));
const SCR_EC8A = scr('Evidence 1 of 2', h1('Photograph the EC8A sheet') + cam('EC8A') + fine('Live photo only — no gallery uploads, no screenshots.'));
const SCR_SIGN = scr('Sign & submit', h1('Sign on your device') + card(fine('Counts, photo fingerprints and location are signed with a key that never leaves your phone.') + btn('Sign & submit report')));
const SCR_DONE = scr('Done', ok('Report recorded', 'Chained to the public ledger.') + card(fine('Marked verified once separate observers at your unit report matching figures.')));
const SCR_REG = scr('Register your device', h1('Register your device') + card(label('Nigerian mobile number') + input('e.g. 0803 123 4567', '0803 123 4567') + btn('Request OTP')));

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>Osun Decides — Hawkeye hero (product-in-phone)</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; box-sizing: border-box; }
      body { background: #00140e; font-family: Inter, 'Helvetica Neue', Arial, sans-serif; color: #fff; }
      #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
      #bg { position: absolute; inset: 0; background: #00251a; }
      #bg .grad { position: absolute; inset: 0; background: radial-gradient(120% 80% at 50% 0%, #0a4632 0%, #00251a 60%); }
      #glow { position: absolute; width: 1400px; height: 1400px; left: -160px; top: 360px; border-radius: 50%;
        background: radial-gradient(circle, rgba(111,227,165,0.16) 0%, rgba(111,227,165,0) 62%); will-change: transform; }
      #brand { position: absolute; top: 96px; left: 0; right: 0; text-align: center; }
      #brand img { width: 138px; height: 138px; display: block; margin: 0 auto; }
      #brand .name { font-size: 58px; font-weight: 800; letter-spacing: 4px; margin-top: 6px; }
      #brand .sub { font-size: 25px; color: #9fd3b6; margin-top: 4px; letter-spacing: 1px; }
      .chip { display: inline-flex; align-items: center; gap: 14px; margin-top: 22px; background: rgba(111,227,165,0.14);
        border: 2px solid #6fe3a5; color: #6fe3a5; padding: 13px 30px; border-radius: 999px; font-size: 30px; font-weight: 800; letter-spacing: 2px; }
      .clip { position: absolute; }
      /* text scenes (S1/S3/S5) */
      .scene { left: 90px; right: 90px; top: 620px; height: 900px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; }
      .big { font-size: 96px; font-weight: 800; line-height: 1.1; }
      .big .l { display: block; } .g { color: #6fe3a5; }
      .small { font-size: 38px; color: #cfe6d9; margin-top: 30px; line-height: 1.4; max-width: 880px; }
      /* phone scenes (S2/S4/S6) */
      .heroPhone { position: absolute; top: 448px; left: 50%; width: 560px; height: 1064px; transform: translateX(-50%) scale(0.78); transform-origin: top center; }
      .pscreen { position: absolute; inset: 0; }
      .pcap { position: absolute; top: 1332px; left: 70px; right: 70px; text-align: center; }
      .pcap .w { font-size: 84px; font-weight: 800; line-height: 1.08; }
      .pcap .beat { position: absolute; left: 0; right: 0; top: 0; }
      .pcap .line { font-size: 34px; color: #cfe6d9; margin-top: 18px; line-height: 1.35; }
      .cta-chip { display: inline-flex; align-items: center; gap: 16px; margin-top: 26px; background: rgba(111,227,165,0.16);
        border: 2px solid #6fe3a5; color: #6fe3a5; padding: 18px 38px; border-radius: 999px; font-size: 42px; font-weight: 800; }
      .cta-chip .dot { width: 18px; height: 18px; border-radius: 50%; background: #6fe3a5; display: block; }
      /* phone internals (ported from render_howto.mjs) */
      .phone { position: relative; width: 560px; height: 1064px; background: #0b1712; border-radius: 60px; border: 12px solid #14261c; box-shadow: 0 40px 90px rgba(0,0,0,.55), inset 0 0 0 2px #04100a; overflow: hidden; }
      .phone-notch { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 180px; height: 34px; background: #14261c; border-radius: 0 0 22px 22px; z-index: 5; }
      .ph-screen { position: absolute; inset: 0; background: #f7f8f6; display: flex; flex-direction: column; color: #14201a; }
      .ph-hd { background: #00482b; color: #fff; padding: 52px 30px 20px; display: flex; align-items: center; gap: 14px; }
      .ph-crest { width: 40px; height: 40px; object-fit: contain; flex: none; }
      .ic { vertical-align: -0.14em; }
      .ph-pinico { color: #d4351c; }
      .ph-hdt b { font-size: 28px; font-weight: 800; letter-spacing: 1px; display: block; line-height: 1; }
      .ph-hdt span { font-size: 17px; color: #9fd3b6; display: block; margin-top: 3px; }
      .ph-menu { margin-left: auto; font-size: 34px; color: #cfe6d9; }
      .ph-body { padding: 30px 30px; display: flex; flex-direction: column; gap: 22px; overflow: hidden; }
      .ph-h1 { font-size: 38px; font-weight: 800; line-height: 1.12; }
      .ph-lede { font-size: 24px; color: #5b6b62; line-height: 1.35; margin-top: -6px; }
      .ph-card { background: #fff; border: 2px solid #dde4de; border-radius: 20px; padding: 26px; display: flex; flex-direction: column; gap: 20px; }
      .ph-label { font-size: 22px; font-weight: 700; color: #14201a; }
      .ph-input { border: 2px solid #b9c4bd; border-radius: 14px; padding: 22px 22px; font-size: 26px; color: #8a978f; background: #fff; }
      .ph-input.filled { color: #14201a; font-weight: 600; }
      .ph-btn { background: #008751; color: #fff; border: none; border-radius: 999px; padding: 24px 28px; font-size: 28px; font-weight: 800; text-align: center; }
      .ph-fine { font-size: 21px; line-height: 1.4; color: #5b6b62; }
      .ph-ok { background: #e8f5ee; border: 2px solid #96d7b4; border-radius: 20px; padding: 30px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
      .ph-okmark { width: 78px; height: 78px; border-radius: 50%; background: #008751; display: flex; align-items: center; justify-content: center; position: relative; }
      .ph-okmark::after { content: ""; width: 20px; height: 38px; border: solid #fff; border-width: 0 8px 8px 0; transform: rotate(45deg); margin-top: -6px; }
      .ph-ok b { font-size: 32px; font-weight: 800; color: #00482b; }
      .ph-ok span { font-size: 22px; color: #3d6b52; }
      .ph-cam { background: #0c0f0d; border-radius: 20px; height: 420px; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
      .ph-scanbox { width: 74%; height: 66%; border: 4px dashed #6fe3a5; border-radius: 12px; display: flex; align-items: flex-start; justify-content: flex-start; }
      .ph-scanbox span { background: #6fe3a5; color: #04100a; font-size: 20px; font-weight: 800; padding: 4px 12px; border-radius: 0 0 10px 0; }
      .ph-gps { position: absolute; top: 18px; right: 18px; background: rgba(0,0,0,.55); color: #6fe3a5; font-size: 18px; padding: 6px 12px; border-radius: 999px; }
      .ph-shutter { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); width: 82px; height: 82px; border-radius: 50%; background: #fff; border: 6px solid rgba(255,255,255,.5); }
      .ph-res { display: flex; flex-direction: column; gap: 0; }
      .ph-resrow { display: flex; align-items: center; gap: 14px; padding: 18px 4px; border-bottom: 2px solid #eef2ef; font-size: 26px; }
      .ph-resrow:last-child { border-bottom: none; }
      .ph-dot { width: 20px; height: 20px; border-radius: 50%; background: #008751; flex: none; }
      .ph-resrow b { font-weight: 700; }
      .ph-resrow i { flex: 1; border-bottom: 2px dotted #cfd8d1; height: 1px; }
      .ph-num { font-weight: 800; font-variant-numeric: tabular-nums; }
      /* footer / disclaimer / progress */
      #footer { position: absolute; bottom: 116px; left: 0; right: 0; text-align: center; font-size: 44px; font-weight: 800; letter-spacing: 1px; }
      #disclaimer { position: absolute; bottom: 64px; left: 0; right: 0; text-align: center; font-size: 24px; color: #9fd3b6; }
      #bar { position: absolute; bottom: 0; left: 0; height: 10px; background: #6fe3a5; width: 1080px; transform-origin: left; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="31">
      <div id="bg" class="clip" data-start="0" data-duration="31" data-track-index="0"><div class="grad"></div><div id="glow"></div></div>

      <!-- S1 text -->
      <section id="s1" class="clip scene" data-start="0" data-duration="3.66" data-track-index="2">
        <div class="big"><span class="l">Osun</span><span class="l g">decides.</span></div>
        <div class="small">On the 15th of August, the result is yours to verify.</div>
      </section>

      <!-- S2 phone: leaderboard -->
      <section id="s2" class="clip" data-start="3.66" data-duration="4.34" data-track-index="2">
        ${phone(`<div class="pscreen" id="s2scr">${SCR_LEADER}</div>`, 's2phone')}
        <div class="pcap" id="s2cap"><div class="w">Counted <span class="g">in public.</span></div><div class="line">The count is read out loud, unit by unit.</div></div>
      </section>

      <!-- S3 text -->
      <section id="s3" class="clip scene" data-start="8.0" data-duration="3.42" data-track-index="2">
        <div class="big"><span class="l">What happens</span><span class="l">to it next</span><span class="l g">isn't.</span></div>
        <div class="small">Results travel through collation — out of sight.</div>
      </section>

      <!-- S4 phone: photograph -> sign -> seal -->
      <section id="s4" class="clip" data-start="11.42" data-duration="7.67" data-track-index="2">
        ${phone(`<div class="pscreen" id="s4a">${SCR_EC8A}</div><div class="pscreen" id="s4b">${SCR_SIGN}</div><div class="pscreen" id="s4c">${SCR_DONE}</div>`, 's4phone')}
        <div class="pcap" id="s4cap"><div class="w"><span class="beat g" id="b4a">Photograph it.</span><span class="beat g" id="b4b">Sign it.</span><span class="beat g" id="b4c">Seal it.</span></div></div>
      </section>

      <!-- S5 text -->
      <section id="s5" class="clip scene" data-start="19.09" data-duration="3.87" data-track-index="2">
        <div class="big"><span class="l">Numbers that</span><span class="l">change on the way up</span><span class="l g">get flagged.</span></div>
        <div class="small">Publicly. Osun will see it.</div>
      </section>

      <!-- S6 phone: register + CTA -->
      <section id="s6" class="clip" data-start="22.96" data-duration="8.04" data-track-index="2">
        ${phone(`<div class="pscreen" id="s6scr">${SCR_REG}</div>`, 's6phone')}
        <div class="pcap" id="s6cap"><div class="w">Become an <span class="g">observer.</span></div><div class="cta-chip"><span class="dot"></span>hawkeye.com.ng</div><div class="line">Free · Nonpartisan · Your phone is the witness.</div></div>
      </section>

      <div id="brand" class="clip" data-start="0" data-duration="31" data-track-index="6">
        <img src="assets/logo.svg" alt="" /><div class="name">HAWKEYE</div><div class="sub">INDEPENDENT ELECTION RESULTS MONITOR</div>
        <div id="brand-chip" class="chip">OSUN DECIDES · 15 AUGUST 2026</div>
      </div>
      <div id="footer" class="clip" data-start="0" data-duration="31" data-track-index="3">hawkeye.com.ng</div>
      <div id="disclaimer" class="clip" data-start="0" data-duration="31" data-track-index="5">Independent · Nonpartisan · Unofficial — INEC declares the official result.</div>
      <div id="bar" class="clip" data-start="0" data-duration="31" data-track-index="4"></div>
      <audio id="vo" src="assets/vo.mp3" data-start="0" data-duration="31" data-track-index="10" data-volume="1"></audio>
      <audio id="bgm" src="assets/bgm.mp3" data-start="0" data-duration="31" data-track-index="11" data-volume="0.16"></audio>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#glow", { x: 0, y: 0 }, { x: 220, y: -120, duration: 31, ease: "none" }, 0);
      tl.to("#glow", { scale: 1.15, duration: 15.5, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0);
      // brand + scene 1 are fully visible at frame 0 (frame 0 = the thumbnail
      // on TikTok/FB/IG — it must read as a composed title card, not a gradient)
      function textScene(sel, t) {
        tl.from(sel + " .big", { y: 40, opacity: 0, duration: 0.55, stagger: 0.12, ease: "power3.out" }, t);
        tl.from(sel + " .small", { y: 24, opacity: 0, duration: 0.55, ease: "power3.out" }, t + 0.25);
      }
      textScene("#s3", 8.05); textScene("#s5", 19.2);
      // phone scenes: rise/fade the phone, fade the caption
      // animate the INNER .phone (the outer .heroPhone keeps its static
      // translateX(-50%) scale() centering — gsap would otherwise clobber it)
      function phoneIn(phoneSel, capSel, t, dur) {
        tl.fromTo(phoneSel + " .phone", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, t);
        tl.to(phoneSel + " .phone", { opacity: 0, duration: 0.45, ease: "sine.in" }, t + dur - 0.45);
        tl.from(capSel, { opacity: 0, y: 20, duration: 0.55, ease: "power3.out" }, t + 0.2);
      }
      phoneIn("#s2phone", "#s2cap", 3.66, 4.34);
      phoneIn("#s4phone", "#s4cap", 11.42, 7.67);
      phoneIn("#s6phone", "#s6cap", 22.96, 8.04);
      // S4 screen crossfades + beat words (photograph -> sign -> seal)
      gsap.set(["#s4b", "#s4c", "#b4b", "#b4c"], { opacity: 0 });
      tl.to("#s4a", { opacity: 0, duration: 0.35 }, 13.5);
      tl.to("#s4b", { opacity: 1, duration: 0.35 }, 13.5);
      tl.to("#s4b", { opacity: 0, duration: 0.35 }, 15.5);
      tl.to("#s4c", { opacity: 1, duration: 0.35 }, 15.5);
      tl.to("#b4a", { opacity: 0, duration: 0.3 }, 13.45);
      tl.to("#b4b", { opacity: 1, duration: 0.3 }, 13.55);
      tl.to("#b4b", { opacity: 0, duration: 0.3 }, 15.45);
      tl.to("#b4c", { opacity: 1, duration: 0.3 }, 15.55);
      // progress + bgm
      tl.fromTo("#bar", { scaleX: 0 }, { scaleX: 1, duration: 31, ease: "none" }, 0);
      tl.fromTo("#bgm", { volume: 0 }, { volume: 0.16, duration: 1.2, ease: "sine.out" }, 0);
      tl.to("#bgm", { volume: 0.22, duration: 1.0 }, 22.9);
      tl.to("#bgm", { volume: 0, duration: 1.8, ease: "sine.in" }, 29.2);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;

fs.writeFileSync(path.join(__dir, 'index.html'), html);
console.log('wrote index.html', html.length, 'bytes');

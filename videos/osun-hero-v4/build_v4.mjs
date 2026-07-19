// v4: real Veo-animated b-roll behind the text. <video> must be a direct child
// of the composition root (HyperFrames media rule), so videos sit on track 1 and
// the green scrim + AI-disclosure tag ride above them on track 2. Motion comes
// from Veo, so no push-in. Writes index.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dir = path.dirname(fileURLToPath(import.meta.url));

const scrimClip = (id, t, dur) => `      <div id="${id}" class="clip scrimclip" data-start="${t}" data-duration="${dur}" data-track-index="2">
        <div class="scrim-inner"><div class="broll-scrim"></div><div class="ai-tag"><span>AI-GENERATED DRAMATIZATION</span></div></div>
      </div>`;
const vid = (id, t, dur, src) => `      <video id="${id}" class="clip vbroll" src="assets/veo/${src}" data-start="${t}" data-duration="${dur}" data-track-index="1" muted playsinline data-volume="0"></video>`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>Osun Decides — Hawkeye hero (Veo b-roll)</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; box-sizing: border-box; }
      body { background: #00140e; font-family: Inter, 'Helvetica Neue', Arial, sans-serif; color: #fff; }
      #root { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
      #bg { position: absolute; inset: 0; background: #00251a; }
      #bg .grad { position: absolute; inset: 0; background: radial-gradient(120% 80% at 50% 0%, #0a4632 0%, #00251a 60%); }
      #glow { position: absolute; width: 1400px; height: 1400px; left: -160px; top: 360px; border-radius: 50%;
        background: radial-gradient(circle, rgba(111,227,165,0.16) 0%, rgba(111,227,165,0) 62%); will-change: transform; }
      .vbroll { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transform: scale(1.06);
        filter: saturate(0.9) contrast(1.02) brightness(0.95); }
      .scrim-inner { position: absolute; inset: 0; }
      .broll-scrim { position: absolute; inset: 0; background:
        linear-gradient(180deg, rgba(0,18,12,0.86) 0%, rgba(0,18,12,0.34) 22%, rgba(0,18,12,0.34) 38%,
          rgba(0,18,12,0.68) 54%, rgba(0,18,12,0.72) 74%, rgba(0,18,12,0.93) 100%),
        linear-gradient(0deg, rgba(0,40,28,0.32), rgba(0,40,28,0.32)); }
      .ai-tag { position: absolute; top: 522px; left: 0; right: 0; text-align: center; font-size: 21px; letter-spacing: 2px; font-weight: 700; }
      .ai-tag span { background: rgba(0,20,14,0.55); border: 1px solid rgba(111,227,165,0.5); color: #bfe6d2; padding: 7px 18px; border-radius: 999px; }
      #brand { position: absolute; top: 96px; left: 0; right: 0; text-align: center; }
      #brand img { width: 138px; height: 138px; display: block; margin: 0 auto; }
      #brand .name { font-size: 58px; font-weight: 800; letter-spacing: 4px; margin-top: 6px; }
      #brand .sub { font-size: 25px; color: #9fd3b6; margin-top: 4px; letter-spacing: 1px; }
      .chip { display: inline-flex; align-items: center; gap: 14px; margin-top: 22px; background: rgba(111,227,165,0.14);
        border: 2px solid #6fe3a5; color: #6fe3a5; padding: 13px 30px; border-radius: 999px; font-size: 30px; font-weight: 800; letter-spacing: 2px; }
      .clip { position: absolute; }
      .scene { left: 90px; right: 90px; top: 620px; height: 900px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; }
      .big { font-size: 96px; font-weight: 800; line-height: 1.1; } .big .l { display: block; } .g { color: #6fe3a5; }
      .small { font-size: 38px; color: #cfe6d9; margin-top: 30px; line-height: 1.4; max-width: 880px; }
      .beat { font-size: 108px; font-weight: 800; }
      .cta-chip { display: inline-flex; align-items: center; gap: 16px; margin-top: 40px; background: rgba(111,227,165,0.16);
        border: 2px solid #6fe3a5; color: #6fe3a5; padding: 20px 40px; border-radius: 999px; font-size: 44px; font-weight: 800; }
      .dot { width: 20px; height: 20px; border-radius: 50%; background: #6fe3a5; display: block; }
      #footer { position: absolute; bottom: 116px; left: 0; right: 0; text-align: center; font-size: 44px; font-weight: 800; letter-spacing: 1px; }
      #disclaimer { position: absolute; bottom: 64px; left: 0; right: 0; text-align: center; font-size: 24px; color: #9fd3b6; }
      #bar { position: absolute; bottom: 0; left: 0; height: 10px; background: #6fe3a5; width: 1080px; transform-origin: left; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="31">
      <div id="bg" class="clip" data-start="0" data-duration="31" data-track-index="0"><div class="grad"></div><div id="glow"></div></div>

${vid('v2', '3.66', '4.34', 's2.mp4')}
${vid('v4', '11.42', '7.67', 's4.mp4')}
${vid('v6', '22.96', '8.04', 's6.mp4')}

${scrimClip('sc2', '3.66', '4.34')}
${scrimClip('sc4', '11.42', '7.67')}
${scrimClip('sc6', '22.96', '8.04')}

      <section id="s1" class="clip scene" data-start="0" data-duration="3.66" data-track-index="3">
        <div class="big"><span class="l">Osun</span><span class="l g">decides.</span></div>
        <div class="small">On the 15th of August, the result is yours to verify.</div>
      </section>
      <section id="s2" class="clip scene" data-start="3.66" data-duration="4.34" data-track-index="3">
        <div class="big"><span class="l">The count is</span><span class="l">read out loud.</span></div>
        <div class="small"><span class="g">In public.</span> At every polling unit.</div>
      </section>
      <section id="s3" class="clip scene" data-start="8.0" data-duration="3.42" data-track-index="3">
        <div class="big"><span class="l">What happens</span><span class="l">to it next</span><span class="l g">isn't.</span></div>
        <div class="small">Results travel through collation — out of sight.</div>
      </section>
      <section id="s4" class="clip scene" data-start="11.42" data-duration="7.67" data-track-index="3">
        <div class="beat"><span id="b4a" class="g">Photograph it.</span></div>
        <div class="beat"><span id="b4b" class="g">Sign it.</span></div>
        <div class="beat"><span id="b4c" class="g">Seal it.</span></div>
        <div id="s4sub" class="small">On a public ledger nobody can quietly change.</div>
      </section>
      <section id="s5" class="clip scene" data-start="19.09" data-duration="3.87" data-track-index="3">
        <div class="big"><span class="l">Numbers that</span><span class="l">change on the way up</span><span class="l g">get flagged.</span></div>
        <div class="small">Publicly. Osun will see it.</div>
      </section>
      <section id="s6" class="clip scene" data-start="22.96" data-duration="8.04" data-track-index="3">
        <div class="big"><span class="l">Become an</span><span class="l g">observer.</span></div>
        <div class="cta-chip"><span class="dot"></span>hawkeye.com.ng</div>
        <div class="small">Free · Nonpartisan · Your phone is the witness.</div>
      </section>

      <div id="footer" class="clip" data-start="0" data-duration="31" data-track-index="4">hawkeye.com.ng</div>
      <div id="disclaimer" class="clip" data-start="0" data-duration="31" data-track-index="6">Independent · Nonpartisan · Unofficial — INEC declares the official result.</div>
      <div id="bar" class="clip" data-start="0" data-duration="31" data-track-index="5"></div>
      <div id="brand" class="clip" data-start="0" data-duration="31" data-track-index="7">
        <img src="assets/logo.svg" alt="" /><div class="name">HAWKEYE</div><div class="sub">INDEPENDENT ELECTION RESULTS MONITOR</div>
        <div id="brand-chip" class="chip">OSUN DECIDES · 15 AUGUST 2026</div>
      </div>
      <audio id="vo" src="assets/vo.mp3" data-start="0" data-duration="31" data-track-index="10" data-volume="1"></audio>
      <audio id="bgm" src="assets/bgm.mp3" data-start="0" data-duration="31" data-track-index="11" data-volume="0.16"></audio>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#glow", { x: 0, y: 0 }, { x: 220, y: -120, duration: 31, ease: "none" }, 0);
      tl.to("#glow", { scale: 1.15, duration: 15.5, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0);
      // brand + scene 1 fully visible at frame 0 (frame 0 = the platform thumbnail)
      function scene(sel, t) {
        tl.from(sel + " .big, " + sel + " .beat", { y: 40, opacity: 0, duration: 0.55, stagger: 0.12, ease: "power3.out" }, t);
        tl.from(sel + " .small, " + sel + " .cta-chip", { y: 24, opacity: 0, duration: 0.55, ease: "power3.out" }, t + 0.25);
      }
      scene("#s2", 3.75); scene("#s3", 8.05);
      tl.from("#b4a", { y: 36, opacity: 0, duration: 0.5, ease: "power3.out" }, 11.5);
      tl.from("#b4b", { y: 36, opacity: 0, duration: 0.5, ease: "power3.out" }, 13.5);
      tl.from("#b4c", { y: 36, opacity: 0, duration: 0.5, ease: "power3.out" }, 15.5);
      tl.from("#s4sub", { opacity: 0, duration: 0.6 }, 16.1);
      scene("#s5", 19.2);
      tl.from("#s6 .big", { y: 44, opacity: 0, duration: 0.6, stagger: 0.12, ease: "power3.out" }, 23.1);
      tl.from("#s6 .cta-chip", { scale: 0.9, opacity: 0, duration: 0.6, ease: "back.out(1.6)" }, 23.7);
      tl.from("#s6 .small", { opacity: 0, duration: 0.6 }, 24.4);
      // video + scrim fade in/out (motion is in the Veo footage; no push-in).
      // Videos are .clip elements the framework already shows/hides, so each
      // opacity exit needs a hard-kill tl.set at the clip boundary (a video can't
      // be wrapped — it must stay a direct root child).
      function bv(vSel, sSel, t, dur) {
        const end = t + dur;
        tl.fromTo(vSel, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "sine.out" }, t);
        tl.to(vSel, { opacity: 0, duration: 0.45, ease: "sine.in" }, end - 0.45);
        tl.set(vSel, { opacity: 0 }, end);
        tl.fromTo(sSel + " .scrim-inner", { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "sine.out" }, t);
        tl.to(sSel + " .scrim-inner", { opacity: 0, duration: 0.45, ease: "sine.in" }, end - 0.45);
        tl.set(sSel + " .scrim-inner", { opacity: 0 }, end);
      }
      bv("#v2", "#sc2", 3.66, 4.34);
      bv("#v4", "#sc4", 11.42, 7.67);
      bv("#v6", "#sc6", 22.96, 8.04);
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

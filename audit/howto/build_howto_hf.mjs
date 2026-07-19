// Build ONE how-to as a HyperFrames composition (v3 product-in-phone style) with
// per-step Abeo voiceover + BGM and deterministic GSAP timing. Usage:
//   node build_howto_hf.mjs <slug>
// Produces videos/howto/<slug>/{index.html, assets/{vo.mp3,bgm.mp3,logo.svg}}.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIPS, PHONE_CSS, esc } from './howto_content.mjs';

const HOME = process.env.HOME;
const BIN = `${HOME}/.local/bin`;
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` } }).toString().trim();
const dur = (f) => parseFloat(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${f}"`));

const slug = process.argv[2];
const c = CLIPS.find((x) => x.slug === slug);
if (!c) { console.error('unknown slug', slug); process.exit(1); }

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..'); // ~/hawkeye
const proj = path.join(ROOT, 'videos', 'howto', slug);
const assets = path.join(proj, 'assets');
fs.mkdirSync(assets, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'app', 'logo.svg'), path.join(assets, 'logo.svg'));
fs.copyFileSync(path.join(ROOT, 'videos', 'osun-hero', 'assets', 'bgm.mp3'), path.join(assets, 'bgm.mp3'));

// ---- voiceover: intro line + each step caption + outro line -----------------
const introLine = `${c.title}.`;
const outroLine = 'Get started, free, at hawkeye dot com dot N G.';
const segTexts = [introLine, ...c.steps.map((s) => s.vo || s.cap), outroLine];
const seg = path.join(proj, '_seg');
fs.mkdirSync(seg, { recursive: true });
const PAD = 0.45; // breathing room after each segment
const durs = segTexts.map((t, i) => {
  const f = path.join(seg, `s${i}.mp3`);
  const clean = t.replace(/"/g, '').replace(/—/g, ', ');
  sh(`edge-tts --voice en-NG-AbeoNeural --text "${clean}" --write-media "${f}"`);
  return dur(f) + PAD;
});
// concat segments with PAD silence between into vo.mp3
const inputs = [];
const filt = [];
segTexts.forEach((_, i) => { inputs.push(`-i "${path.join(seg, `s${i}.mp3`)}"`); });
const sil = path.join(seg, 'sil.mp3');
sh(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${PAD} -q:a 9 "${sil}"`);
const parts = [];
segTexts.forEach((_, i) => { parts.push(`[${i}:a]`); parts.push(`[${segTexts.length}:a]`); });
const vo = path.join(assets, 'vo.mp3');
sh(`ffmpeg -y ${inputs.join(' ')} -i "${sil}" -filter_complex "${parts.join('')}concat=n=${parts.length}:v=0:a=1[a]" -map "[a]" "${vo}"`);
const VO_TOTAL = dur(vo);

// ---- timeline: intro | steps | outro (each = its VO segment duration) -------
const INTRO = durs[0];
const stepDurs = durs.slice(1, 1 + c.steps.length);
const OUTRO = durs[durs.length - 1];
const stepStart = [];
let t = INTRO;
stepDurs.forEach((d) => { stepStart.push(t); t += d; });
const outroStart = t;
const TOTAL = +(INTRO + stepDurs.reduce((a, b) => a + b, 0) + OUTRO).toFixed(2);

// ---- composition ------------------------------------------------------------
const N = c.steps.length;
const screens = c.steps.map((s, i) => `<div class="pscreen" id="scr${i}">${s.screen}</div>`).join('');
const caps = c.steps.map((s, i) => `<div class="hcap" id="cap${i}">${esc(s.cap)}</div>`).join('');
const dots = c.steps.map((_, i) => `<span class="hdot" id="dot${i}"></span>`).join('');
const titleHtml = c.title.replace(/^How to /, 'How to<br><span class="g">') + '</span>';

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>${esc(c.title)} — Hawkeye</title>
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
      #brand img { width: 132px; height: 132px; display: block; margin: 0 auto; }
      #brand .name { font-size: 56px; font-weight: 800; letter-spacing: 4px; margin-top: 6px; }
      #brand .sub { font-size: 24px; color: #9fd3b6; margin-top: 4px; letter-spacing: 1px; }
      #kicker { position: absolute; top: 430px; left: 0; right: 0; text-align: center; font-size: 27px; font-weight: 800; letter-spacing: 3px; color: #6fe3a5; }
      /* intro title */
      #htitle { position: absolute; top: 720px; left: 60px; right: 60px; text-align: center; font-size: 104px; font-weight: 800; line-height: 1.05; }
      #htitle .g { color: #6fe3a5; }
      /* phone (v3 layout) */
      .heroPhone { position: absolute; top: 486px; left: 50%; width: 560px; height: 1064px; transform: translateX(-50%) scale(0.78); transform-origin: top center; }
      .pscreen { position: absolute; inset: 0; }
      /* caption + step dots */
      #hcaps { position: absolute; top: 1372px; left: 80px; right: 80px; height: 260px; text-align: center; }
      .hcap { position: absolute; left: 0; right: 0; top: 0; font-size: 44px; font-weight: 700; line-height: 1.3; color: #eafff4; }
      #hdots { position: absolute; top: 1660px; left: 0; right: 0; text-align: center; display: flex; gap: 16px; justify-content: center; }
      .hdot { width: 18px; height: 18px; border-radius: 50%; background: rgba(255,255,255,0.22); }
      .hdot.on { background: #6fe3a5; }
      /* outro CTA */
      #houtro { position: absolute; top: 700px; left: 70px; right: 70px; text-align: center; }
      #houtro .big { font-size: 92px; font-weight: 800; line-height: 1.08; }
      #houtro .g { color: #6fe3a5; }
      #houtro .chip { display: inline-flex; align-items: center; gap: 16px; margin-top: 40px; background: rgba(111,227,165,0.16);
        border: 2px solid #6fe3a5; color: #6fe3a5; padding: 20px 40px; border-radius: 999px; font-size: 46px; font-weight: 800; }
      #houtro .chip .dot { width: 20px; height: 20px; border-radius: 50%; background: #6fe3a5; display: block; }
      #footer { position: absolute; bottom: 96px; left: 0; right: 0; text-align: center; font-size: 42px; font-weight: 800; letter-spacing: 1px; }
      #bar { position: absolute; bottom: 0; left: 0; height: 10px; background: #6fe3a5; width: 1080px; transform-origin: left; }
      ${PHONE_CSS}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1080" data-height="1920" data-duration="${TOTAL}">
      <div id="bg" class="clip" data-start="0" data-duration="${TOTAL}" data-track-index="0"><div class="grad"></div><div id="glow"></div></div>

      <div id="brand" class="clip" data-start="0" data-duration="${TOTAL}" data-track-index="5">
        <img src="assets/logo.svg" alt="" /><div class="name">HAWKEYE</div><div class="sub">INDEPENDENT ELECTION RESULTS MONITOR</div>
      </div>
      <div id="kicker" class="clip" data-start="${INTRO}" data-duration="${(TOTAL - INTRO).toFixed(2)}" data-track-index="9">${esc(c.kicker)}</div>

      <div id="htitle" class="clip" data-start="0" data-duration="${INTRO.toFixed(2)}" data-track-index="2">${titleHtml}</div>

      <div class="heroPhone clip" id="phone" data-start="${INTRO.toFixed(2)}" data-duration="${(outroStart - INTRO).toFixed(2)}" data-track-index="1">
        <div class="phone"><div class="phone-notch"></div>${screens}</div>
      </div>
      <div id="hcaps" class="clip" data-start="${INTRO.toFixed(2)}" data-duration="${(outroStart - INTRO).toFixed(2)}" data-track-index="6">${caps}</div>
      <div id="hdots" class="clip" data-start="${INTRO.toFixed(2)}" data-duration="${(outroStart - INTRO).toFixed(2)}" data-track-index="7">${dots}</div>

      <div id="houtro" class="clip" data-start="${outroStart.toFixed(2)}" data-duration="${OUTRO.toFixed(2)}" data-track-index="8">
        <div class="big">Become an <span class="g">observer.</span></div>
        <div class="chip"><span class="dot"></span>hawkeye.com.ng</div>
      </div>

      <div id="footer" class="clip" data-start="0" data-duration="${TOTAL}" data-track-index="3">hawkeye.com.ng</div>
      <div id="bar" class="clip" data-start="0" data-duration="${TOTAL}" data-track-index="4"></div>
      <audio id="vo" src="assets/vo.mp3" data-start="0" data-duration="${TOTAL}" data-track-index="10" data-volume="1"></audio>
      <audio id="bgm" src="assets/bgm.mp3" data-start="0" data-duration="${TOTAL}" data-track-index="11" data-volume="0.14"></audio>
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      const STEPSTART = ${JSON.stringify(stepStart.map((x) => +x.toFixed(3)))};
      const STEPDUR = ${JSON.stringify(stepDurs.map((x) => +x.toFixed(3)))};
      tl.fromTo("#glow", { x: 0, y: 0 }, { x: 220, y: -120, duration: ${TOTAL}, ease: "none" }, 0);
      // brand + title stay fully visible from frame 0 — the first frame IS the
      // thumbnail on TikTok/FB/IG, so it must read as a composed title card.
      // phone screens crossfade + captions + dots, per step
      gsap.set([${c.steps.map((_, i) => i === 0 ? null : `"#scr${i}"`).filter(Boolean).join(',')}], { opacity: 0 });
      gsap.set([${c.steps.map((_, i) => i === 0 ? null : `"#cap${i}"`).filter(Boolean).join(',')}], { opacity: 0 });
      STEPSTART.forEach((st, i) => {
        if (i > 0) {
          tl.to("#scr" + (i - 1), { opacity: 0, duration: 0.3 }, st);
          tl.to("#scr" + i, { opacity: 1, duration: 0.3 }, st);
          tl.to("#cap" + (i - 1), { opacity: 0, duration: 0.25 }, st - 0.05);
          tl.fromTo("#cap" + i, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.35 }, st + 0.05);
        } else {
          tl.fromTo("#cap0", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4 }, st + 0.1);
        }
        tl.to("#dot" + i, { backgroundColor: "#6fe3a5", duration: 0.2 }, st);
      });
      tl.from("#phone .phone", { opacity: 0, y: 30, duration: 0.5, ease: "power3.out" }, ${INTRO.toFixed(2)});
      // outro
      tl.from("#houtro .big", { y: 30, opacity: 0, duration: 0.5, stagger: 0.1, ease: "power3.out" }, ${(outroStart + 0.1).toFixed(2)});
      tl.from("#houtro .chip", { scale: 0.9, opacity: 0, duration: 0.5, ease: "back.out(1.6)" }, ${(outroStart + 0.35).toFixed(2)});
      // progress + bgm
      tl.fromTo("#bar", { scaleX: 0 }, { scaleX: 1, duration: ${TOTAL}, ease: "none" }, 0);
      tl.fromTo("#bgm", { volume: 0 }, { volume: 0.14, duration: 1.0, ease: "sine.out" }, 0);
      tl.to("#bgm", { volume: 0, duration: 1.4, ease: "sine.in" }, ${(TOTAL - 1.5).toFixed(2)});
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
fs.writeFileSync(path.join(proj, 'index.html'), html);
fs.rmSync(seg, { recursive: true, force: true });
console.log(`OK ${slug}: total=${TOTAL}s intro=${INTRO.toFixed(2)} steps=[${stepDurs.map((x) => x.toFixed(2)).join(',')}] outro=${OUTRO.toFixed(2)} vo=${VO_TOTAL.toFixed(2)}s`);
console.log(`   -> ${path.join(proj, 'index.html')}`);

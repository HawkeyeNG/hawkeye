// Render the Osun Decides hero clip (osun_clip.html) DETERMINISTICALLY:
// pause all CSS animations, step currentTime frame-by-frame at 30fps and
// screenshot each frame, then assemble with ffmpeg. Playwright's wall-clock
// recordVideo lags ~2s at startup (stretching slide 1) — frame-stepping gives
// every slide exactly its authored duration and no white pre-paint head.
// Run from ~/hawkeye/audit.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = path.join(__dir, 'node_modules', 'ffmpeg-static', 'ffmpeg');
const OUTDIR = path.join(__dir, 'howto', 'out');
const FPS = 30;
const TOTAL = 25; // 22.8s slide cycle + CTA end-card hold

let html = fs.readFileSync(path.join(__dir, 'osun_clip.html'), 'utf8');
const logo = fs.readFileSync(path.join(__dir, '..', 'app', 'logo.svg')).toString('base64');
html = html.replace('LOGO', `data:image/svg+xml;base64,${logo}`);
const htmlPath = path.join(OUTDIR, 'osun-decides.html');
fs.writeFileSync(htmlPath, html);

const framesDir = path.join(OUTDIR, 'frames-osun');
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await p.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
await p.evaluate(() => document.getAnimations({ subtree: true }).forEach((a) => a.pause()));
const nFrames = TOTAL * FPS;
for (let i = 0; i < nFrames; i++) {
  await p.evaluate((ms) => document.getAnimations({ subtree: true }).forEach((a) => { a.currentTime = ms; }), (i * 1000) / FPS);
  await p.screenshot({ path: path.join(framesDir, `f${String(i).padStart(5, '0')}.png`) });
}
await b.close();

const mp4 = path.join(OUTDIR, 'osun-decides.mp4');
execFileSync(FFMPEG, [
  '-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f%05d.png'),
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
  mp4,
], { stdio: 'ignore' });
fs.rmSync(framesDir, { recursive: true, force: true });
console.log('OK osun-decides', Math.round(fs.statSync(mp4).size / 1024) + 'KB');

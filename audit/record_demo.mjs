import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ffmpeg = '/tmp/vid/node_modules/ffmpeg-static/ffmpeg';
const OUTDIR = '/tmp/vid';
// Inline the logo so the recording is self-contained.
let html = fs.readFileSync(new URL('./demo_clip.html', import.meta.url), 'utf8');
const logo = fs.readFileSync(new URL('../app/logo.svg', import.meta.url).pathname).toString('base64');
html = html.replace('LOGO', `data:image/svg+xml;base64,${logo}`);
fs.writeFileSync(`${OUTDIR}/clip.html`, html);

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1080, height: 1920 },
  recordVideo: { dir: OUTDIR, size: { width: 1080, height: 1920 } },
});
const p = await ctx.newPage();
await p.goto('file://' + `${OUTDIR}/clip.html`, { waitUntil: 'networkidle' });
await p.waitForTimeout(12000); // full animation cycle
await ctx.close(); // finalizes the webm
await b.close();

const webm = fs.readdirSync(OUTDIR).filter((f) => f.endsWith('.webm')).map((f) => `${OUTDIR}/${f}`)
  .sort((a, b2) => fs.statSync(b2).mtimeMs - fs.statSync(a).mtimeMs)[0];
console.log('webm', webm);

// Convert to a TikTok-friendly MP4: H.264 yuv420p + a silent AAC track (TikTok
// wants an audio stream), 30 fps, trimmed to ~11s, faststart for streaming.
const mp4 = '/mnt/c/Users/HP/Downloads/hawkeye-demo.mp4';
execFileSync(ffmpeg, [
  '-y', '-i', webm,
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
  '-t', '11', '-r', '30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
  mp4,
], { stdio: 'ignore' });
const kb = Math.round(fs.statSync(mp4).size / 1024);
console.log('mp4', mp4, kb + 'KB');

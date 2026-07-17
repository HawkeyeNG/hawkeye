// Record the Osun Decides hero clip (osun_clip.html, 14s cycle) the same way as
// record_demo.mjs but using audit-local node_modules. Run from ~/hawkeye/audit.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = path.join(__dir, 'node_modules', 'ffmpeg-static', 'ffmpeg');
const OUTDIR = path.join(__dir, 'howto', 'out');

let html = fs.readFileSync(path.join(__dir, 'osun_clip.html'), 'utf8');
const logo = fs.readFileSync(path.join(__dir, '..', 'app', 'logo.svg')).toString('base64');
html = html.replace('LOGO', `data:image/svg+xml;base64,${logo}`);
const htmlPath = path.join(OUTDIR, 'osun-decides.html');
fs.writeFileSync(htmlPath, html);

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1080, height: 1920 },
  recordVideo: { dir: OUTDIR, size: { width: 1080, height: 1920 } },
});
const p = await ctx.newPage();
await p.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
await p.waitForTimeout(27000);
await ctx.close();
await b.close();

const webm = fs.readdirSync(OUTDIR).filter((f) => f.endsWith('.webm')).map((f) => path.join(OUTDIR, f))
  .sort((a, b2) => fs.statSync(b2).mtimeMs - fs.statSync(a).mtimeMs)[0];

// Trim the white pre-paint head (see render_howto.mjs whiteHead()).
const meta = '/tmp/osun_ss_meta.txt';
execFileSync(FFMPEG, ['-y', '-i', webm, '-t', '3', '-vf', `signalstats,metadata=print:file=${meta}`, '-f', 'null', '-'], { stdio: 'ignore' });
let head = 0;
{
  // pts_time line is followed by a block of stat lines — pair YAVG with the
  // last-seen pts_time (YAVG is NOT the immediate next line).
  const lines = fs.readFileSync(meta, 'utf8').split('\n');
  let cur = 0;
  for (const line of lines) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) { cur = parseFloat(m[1]); continue; }
    const y = line.match(/YAVG=([\d.]+)/);
    if (y && parseFloat(y[1]) < 100) { head = cur; break; }
  }
}

const mp4 = path.join(OUTDIR, 'osun-decides.mp4');
execFileSync(FFMPEG, [
  '-y', '-i', webm,
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
  '-ss', String(head.toFixed(3)), '-t', '25', '-r', '30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-preset', 'medium', '-crf', '20',
  '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart',
  mp4,
], { stdio: 'ignore' });
fs.unlinkSync(webm);
console.log('OK osun-decides', Math.round(fs.statSync(mp4).size / 1024) + 'KB');

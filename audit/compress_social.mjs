// Compress any image or video to web/social-optimized specs BEFORE it is hosted
// and posted — keeps bandwidth (GO54) and platform ingestion light. One tool for
// both (ffmpeg handles images too), so nothing large ever goes out.
//   node audit/compress_social.mjs <input> [output]
// Specs: images -> max 1080px long edge, JPEG q~80, metadata stripped.
//        video  -> fit 1080x1920, H.264 CRF 24, 30fps, AAC 128k, faststart, meta stripped.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('usage: node compress_social.mjs <input> [output]'); process.exit(1); }
const ext = path.extname(src).toLowerCase();
const isVideo = ['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext);
const out = process.argv[3] || src.replace(/(\.[^.]+)$/, isVideo ? '.social.mp4' : '.social.jpg');

const before = fs.statSync(src).size;
if (isVideo) {
  execFileSync(ffmpeg, [
    '-y', '-i', src,
    '-vf', "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
    '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '24',
    '-c:a', 'aac', '-b:a', '128k', '-map_metadata', '-1', '-movflags', '+faststart', out,
  ], { stdio: 'ignore' });
} else {
  execFileSync(ffmpeg, [
    '-y', '-i', src,
    '-vf', "scale='min(1080,iw)':-2", '-q:v', '4', '-map_metadata', '-1', out,
  ], { stdio: 'ignore' });
}
const after = fs.statSync(out).size;
const kb = (n) => Math.round(n / 1024);
console.log(`${path.basename(src)} ${kb(before)}KB -> ${path.basename(out)} ${kb(after)}KB (${Math.round((1 - after / before) * 100)}% smaller)`);

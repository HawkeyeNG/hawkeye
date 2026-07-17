import { execFileSync } from 'node:child_process';
import path from 'node:path';
const FF = path.resolve('..', 'node_modules', 'ffmpeg-static', 'ffmpeg'); // cwd = howto/
const mp4 = process.argv[2];
const stamps = process.argv.slice(3);
for (const t of stamps) {
  const out = path.join('out', `qa_${path.basename(mp4, '.mp4')}_${t}.png`);
  execFileSync(FF, ['-y', '-ss', String(t), '-i', mp4, '-frames:v', '1', out], { stdio: 'ignore' });
  console.log(out);
}

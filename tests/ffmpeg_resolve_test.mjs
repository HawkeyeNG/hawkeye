/**
 * ffmpeg MUST BE FOUND WITHOUT PATH.
 *
 * Detection was a bare `execFileSync('ffmpeg', …)`, which resolves through PATH
 * and nothing else. The production host is a jailed DirectAdmin/Passenger Node
 * process with a minimal environment, so nothing was found and every incident
 * video was stored exactly as the phone recorded it — HEVC, which a desktop
 * browser will not decode. The symptom (audio plays, picture does not) reads as
 * a browser fault, so this went unnoticed until a clip was pulled off the server
 * and probed.
 *
 * The fix ships a binary as an npm dependency, because that host has no root and
 * no shell and the file is 76 MB against a 10 MB upload limit. That makes the
 * BUNDLED branch the one that matters in production — and the one that never
 * runs locally, where PATH always wins. So this test strips PATH and asserts the
 * bundled binary is found and actually executes.
 *
 * Skips when ffmpeg-static is not installed, so the suite still runs on a
 * machine that has not done `npm install` in backend/.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const BACKEND = '/home/elrio/hawkeye/backend';
const require_ = createRequire(BACKEND + '/');

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok || !extra ? '' : `\n        ${extra}`}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

let bundled = null;
for (const mod of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
  try {
    const m = require_(mod);
    const p = typeof m === 'string' ? m : m && m.path;
    if (typeof p === 'string' && p) { bundled = p; break; }
  } catch { /* not installed */ }
}
if (!bundled) {
  console.log('SKIP  no bundled ffmpeg installed — run `npm install` in backend/');
  process.exit(0);
}

console.log(`      bundled binary: ${bundled}`);
check('the bundled binary exists on disk', fs.existsSync(bundled), bundled);
check('and it is executable', (fs.statSync(bundled).mode & 0o111) !== 0);
{
  const mb = fs.statSync(bundled).size / 1048576;
  console.log(`      size: ${mb.toFixed(1)} MB`);
  // Stated so the deployment constraint is visible in the test output: this is
  // why it cannot be uploaded by scripts/deploy_app.sh.
  check('it is a real static build, not a stub', mb > 20, `${mb.toFixed(1)} MB`);
}

console.log('\n=== it is found when PATH has no ffmpeg (the production case) ===');
{
  const nodeDir = path.dirname(process.execPath);
  const stripped = `${nodeDir}:/usr/bin:/bin`;
  const visible = (() => {
    try { execFileSync('sh', ['-c', 'command -v ffmpeg'], { env: { PATH: stripped }, stdio: 'pipe' }); return true; }
    catch { return false; }
  })();
  // The precondition IS the test: if ffmpeg were still on this PATH, the run
  // below would prove nothing at all.
  check('precondition: ffmpeg is NOT on the stripped PATH', visible === false);

  const out = execFileSync(process.execPath, ['-e', `
    import('./src/routes/incidents.js').then((m) => {
      console.log(JSON.stringify({ ok: m.mediaHealth.ffmpeg, path: m.mediaHealth.ffmpegPath }));
      process.exit(0);
    });
  `], { cwd: BACKEND, env: { ...process.env, PATH: stripped }, encoding: 'utf8' });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}';
  const r = JSON.parse(line);
  console.log(`      resolved: ${r.path}`);
  check('ffmpeg is still found', r.ok === true, out.slice(0, 200));
  check('and it resolved to the bundled binary', /ffmpeg-static|ffmpeg-installer/.test(String(r.path)), String(r.path));
}

console.log('\n=== the binary actually runs ===');
{
  let version = '';
  try { version = execFileSync(bundled, ['-version'], { encoding: 'utf8' }).split('\n')[0]; } catch { /* stays empty */ }
  console.log(`      ${version}`);
  check('it reports a version', /ffmpeg version/.test(version), version);
  // CONTROL: a path that does not exist must NOT report a version, or the
  // assertion above would pass for anything.
  let bogus = '';
  try { bogus = execFileSync('/nonexistent/ffmpeg', ['-version'], { encoding: 'utf8' }); } catch { /* expected */ }
  control('a missing binary reports nothing', /ffmpeg version/.test(bogus));
}

/**
 * THE REAL PIPELINE ARGUMENTS MUST RUN ON THE BUNDLED BINARY.
 *
 * This is the check that would have caught the last failure and none of the
 * others would. The bundled build is from 2018: it reports an `hevc` decoder
 * and a `libx264` encoder, answers `-version` happily, and then dies mid-stream
 * with "Option 'force_divisible_by' not found" — an option added in FFmpeg 4.2.
 * Presence checks and version strings all passed; only running the actual
 * filter graph failed.
 *
 * So the filter string is read OUT OF THE ROUTE and executed, rather than
 * copied here where it could drift into being a test of itself.
 */
console.log('\n=== the route\'s own filter graph runs on this binary ===');
{
  const src = fs.readFileSync(path.join(BACKEND, 'src/routes/incidents.js'), 'utf8');
  const m = src.match(/'-vf',\s*"([^"]+)"/);
  check('the -vf filter was found in incidents.js', !!m, 'the route changed shape');
  if (m) {
    const vf = m[1];
    console.log(`      ${vf.slice(0, 90)}…`);
    check('it does not use force_divisible_by (FFmpeg 4.2+ only)',
      !/force_divisible_by/.test(vf),
      'the bundled binary predates it and fails at runtime, not at startup');

    const IN = '/tmp/hk_filter_probe.mp4';
    const OUT = '/tmp/hk_filter_out.mp4';
    // Odd dimensions on purpose: 641x361 is exactly what the even-rounding pass
    // exists for, so a filter that cannot round would fail here.
    execFileSync(bundled, ['-y', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc2=size=641x361:rate=15:duration=1', '-pix_fmt', 'yuv420p', IN]);

    let ran = true;
    let err = '';
    try {
      execFileSync(bundled, ['-y', '-v', 'error', '-i', IN, '-map_metadata', '-1',
        '-movflags', '+faststart', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '28', '-c:a', 'aac', '-b:a', '96k', OUT],
      { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 120000 });
    } catch (e) { ran = false; err = String(e.stderr || e).slice(0, 200); }
    check('the filter graph completes on the bundled binary', ran, err);
    check('and it produced a file', ran && fs.existsSync(OUT) && fs.statSync(OUT).size > 0);

    // CONTROL: the old argument really does fail here, so the check above has
    // teeth rather than passing because ffmpeg is lenient.
    let oldFailed = false;
    try {
      execFileSync(bundled, ['-y', '-v', 'error', '-i', IN,
        '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-c:v', 'libx264', '-f', 'null', '-'],
      { stdio: 'ignore', timeout: 120000 });
    } catch { oldFailed = true; }
    control('the pre-fix filter is rejected by this binary', !oldFailed);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

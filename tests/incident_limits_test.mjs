/**
 * THE INCIDENT MEDIA LIMITS, EXERCISED AGAINST THE REAL ENDPOINT.
 *
 * Three things were wrong at once and each hid the next:
 *
 * 1. An oversize attachment hit multer's LIMIT_FILE_SIZE, which nothing
 *    handled, so it fell through as {"error":"internal_error"} with a 500 —
 *    after the observer had already spent the mobile data to send it. A generic
 *    failure invites the identical retry.
 * 2. The cap was 4 x 30 MB = 120 MB per report, with no limit on how many of
 *    those were video, which is where essentially all the bytes are.
 * 3. The server-side transcode that the storage plan depends on could fail
 *    silently, storing the phone's original HEVC — audio plays, video does not.
 *
 * Needs the dev backend on :8430. Skips (rather than fails) when it is absent,
 * because the rest of the suite must stay runnable without it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.HK_BASE || 'http://localhost:8430';
const REPO = '/home/elrio/hawkeye';

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok || !extra ? '' : `\n        ${extra}`}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

const alive = await fetch(`${BASE}/api/parties`).then((r) => r.ok).catch(() => false);
if (!alive) {
  console.log(`SKIP  no backend on ${BASE} — start it with: node backend/src/server.js`);
  process.exit(0);
}

const out = execFileSync('node', ['scripts/dev_session.mjs', '--observer', '111'],
  { cwd: path.join(REPO, 'backend'), encoding: 'utf8' });
const token = out.match(/hawkeye\.auth\.token'\s*,\s*"([^"]+)"/)[1];

const ffmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();
if (!ffmpeg) { console.log('SKIP  ffmpeg absent locally — cannot build fixtures'); process.exit(0); }

/** Build a clip of roughly the requested size, cached across runs. */
function clip(seconds, bitrate, file) {
  if (fs.existsSync(file)) return file;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc2=size=1920x1080:rate=30:duration=${seconds}`,
    '-vf', 'noise=alls=18:allf=t', '-c:v', 'libx264', '-preset', 'veryfast',
    '-b:v', bitrate, '-pix_fmt', 'yuv420p', file]);
  return file;
}
const small = clip(4, '6M', '/tmp/hk_small.mp4');      // a few MB, well under the cap
const huge = clip(30, '12M', '/tmp/hk_huge.mp4');      // ~46 MB, well over the 25 MB cap

const post = async (files) => {
  const fd = new FormData();
  fd.append('kind', 'other');
  fd.append('description', 'automated limits check - safe to delete');
  for (const [i, f] of files.entries()) {
    fd.append('media', new Blob([fs.readFileSync(f)], { type: 'video/mp4' }), `c${i}.mp4`);
  }
  const r = await fetch(`${BASE}/api/incidents`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log(`fixtures: small=${(fs.statSync(small).size / 1048576).toFixed(1)}MB  huge=${(fs.statSync(huge).size / 1048576).toFixed(1)}MB`);

console.log('\n=== an oversize video is REFUSED BY NAME, not as a 500 ===');
{
  const r = await post([huge]);
  console.log(`      -> ${r.status} ${JSON.stringify(r.body)}`);
  check('the status is 413, not 500', r.status === 413, `got ${r.status}`);
  check('the error names the problem', r.body.error === 'file_too_large', JSON.stringify(r.body));
  check('and the hint says what to do about it', /MB/.test(r.body.hint || ''));
  // CONTROL: the old behaviour really was an unnamed 500, so this can fail.
  control('a 500 with error=internal_error would NOT pass the assertions above',
    r.status === 500 || r.body.error === 'internal_error');
}

console.log('\n=== at most two videos per report ===');
{
  const r = await post([small, small, small]);
  console.log(`      -> ${r.status} ${JSON.stringify(r.body)}`);
  check('a third video is refused', r.status === 400, `got ${r.status}`);
  check('named too_many_videos', r.body.error === 'too_many_videos', JSON.stringify(r.body));
}

console.log('\n=== two videos are accepted, and both are transcoded ===');
{
  const r = await post([small, small]);
  console.log(`      -> ${r.status} ${JSON.stringify(r.body)}`);
  check('two videos are accepted', r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);

  // What actually landed: the ledger of this is media_json, so read it back.
  const row = execFileSync('node', ['-e',
    'const D=require("better-sqlite3");const db=new D("storage/hawkeye.db",{readonly:true});'
    + 'console.log(db.prepare("SELECT media_json FROM incidents ORDER BY id DESC LIMIT 1").get().media_json);'],
  { cwd: path.join(REPO, 'backend'), encoding: 'utf8' }).trim();
  const parsed = JSON.parse(row);
  console.log(`      media_json: ${row}`);
  check('both files were stored', parsed.length === 2, row);
  check('both are marked transcoded', parsed.every((m) => m.transcoded === true), row);
  check('and both are named .mp4, matching their new codec',
    parsed.every((m) => m.file.endsWith('.mp4')), row);

  // CONTROL: a fallback-stored file would be flagged, so the assertion has teeth.
  control('an untranscoded entry would fail the check above',
    parsed.some((m) => m.transcoded === false));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

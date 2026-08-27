/**
 * THE VIDEO LENGTH LIMIT MUST BE ONE NUMBER.
 *
 * It was three. incident.tsx hard-coded "up to 90s" in the camera hint,
 * capture-camera computed `VideoCompressor ? 180 : 90` for the recorder and its
 * on-screen "max Ns" badge, and the library picker used 45. So the app told an
 * observer 90 seconds, then allowed 180, and the web client meant something
 * else again. A limit the app contradicts itself about is not a limit, and no
 * amount of picking the "right" number fixes having several.
 *
 * This asserts a single source and that nothing near the media code carries a
 * competing literal. It is a SOURCE test on purpose: the contradiction was
 * visible in the strings long before anyone recorded a 180-second video, and a
 * runtime test would need a camera to catch it.
 */
import fs from 'node:fs';

const R = '/home/elrio/hawkeye';
const read = (p) => fs.readFileSync(`${R}/${p}`, 'utf8');

/**
 * Check the CODE, not the prose.
 *
 * The first run of this failed on two comments: a stale header describing the
 * old "90s ≈ 24MB" regime, and the note explaining that the cap USED to be
 * `VideoCompressor ? 180 : 90`. A test that forbids writing down the bug you
 * just fixed is a bad test — the history is the most useful thing in the file.
 * Strings are kept, because user-facing copy is exactly what must not disagree.
 */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

let fail = 0;
const check = (l, ok, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${ok || !extra ? '' : `\n        ${extra}`}`);
};
const control = (l, red) => { if (red) fail++; console.log(`${red ? 'FAIL' : 'PASS'}  CONTROL ${l}`); };

const policy = read('native/src/lib/media-compress.ts');
const m = policy.match(/export const MAX_VIDEO_SECONDS\s*=\s*(\d+)/);
check('lib/media-compress.ts declares MAX_VIDEO_SECONDS', !!m, 'the single source is missing');
if (!m) { console.log('\n1 FAILED'); process.exit(1); }
const SECONDS = Number(m[1]);
console.log(`      single source: MAX_VIDEO_SECONDS = ${SECONDS}`);

/* Every native file that talks about video length must IMPORT it, never
   restate it. */
for (const f of ['native/src/components/capture-camera.tsx', 'native/src/app/report/incident.tsx']) {
  const src = code(read(f));
  check(`${f} imports the shared constant`,
    /MAX_VIDEO_SECONDS/.test(src) && /from '@\/lib\/media-compress'/.test(src));
  check(`${f} does not redeclare it`,
    !/const MAX_VIDEO_SECONDS\s*=\s*\d/.test(src),
    'a local copy is how the 90-vs-180 split happened');
  // The old shape, spelled out so this test names what it is guarding against.
  check(`${f} has no VideoCompressor-dependent cap`,
    !/VideoCompressor\s*\?\s*\d+\s*:\s*\d+/.test(src));
}

/* No stray "up to Ns" / "max Ns" copy that disagrees with the constant. */
const HUMAN = /(?:up to|max(?:imum)?)\s*(\d{2,3})\s*s\b/gi;
for (const f of ['native/src/components/capture-camera.tsx', 'native/src/app/report/incident.tsx']) {
  const src = code(read(f));
  const bad = [...src.matchAll(HUMAN)].map((x) => Number(x[1])).filter((n) => n !== SECONDS);
  check(`${f} states no other duration in its copy`, bad.length === 0,
    bad.length ? `found ${bad.join(', ')} alongside ${SECONDS}` : '');
}

/* The web client is a separate codebase and cannot import it, so it is checked
   against the same number rather than trusted. */
{
  const web = read('app/incidents.html');
  const w = web.match(/MAX_VIDEO_SECONDS\s*=\s*(\d+)/);
  check('app/incidents.html declares a video duration', !!w);
  check('and it matches the native limit', w && Number(w[1]) === SECONDS,
    w ? `web says ${w[1]}, native says ${SECONDS}` : '');
}

/* CONTROL: the detector must fire on the exact shape that shipped. */
{
  const oldSrc = 'const VIDEO_MAX_S = VideoCompressor ? 180 : 90;\nhint="switch to video (up to 90s)"';
  const caughtShape = /VideoCompressor\s*\?\s*\d+\s*:\s*\d+/.test(oldSrc);
  const caughtCopy = [...oldSrc.matchAll(HUMAN)].map((x) => Number(x[1])).some((n) => n !== SECONDS);
  control('the pre-fix source would be rejected by both checks', !(caughtShape && caughtCopy));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);

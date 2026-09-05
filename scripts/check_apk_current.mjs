/**
 * Fail if the APK the website links is not the one the current source builds.
 *
 *   node scripts/check_apk_current.mjs            # links vs build.gradle vs bytes
 *   node scripts/check_apk_current.mjs --live     # also fetch it from the site
 *   node scripts/check_apk_current.mjs --selftest # prove this check can fail
 *
 * WHY. On 2026-09-05 hawkeye.com.ng served hawkeye-1.2-8.apk, built 14 August,
 * while Lite 1.2 was live on both stores — three weeks of fixes that nobody on
 * the direct-download route ever received. Nothing announced it: a stale link
 * 200s exactly like a fresh one.
 *
 * TWO PAGES link it — app/download.html and the install dialog in app/index.html
 * — and they had drifted from the build script, which was refreshing an entirely
 * different file (app/download/hawkeye.apk) that neither page referenced.
 * Agreeing with each other is not enough; both must agree with build.gradle.
 *
 * THE NAME IS hawkeye-<versionName>-<versionCode>-<sha8>.apk. The hash is what
 * makes the check meaningful: a version-only name can be correct while the bytes
 * behind it are months old, and app/download/ still holds hawkeye-1.2-4.apk
 * through -8.apk from August under a serial that no longer means anything. With
 * the hash in the name, re-hashing the file proves the link, the filename and
 * the bytes are the same artifact — and a rebuilt APK can never reuse a URL that
 * once held different bytes, which app/download/.htaccess says must never happen.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const LIVE = process.argv.includes('--live');
const SELFTEST = process.argv.includes('--selftest');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

export function versionOf(gradleText) {
  const vn = gradleText.match(/versionName\s+"([^"]+)"/)?.[1];
  const vc = gradleText.match(/versionCode\s+(\d+)/)?.[1];
  if (!vn || !vc) throw new Error('could not read versionName/versionCode');
  return { vn, vc };
}
export function linkedApks(htmlText) {
  return [...htmlText.matchAll(/download\/(hawkeye-[0-9a-f._-]+\.apk)/g)].map((m) => m[1]);
}
export function parseName(name) {
  const m = name.match(/^hawkeye-(.+)-(\d+)-([0-9a-f]{8})\.apk$/);
  return m ? { vn: m[1], vc: m[2], sha: m[3] } : null;
}

if (SELFTEST) {
  // A checker nobody has watched fail is one you are trusting on faith.
  const cases = [
    ['detects a legacy unhashed name', parseName('hawkeye-1.2-8.apk') === null],
    ['parses a hashed name', parseName('hawkeye-1.2-9-deadbeef.apk')?.sha === 'deadbeef'],
    ['finds links in html', linkedApks('<a href="download/hawkeye-1.2-9-deadbeef.apk">').length === 1],
    ['reads a version', versionOf('versionName "9.9"\nversionCode 42').vc === '42'],
  ];
  for (const [label, ok] of cases) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  process.exit(cases.every(([, ok]) => ok) ? 0 : 1);
}

const { vn, vc } = versionOf(read('mobile/android/app/build.gradle'));
console.log(`source version: ${vn} (${vc})\n`);
let fails = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); fails++; };
const pass = (m) => console.log(`  PASS  ${m}`);

const names = new Set();
for (const p of ['app/download.html', 'app/index.html']) {
  const links = linkedApks(read(p));
  if (!links.length) { fail(`${p} links no APK`); continue; }
  links.forEach((l) => names.add(l));
  const bad = links.filter((l) => { const q = parseName(l); return !q || q.vn !== vn || q.vc !== vc; });
  if (bad.length) fail(`${p} links ${[...new Set(bad)].join(', ')} — stale, or the pre-hash naming scheme`);
  else pass(`${p} links a current-version APK`);
}
if (names.size > 1) fail(`the two pages link DIFFERENT files: ${[...names].join(' vs ')}`);

for (const name of names) {
  const q = parseName(name);
  const f = path.join(ROOT, 'app/download', name);
  if (!fs.existsSync(f)) { fail(`app/download/${name} missing — run scripts/build_lite_release.sh`); continue; }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 8);
  if (!q) fail(`${name} has no hash in its name, so its bytes cannot be verified against it`);
  else if (sha !== q.sha) fail(`${name} contains bytes hashing to ${sha} — the file is not what its name claims`);
  else pass(`${name} bytes match its name (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);

  if (LIVE) {
    // FULL GET, not HEAD. This host returns NO content-length on HEAD and
    // ignores Range (a `bytes=0-0` request answers 200, not 206), so a
    // header-based size check reads every healthy file as 0 bytes and reports a
    // perfectly good upload as truncated — which is exactly what it did on
    // 2026-09-05. Downloading ~35 MB is the only way to learn the served size
    // here, and this check is opt-in for that reason.
    const url = `https://hawkeye.com.ng/download/${name}`;
    try {
      const r = await fetch(url);
      if (!r.ok) fail(`live ${url} -> HTTP ${r.status}`);
      else {
        const served = (await r.arrayBuffer()).byteLength;
        const want = fs.statSync(f).size;
        if (served !== want) fail(`live ${served}B != local ${want}B — truncated upload`);
        else pass(`live ${url} -> 200, ${served}B, complete`);
      }
    } catch (e) { fail(`live fetch failed: ${e.message}`); }
  }
}

console.log(fails ? `\n${fails} problem(s) — the site is serving a stale, missing or mislabelled APK.`
                  : '\nAPK links are current.');
process.exit(fails ? 1 : 0);

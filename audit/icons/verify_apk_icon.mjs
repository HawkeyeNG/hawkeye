// Confirm the NEW green launcher icon is actually packaged in the built APK.
// Release build obfuscates res/ paths (shrinkResources), so resolve the real
// icon path via aapt2 badging, extract it, and check its mean colour is green.
import { createRequire } from 'module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire('/home/elrio/hawkeye/backend/');
const sharp = require('sharp');

const APK = '/mnt/c/Users/HP/Downloads/hawkeye-capacitor-release.apk';
const HOME = process.env.HOME;
const bt = `${HOME}/android/sdk/build-tools`;
const ver = fs.readdirSync(bt).sort().pop();
const aapt2 = `${bt}/${ver}/aapt2`;
console.log('aapt2:', aapt2);

// The launcher resolves to an adaptive-icon XML; its drawables are obfuscated
// binary refs. Simpler + decisive: pull every res/*.png and inspect the ones at
// launcher densities. OLD icon shipped a WHITE background (#FFFFFF) + white
// corners; NEW icon is green throughout. So "green at launcher sizes, no white"
// proves the new icon shipped.
const SIZES = new Set([36, 48, 72, 96, 108, 144, 162, 192, 216, 324, 432, 512]);
fs.rmSync('/tmp/_ic', { recursive: true, force: true });
fs.mkdirSync('/tmp/_ic');
const names = execSync(`unzip -Z1 "${APK}"`, { encoding: 'utf8' }).split('\n').filter((n) => /^res\/.*\.png$/i.test(n));
execSync(`cd /tmp/_ic && unzip -o "${APK}" "res/*.png" >/dev/null 2>&1 || true`, { stdio: 'ignore' });

let green = 0, white = 0, checked = 0;
for (const n of names) {
  const f = '/tmp/_ic/' + n;
  let meta; try { meta = await sharp(f).metadata(); } catch { continue; }
  if (meta.width !== meta.height || !SIZES.has(meta.width)) continue;
  const [r, g, b] = await sharp(f).resize(1, 1).removeAlpha().raw().toBuffer();
  const isGreen = g > r && g > b && r < 120 && b < 140;
  const isWhite = r > 200 && g > 200 && b > 200;
  if (isGreen) green++; if (isWhite) white++; checked++;
  if (checked <= 16) console.log(`  ${n.padEnd(14)} ${meta.width}px  mean ${r},${g},${b}  ${isGreen ? 'GREEN' : isWhite ? 'WHITE' : 'other'}`);
}
console.log(`\nlauncher-sized square PNGs: ${checked}  |  green: ${green}  white: ${white}`);
console.log(green > 0 && white === 0
  ? 'VERDICT: new green icon shipped, no white assets ✅'
  : white > 0 ? 'VERDICT: white launcher asset still present ❌' : 'VERDICT: inconclusive');

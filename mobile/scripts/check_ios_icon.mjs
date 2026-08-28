/**
 * Did the iOS app icon actually become OUR icon?
 *
 * `cap add ios` ships Capacitor's default app icon — a blue X on white. Nothing
 * in this pipeline replaced it, so TestFlight build 3 installed with that icon
 * on the home screen next to the real Hawkeye. It was not a bug; it was a step
 * that had never been written.
 *
 * `@capacitor/assets generate --ios` fixes it, and this proves it fixed it. A
 * generator that silently no-ops leaves the default in place and still exits 0,
 * which is exactly the shape that got us here.
 *
 * THRESHOLD IS CALIBRATED, NOT GUESSED (tmp/calib_icon.mjs, 2026-08-28):
 *   identical image ............... 0.0
 *   icon-foreground (same crest,
 *     different framing) .......... 28.4
 *   icon-background (flat plate) .. 58.1
 * 10 sits well clear of resampling noise and well below even a near-miss.
 *
 *   node scripts/check_ios_icon.mjs          # run from mobile/
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const sharp = require_('sharp');

const SRC = 'assets/icon-only.png';
const SET = 'ios/App/App/Assets.xcassets/AppIcon.appiconset';
const LIMIT = 10;

if (!fs.existsSync(SET)) {
  console.log(`FAIL: ${SET} does not exist — did the generate step run?`);
  process.exit(1);
}

// Find the 1024 icon by its DIMENSIONS rather than by filename: the generator
// has renamed that file between major versions.
let biggest = null;
for (const f of fs.readdirSync(SET).filter((x) => x.endsWith('.png'))) {
  const p = path.join(SET, f);
  const m = await sharp(p).metadata();
  if (m.width === 1024 && m.height === 1024) biggest = p;
}
if (!biggest) {
  console.log(`FAIL: no 1024x1024 icon in ${SET} — App Store submission needs one`);
  console.log('  found: ' + fs.readdirSync(SET).join(', '));
  process.exit(1);
}

const px = async (p) => sharp(p).resize(24, 24, { fit: 'fill' })
  .flatten({ background: '#fff' }).removeAlpha().raw().toBuffer();
const [a, b] = await Promise.all([px(SRC), px(biggest)]);
let d = 0;
for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
const mad = d / a.length;

// ALPHA IS A HARD REJECTION. App Store icons must be fully opaque; a
// transparent one is refused at upload with a message about the icon, long
// after the build has been spent.
const meta = await sharp(biggest).metadata();
console.log(`  ${path.basename(biggest)}  ${meta.width}x${meta.height}  alpha=${meta.hasAlpha ? 'YES' : 'no'}  diff=${mad.toFixed(1)}`);

let bad = 0;
if (meta.hasAlpha) { console.log('FAIL: the app icon has an alpha channel — App Store upload rejects that'); bad = 1; }
if (mad > LIMIT) {
  console.log(`FAIL: icon differs from ${SRC} by ${mad.toFixed(1)} (limit ${LIMIT}) — still Capacitor's default?`);
  bad = 1;
}
if (!bad) console.log('  ok: the iOS app icon is ours, opaque, and 1024x1024');
process.exit(bad);

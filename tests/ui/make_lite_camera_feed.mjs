/**
 * The fake camera frame for LITE, built against MEASURED geometry.
 *
 * Lite is NOT the native app and its two camera facts are both different:
 *
 *   region aspect   native 0.683 (1318x1930)   ·   LITE 0.563 (440x782)
 *   preview mirror  native yes (selfie flip)   ·   LITE none (transform: none)
 *
 * So this is 9:16 and is NOT pre-flipped. Inheriting the native numbers would
 * put a 0.683 feed into a 0.563 region under object-fit:cover, which crops the
 * sheet's sides away, and an hflip would reverse a preview that never mirrors.
 * Both facts came from opening the real overlay and reading the computed style,
 * not from the native script's comments.
 *
 * The sheet is inset to 66% of the frame so the surface it lies on shows all
 * round it, inside the app's gold corner guides.
 *
 * The sheet is the SPECIMEN: blank, struck SPECIMEN, polling unit 00-00-00-000,
 * which is in no register. A real EC8A carries a real unit's real votes and has
 * no business on a store listing.
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const require_ = createRequire('/home/elrio/hawkeye/backend/');
const sharp = require_('sharp');

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };

const SPECIMEN = '/home/elrio/hawkeye/app/play-shots/specimen-ec8a.png';
const FRAME = '/tmp/lite-camera-frame.png';
const FEED = '/tmp/lite-camera-feed.y4m';

if (!fs.existsSync(SPECIMEN)) {
  console.error(`no specimen at ${SPECIMEN} — run: node backend/scripts/make_specimen_ec8a.mjs`);
  process.exit(2);
}

const W = 720, H = 1280;                  // 0.5625, matching the measured 0.563
/* 76%, not the native builder's 66%. Lite's region is TALLER relative to its
   width (0.563 vs 0.683), so the same fraction leaves far more dead grey above
   and below the sheet — at 66% the sheet covered barely half the frame height
   and the shot read as mostly empty floor. 76% still clears the gold corner
   guides, which sit ~30px inside the region. */
const INSET = Number(arg('inset', '0.76'));
const sheetW = Math.round(W * INSET);
const sheet = await sharp(SPECIMEN)
  .flatten({ background: '#ffffff' })
  .resize({ width: sheetW, fit: 'inside' })
  .toBuffer();
const m = await sharp(sheet).metadata();

await sharp({ create: { width: W, height: H, channels: 3, background: '#3f4643' } })
  .composite([{ input: sheet, left: Math.round((W - m.width) / 2), top: Math.round((H - m.height) / 2) }])
  .png()
  .toFile(FRAME);

console.log(`frame ${W}x${H} (aspect ${(W / H).toFixed(3)}), sheet ${m.width}x${m.height}`
  + ` = ${((m.width / W) * 100).toFixed(0)}% wide, ${((m.height / H) * 100).toFixed(0)}% tall`);

// NO hflip: Lite's preview reports transform:none.
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', FRAME,
  '-t', '3', '-r', '5', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, FEED], { stdio: 'inherit' });

const kb = Math.round(fs.statSync(FEED).size / 1024);
console.log(`feed -> ${FEED}  ${kb}KB`);

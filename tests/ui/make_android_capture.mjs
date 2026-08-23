/**
 * The Android capture screenshot: YOUR device's ML Kit scanner UI, with the
 * specimen sheet placed in the camera viewport.
 *
 * The chrome is genuine — top bar, shutter, Manual/Auto capture toggle and the
 * "Hawkeye will have access only to the images you scan" line all come straight
 * off a real phone. That matters: the scanner UI is a Play-services surface that
 * Google draws at runtime, so it cannot be rendered by the web build and could
 * not be recreated by hand without inventing Google's interface. Only the camera
 * CONTENT is supplied, which is what the camera would show pointed at a sheet.
 *
 * Geometry is measured, not guessed: the viewport is the pure-black band at
 * y 75..874 (the bar above and the panel below are both #131313).
 */
import sharp from '/home/elrio/hawkeye/backend/node_modules/sharp/dist/index.cjs';

const SRC = '/mnt/c/Users/HP/Downloads/5789690987201368074.jpg';
const OUT = '/tmp/raw/1-capture.android.png';
const VIEW_TOP = 75;
const VIEW_BOT = 874;

const base = sharp(SRC);
const meta = await base.metadata();
const vw = meta.width;
const vh = VIEW_BOT - VIEW_TOP;

// The surface the sheet is lying on, filling the viewport as a camera would see
// it, then the sheet inset so the surface shows all round — the same framing
// asked for on iOS.
const surface = await sharp({ create: { width: vw, height: vh, channels: 3, background: '#3f4643' } })
  .png().toBuffer();
const sheetH = Math.round(vh * 0.88);
const sheet = await sharp('/tmp/specimen-ec8a.png')
  .flatten({ background: '#ffffff' })
  .resize({ height: sheetH, fit: 'inside' })
  .toBuffer();
const sm = await sharp(sheet).metadata();
const viewport = await sharp(surface)
  .composite([{ input: sheet, left: Math.round((vw - sm.width) / 2), top: Math.round((vh - sm.height) / 2) }])
  .png().toBuffer();

const withSheet = await sharp(SRC)
  .composite([{ input: viewport, left: 0, top: VIEW_TOP }])
  .png().toBuffer();

/**
 * Pad to the same 1320x2868 frame the other raw shots use, in the UI's own
 * #131313, so this flows through make_store_screenshots.mjs unchanged.
 *
 * Placed at the TOP because that script crops the device from the top and bleeds
 * it off the bottom edge — it keeps roughly the top 81% for Play. Anything below
 * that line is cut, and the grey panel with the shutter and the toggle is the
 * whole point of this shot.
 */
const W = 1320;
const H = 2868;
const scaled = await sharp(withSheet).resize({ width: W }).png().toBuffer();
const sc = await sharp(scaled).metadata();
await sharp({ create: { width: W, height: H, channels: 3, background: '#131313' } })
  .composite([{ input: scaled, left: 0, top: 0 }])
  .removeAlpha()
  .png()
  .toFile(OUT);

console.log(`viewport ${vw}x${vh}, sheet ${sm.width}x${sm.height} (${Math.round(sm.height / vh * 100)}% tall)`);
console.log(`UI occupies 0..${sc.height} of ${H} (${Math.round(sc.height / H * 100)}%) — inside the ~81% Play keeps`);
console.log(`wrote ${OUT}`);

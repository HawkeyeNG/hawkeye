/**
 * The Android capture screenshot: the device's real ML Kit scanner chrome, at a
 * full phone screen's proportions.
 *
 * The source is a CROP — 1066x1280, aspect 0.833, where a phone screen is nearer
 * 0.45. Padding it to a phone-shaped canvas simply grew the black below the
 * panel, which put the panel at 62% of the frame when on a real device it is
 * closer to a fifth. Both wrong, and wrong in a way that reads as a mistake.
 *
 * So it is REASSEMBLED rather than padded. The top bar and the whole bottom
 * panel — shutter, Manual/Auto toggle, privacy line — are lifted pixel-for-pixel
 * from the device capture and keep their true height. Only the VIEWPORT is
 * rebuilt, to the height a real phone gives it, holding the surface and the
 * specimen sheet. A camera preview is the one region whose content is whatever
 * the lens is pointed at, so its extent is the honest thing to set and its
 * chrome is not.
 *
 * Measured, not guessed: bar y 0..74, viewport y 75..874 (pure black), panel
 * y 875..1280. The bar and panel are both #131313.
 */
import sharp from '/home/elrio/hawkeye/backend/node_modules/sharp/dist/index.cjs';

const SRC = '/mnt/c/Users/HP/Downloads/5789690987201368074.jpg';
const OUT = '/tmp/raw/1-capture.android.png';
const BAR_BOT = 75;
const PANEL_TOP = 875;
const W = 1320;
const H = 2868;

const meta = await sharp(SRC).metadata();
const scale = W / meta.width;

const bar = await sharp(SRC)
  .extract({ left: 0, top: 0, width: meta.width, height: BAR_BOT })
  .resize({ width: W }).png().toBuffer();
const panel = await sharp(SRC)
  .extract({ left: 0, top: PANEL_TOP, width: meta.width, height: meta.height - PANEL_TOP })
  .resize({ width: W }).png().toBuffer();
const barH = (await sharp(bar).metadata()).height;
const panelH = (await sharp(panel).metadata()).height;

/**
 * THE VIEWPORT IS SIZED TO WHAT SURVIVES THE CROP, not to the canvas.
 *
 * make_store_screenshots.mjs fits the device with `cover, position: top` and
 * bleeds it off the bottom edge, so roughly the top 81% of this frame is what a
 * reader sees. Sizing the viewport to fill the whole 2868 pushed the panel —
 * the shutter, the Manual/Auto toggle, the privacy line, the whole reason this
 * shot is the Android one — clean off the bottom of the visible device.
 *
 * So the bar, the viewport and the panel are laid out to end at that line, and
 * the remainder below is the panel's own #131313 continuing to the screen edge,
 * exactly as it does on the phone.
 */
const VISIBLE = 0.81;
const viewH = Math.round(H * VISIBLE) - barH - panelH;

// The viewport, at the height a phone actually gives it: the surface the sheet
// lies on, with the sheet inset so the surface shows all round — the same
// framing as the iOS shot.
const sheetH = Math.round(viewH * 0.74);
const sheet = await sharp('/tmp/specimen-ec8a.png')
  .flatten({ background: '#ffffff' })
  .resize({ height: sheetH, fit: 'inside' })
  .toBuffer();
const sm = await sharp(sheet).metadata();
const viewport = await sharp({ create: { width: W, height: viewH, channels: 3, background: '#3f4643' } })
  .composite([{ input: sheet, left: Math.round((W - sm.width) / 2), top: Math.round((viewH - sm.height) / 2) }])
  .png().toBuffer();

await sharp({ create: { width: W, height: H, channels: 3, background: '#131313' } })
  .composite([
    { input: bar, left: 0, top: 0 },
    { input: viewport, left: 0, top: barH },
    { input: panel, left: 0, top: barH + viewH },
  ])
  .removeAlpha()
  .png()
  .toFile(OUT);

const visible = Math.round(H * VISIBLE);
const pct = (n) => `${Math.round((n / visible) * 100)}%`;
console.log(`scale ${scale.toFixed(3)}  of the VISIBLE ${visible}px: bar ${barH} (${pct(barH)})`
  + `  viewport ${viewH} (${pct(viewH)})  panel ${panelH} (${pct(panelH)})`);
console.log(`panel ends at y=${barH + viewH + panelH}, visible to y=${visible} — ${barH + viewH + panelH <= visible ? 'inside' : 'CUT OFF'}`);
console.log(`sheet ${sm.width}x${sm.height} — ${Math.round((sm.height / viewH) * 100)}% of the viewport`);
console.log(`wrote ${OUT}`);

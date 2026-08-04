// Regenerate every launcher/app icon from the new green-plate master.
//
// The AI master (src/plate.jpg) is a dark-green rounded-square on a WHITE canvas
// (thin margin + rounded corners). Launcher masks (iOS squircle, web square, PWA
// maskable) would show white slivers, so we flood-fill the connected outer white
// region to the plate's own green — full-bleed square, corners gone. The interior
// white eye-catchlight is NOT corner-connected, so the flood-fill leaves it intact.
//
// One opaque master then serves every platform: iOS/Android-legacy/web = the plate;
// Android adaptive foreground = the plate (bg is the same green → seamless under the
// 16.7% inset); adaptive background = solid plate-green.
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire('/home/elrio/hawkeye/backend/');
const sharp = require('sharp');

const ROOT = '/home/elrio/hawkeye';
const SRC = path.join(ROOT, 'audit/icons/src/plate.jpg');
const OUT = path.join(ROOT, 'audit/icons/build');
fs.mkdirSync(OUT, { recursive: true });
const N = 1024;

// ---- raw source (only for sampling the plate's green) ------------------------
const data = await sharp(SRC).resize(N, N, { fit: 'cover' }).ensureAlpha().raw().toBuffer();

// ---- sample the plate green (top band, above the hawk head, excluding margin) -
let sr = 0, sg = 0, sb = 0, sn = 0;
for (let y = 95; y < 150; y++) {
  for (let x = 300; x < 724; x++) {
    const i = (y * N + x) * 4;
    if (data[i] > 205 && data[i + 1] > 205 && data[i + 2] > 205) continue; // skip white
    sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; sn++;
  }
}
const G = { r: Math.round(sr / sn), g: Math.round(sg / sn), b: Math.round(sb / sn) };
const HEX = '#' + [G.r, G.g, G.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

// ---- master: zoom-crop to full-bleed -----------------------------------------
// Scale up ~20% and centre-crop so the white margin, the rounded corners AND the
// plate's inner keyline all fall off-canvas. Keeps the plate's own edge-green (so
// there's no flat-fill seam / ghost outline) and never touches the eye catchlight.
const ZOOM = 1.20;
const big = Math.round(N * ZOOM), off = Math.round((big - N) / 2);
const masterPng = await sharp(SRC).resize(big, big, { fit: 'cover' })
  .extract({ left: off, top: off, width: N, height: N }).png().toBuffer();
fs.writeFileSync(path.join(OUT, 'master.png'), masterPng);

// sanity: the four corners must now be green, not white
const cc = await sharp(masterPng).ensureAlpha().raw().toBuffer();
let warn = 0;
for (const [x, y] of [[4, 4], [N - 5, 4], [4, N - 5], [N - 5, N - 5]]) {
  const i = (y * N + x) * 4;
  if (cc[i] > 150 && cc[i + 1] > 150 && cc[i + 2] > 150) { console.warn(`WARN near-white corner @${x},${y}: ${cc[i]},${cc[i + 1]},${cc[i + 2]}`); warn++; }
}
console.log(`plate green ${HEX} (sampled ${sn}px)   zoom ${ZOOM}  corners ${warn ? 'WHITE!' : 'clean'}`);

// ---- generators --------------------------------------------------------------
const plate = (size) => sharp(masterPng).resize(size, size, { fit: 'cover' }).png().toBuffer();
const green = (size) => sharp({ create: { width: size, height: size, channels: 4, background: { ...G, alpha: 1 } } }).png().toBuffer();
const round = async (size) => {
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);
  return sharp(await plate(size)).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
};
const gen = { plate, green, round };

const sizeOf = (p, fallback) => {
  try { const s = require('child_process').execSync; } catch {}
  return fallback;
};
async function metaSize(p, fallback) {
  try { const m = await sharp(p).metadata(); return Math.max(m.width, m.height) || fallback; }
  catch { return fallback; }
}

// ---- target list -------------------------------------------------------------
const targets = [];
// native (expo) — match existing sizes
const NAT = path.join(ROOT, 'native/assets/images');
for (const [file, kind, fb] of [
  ['icon.png', 'plate', 1024], ['ios-icon.png', 'plate', 1024], ['favicon.png', 'plate', 48],
  ['android-icon-foreground.png', 'plate', 1024], ['android-icon-background.png', 'green', 1024],
]) targets.push({ path: path.join(NAT, file), kind, size: await metaSize(path.join(NAT, file), fb) });

// mobile (capacitor) mipmaps — every density, match existing sizes
const RES = path.join(ROOT, 'mobile/android/app/src/main/res');
const KIND = { 'ic_launcher.png': 'plate', 'ic_launcher_round.png': 'round', 'ic_launcher_foreground.png': 'plate', 'ic_launcher_background.png': 'green' };
for (const d of fs.readdirSync(RES).filter((x) => x.startsWith('mipmap-') && x !== 'mipmap-anydpi-v26')) {
  const dir = path.join(RES, d);
  for (const f of fs.readdirSync(dir)) {
    if (KIND[f]) targets.push({ path: path.join(dir, f), kind: KIND[f], size: await metaSize(path.join(dir, f), 108) });
  }
}
// capacitor generator sources
const MASSETS = path.join(ROOT, 'mobile/assets');
for (const [file, kind] of [['icon-only.png', 'plate'], ['icon-foreground.png', 'plate'], ['icon-background.png', 'green']])
  targets.push({ path: path.join(MASSETS, file), kind, size: await metaSize(path.join(MASSETS, file), 1024) });

// app (web/PWA)
const APP = path.join(ROOT, 'app');
targets.push({ path: path.join(APP, 'apple-touch-icon.png'), kind: 'plate', size: await metaSize(path.join(APP, 'apple-touch-icon.png'), 180) });
for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-192-maskable.png', 192], ['icon-512-maskable.png', 512]])
  targets.push({ path: path.join(APP, file), kind: 'plate', size });

// ---- write -------------------------------------------------------------------
for (const t of targets) {
  const buf = await gen[t.kind](t.size);
  fs.writeFileSync(t.path, buf);
  console.log(`  ${t.kind.padEnd(6)} ${t.size}px  ${t.path.replace(ROOT + '/', '')}`);
}
// emit the green hex for wiring app.json / colors.xml
fs.writeFileSync(path.join(OUT, 'green.txt'), HEX);
console.log(`\nDONE ${targets.length} files. plate green = ${HEX}`);

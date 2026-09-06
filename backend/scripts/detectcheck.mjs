/**
 * Validate the table detector against the real corpus.
 *
 *   node scripts/detectcheck.mjs [n] [--overlay=key1,key2]
 *
 * NOTE ON WHAT COUNTS AS EVIDENCE. An earlier version of this script reported
 * "0 failures across 672 bands" from a check that built each band out of
 * detected.lines and then asked whether it contained detected.lines. It could
 * not fail. That number is gone; nothing below compares the detector to itself.
 *
 * What is left is genuinely falsifiable:
 *   - inlier count out of 17, which is low when the fit is guessing
 *   - the SPREAD of detected geometry: sheets are photographs of the same
 *     printed form, so a correct detector must find a similar row PITCH on all
 *     of them. A wide pitch distribution means some fits are wrong, however
 *     confident each one looks on its own.
 *   - overlays, because only looking can confirm the comb sits on the party
 *     table rather than on some other set of evenly spaced lines.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { detectRows, bandFromLines, TABLE_LINES } from '../src/services/ec8a_table_detect.js';

const SHEETS = '/home/elrio/hawkeye/audits/2026-osun-governorship/sheets';
const N = Number(process.argv[2] || 40);
const overlayArg = process.argv.find((a) => a.startsWith('--overlay='));
const overlayKeys = (overlayArg ? overlayArg.split('=')[1] : '').split(',').filter(Boolean);

const all = fs.readdirSync(SHEETS).filter((f) => f.endsWith('.jpg')).sort();
const step = Math.max(1, Math.floor(all.length / N));
const sample = [];
for (let i = 0; i < all.length && sample.length < N; i += step) sample.push(all[i]);
for (const k of overlayKeys) if (!sample.includes(`${k}.jpg`)) sample.push(`${k}.jpg`);

const WORK_W = 1000;
const rows = [];
for (const file of sample) {
  const src = path.join(SHEETS, file);
  const { data, info } = await sharp(src).greyscale().resize({ width: WORK_W })
    .raw().toBuffer({ resolveWithObject: true });
  rows.push({ file, info, src, det: detectRows(data, info) });
}

const ok = rows.filter((r) => r.det);
console.log(`sampled ${rows.length} sheets across the corpus`);
console.log(`detected: ${ok.length}/${rows.length} (${(100 * ok.length / rows.length).toFixed(1)}%)   `
  + `refused: ${rows.length - ok.length}\n`);

const stat = (a) => {
  if (!a.length) return 'n/a';
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `min ${s[0].toFixed(2)}  p25 ${q(0.25).toFixed(2)}  median ${q(0.5).toFixed(2)}  p75 ${q(0.75).toFixed(2)}  max ${s[s.length - 1].toFixed(2)}`;
};
const pctH = (r, v) => (100 * v / r.info.height);
console.log('inliers of 17    :', stat(ok.map((r) => r.det.inliers)));
console.log('row pitch   (%H) :', stat(ok.map((r) => pctH(r, r.det.pitch))));
console.log('first rule  (%H) :', stat(ok.map((r) => pctH(r, r.det.first))));
console.log('last rule   (%H) :', stat(ok.map((r) => pctH(r, r.det.lines[TABLE_LINES - 1]))));
console.log('\nthe OLD fixed model said: pitch 4.44, first 24.0, last 95.0');

// THE FALSIFIABLE ONE. Every sheet photographs the same printed form, so the
// row pitch as a fraction of the FORM should be near-constant. It is expressed
// here relative to the detected table height, which cancels how much margin the
// photographer left. A tight spread means the fits agree with each other; a
// wide one means some are wrong no matter how confident they look alone.
const ratio = ok.map((r) => r.det.pitch / (r.det.lines[TABLE_LINES - 1] - r.det.lines[0]));
console.log('\npitch / table-height (must be ~1/16 = 0.0625 for every sheet):');
console.log('  ', stat(ratio));

const outliers = ok.filter((r) => {
  const p = pctH(r, r.det.pitch);
  return p < 1.8 || p > 3.6;
});
console.log(`\npitch outliers (outside 1.8-3.6 %H): ${outliers.length}`);
for (const r of outliers.slice(0, 12)) {
  console.log(`   ${r.file}  pitch ${pctH(r, r.det.pitch).toFixed(2)}%H  inliers ${r.det.inliers}  first ${pctH(r, r.det.first).toFixed(1)}%`);
}

for (const k of overlayKeys) {
  const r = rows.find((x) => x.file === `${k}.jpg`);
  if (!r || !r.det) { console.log(`\nno detection for ${k} (refused)`); continue; }
  const kk = 820 / r.info.width;
  const s = (v) => Math.round(v * kk);
  const ph = Math.round(r.info.height * kk);
  const lines = r.det.lines.map((y, i) =>
    `<line x1="${s(r.info.width * 0.10)}" y1="${s(y)}" x2="${s(r.info.width * 0.80)}" y2="${s(y)}" `
    + `stroke="${i === 0 || i === TABLE_LINES - 1 ? '#e11d48' : '#22c55e'}" stroke-width="2"/>`).join('');
  const b0 = bandFromLines(r.det, r.info, 0);
  const svg = Buffer.from(`<svg width="820" height="${ph}" xmlns="http://www.w3.org/2000/svg">`
    + `<rect x="${s(b0.left)}" y="${s(b0.top)}" width="${s(b0.width)}" height="${s(b0.height)}" fill="#3b82f6" fill-opacity="0.25" stroke="#2563eb" stroke-width="2"/>`
    + lines + `</svg>`);
  await sharp(r.src).resize({ width: 820 }).composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 84 }).toFile(`/tmp/detect-${k}.jpg`);
  console.log(`\nwrote /tmp/detect-${k}.jpg  inliers=${r.det.inliers}/17 pitch=${pctH(r, r.det.pitch).toFixed(2)}%H`);
}

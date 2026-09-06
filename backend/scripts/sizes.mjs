/**
 * What does ONE observer actually upload?
 *
 * The trigger point for paying for R2 depends entirely on bytes per observer,
 * so this measures rather than assumes. Replicates app.js:compressCapture
 * exactly — sheet 1500px/q0.76, venue 1280px/q0.72 — over real sheets.
 *
 * Caveat stated up front: the audit corpus is already INEC's 1500px derivative,
 * so re-encoding it is a LOWER BOUND for a phone photo of the same sheet, which
 * starts from a 12MP camera frame. Both numbers are printed.
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const SHEETS = '/home/elrio/hawkeye/audits/2026-osun-governorship/sheets';
const all = fs.readdirSync(SHEETS).filter((f) => f.endsWith('.jpg')).sort();
const step = Math.floor(all.length / 40);
const sample = [];
for (let i = 0; i < all.length && sample.length < 40; i += step) sample.push(all[i]);

const stat = (a, unit = 'KB') => {
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((t, v) => t + v, 0) / s.length;
  return `mean ${mean.toFixed(0)} ${unit}  median ${q(0.5).toFixed(0)}  p90 ${q(0.9).toFixed(0)}  max ${s[s.length - 1].toFixed(0)}`;
};

const onDisk = [];
const asSheet = [];
const asVenue = [];
for (const f of sample) {
  const p = path.join(SHEETS, f);
  onDisk.push(fs.statSync(p).size / 1024);
  const sheet = await sharp(p).resize({ width: 1500, height: 1500, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 76 }).toBuffer();
  asSheet.push(sheet.length / 1024);
  const venue = await sharp(p).resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 }).toBuffer();
  asVenue.push(venue.length / 1024);
}

console.log(`sampled ${sample.length} real sheets\n`);
console.log('as stored by INEC pull   :', stat(onDisk));
console.log('re-encoded 1500/q0.76    :', stat(asSheet), ' <- the sheet photo');
console.log('re-encoded 1280/q0.72    :', stat(asVenue), ' <- the venue photo');

const meanSheet = asSheet.reduce((t, v) => t + v, 0) / asSheet.length;
const meanVenue = asVenue.reduce((t, v) => t + v, 0) / asVenue.length;
const perObserver = meanSheet + meanVenue;
console.log(`\nONE OBSERVER = 1 sheet + 1 venue photo = ${perObserver.toFixed(0)} KB`);
console.log('(lower bound: the corpus is already a 1500px derivative, so a phone');
console.log(' photo of the same sheet starts from more detail and lands higher)');

const MB = 1024;
const GB = 1024 * 1024;
console.log('\n--- what fits in the GO54 caps ---');
const DISK_FREE = (120 - 3) * GB;        // 120 GB cap, ~3 GB already used
const BW = 150 * GB;                     // 150 GB/month, inbound AND outbound
for (const label of ['disk (120 GB hard cap, 3 GB used)', 'bandwidth, uploads only', 'bandwidth, uploads + 1 view each', 'bandwidth, uploads + 3 views each']) {
  let cap;
  if (label.startsWith('disk')) cap = DISK_FREE / perObserver;
  else if (label.endsWith('uploads only')) cap = BW / perObserver;
  else if (label.endsWith('1 view each')) cap = BW / (perObserver * 2);
  else cap = BW / (perObserver * 4);
  console.log(`  ${label.padEnd(38)} ${Math.round(cap).toLocaleString()} observers`);
}

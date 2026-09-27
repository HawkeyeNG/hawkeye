#!/usr/bin/env node
// Synthetic "sheet" and "venue" JPEGs at the MEASURED production sizes
// (sheet ~218 KB at 1500 px, venue ~152 KB at 1280 px; DIRECT-UPLOAD.md), so the
// upload test moves realistic bytes. They are noise plus a grid and a banner
// reading "LOADTEST - SYNTHETIC - NOT AN INEC SHEET". Never use a real observer
// photo or a real EC8A here.
//
//   node scripts/loadtest/seed/make_sample_jpegs.mjs [outDir]
// Uses sharp from backend/node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../backend/package.json', import.meta.url));
const sharp = require('sharp');

const outDir = path.resolve(process.argv[2] || new URL('../.fixtures/', import.meta.url).pathname);
fs.mkdirSync(outDir, { recursive: true });

function overlay(w, h) {
  const lines = [];
  for (let y = 120; y < h; y += 60) lines.push(`<line x1="40" y1="${y}" x2="${w - 40}" y2="${y}" stroke="#333" stroke-width="2"/>`);
  for (let x = 40; x < w; x += 250) lines.push(`<line x1="${x}" y1="120" x2="${x}" y2="${h - 40}" stroke="#333" stroke-width="2"/>`);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="0" y="0" width="${w}" height="100" fill="#c00"/>
    <text x="40" y="68" font-family="sans-serif" font-size="44" fill="#fff">LOADTEST - SYNTHETIC - NOT AN INEC SHEET</text>
    ${lines.join('')}</svg>`);
}

async function render(w, h, sigma, quality) {
  return sharp({ create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 200, sigma } } })
    .composite([{ input: overlay(w, h) }])
    // PROGRESSIVE with libjpeg's standard scan script: the first scan holds only
    // the DC coefficients, which lib/jpeg.js replaces per report (unique pixels).
    .jpeg({ quality, progressive: true, mozjpeg: false, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

// Binary-search the noise level until the file lands within 10% of the target.
async function make(name, w, h, quality, targetKB) {
  let lo = 1; let hi = 80; let best = null;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const buf = await render(w, h, mid, quality);
    const kb = buf.length / 1024;
    if (!best || Math.abs(kb - targetKB) < Math.abs(best.length / 1024 - targetKB)) best = buf;
    if (Math.abs(kb - targetKB) / targetKB < 0.1) break;
    if (kb > targetKB) hi = mid; else lo = mid;
  }
  const file = path.join(outDir, name);
  fs.writeFileSync(file, best);
  console.log(`${file}  ${(best.length / 1024).toFixed(0)} KB  (target ${targetKB} KB)`);
}

await make('sheet.jpg', 1500, 2000, 76, 218);
await make('venue.jpg', 1280, 960, 72, 152);

/**
 * A stand-in "phone screenshot" for testing the store-screenshot compositor.
 *
 *   node scripts/make_fixture_shot.mjs /tmp/rawshots/1-capture.png
 *
 * Approximates Hawkeye's actual look — a very dark green UI with a card and a
 * header bar — because the thing being tested is whether a DARK screenshot
 * separates from the background. A flat fill cannot answer that.
 */
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

const out = process.argv[2] || '/tmp/rawshots/1-capture.png';
fs.mkdirSync(path.dirname(out), { recursive: true });

const W = 1080;
const H = 2400;
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#0d1f16"/>
  <rect x="0" y="0" width="${W}" height="150" fill="#06170f"/>
  <text x="60" y="98" font-family="Arial" font-size="54" font-weight="700" fill="#e8f2ec">Report</text>
  <rect x="60" y="230" width="960" height="1180" rx="28" fill="#12362a"/>
  <rect x="110" y="300" width="640" height="44" rx="10" fill="#1d4d3b"/>
  <rect x="110" y="380" width="860" height="900" rx="16" fill="#0a2a1e"/>
  <rect x="60" y="1470" width="960" height="120" rx="24" fill="#f5b301"/>
  <text x="540" y="1548" text-anchor="middle" font-family="Arial" font-size="48"
        font-weight="700" fill="#06170f">Use this photo</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`fixture written: ${out}`);

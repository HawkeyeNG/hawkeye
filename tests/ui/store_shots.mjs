/**
 * Turn the raw captures into store-ready assets for BOTH listings.
 *
 * The raw frame is 1320x2868, which is exactly Apple's 6.9" display size
 * (iPhone 16 Pro Max) — so iOS takes them untouched. Play is the one that needs
 * work: its phone slot caps the longer side at TWICE the shorter, and
 * 2868/1320 = 2.17. Uploading these as-is is a rejection at the upload step.
 * Cropping the foot off is right rather than letterboxing, because everything
 * these shots are about sits at the top of the frame.
 *
 * Also flattens alpha: Play wants 24-bit PNG with no alpha channel.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from '/home/elrio/hawkeye/backend/node_modules/sharp/dist/index.cjs';

const SRC = '/tmp/raw';
const OUT = process.argv[2] || '/mnt/c/Users/HP/Downloads/hawkeye-screenshots';
const ORDER = ['3-published.png', '4-result.png', '5-map.png', '6-practice.png'];

const ios = path.join(OUT, 'ios-6.9');
const play = path.join(OUT, 'play-phone');
fs.mkdirSync(ios, { recursive: true });
fs.mkdirSync(play, { recursive: true });

let n = 0;
for (const f of ORDER) {
  const src = path.join(SRC, f);
  if (!fs.existsSync(src)) { console.log(`SKIP ${f} — not captured`); continue; }
  const meta = await sharp(src).metadata();
  if (meta.width !== 1320 || meta.height !== 2868) {
    console.log(`SKIP ${f} — unexpected ${meta.width}x${meta.height}, expected 1320x2868`);
    continue;
  }
  n += 1;
  const name = `${String(n).padStart(2, '0')}-${f.replace(/^\d+-/, '')}`;

  // iOS 6.9" — the native frame, alpha flattened.
  await sharp(src).flatten({ background: '#ffffff' }).png().toFile(path.join(ios, name));

  // Play phone — 1320x2640 is exactly 2:1, the limit rather than past it.
  await sharp(src)
    .extract({ left: 0, top: 0, width: 1320, height: 2640 })
    .flatten({ background: '#ffffff' })
    .png()
    .toFile(path.join(play, name));

  console.log(`${name}  ios 1320x2868   play 1320x2640`);
}

// Prove the outputs are what the stores accept, rather than assuming the writes
// did what the calls said.
console.log('\nverifying what was actually written:');
let bad = 0;
for (const [label, dir, want] of [['ios ', ios, [1320, 2868]], ['play', play, [1320, 2640]]]) {
  for (const f of fs.readdirSync(dir).sort()) {
    const m = await sharp(path.join(dir, f)).metadata();
    const ratio = m.height / m.width;
    const okDim = m.width === want[0] && m.height === want[1];
    const okRatio = label === 'ios ' ? true : ratio <= 2.0001;
    const okAlpha = !m.hasAlpha;
    if (!(okDim && okRatio && okAlpha)) bad += 1;
    console.log(`  ${label} ${f.padEnd(18)} ${m.width}x${m.height} ratio=${ratio.toFixed(3)} alpha=${m.hasAlpha} ${okDim && okRatio && okAlpha ? 'ok' : 'WRONG'}`);
  }
}
console.log(bad ? `\n${bad} file(s) wrong` : `\n${n} screenshots ready in ${OUT}`);
process.exit(bad ? 1 : 0);

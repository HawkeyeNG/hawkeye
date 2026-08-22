/**
 * Turn raw phone screenshots into captioned Play Store assets.
 *
 *   node scripts/make_store_screenshots.mjs --in raw/ --out ../app/play-shots/
 *
 * Takes the style of the Facebook listing: a saturated brand background, a
 * large two-line caption at the top, and the phone screenshot below it, bled
 * off the bottom edge so it reads as a device rather than a picture of one.
 *
 * WHY CAPTIONS. Play shows screenshots at roughly thumbnail size in search
 * results, and most people never scroll past the second. At that size a raw UI
 * capture is an unreadable grey rectangle; a six-word caption is legible. The
 * caption carries the message and the UI behind it is texture.
 *
 * WHAT TO SHOOT is listed in CAPTIONS below — the order matters more than the
 * polish. Screens 1-3 must show the core action (photograph a sheet, check the
 * figures, publish), because that is the product and it is currently absent
 * from the store entirely. Never ship an empty state: three of the six live
 * screenshots today are grey maps and a leaderboard reading "Nothing is being
 * ranked yet", which tells a prospective observer the app has nothing in it.
 *
 * Play wants 2-8 phone screenshots, 16:9 or 9:16, min 320px, max 3840px.
 * These render at 1080x1920, which is inside every constraint.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };

const inDir = arg('in', 'raw');
const outDir = arg('out', '../app/play-shots');

const W = 1080;
const H = 1920;
/**
 * BRAND.leaf, not BRAND.green.
 *
 * The Facebook listing this copies works because a saturated blue sits behind a
 * WHITE app UI — the device separates from the background at a glance. Hawkeye's
 * UI is dark green, so putting it on the dark brand green (#004225) produced a
 * device that was nearly invisible; the first render was a green rectangle on a
 * green rectangle. `leaf` (#0b6b3a) is light enough to throw the dark UI
 * forward while still being unmistakably Hawkeye. Override with --bg.
 */
const BG = arg('bg', '#0b6b3a');
const INK = '#ffffff';
/** A hairline rim so the device reads as a device on ANY background. */
const RIM = 'rgba(255,255,255,0.28)';

/**
 * The shot list. Order is the ranking — most people see 1 and 2 only.
 *
 * `file` is what to name the raw capture; anything not present is skipped, so
 * this can be run with a partial set while the rest are still being taken.
 */
const CAPTIONS = [
  {
    file: '1-capture.png',
    lines: ['Photograph the', 'result sheet'],
    shoot: 'The capture screen with the SPECIMEN sheet in frame — generate it with '
      + 'make_specimen_ec8a.mjs and print it. A real EC8A cannot be used: it carries a real '
      + "unit's real votes, and putting that on a store listing shows results Hawkeye has no "
      + 'business publishing. The specimen is blank by design.',
  },
  {
    file: '2-figures.png',
    lines: ['Type what you', 'see on the sheet'],
    shoot: 'The entry step with the sheet photo still on screen. Counts may be blank or nominal — '
      + 'the message is that the photo stays visible while you type, not what the numbers say.',
  },
  {
    file: '3-published.png',
    lines: ['Published where', 'anyone can check'],
    shoot: 'The receipt after filing a PRACTICE run: entry hash and anchor, on the practice chain. '
      + 'Real and populated without publishing anyone real. The differentiator no other election '
      + 'app has.',
  },
  {
    file: '4-result.png',
    lines: ['Every result,', 'permanently'],
    shoot: 'The Osun 2026 race page (/osun) showing the DECLARED result — Adeleke 511,067 v '
      + 'Oyebamiji 444,815, LGAs won, returning officer, sources. NOT the leaderboard: the '
      + 'leaderboard is empty until an election is live and practice does not feed it. This page '
      + 'is real, official, sourced and already populated today.',
  },
  {
    file: '5-map.png',
    lines: ['Every seat in', 'the country'],
    shoot: 'The political map with all 37 governorships coloured by party — real data shipping in '
      + 'political_data.json right now. Populated on any device, any day.',
  },
  {
    file: '6-practice.png',
    lines: ['Practise before', 'election day'],
    shoot: 'The practice run mid-flow. Answers "what do I do with this between elections", which '
      + 'is also the retention story Play ranks on.',
  },
];

/** Escape for embedding in SVG text. */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The caption block, as an SVG overlay.
 *
 * Two lines maximum and a hard cap on characters per line: the whole point is
 * legibility at thumbnail size, and a caption that wraps to three lines has
 * already failed at that. Font size steps down for long lines rather than
 * letting them overflow the canvas.
 */
function captionSvg(lines) {
  const longest = Math.max(...lines.map((l) => l.length));
  const size = longest > 18 ? 84 : longest > 14 ? 96 : 108;
  const lineHeight = Math.round(size * 1.18);
  const top = 150;
  const text = lines.map((l, i) => `
    <text x="${W / 2}" y="${top + i * lineHeight}" text-anchor="middle"
          font-family="Inter, 'Helvetica Neue', Arial, sans-serif"
          font-size="${size}" font-weight="800" fill="${INK}"
          letter-spacing="-1.5">${esc(l)}</text>`).join('');
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${text}</svg>`);
}

async function build(spec) {
  const src = path.join(inDir, spec.file);
  if (!fs.existsSync(src)) return { file: spec.file, skipped: true };

  // The device sits below the caption and bleeds off the bottom. Rounded
  // corners and a soft edge stop it reading as a pasted rectangle.
  const deviceW = Math.round(W * 0.82);
  const deviceTop = 400;
  const deviceH = H - deviceTop + 40;               // +40 bleeds past the edge

  const shot = await sharp(src)
    .resize({ width: deviceW, height: deviceH, fit: 'cover', position: 'top' })
    .composite([{
      input: Buffer.from(
        `<svg width="${deviceW}" height="${deviceH}">
           <rect x="0" y="0" width="${deviceW}" height="${deviceH}" rx="36" ry="36" fill="#fff"/>
         </svg>`,
      ),
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();

  // The rim is drawn OVER the screenshot at the same geometry, so it traces the
  // device edge exactly rather than approximating it with a drop shadow.
  const rim = Buffer.from(
    `<svg width="${deviceW}" height="${deviceH}" xmlns="http://www.w3.org/2000/svg">
       <rect x="1.5" y="1.5" width="${deviceW - 3}" height="${deviceH - 3}"
             rx="35" ry="35" fill="none" stroke="${RIM}" stroke-width="3"/>
     </svg>`,
  );

  const out = path.join(outDir, spec.file.replace(/\.[^.]+$/, '.png'));
  const left = Math.round((W - deviceW) / 2);
  await sharp({ create: { width: W, height: H, channels: 4, background: BG } })
    .composite([
      { input: shot, top: deviceTop, left },
      { input: rim, top: deviceTop, left },
      { input: captionSvg(spec.lines), top: 0, left: 0 },
    ])
    .png()
    .toFile(out);
  return { file: spec.file, out };
}

fs.mkdirSync(outDir, { recursive: true });
console.log(`background ${BG} · ${W}x${H}\n`);

let made = 0;
let missing = 0;
for (const spec of CAPTIONS) {
  // eslint-disable-next-line no-await-in-loop
  const r = await build(spec);
  if (r.skipped) {
    missing++;
    console.log(`  MISSING  ${spec.file}`);
    console.log(`           caption: "${spec.lines.join(' ')}"`);
    console.log(`           shoot:   ${spec.shoot}\n`);
  } else {
    made++;
    console.log(`  built    ${r.out}   "${spec.lines.join(' ')}"`);
  }
}

console.log(`\n${made} built, ${missing} still to shoot.`);
if (missing) console.log(`Drop the raw captures in ${path.resolve(inDir)}/ using the names above and re-run.`);
if (made) console.log('Play accepts 2-8 phone screenshots; upload them in the order above.');

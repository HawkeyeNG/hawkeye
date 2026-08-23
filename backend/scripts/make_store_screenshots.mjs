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

/**
 * CANVAS SIZE IS AN ARGUMENT, because the two stores want different ones and
 * the design should not be redrawn twice. Play takes 1080x1920 (9:16); Apple's
 * 6.9" slot takes 1320x2868, which is a taller frame — so every fixed offset
 * below scales with it rather than staying where it was put for Play.
 *   --w 1320 --h 2868   ->  App Store 6.9"
 */
const W = Number(arg('w', 1080));
const H = Number(arg('h', 1920));
/** Everything positioned in pixels was tuned at 1080x1920; scale from there. */
const S = H / 1920;
const SX = W / 1080;
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
    shoot: 'The capture screen with the SPECIMEN sheet in frame. NO PRINTER AND NO PHONE '
      + 'NEEDED: tests/ui/capture_camera_shots.mjs feeds the specimen to Chromium as a fake '
      + 'capture device, so expo-camera renders it through the camera path the app itself '
      + 'uses. The screenshot is a real screen, not a sheet pasted over one afterwards. The '
      + 'note saying this had to be printed and photographed went unchallenged for weeks '
      + 'and was simply wrong. '
      + 'A real EC8A cannot be used: it carries a real polling unit and real votes, and '
      + 'putting that on a store listing publishes a result Hawkeye has no business '
      + 'publishing. The specimen is blank, struck SPECIMEN, and names unit 00-00-00-000, '
      + 'which is in no register.',
  },
  {
    file: '2-home.png',
    lines: ['Every election,', 'and when it opens'],
    shoot: 'The home screen: the next election with its countdown, and the observation '
      + 'promise above it. Captured headlessly, shot 2 of capture_store_shots.mjs. '
      + 'This slot used to be the vote-entry step, captioned Type what you see on the '
      + 'sheet. It went because it is the same screen as 6-practice, and two pictures of '
      + 'one screen is a wasted slot in a list most people never scroll past — while the '
      + 'app had no front door in the set at all.',
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
function captionSvgAt(lines, size) {
  const lineHeight = Math.round(size * 1.18);
  // First BASELINE, so the cap-height of line 1 sits a fixed distance below the
  // top edge whatever the size — an ascent-relative offset, not a box offset.
  const top = Math.round(150 * S) + size;
  const text = lines.map((l, i) => `
    <text x="${W / 2}" y="${top + i * lineHeight}" text-anchor="middle"
          font-family="Inter, 'Helvetica Neue', Arial, sans-serif"
          font-size="${size}" font-weight="800" fill="${INK}"
          letter-spacing="-1.5">${esc(l)}</text>`).join('');
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${text}</svg>`);
}

/** No caption may come within this fraction of the canvas edge. */
const CAPTION_MAX = 0.88;

/**
 * The largest size at which the caption actually FITS, measured rather than
 * guessed.
 *
 * The size used to come from a character-count threshold scaled by S — the
 * HEIGHT ratio. That is the wrong ratio: a caption is bounded by the canvas
 * WIDTH, and going from Play's 1080x1920 to Apple's 1320x2868 grows the height
 * by 1.49 and the width by only 1.22. Every iOS caption was therefore set a
 * fifth too large for its line, and the longer ones ran off the edge.
 *
 * Scaling by SX instead fixes the arithmetic, but a heuristic that counts
 * characters still cannot know that "Every election, and when it opens" sets
 * wider than "Every result, permanently" at the same count. So the text is
 * rendered, trimmed to its ink, and stepped down until it is inside the margin.
 * Measuring costs a few milliseconds and removes the whole class of bug.
 */
/**
 * ONE SIZE FOR EVERY CAPTION, as a fraction of the canvas width.
 *
 * The size used to be picked per caption from a character count, so a six-shot
 * set carried three different sizes — 90, 96 and 108 on Play — and the block
 * above the device changed height from shot to shot. In a store listing the six
 * are seen as a row, and a headline that grows and shrinks along it reads as
 * carelessness rather than emphasis.
 *
 * 0.0833 of the width is the size the longest caption settled at when it was
 * measured — 110px at 1320, 90px at 1080 — so every other line was only ever
 * bigger because it could be, not because it should be. Fixing the size also
 * fixes the spacing: a constant caption block under a constant `deviceTop`
 * leaves the same gap above the screenshot in all six.
 */
const CAPTION_SIZE = 0.0833;

async function captionSvg(lines) {
  let size = Math.round(W * CAPTION_SIZE);
  // Kept as a GUARD, not as the mechanism: at this size every current caption
  // fits, and the loop only bites if someone writes a longer one later.
  for (let i = 0; i < 14; i += 1) {
    // resolveWithObject, NOT metadata(). metadata() reports the INPUT's
    // dimensions, so it returned the full canvas width on every pass and the
    // loop ran to exhaustion — 0.94^14, which took Play's captions from 108px
    // down to 46px and made them less legible than the bug being fixed. The
    // trimmed size only exists on the pipeline's output.
    // eslint-disable-next-line no-await-in-loop
    const { info } = await sharp(captionSvgAt(lines, size)).png().trim()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || info.width <= W * CAPTION_MAX) break;
    size = Math.round(size * 0.94);
  }
  return { svg: captionSvgAt(lines, size), size };
}

/**
 * A PER-STORE SOURCE, when the two platforms genuinely differ.
 *
 * They usually do not — one capture serves both, which is the point of building
 * from one pipeline. The capture screen is the exception: on Android the sheet
 * is taken through Google's ML Kit scanner, a Play-services surface with its own
 * shutter and Manual/Auto toggle, and on iOS through the app's own camera with
 * its gold corner guides. Showing an iPhone screen on the Play listing would be
 * a picture of an app the Play user does not have.
 *
 * So `1-capture.android.png` wins over `1-capture.png` when --variant android is
 * passed, and everything without a variant file is shared exactly as before.
 */
const VARIANT = arg('variant', null);

async function build(spec) {
  const variantFile = VARIANT
    ? path.join(inDir, spec.file.replace(/\.png$/, `.${VARIANT}.png`))
    : null;
  const src = variantFile && fs.existsSync(variantFile) ? variantFile : path.join(inDir, spec.file);
  if (!fs.existsSync(src)) return { file: spec.file, skipped: true };

  // The device sits below the caption and bleeds off the bottom. Rounded
  // corners and a soft edge stop it reading as a pasted rectangle.
  const deviceW = Math.round(W * 0.82);
  const deviceTop = Math.round(400 * S);
  const deviceH = H - deviceTop + Math.round(40 * S);   // bleeds past the edge

  const shot = await sharp(src)
    .resize({ width: deviceW, height: deviceH, fit: 'cover', position: 'top' })
    .composite([{
      input: Buffer.from(
        `<svg width="${deviceW}" height="${deviceH}">
           <rect x="0" y="0" width="${deviceW}" height="${deviceH}" rx="${Math.round(36 * SX)}" ry="${Math.round(36 * SX)}" fill="#fff"/>
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
             rx="${Math.round(35 * SX)}" ry="${Math.round(35 * SX)}" fill="none" stroke="${RIM}" stroke-width="${Math.max(2, Math.round(3 * SX))}"/>
     </svg>`,
  );

  const caption = await captionSvg(spec.lines);
  const out = path.join(outDir, spec.file.replace(/\.[^.]+$/, '.png'));
  const left = Math.round((W - deviceW) / 2);
  // FLATTEN, THEN REMOVE THE CHANNEL. flatten() composites alpha onto the
  // background but leaves a 4-channel PNG behind; removeAlpha() is what actually
  // drops it. Both are needed, and only the second one shows up in a metadata
  // check — which is why the first attempt at this reported twelve files fixed
  // and twelve files still carrying alpha.
  //
  // Not strictly required: Play's no-alpha rule is for the ICON and the feature
  // graphic, not screenshots, which take PNG or JPEG either way. The background
  // here is fully opaque, so this changes no pixel and removes one thing for a
  // store's validator to have an opinion about.
  await sharp({ create: { width: W, height: H, channels: 4, background: BG } })
    .composite([
      { input: shot, top: deviceTop, left },
      { input: rim, top: deviceTop, left },
      { input: caption.svg, top: 0, left: 0 },
    ])
    .flatten({ background: BG })
    .removeAlpha()
    .png()
    .toFile(out);
  return { file: spec.file, out, size: caption.size, variant: src !== path.join(inDir, spec.file) };
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
    console.log(`  built    ${r.out}   ${r.size}px${r.variant ? `  [${VARIANT}]` : ''}   "${spec.lines.join(' ')}"`);
  }
}

console.log(`\n${made} built, ${missing} still to shoot.`);
if (missing) console.log(`Drop the raw captures in ${path.resolve(inDir)}/ using the names above and re-run.`);
if (made) {
  console.log(W === 1080
    ? 'Play accepts 2-8 phone screenshots; upload them in the order above.'
    : `Built at ${W}x${H}. Apple's 6.9" slot takes up to 10; upload in the order above.`);
}

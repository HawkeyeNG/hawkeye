/**
 * THE HAWK, IN EVERY NATIVE HEADER AND ON THE CARD.
 *
 * The website's crest was unified and the app was not: ScreenHeader already
 * used the transparent mark, but six screens hand-roll their own bar and each
 * reached for assets/images/icon.png — the app BADGE, which is the same hawk on
 * an opaque green tile with a rounded corner. Beside a transparent mark
 * everywhere else it reads as a second logo.
 *
 * The receipt card had no mark at all. It went out as a wordmark while its own
 * canvas twin has drawn the hawk since the day it shipped.
 *
 * Read from source and from the asset bytes, because neither defect is
 * something a running screen would report.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const N = '/home/elrio/hawkeye/native/src/';
const read = (f) => fs.readFileSync(f, 'utf8');

let fail = 0;
const check = (label, got, want) => {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        got  ${JSON.stringify(got)}`}`);
};

// ------------------------------------------------- nothing uses the badge
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};
const files = walk(N);
check('CONTROL the sweep found the app source', files.length > 40, true);
check('no screen draws the opaque badge',
  files.filter((f) => /images\/icon\.png/.test(read(f))).map((f) => f.replace(N, '')), []);

// Every screen that draws a logo at all must draw the transparent one.
const drawsLogo = files.filter((f) => /assets\/images\/(icon|crest)\.png/.test(read(f)));
check('and the screens that draw one use the crest', drawsLogo.length >= 7, true);

// ------------------------------------------------------------- the card
const card = read(N + 'components/receipt-card.tsx');
check('the receipt card draws a crest', /<SvgImage[^>]*href=\{RECEIPT_CREST\}/.test(card), true);
check('at the left margin, 84 square, like the canvas twin',
  /x=\{PAD\} y=\{y\} width=\{84\} height=\{84\}/.test(card), true);
check('with the wordmark 104 to its right',
  /x=\{PAD \+ 104\} y=\{y \+ 56\}/.test(card), true);
// The capture rasterises what has PAINTED, so the delay has to outlast the
// decode or the saved copy is the one thing missing the mark.
check('and the capture waits for it', /setTimeout\(onReady, 320\)/.test(card), true);

// ------------------------------------------------ the inlined artwork itself
// INLINE, NOT require(). A bundler asset resolves through the image loader at
// paint time; a data URI is in memory when the element mounts.
const crest = read(N + 'lib/receipt-crest.ts');
const m = crest.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
check('the crest is inlined as a data URI', !!m, true);
if (m) {
  const png = Buffer.from(m[1], 'base64');
  check('it is a real PNG', png.subarray(1, 4).toString(), 'PNG');
  // IHDR: width, height, bit depth, colour type. Type 6 is RGBA — a crest
  // without an alpha channel is the badge again, just drawn smaller.
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20), colour = png[25];
  check('square, and the size the card draws it at', { w, h }, { w: 128, h: 128 });
  check('with an alpha channel', colour, 6);
  // CONTROL: an alpha channel is not the same as being transparent. Decode the
  // corner and require it to be see-through, or a fully opaque RGBA tile passes.
  const idat = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.subarray(o + 4, o + 8).toString();
    if (type === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // First scanline: 1 filter byte, then RGBA pixels. The top-left of a trimmed,
  // squared crest is background.
  check('and its corner is actually transparent', raw[4], 0);
}

// ------------------------------------------------------- the twin still does
const web = read('/home/elrio/hawkeye/app/receipt.js');
check('the canvas twin still draws its own logo',
  /drawImage\(logo, PAD, y, 84, 84\)/.test(web), true);
check('and offsets its wordmark the same 104', /PAD \+ \(logo \? 104 : 0\)/.test(web), true);

console.log(fail ? `\n${fail} FAILED` : '\nAll passed — one hawk, everywhere');
process.exit(fail ? 1 : 0);

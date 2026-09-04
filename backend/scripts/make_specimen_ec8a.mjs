/**
 * A BLANK specimen result sheet, for screenshots and observer training.
 *
 *   node scripts/make_specimen_ec8a.mjs --out ../app/play-shots/specimen-ec8a.png
 *
 * Print it, photograph it with the app, and that photograph is the store
 * screenshot. It is also the right prop for training a new observer through the
 * capture flow without handing them a real result.
 *
 * ── WHY NOT JUST USE A REAL EC8A ──────────────────────────────────────────
 *
 * A real sheet carries a real polling unit's real votes. Putting that on a Play
 * Store listing publishes a result Hawkeye has no business publishing, attaches
 * named parties' numbers to a marketing asset, and — for a tool whose whole
 * claim is that it does not declare results — says exactly the wrong thing.
 * This sheet is blank for that reason, not for convenience.
 *
 * ── WHY IT IS MARKED AS LOUDLY AS IT IS ───────────────────────────────────
 *
 * A convincing blank government form is a forgery kit: fill it in and it is a
 * fabricated result. So this deliberately is NOT convincing.
 *
 *   - no INEC crest, no coat of arms, no INEC branding of any kind. Hawkeye is
 *     not affiliated with INEC and must not produce anything that implies it is
 *   - "SPECIMEN" struck diagonally across the whole page, under the fields
 *   - a header and a footer that both say it is not an INEC document
 *   - a polling unit code of 00-00-00-000, which exists nowhere in the register
 *
 * Anyone filling this in produces a page that says SPECIMEN across the middle
 * and names no real unit. That is the point.
 *
 * Renders A4 at 300 dpi (2480x3508), which prints correctly and downsamples
 * cleanly for a phone screenshot.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { OSUN_2026_BALLOT } from '../src/services/ec8a_prompt.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };

const out = arg('out', '../app/play-shots/specimen-ec8a.png');
const parties = (arg('ballot') || OSUN_2026_BALLOT.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

/**
 * --fillable: leave the identity fields EMPTY so a demo audience can write a
 * polling unit in by hand, and print the unit code as boxed characters.
 *
 * Off by default, because the default output is a committed asset: the store
 * screenshot and the fake camera feed in tests/ui/capture_camera_shots.mjs both
 * consume app/play-shots/specimen-ec8a.png, and silently blanking its fields
 * would change a published screenshot.
 *
 * WHAT THIS COSTS, stated plainly: the docstring above lists the 00-00-00-000
 * code as one of four reasons this sheet is not a forgery kit. This mode drops
 * that one — a filled-in code is the whole point of a scan demo. The other
 * three are untouched and are the load-bearing ones: no INEC branding of any
 * kind, SPECIMEN struck across the page in 330px red under every field, and a
 * red header and footer that both disclaim INEC. A page carrying all three
 * cannot pass as an issued result no matter what is written on it.
 *
 * BOXED, not a dotted rule, for the unit code. A real EC8A boxes those
 * characters, and native/src/lib/pu-code.ts parses a TOKEN STREAM precisely
 * because ML Kit returns each boxed character as its own text block. A demo
 * scan off a ruled line would exercise a different path than election day.
 */
const fillable = argv.includes('--fillable');

/**
 * --serial <digits>: print a sheet serial number, as a real EC8A carries.
 *
 * Nothing in the app READS this. native/src/lib/ocr.ts returns only
 * { text, numericLines, counts }, and parseCounts extracts nothing but
 * "party code -> last number on that line"; the sheetSerial field on the review
 * step is typed by hand. So this exists to prove the sheet is not read, and to
 * exercise the guard below.
 *
 * THE GUARD: parseCounts only accepts a token as a count when it matches
 * /^\d{1,6}$/ — "anything longer than six digits is discarded as a serial or
 * form number rather than a tally". A SEVEN-digit serial is therefore outside
 * the count range by construction. A six-digit one is not, and would be
 * eligible as a vote if it ever shared a recognised line with a party code —
 * which is why this prints in the header, far from the party table, rather than
 * in a corner of it.
 *
 * Opt-in with an explicit value: no serial is ever baked in as a default,
 * for the same reason no example vote counts are.
 */
const serial = arg('serial', null);

/**
 * --pu-code 29-01-01-001: print the delimitation code INTO the boxes, instead of
 * leaving them blank to be written in.
 *
 * For demonstrating Tier A — native/src/lib/pu-code.ts reading the sheet's own
 * polling unit — where handwriting is the weak link. The serial reads well
 * because it is printed; a biro code in nine small boxes is exactly the case an
 * on-device recogniser is worst at, so a sheet meant to show the feature working
 * should print it.
 *
 * THE CODE HAS TO BE REAL, and that is not a contradiction of the specimen's
 * whole design. The resolver checks the register, so an invented code resolves
 * to nothing and the card never appears — the demo would show only the failure
 * path. A real code in PRACTICE is contained: routes/practice.js writes to
 * practice_submissions on its own genesis and never to `submissions`, so
 * integrity.js never sees it and no real unit is touched.
 *
 * Accepts with or without dashes; validated to nine digits, because a code that
 * is silently wrong produces a sheet that silently demonstrates nothing.
 */
const puCodeRaw = arg('pu-code', null);
const puDigits = puCodeRaw ? String(puCodeRaw).replace(/[^0-9]/g, '') : null;
if (puCodeRaw && puDigits.length !== 9) {
  console.error(`--pu-code must be 9 digits (NN-NN-NN-NNN); got ${puDigits.length} in "${puCodeRaw}"`);
  process.exit(1);
}

const W = 2480;
const H = 3508;
const M = 150;                       // page margin
const INK = '#1a1a1a';
const RULE = '#555';
const FAINT = '#888';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const t = (x, y, s, { size = 34, weight = 400, anchor = 'start', fill = INK, ls = 0 } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, Helvetica, sans-serif"
         font-size="${size}" font-weight="${weight}" fill="${fill}" letter-spacing="${ls}">${esc(s)}</text>`;
const rect = (x, y, w, h, { stroke = RULE, sw = 2, fill = 'none' } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;

const parts = [];
parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

// ── header ────────────────────────────────────────────────────────────────
let y = M + 40;
parts.push(t(W / 2, y, 'SPECIMEN — TRAINING SHEET', { size: 40, weight: 700, anchor: 'middle', ls: 4, fill: '#b00' }));
y += 54;
parts.push(t(W / 2, y, 'NOT AN INEC DOCUMENT · NOT A RECORD OF ANY ELECTION', { size: 28, anchor: 'middle', fill: '#b00' }));
y += 70;
parts.push(t(W / 2, y, 'STATEMENT OF RESULT OF POLL FROM POLLING UNIT', { size: 42, weight: 700, anchor: 'middle' }));
y += 46;
parts.push(t(W / 2, y, 'Layout follows Form EC8A for training purposes only', { size: 26, anchor: 'middle', fill: FAINT }));

// Sheet serial, top-right — where a real form carries it, and deliberately far
// from the party table so it can never share a recognised line with a party
// code. Boxed and monospaced so a camera reads the digits cleanly.
if (serial) {
  const sw2 = 26 * String(serial).length + 60;
  const sx = W - M - sw2;
  const sy = M - 40;
  // "S/N", because that is what a real EC8A prints — verified against the 2026
  // Osun sheets in audits/: 29-01-01-001 reads "S/N 0000001", 29-02-01-001
  // "S/N 0000078", 29-05-03-002 "S/N 0000388". Seven digits, zero-padded,
  // printed rather than handwritten, sitting under the FORM EC 8A box.
  //
  // The label matters more than it looks: native/src/lib/ocr.ts anchors serial
  // extraction on this exact token, so a training sheet labelled anything else
  // ("Sheet Serial No.", as this first said) would demonstrate nothing — the
  // matcher would never fire on it.
  parts.push(t(W - M, sy - 14, 'S/N', { size: 28, anchor: 'end', weight: 700 }));
  parts.push(rect(sx, sy, sw2, 74, { sw: 3 }));
  parts.push(`<text x="${sx + sw2 / 2}" y="${sy + 52}" text-anchor="middle"
    font-family="'DejaVu Sans Mono', 'Courier New', monospace" font-size="40"
    font-weight="700" fill="${INK}" letter-spacing="4">${esc(serial)}</text>`);
}

// ── identity fields + the #1-#8 box block ────────────────────────────────
y += 80;
const boxW = 900;
const boxX = W - M - boxW;
const fieldW = boxX - M - 60;
const rows = fillable
  ? [['State', ''], ['Local Government Area', ''], ['Registration Area', ''], ['Polling Unit', '']]
  : [['State', 'SPECIMEN'], ['Local Government Area', 'SPECIMEN'],
    ['Registration Area', 'SPECIMEN'], ['Polling Unit', 'SPECIMEN (code 00-00-00-000)']];
// A ruled line rather than a run of dots: the dots were a fixed length, so a
// short label like "State" left them running under the value and the two
// collided. A rule starts where the label ends and stops at a fixed column.
let fy = y + 20;
const ruleEnd = M + fieldW;
for (const [label, val] of rows) {
  const labelW = label.length * 17 + 30;
  parts.push(t(M, fy + 34, label, { size: 32 }));
  parts.push(`<line x1="${M + labelW}" y1="${fy + 44}" x2="${ruleEnd}" y2="${fy + 44}"
                    stroke="${RULE}" stroke-width="2" stroke-dasharray="6 8"/>`);
  parts.push(t(M + labelW + 24, fy + 34, val, { size: 30, fill: FAINT }));
  fy += 92;
}

// ── the unit code, as boxed characters (fillable mode only) ──────────────
// Grouped 2-2-2-3 because every code in the register is NN-NN-NN-NNN — state,
// LGA, ward, unit — and all 176,846 of them are exactly that shape. The group
// captions say which part is which so a demo audience can copy a code off a
// phone without being told the format twice.
//
// NO EXAMPLE DIGITS ANYWHERE ON THIS SHEET. A sample value printed in a form
// gets copied verbatim by people filling it in — that is not hypothetical here;
// a worked example in an OCR prompt once ended up in 38 real sheets. The boxes
// are captioned, never pre-filled.
if (fillable) {
  const label = 'Polling Unit Code';
  parts.push(t(M, fy + 40, label, { size: 32 }));
  const BW = 78;         // box width
  const BH = 92;
  const GAP = 8;         // between boxes inside a group
  const DASH = 34;       // between groups
  const GROUPS = [[2, 'STATE'], [2, 'LGA'], [2, 'WARD'], [3, 'UNIT']];
  let bx = M + label.length * 17 + 60;
  const by0 = fy - 14;
  let digit = 0;               // walks puDigits across the four groups
  for (const [n, caption] of GROUPS) {
    const gStart = bx;
    for (let k = 0; k < n; k += 1) {
      parts.push(rect(bx, by0, BW, BH, { sw: 3 }));
      // One digit per box, centred — the same one-character-per-cell shape the
      // real form uses, which is why pu-code.ts parses a token stream: ML Kit
      // returns each boxed character as its own text block.
      if (puDigits) {
        parts.push(`<text x="${bx + BW / 2}" y="${by0 + BH - 24}" text-anchor="middle"
          font-family="'DejaVu Sans Mono', 'Courier New', monospace" font-size="52"
          font-weight="700" fill="${INK}">${esc(puDigits[digit])}</text>`);
      }
      digit += 1;
      bx += BW + (k < n - 1 ? GAP : 0);
    }
    const gWidth = bx - gStart;
    parts.push(t(gStart + gWidth / 2, by0 + BH + 34, caption,
      { size: 22, anchor: 'middle', fill: FAINT, ls: 1 }));
    if (caption !== 'UNIT') {
      parts.push(t(bx + DASH / 2, by0 + BH / 2 + 14, '-', { size: 44, anchor: 'middle' }));
      bx += DASH;
    }
  }
  fy += BH + 60;
}

const BOXES = [
  ['#1', 'Number of Voters on the Register'],
  ['#2', 'Number of Accredited Voters'],
  ['#3', 'Ballot Papers Issued to the Polling Unit'],
  ['#4', 'Number of Unused Ballot Papers'],
  ['#5', 'Number of Spoiled Ballot Papers'],
  ['#6', 'Number of Rejected Ballots'],
  ['#7', 'Total Valid Votes'],
  ['#8', 'Total Used Ballot Papers (#5 + #6 + #7)'],
];
const bh = 88;
parts.push(rect(boxX, y, boxW, bh * BOXES.length));
BOXES.forEach(([n, label], i) => {
  const by = y + i * bh;
  if (i) parts.push(`<line x1="${boxX}" y1="${by}" x2="${boxX + boxW}" y2="${by}" stroke="${RULE}" stroke-width="2"/>`);
  parts.push(`<line x1="${boxX + 80}" y1="${by}" x2="${boxX + 80}" y2="${by + bh}" stroke="${RULE}" stroke-width="2"/>`);
  parts.push(`<line x1="${boxX + boxW - 200}" y1="${by}" x2="${boxX + boxW - 200}" y2="${by + bh}" stroke="${RULE}" stroke-width="2"/>`);
  parts.push(t(boxX + 22, by + 56, n, { size: 30, weight: 700 }));
  parts.push(t(boxX + 96, by + 54, label, { size: 25 }));
});

// ── the party table ───────────────────────────────────────────────────────
let ty = Math.max(fy + 40, y + bh * BOXES.length + 60);
const tw = W - M * 2;
const cSn = 120;
const cParty = 380;
const cFig = 560;
const cWords = 760;
const cAgent = tw - cSn - cParty - cFig - cWords;
/**
 * Row height. 96px suits the 15-party Osun ballot, which fills the page on its
 * own — but a 4-party practice sheet at 96px leaves two thirds of an A4 blank
 * and gives 8mm boxes to write votes in.
 *
 * On a sheet whose job is to be READ BACK by OCR that is the wrong trade: digit
 * height is the single biggest lever on recognition off a phone camera. So in
 * fillable mode the rows grow to fill the space actually available, capped at
 * 210px (~18mm at 300dpi) — comfortable for handwriting, and still leaving room
 * for the certification block below.
 */
const headH = 120;
const CERT_RESERVE = 420;               // certification lines + footer breathing room
const FILL_CAP = 210;
const rowH = fillable
  ? Math.min(FILL_CAP, Math.max(96,
    Math.floor((H - M - CERT_RESERVE - (ty + headH)) / (parties.length + 1))))
  : 96;

parts.push(rect(M, ty, tw, headH));
let cx = M;
// Two-line headers where one line does not fit the column — the agent header
// is the widest label in the narrowest column and overflowed into the rule.
const heads = [[cSn, ['S/N']], [cParty, ['POLITICAL', 'PARTY']], [cFig, ['VOTES IN', 'FIGURES']],
  [cWords, ['VOTES IN', 'WORDS']], [cAgent, ['NAME / SIGNATURE', 'OF POLLING AGENT']]];
for (const [w, labels] of heads) {
  const startY = labels.length > 1 ? ty + 52 : ty + 72;
  labels.forEach((label, i) => {
    parts.push(t(cx + w / 2, startY + i * 38, label, { size: 26, weight: 700, anchor: 'middle' }));
  });
  cx += w;
  if (cx < M + tw) parts.push(`<line x1="${cx}" y1="${ty}" x2="${cx}" y2="${ty + headH + rowH * parties.length + rowH}" stroke="${RULE}" stroke-width="2"/>`);
}

let ry = ty + headH;
parties.forEach((p, i) => {
  parts.push(rect(M, ry, tw, rowH));
  parts.push(t(M + cSn / 2, ry + 62, String(i + 1), { size: 32, anchor: 'middle' }));
  parts.push(t(M + cSn + cParty / 2, ry + 62, p, { size: 34, weight: 700, anchor: 'middle' }));
  ry += rowH;
});

// TOTAL row
parts.push(rect(M, ry, tw, rowH));
parts.push(t(M + 30, ry + 46, 'TOTAL VALID VOTES', { size: 30, weight: 700 }));
parts.push(t(M + 30, ry + 80, '(record under #7 above)', { size: 22, fill: FAINT }));
ry += rowH;

// ── certification ────────────────────────────────────────────────────────
ry += 70;
parts.push(t(M, ry, 'I, ................................................................ (Presiding Officer) certify that the', { size: 30 }));
ry += 56;
parts.push(t(M, ry, 'information above is a true and accurate account of votes cast in this polling unit.', { size: 30 }));
ry += 90;
parts.push(t(M, ry, 'Date .............................', { size: 30 }));
parts.push(t(M + 900, ry, 'Signature / Stamp .............................', { size: 30 }));

// ── the watermark, over everything ───────────────────────────────────────
parts.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle"
  font-family="Arial, Helvetica, sans-serif" font-size="330" font-weight="800"
  fill="#d00" fill-opacity="0.13" letter-spacing="30"
  transform="rotate(-32 ${W / 2} ${H / 2})">SPECIMEN</text>`);

// ── footer ───────────────────────────────────────────────────────────────
parts.push(t(W / 2, H - 90, 'SPECIMEN — produced by Hawkeye for training. Not issued by, affiliated with, or endorsed by INEC.',
  { size: 26, anchor: 'middle', fill: '#b00' }));
// The default sheet can point at its own impossible code. The fillable one
// cannot — it no longer prints one — so it must not keep saying it does.
parts.push(t(W / 2, H - 50, fillable
  ? 'Contains no result. Anything written on this sheet is a practice entry, not a record of any poll.'
  : 'Contains no result. Polling unit code 00-00-00-000 exists in no register.',
{ size: 24, anchor: 'middle', fill: FAINT }));

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('\n')}</svg>`;

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`specimen written: ${path.resolve(out)}`);
console.log(`  ${W}x${H} (A4 at 300dpi) · ${parties.length} party rows · every cell blank`);
console.log('  Print at A4, photograph it in the app, use that as store screenshot 1.');

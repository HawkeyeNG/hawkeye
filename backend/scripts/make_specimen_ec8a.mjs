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

// ── identity fields + the #1-#8 box block ────────────────────────────────
y += 80;
const boxW = 900;
const boxX = W - M - boxW;
const fieldW = boxX - M - 60;
const rows = [['State', 'SPECIMEN'], ['Local Government Area', 'SPECIMEN'],
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
const rowH = 96;
const headH = 120;

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
parts.push(t(W / 2, H - 50, 'Contains no result. Polling unit code 00-00-00-000 exists in no register.',
  { size: 24, anchor: 'middle', fill: FAINT }));

const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${parts.join('\n')}</svg>`;

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`specimen written: ${path.resolve(out)}`);
console.log(`  ${W}x${H} (A4 at 300dpi) · ${parties.length} party rows · every cell blank`);
console.log('  Print at A4, photograph it in the app, use that as store screenshot 1.');

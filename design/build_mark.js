// Hawkeye brand mark candidates — "The Witness Seal".
// Option 1: square ballot box with binoculars on its face (3D perspective).
// Option 2: square ballot box with a hawk head — white + light-green feathers.
// Outputs per option: hawkeye-mark-optN.svg (vector) + hawkeye-mark-sheet-optN.png.
//   cd ~/hawkeye/backend && node ../design/build_mark.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// sharp lives in backend's node_modules (this script sits outside it)
const sharp = createRequire(new URL('../backend/', import.meta.url))('sharp');

const OUT = path.dirname(fileURLToPath(import.meta.url));
const INK = '#13221B', GREEN = '#008751', PAPER = '#F5F3EC', LGREEN = '#9BD4B4';

// Square-edged ballot box: lid, slot, green ballot with tick. `face` is the
// emblem drawn on the body. fg = box, accent = ballot/eye, bg = contrast emblem.
function box(fg, accent, bg, face) {
  return `
  <g>
    <rect x="64"  y="136" width="352" height="48"  rx="4" fill="${fg}"/>
    <rect x="80"  y="184" width="320" height="216" rx="4" fill="${fg}"/>
    <rect x="208" y="56"  width="64"  height="104" rx="6"  fill="${accent}"/>
    <path d="M224 100 l12 12 l22 -26" fill="none" stroke="${bg}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="184" y="152" width="112" height="16" rx="8" fill="${bg}"/>
    <rect x="208" y="152" width="64"  height="16" fill="${accent}"/>
    ${face}
  </g>`;
}

// ---- option 1: binoculars, gentle perspective ------------------------------
function binoBarrel(exCx, obCx, fg, accent, bg) {
  return `
    <polygon points="${exCx - 20},246 ${exCx + 20},246 ${obCx + 42},330 ${obCx - 42},330" fill="${bg}"/>
    <circle cx="${exCx}" cy="246" r="20" fill="${bg}"/>
    <circle cx="${exCx}" cy="246" r="10" fill="${fg}"/>
    <circle cx="${obCx}" cy="330" r="42" fill="${bg}"/>
    <circle cx="${obCx}" cy="330" r="30" fill="${fg}"/>
    <circle cx="${obCx}" cy="330" r="9"  fill="${accent}"/>`;
}
const markBinos = (fg, accent, bg) => box(fg, accent, bg, `
    ${binoBarrel(205, 185, fg, accent, bg)}
    ${binoBarrel(275, 295, fg, accent, bg)}
    <rect x="220" y="252" width="40" height="20" fill="${bg}"/>
    <circle cx="240" cy="288" r="15" fill="${bg}"/>
    <circle cx="240" cy="288" r="6"  fill="${accent}"/>`);

// ---- option 2: hawk head, profile right, layered feathers ------------------
// Two zigzag breast-feather bands (light green under white), light-green nape
// crescent behind the white head, hooked beak, ink brow over a green eye.
function markHawk(fg, accent, bg) {
  const zig = (top, fill) => {
    const bot = top + 40, tip = top + 68;
    return `<polygon points="184,${top} 296,${top} 296,${bot} 278,${tip} 259,${bot} 240,${tip} 221,${bot} 202,${tip} 184,${bot}" fill="${fill}"/>`;
  };
  // Front-facing: symmetric like the seal itself. Light-green crown crescent
  // over a white head, V-brow knitted at the center, green eyes, hooked beak
  // dropping between them, breast fringe in alternating white/light green.
  return box(fg, accent, bg, `
    <circle cx="240" cy="246" r="54" fill="${LGREEN}"/>
    ${zig(300, LGREEN)}
    ${zig(268, bg)}
    <circle cx="240" cy="254" r="54" fill="${bg}"/>
    <polygon points="192,216 238,234 238,248 196,230" fill="${fg}"/>
    <polygon points="288,216 242,234 242,248 284,230" fill="${fg}"/>
    <circle cx="212" cy="254" r="10" fill="${accent}"/>
    <circle cx="268" cy="254" r="10" fill="${accent}"/>
    <circle cx="214" cy="255" r="4.5" fill="${fg}"/>
    <circle cx="266" cy="255" r="4.5" fill="${fg}"/>
    <path d="M226 254 Q 240 247 254 254 Q 257 282 243 302 Q 240 310 236 301 Q 225 278 226 254 Z" fill="${LGREEN}"/>`);
}

// ---- presentation sheet -----------------------------------------------------
const mono = `font-family="Geist Mono"`;
const tile = (x, label, fgTile, m) => `
  <g transform="translate(${x},762)">
    ${fgTile
    ? `<rect x="0" y="0" width="120" height="120" rx="14" fill="${fgTile}"/>`
    : `<rect x="0.5" y="0.5" width="119" height="119" rx="14" fill="none" stroke="${INK}" stroke-opacity="0.18" stroke-width="1"/>`}
    <g transform="translate(14,16) scale(0.192)">${m}</g>
    <text x="60" y="148" ${mono} font-size="8" letter-spacing="3" fill="${INK}" fill-opacity="0.55" text-anchor="middle">${label}</text>
  </g>`;

function sheet(mark, fig, sub, construction) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1000">
  <rect width="800" height="1000" fill="${PAPER}"/>
  <rect x="40" y="40" width="720" height="920" fill="none" stroke="${INK}" stroke-opacity="0.30" stroke-width="1"/>
  <rect x="48" y="48" width="704" height="904" fill="none" stroke="${INK}" stroke-opacity="0.12" stroke-width="0.75"/>
  <text x="72" y="84" ${mono} font-size="9" letter-spacing="2.5" fill="${INK}" fill-opacity="0.6">${fig}</text>
  <text x="728" y="84" ${mono} font-size="9" letter-spacing="2.5" fill="${INK}" fill-opacity="0.6" text-anchor="end">${sub}</text>
  ${construction}
  <g transform="translate(160,120)">${mark(INK, GREEN, PAPER)}</g>
  <text x="400" y="648" font-family="Gloock" font-size="58" letter-spacing="14" fill="${INK}" text-anchor="middle">HAWKEYE</text>
  <rect x="372" y="672" width="56" height="3" fill="${GREEN}"/>
  <text x="400" y="704" ${mono} font-size="11" letter-spacing="6" fill="${INK}" fill-opacity="0.62" text-anchor="middle">THE COUNT, WITNESSED.</text>
  ${tile(196, 'POSITIVE', '', mark(INK, GREEN, PAPER))}
  ${tile(340, 'CIVIC', GREEN, mark(PAPER, PAPER, GREEN))}
  ${tile(484, 'ARCHIVE', INK, mark(PAPER, GREEN, INK))}
  <text x="400" y="936" ${mono} font-size="8" letter-spacing="2.5" fill="${INK}" fill-opacity="0.45" text-anchor="middle">HAWKEYE · INDEPENDENT ELECTION RESULTS MONITOR · HAWKEYE.COM.NG · MMXXVI</text>
</svg>`;
}

const conBase = `
  <g stroke="${INK}" stroke-opacity="0.20" stroke-width="0.75" fill="none">
    <line x1="400" y1="128" x2="400" y2="552" stroke-dasharray="1 5"/>
    <line x1="150" y1="450" x2="650" y2="450" stroke-dasharray="1 5"/>`;
const conBinos = `${conBase}
    <circle cx="345" cy="450" r="56"/>
    <circle cx="455" cy="450" r="56"/>
    <line x1="303" y1="540" x2="303" y2="556"/>
    <line x1="387" y1="540" x2="387" y2="556"/>
    <line x1="303" y1="548" x2="387" y2="548"/>
  </g>
  <text x="345" y="574" ${mono} font-size="8" letter-spacing="1.5" fill="${INK}" fill-opacity="0.5" text-anchor="middle">Ø 84</text>`;
const conHawk = `${conBase}
    <circle cx="402" cy="372" r="68"/>
    <line x1="348" y1="540" x2="348" y2="556"/>
    <line x1="456" y1="540" x2="456" y2="556"/>
    <line x1="348" y1="548" x2="456" y2="548"/>
  </g>
  <text x="402" y="574" ${mono} font-size="8" letter-spacing="1.5" fill="${INK}" fill-opacity="0.5" text-anchor="middle">R 54</text>`;

async function emit(mark, tag, fig, sub, construction) {
  fs.writeFileSync(path.join(OUT, `hawkeye-mark-${tag}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 32 400 392">${mark(INK, GREEN, PAPER)}</svg>`);
  await sharp(Buffer.from(sheet(mark, fig, sub, construction)), { density: 260 })
    .png().toFile(path.join(OUT, `hawkeye-mark-sheet-${tag}.png`));
}

await emit(markBinos, 'opt1', 'FIG. 01 — THE WITNESS SEAL', 'BALLOT × BINOCULAR', conBinos);
await emit(markHawk, 'opt2', 'FIG. 02 — THE WITNESS SEAL', 'BALLOT × HAWK', conHawk);
console.log('done', OUT);

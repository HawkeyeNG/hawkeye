/**
 * ENGLISH STILL HARD-CODED IN A PAGE'S SCRIPT — read-only, rewrites nothing.
 *
 * situation-room.html, join.html and my-groups.html build their DOM from
 * template literals, so neither markup keyer sees them: i18n_extract/auto_key
 * read markup, key_js reads `el.textContent = '…'`, and a sentence sitting
 * inside `${…}` or between tags of a template literal is invisible to all three.
 * rendered_gaps.mjs cannot reach the room either — signed out it renders an auth
 * wall, so its "0 gaps" says nothing about the screen a manager actually uses.
 *
 * This lists the candidates with line numbers so the keying can be planned and
 * counted before anything is rewritten:
 *   · text between tags inside a template literal  `>Some sentence<`
 *   · quoted prose passed to alert/confirm/textContent
 * Anything already inside T('…') is skipped, as is anything in a comment or an
 * attribute value.
 *
 *   node scripts/i18n/web_template_scan.mjs situation-room.html
 */
import fs from 'node:fs';

const APP = '/home/elrio/hawkeye/app';
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const CODEY = /^[a-z]+[A-Z]|[{}$;=<>]|=>|\bfunction\b|\bconst\b|^\W+$/;
const prose = (s) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 4 || !/[A-Za-z]{2}/.test(t)) return null;
  if (!/[A-Za-z]/.test(t[0])) return null;
  if (CODEY.test(t)) return null;
  if (/^(px|rem|em|auto|none|flex|grid|div|span|true|false)\b/.test(t)) return null;
  return t;
};

let total = 0;
for (const f of files) {
  const src = fs.readFileSync(`${APP}/${f}`, 'utf8');
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const seen = new Set();
  const hits = [];
  const add = (kind, raw, idx) => {
    const t = prose(raw);
    if (!t || seen.has(t)) return;
    // already keyed, or a data-i18n attribute's own English fallback
    const around = src.slice(Math.max(0, idx - 60), idx);
    if (/T\('[^']+',\s*$/.test(around) || /data-i18n(?:-html)?="[^"]*"[^<>]*$/.test(around)) return;
    seen.add(t);
    hits.push({ line: lineOf(idx), kind, text: t });
  };
  for (const m of src.matchAll(/>([^<>{}\n][^<>{}]{3,})</g)) add('tag-text', m[1], m.index);
  for (const m of src.matchAll(/(?:alert|confirm)\(\s*'([^']{6,})'/g)) add('dialog', m[1], m.index);
  for (const m of src.matchAll(/textContent\s*=\s*'([^']{4,})'/g)) add('textContent', m[1], m.index);
  total += hits.length;
  console.log(`\n${f}: ${hits.length} candidates`);
  for (const h of hits) console.log(`  ${String(h.line).padStart(4)}  ${h.kind.padEnd(11)} ${JSON.stringify(h.text.slice(0, 96))}`);
}
console.log(`\n==== ${total} candidate(s) across ${files.length} file(s)`);

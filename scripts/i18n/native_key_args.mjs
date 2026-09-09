/**
 * KEY PROSE PASSED AS A BARE ARGUMENT.
 *
 * Neither extractor covers `setLine('Could not open that unit')` — it is not
 * JSX text, not a prop, not a template, not a ternary. It is just a string
 * handed to a function. On result.tsx that shape held fifteen strings, and they
 * were the STATUS AND ERROR messages: what a reporter reads when something has
 * gone wrong at a polling unit. An observer who cannot read the error cannot
 * act on it, which makes these worth more than their word count.
 *
 * NARROW ON PURPOSE. Only a complete argument or return value is taken — the
 * character before must be ( , = or space, and the character after must be )
 * , or ;. That excludes anything mid-expression, anything being compared, and
 * anything concatenated. A string that is part of a larger expression is left
 * for a human, because getting it wrong there changes behaviour rather than
 * wording.
 *
 * REUSE IS TRACKED AS IT GOES. The first version of this built its
 * English-to-key map once and never updated it, so the second occurrence of one
 * sentence minted a -2 key. Two keys for one sentence get translated twice and
 * drift; that is the whole reason reuse exists.
 *
 *   node scripts/i18n/native_key_args.mjs <file...>          # dry run
 *   node scripts/i18n/native_key_args.mjs <file...> --write
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const CAT = path.join(ROOT, 'scripts/i18n/native_catalogue.json');
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const files = args.filter((a) => !a.startsWith('--'));

if (!files.length) {
  console.log('usage: node scripts/i18n/native_key_args.mjs <file...> [--write]');
  process.exit(2);
}

const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
const byText = new Map();
for (const [k, v] of Object.entries(cat)) if (!byText.has(v)) byText.set(v, k);

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'x';

const prefixFor = (f) =>
  'n.' + f.replace(/^native\/src\//, '').replace(/\.tsx?$/, '')
    .replace(/[()]/g, '').replace(/\//g, '.').replace(/\.+/g, '.');

/** Prose a person reads, not code that happens to be quoted. */
/** Add the i18nT import if this file gained its first call. The keyers rewrite
 *  call sites; a file with no previous i18nT has no import, and the rewrite
 *  then does not compile. tsc catches it, but only after the write. */
function ensureImport(src) {
  if (!/\bi18nT\(/.test(src)) return src;
  if (/import \{[^}]*\bt as i18nT\b[^}]*\} from '@\/lib\/i18n'/.test(src)) return src;
  const lines = src.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^import .*from '.*';\s*$/.test(lines[i])) last = i;
  if (last === -1) {
    // No imports at all — a pure helper module. Insert after the leading block
    // comment; those docblocks are load-bearing here and stay at the top.
    let at = 0;
    if (lines[0] && lines[0].trim().startsWith('/*')) {
      while (at < lines.length && !lines[at].includes('*/')) at++;
      at++;
    }
    lines.splice(at, 0, '', "import { t as i18nT } from '@/lib/i18n';");
    return lines.join('\n');
  }
  lines.splice(last + 1, 0, "import { t as i18nT } from '@/lib/i18n';");
  return lines.join('\n');
}

function isProse(s) {
  if (s.length < 8 || s.length > 220) return false;
  if (!/^[A-Z]/.test(s)) return false;
  if (!/\s/.test(s)) return false;
  if (/^(https?:|\/)/.test(s)) return false;
  const toks = s.split(/\s+/);
  const cssish = toks.filter((t) => /^-?[a-z][a-z0-9]*(-[a-z0-9./[\]#%]+)+$/.test(t)).length;
  if (cssish / toks.length > 0.4) return false;
  return true;
}

let total = 0;
const catOut = { ...cat };
for (const f of files) {
  const abs = path.join(ROOT, f);
  const orig = fs.readFileSync(abs, 'utf8');
  // Blank comments for detection, keeping offsets so edits land correctly.
  const probe = orig
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|\n)([ \t]*)\/\/[^\n]*/g, (m, a, b) => a + b + ' '.repeat(m.length - a.length - b.length));

  const prefix = prefixFor(f);
  const found = [];
  for (const m of probe.matchAll(/'((?:[^'\\\n]|\\.){8,220})'/g)) {
    const t = m.group ? m.group(1) : m[1];
    if (!isProse(t)) continue;
    const ls = probe.lastIndexOf('\n', m.index) + 1;
    const le = probe.indexOf('\n', m.index);
    const line = probe.slice(ls, le === -1 ? probe.length : le);
    if (/i18nT\(|console\.|accessibilityLabel|require\(/.test(line)) continue;
    const before = probe[m.index - 1];
    const after = probe[m.index + m[0].length];
    if (!'(,= '.includes(before) || !'),;'.includes(after)) continue;
    found.push({ start: m.index, end: m.index + m[0].length, text: t });
  }

  const added = {};
  let out = orig;
  for (const h of [...found].reverse()) {          // right to left, offsets hold
    if (orig.slice(h.start, h.end) !== `'${h.text}'`) continue;
    let key = byText.get(h.text);
    if (!key) {
      key = `${prefix}.${slug(h.text)}`;
      let n = 2;
      while (key in catOut || key in added) key = `${prefix}.${slug(h.text)}-${n++}`;
      added[key] = h.text;
      byText.set(h.text, key);                     // reuse tracked AS IT GOES
    }
    out = out.slice(0, h.start) + `i18nT('${key}')` + out.slice(h.end);
  }

  const n = Object.keys(added).length;
  total += n;
  console.log(`\n${f}`);
  console.log(`  ${found.length} argument literal(s), ${n} new key(s)`);
  for (const [k, v] of Object.entries(added).slice(0, 6)) {
    console.log(`    ${k.slice(-52).padEnd(52)} ${v.slice(0, 54)}`);
  }
  if (WRITE && found.length) {
    fs.writeFileSync(abs, ensureImport(out));
    Object.assign(catOut, added);
  }
}

if (WRITE) {
  fs.writeFileSync(CAT, JSON.stringify(Object.fromEntries(Object.entries(catOut).sort()), null, 2) + '\n');
  console.log(`\ncatalogue now ${Object.keys(catOut).length} keys (+${total})`);
} else {
  console.log(`\ndry run — ${total} keys would be added. Pass --write to apply.`);
}

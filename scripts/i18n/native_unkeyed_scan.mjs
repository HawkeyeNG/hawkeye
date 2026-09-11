/**
 * FIND THE NATIVE STRINGS NOTHING KEYS — read-only, rewrites nothing.
 *
 * native_extract.mjs owns single-line `>Text<` and `prop="Text"` and reports
 * "0 new" for all 114 files, which is how ~135 rendered-English strings stayed
 * invisible ([[hawkeye-native-keying-gap]]). This lists the shapes it cannot
 * see, so the scope is a number before anything rewrites a line of JSX:
 *
 *   1. multi-line JSX text   <Text ...>\n  Sentence across lines\n</Text>
 *   2. object properties     { title: 'Reporting has not opened', … }
 *   3. single-line JSX text  >Sentence<        (claimed, verify the claim)
 *
 * Excluded, deliberately: lib/i18n/**, content.ts and terms.tsx (translated by
 * the English-keyed CONTENT_I18N walker), support.tsx (chain names and payment
 * URIs — see the machine-string table in the memory), and anything already
 * inside i18nT(...).
 *
 *   node scripts/i18n/native_unkeyed_scan.mjs            # summary
 *   node scripts/i18n/native_unkeyed_scan.mjs --json     # + tmp/native_unkeyed.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye/native/src';
const SKIP = [/\/lib\/i18n\//, /\/content\.ts$/, /\/terms\.tsx$/, /\/support\.tsx$/, /\.test\./];
const PROPS = /^\s*(title|body|label|text|message|hint|placeholder|subtitle|caption|cta|description|desc|empty|error|note|summary)\s*:\s*'([^']{6,})'/;

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p) && !SKIP.some((r) => r.test(p))) files.push(p);
  }
})(ROOT);

/** Prose a person reads, not an identifier, a path, a URI or a template. */
const prose = (s) => {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length < 6 || !/\s/.test(t)) return null;          // one word is a label or an id
  if (!/^[A-Z“"']/.test(t)) return null;                    // sentences start capitalised
  if (/[{}$<>]|https?:|^[a-z-]+\/|\.(tsx?|png|jpg|mp4)$/.test(t)) return null;
  if (/^[A-Z0-9 _-]+$/.test(t)) return null;                // CONSTANT CASE
  return t;
};

/**
 * Not gaps, and saying so is the point: a scanner that keeps reporting the same
 * nine non-issues trains everyone to ignore its output.
 *  · the non-affiliation notice — englishOnly by policy (see the keyer);
 *  · a `title:` that already has a `titleKey:` beside it — the key-beside-English
 *    pattern module-level constants MUST use, because an i18nT() evaluated at
 *    import freezes before the stored language is known;
 *  · anything inside a comment — docblocks show JSX examples.
 */
const NEVER = ['Hawkeye is independent and nonpartisan. It is not affiliated with INEC or any government body, and it does not declare results — it records what observers report and lets anyone check the record.'];
const inComment = (src, i) => {
  const line = src.slice(src.lastIndexOf('\n', i) + 1, i);
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return true;
  const open = src.lastIndexOf('/*', i);
  return open !== -1 && src.lastIndexOf('*/', i) < open;
};
const hasKeySibling = (src, i) => {
  const from = src.lastIndexOf('\n', i) + 1;
  return /\w+Key:\s*'/.test(src.slice(from, src.indexOf('\n', src.indexOf('\n', from) + 1) + 1));
};

const out = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = f.slice(ROOT.length + 1);
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const seen = new Set();
  const push = (kind, text, idx) => {
    const t = prose(text);
    if (!t || seen.has(t) || NEVER.includes(t) || inComment(src, idx)) return;
    if (kind === 'object-prop' && hasKeySibling(src, idx)) return;
    seen.add(t);
    out.push({ file: rel, line: lineOf(idx), kind, text: t });
  };
  // 1. multi-line JSX text: a '>' then only text until the next '<'
  for (const m of src.matchAll(/>\s*\n\s*([^<>{}][^<>{}]*?)\s*\n\s*</g)) push('jsx-multiline', m[1], m.index);
  // 3. single-line JSX text
  for (const m of src.matchAll(/>([^<>{}\n]{6,})</g)) push('jsx-line', m[1], m.index);
  // 2. object-literal string properties
  for (const m of src.matchAll(new RegExp(PROPS, 'gm'))) push('object-prop', m[2], m.index);
}

const byFile = {};
for (const o of out) byFile[o.file] = (byFile[o.file] || 0) + 1;
const byKind = {};
for (const o of out) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
console.log(`${files.length} files scanned, ${out.length} unkeyed candidates`, byKind);
for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${String(n).padStart(3)}  ${f}`);
if (process.argv.includes('--json')) {
  fs.writeFileSync('/home/elrio/hawkeye/tmp/native_unkeyed.json', JSON.stringify(out, null, 2) + '\n');
  console.log('wrote tmp/native_unkeyed.json');
}

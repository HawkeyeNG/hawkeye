/**
 * KEY MULTI-LINE JSX TEXT — the shape native_extract.mjs cannot see.
 *
 * Its matcher requires the sentence to sit on one line, so every paragraph
 * wrapped across lines by the formatter stayed English while the extractor
 * reported "0 new" for all 114 files ([[hawkeye-native-keying-gap]]: ~135
 * strings). This is the third keyer rather than a loosening of the first,
 * for the same reason the second one exists: a partial rewrite of a template
 * is how a screen renders "[object Object]".
 *
 *     <Text className="...">
 *       Automated checks on every result. Anything that looks wrong is logged.
 *     </Text>
 *  -> <Text className="...">
 *       {i18nT('n.app.integrity.automated-checks-on-every-result')}
 *     </Text>
 *
 * THE CATALOGUE GETS THE SENTENCE, whitespace normalised to single spaces —
 * how a reader sees it, and what a translator must be given. The INVERSE
 * CHECK uses the raw block instead, indentation and newlines included, so a
 * file is only written when substituting every original block back reproduces
 * it BYTE FOR BYTE. Prose is judged separately, on the normalised text: a
 * reversible wrong transform is still wrong (that lesson cost ten files).
 *
 * Text inside {} or containing tags is refused outright — it is an expression
 * or mixed markup, and both need a human.
 *
 *   node scripts/i18n/native_key_multiline.mjs                  # dry run, all files
 *   node scripts/i18n/native_key_multiline.mjs app/profile.tsx  # dry run, one file
 *   node scripts/i18n/native_key_multiline.mjs --write
 *   node scripts/i18n/native_key_multiline.mjs --control        # prove the net can fail
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const SRC = path.join(ROOT, 'native/src');
const CAT = path.join(ROOT, 'scripts/i18n/native_catalogue.json');
const SKIP = [/\/lib\/i18n\//, /\/content\.ts$/, /\/terms\.tsx$/, /\/support\.tsx$/, /\.test\./];
const IMPORT = "import { t as i18nT } from '@/lib/i18n';";

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const CONTROL = args.includes('--control');
const only = args.filter((a) => !a.startsWith('--'));

const catalogue = new Map(Object.entries(JSON.parse(fs.readFileSync(CAT, 'utf8'))));
const byText = new Map();
for (const [k, v] of catalogue) if (!byText.has(v)) byText.set(v, k);

/**
 * NEVER KEYED. The non-affiliation notice is englishOnly on the web
 * (en.json `_meta.englishOnly`) and legal wording is not machine-translated.
 * Here it would be worse than on the web: native's builder REFUSES to write
 * while any language lacks a key, so keying a string nothing may translate
 * leaves every bundle stale and the fallback runs off its end into the raw key
 * — which is how `N.APP.TABS.INDEX.UPCOMING-ELECTION` reached a home screen.
 * Matched on the normalised text, so re-wrapping the JSX cannot slip it past.
 */
const NEVER = [
  'Hawkeye is independent and nonpartisan. It is not affiliated with INEC or any government body, and it does not declare results — it records what observers report and lets anyone check the record.',
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'x';
// Same question native_extract asks, minus the newline rule: this text is
// multi-line by definition and is normalised before it is judged.
const CODEY = /[;=(){}[\]`$<>]|&&|\|\||=>|\breturn\b|\bconst\b/;
const prose = (t) => t.length >= 8 && /\s/.test(t) && /^[A-Za-z"'“‘]/.test(t) && !CODEY.test(t)
  && !/^[A-Z0-9 _-]+$/.test(t) && !/https?:|\.(tsx?|png|jpg|mp4)\b/.test(t);

const inComment = (src, i) => {
  const line = src.slice(src.lastIndexOf('\n', i) + 1, i);
  if (/^\s*(\/\/|\*|\/\*)/.test(line)) return true;
  const open = src.lastIndexOf('/*', i);
  return open !== -1 && src.lastIndexOf('*/', i) < open;
};

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx$/.test(p) && !SKIP.some((r) => r.test(p))) files.push(p);
  }
})(SRC);
const targets = only.length ? files.filter((f) => only.some((o) => f.endsWith(o))) : files;

/** Rewrite one source; returns {out, added:[[key, normalised]], ok} without writing. */
function keyFile(file, src) {
  const name = path.relative(SRC, file).replace(/\.tsx$/, '').replace(/[\\/]/g, '.').replace(/[()]/g, '');
  const raws = new Map();   // key -> the ORIGINAL block, for the inverse
  const added = [];
  const used = new Set();

  const out = src.replace(/(>\n)([ \t]*)([^<>{}\n][^<>{}]*?)(\n[ \t]*<)/g, (m, gt, indent, body, tail, offset) => {
    const text = body.replace(/\s+/g, ' ').trim();
    if (!prose(text) || NEVER.includes(text) || inComment(src, offset)) return m;
    let key = byText.get(text);
    if (!key) {
      const base = `n.${name}.${slug(text)}`;
      key = base;
      for (let i = 2; used.has(key) || (catalogue.has(key) && catalogue.get(key) !== text); i++) key = `${base}-${i}`;
      added.push([key, text]);
    }
    used.add(key);
    catalogue.set(key, text);
    raws.set(key, m);
    return `${gt}${indent}{i18nT('${key}')}${tail}`;
  });

  // ---- the inverse: put every original block back, demand byte-identity ----
  const restored = out.replace(/(>\n)([ \t]*)\{i18nT\('([^']+)'\)\}(\n[ \t]*<)/g, (m, gt, indent, key) => raws.get(key) || m);
  return { out, added, ok: restored === src, keyed: used.size };
}

if (CONTROL) {
  // Three corruptions the inverse must catch: a dropped word, a changed
  // indent, and a key whose original block is forgotten.
  const sample = '<Text>\n  Automated checks on every result here.\n</Text>\n';
  const bad = [
    ['dropped word', (s) => s.replace('every ', '')],
    ['changed indent', (s) => s.replace('\n  Automated', '\n   Automated')],
    ['lost original', (s) => s],
  ];
  let caught = 0;
  for (const [label, corrupt] of bad) {
    const r = keyFile(path.join(SRC, 'app/__control.tsx'), sample);
    const restored = label === 'lost original'
      ? r.out.replace(/\{i18nT\('([^']+)'\)\}/, 'SOMETHING ELSE')
      : corrupt(sample);
    const ok = restored !== sample;
    if (ok) caught++;
    console.log(`${ok ? 'caught' : 'MISSED'}  ${label}`);
  }
  console.log(caught === bad.length ? 'control passed' : 'CONTROL FAILED');
  process.exit(caught === bad.length ? 0 : 1);
}

let totalAdded = 0, files_ = 0, refused = 0;
const newKeys = {};
for (const file of targets) {
  const src = fs.readFileSync(file, 'utf8');
  const { out, added, ok, keyed } = keyFile(file, src);
  if (out === src) continue;
  if (!ok) { console.log(`REFUSED (does not round-trip)  ${path.relative(SRC, file)}`); refused++; continue; }
  files_++;
  totalAdded += added.length;
  for (const [k, v] of added) newKeys[k] = v;
  console.log(`${String(keyed).padStart(3)} keyed  ${path.relative(SRC, file)}${added.length ? '' : '  (all reused)'}`);
  if (WRITE) {
    let final = out;
    // Match the BINDING, not this exact line: _layout.tsx imports it as
    // `{ LangProvider, t as i18nT }`, and testing for the canonical line added a
    // second import there — `Duplicate identifier 'i18nT'`, caught by tsc.
    if (!/\bas i18nT\b/.test(final)) {
      const lastImport = final.lastIndexOf('\nimport ');
      const end = final.indexOf('\n', final.indexOf(';', lastImport));
      final = final.slice(0, end + 1) + IMPORT + '\n' + final.slice(end + 1);
    }
    fs.writeFileSync(file, final);
  }
}
console.log(`\n${files_} file(s), ${totalAdded} new key(s), ${refused} refused${WRITE ? '' : '  (dry run — nothing written to source)'}`);
if (totalAdded) {
  // Always, dry run included: the catalogue has to be READ as a whole before
  // any of it is believed — a per-candidate filter passes things a reader
  // would throw out at a glance.
  fs.writeFileSync(path.join(ROOT, 'tmp/native_new_keys.json'), JSON.stringify(newKeys, null, 2) + '\n');
  console.log('new English in tmp/native_new_keys.json');
}
if (WRITE && totalAdded) {
  const merged = Object.fromEntries([...catalogue.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  fs.writeFileSync(CAT, JSON.stringify(merged, null, 2) + '\n');
  console.log(`catalogue: ${Object.keys(merged).length} keys`);
}

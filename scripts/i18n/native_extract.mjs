/**
 * Key the native app's visible strings.
 *
 * TWO SHAPES ONLY, both unambiguous in TSX:
 *   >Some words<            ->  >{i18nT('key')}<
 *   prop="Some words"       ->  prop={i18nT('key')}
 * Anything with braces, tags or interpolation inside is left alone — a partial
 * rewrite of a template is how a screen ends up rendering "[object Object]".
 *
 * SAFETY: this edits CODE, so the byte-identity trick used on the HTML does not
 * apply. The inverse is checked instead — every `{i18nT('key')}` written back is
 * substituted with the English from the catalogue, and the result must equal
 * the original file. A key whose English drifted, a mangled quote or a lost
 * character all fail that. Then `tsc --noEmit` has to pass.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const SRC = path.join(ROOT, 'native/src');
const WEB = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/i18n/en.json'), 'utf8'));
const WRITE = process.argv.includes('--write');

/* Reverse index of the web's English -> key, so copy the two clients share is
   translated once. The app is meant to be at parity with the PWA, so this is
   most of the chrome and much of the report flow. */
const webByText = new Map();
for (const [k, v] of Object.entries(WEB)) if (k !== '_meta' && !webByText.has(v)) webByText.set(v, k);

const KEEP = new Set(['hawkeye', 'inec', 'ec8a', 'ec8b', 'ec8c', 'ec8d', 'faq', 'gps', 'sms',
  'telegram', 'whatsapp', 'android', 'iphone', 'ios', 'qr', 'apc', 'pdp', 'lp', 'nnpp', 'bvas',
  'id', 'ok', 'url', 'api', 'ai']);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'x';

/**
 * IS THIS PROSE, OR IS IT CODE?
 *
 * The first version of this asked only "is it reversible", and it was: it
 * keyed `0 && contest.states.length` out of `x > 0 && y.length <`, wrote that
 * into ten files, and the inverse check passed every one of them because
 * substituting the text back restores the file exactly. A reversible wrong
 * transform is still wrong. So the question here is what the string IS, and
 * `assertProse` below re-asks it over the finished catalogue — a filter that
 * runs per candidate can be bypassed by a match shape nobody predicted.
 */
const CODEY = /[;=(){}[\]`$<>]|&&|\|\||=>|\breturn\b|\bconst\b|\n/;

function worth(s) {
  const t = s.trim();
  if (!t || t.length > 400) return false;
  if (!/[A-Za-z]{3}/.test(t)) return false;              // needs real words
  if (CODEY.test(t)) return false;
  if (!/^[A-Za-z -￿"'‘“]/.test(t)) return false;  // prose starts with a letter or a quote
  if (KEEP.has(t.toLowerCase())) return false;
  if (/^[A-Z_]+$/.test(t)) return false;                  // CONSTANT_CASE
  if (/^https?:|^[\w.]+\/[\w.]/.test(t)) return false;    // urls and paths
  return true;
}

/** The same question, asked of the RESULT rather than of each candidate. */
function assertProse(catalogue) {
  const bad = [...catalogue].filter(([, v]) => CODEY.test(v) || !/^[A-Za-z -￿"'‘“]/.test(v));
  if (!bad.length) return true;
  console.error('\nNOT PROSE — refusing to write. ' + bad.length + ' entr(ies) look like code:');
  for (const [k, v] of bad.slice(0, 10)) console.error('  ' + k + ' :: ' + JSON.stringify(v.slice(0, 70)));
  return false;
}

const PROPS = 'title|label|placeholder|accessibilityLabel|accessibilityHint|subtitle|hint|cta|heading|message|confirmLabel|cancelLabel|body';

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    // i18n.tsx holds the language NAMES, which must read the same in every
    // language — keying them would make the picker translate its own options.
    else if (e.name.endsWith('.tsx') && e.name !== 'i18n.tsx') files.push(p);
  }
})(SRC);
files.sort();

const catalogue = new Map();       // key -> english
/* RE-RUNS. Once a file is keyed its strings are `{i18nT('key')}` and this
   script has nothing left to extract from it — but the reversibility check
   still substitutes the English back for every key it finds, and with an empty
   catalogue it cannot, so every already-done file reported "not reversible".
   Seeding from the shipped English bundle makes a second run a clean no-op
   instead of a wall of false alarms. */
try {
  const shipped = JSON.parse(fs.readFileSync(path.join(SRC, 'lib/i18n/en.json'), 'utf8'));
  for (const [k, v] of Object.entries(shipped)) catalogue.set(k, v);
} catch { /* first run: nothing shipped yet */ }
const byText = new Map(webByText); // english -> key (web keys win)
const reused = new Set();
const report = [];

for (const file of files) {
  const orig = fs.readFileSync(file, 'utf8');
  /**
   * COMMENTS ARE NOT UI.
   *
   * These files' docblocks contain JSX examples, and the first run rewrote
   * one of them -- turning documentation into a call to a translate
   * function, and minting a catalogue entry from a sample.
   *
   * Tested by LINE, not by masking the comment regions out and putting them
   * back: masking needs a sentinel that cannot occur in the source, and the
   * obvious ones match real UI text ("Page 12 of 30"). A line whose first
   * non-space character is * or / is a comment, which covers every case
   * here and cannot corrupt anything.
   */
  const inComment = (src, index) => {
    const lineStart = src.lastIndexOf('\n', index) + 1;
    return /^\s*(\*|\/)/.test(src.slice(lineStart, index + 1));
  };
  const name = path.relative(SRC, file).replace(/\.tsx$/, '').replace(/[\\/]/g, '.').replace(/[()]/g, '');
  let added = 0;
  const used = new Set();

  const keyFor = (text) => {
    if (byText.has(text)) {
      const k = byText.get(text);
      if (webByText.has(text)) reused.add(k);
      catalogue.set(k, text);
      return k;
    }
    let k = 'n.' + name + '.' + slug(text);
    let n = 2;
    while (catalogue.has(k) || used.has(k)) k = 'n.' + name + '.' + slug(text) + '-' + n++;
    used.add(k);
    catalogue.set(k, text);
    byText.set(text, k);
    added++;
    return k;
  };

  /* `>TEXT</` — the closing MUST be a closing tag. Without that `</`, the
     pattern also matches a JavaScript comparison: `x > 0 && y.length <` is
     ">", text, "<" as far as a regex is concerned, and that is exactly what it
     keyed the first time. */
  const pass1 = orig.replace(/>([^<>{}\n][^<>{}\n]*)<\//g, (m, inner, offset) => {
    if (!worth(inner) || inComment(orig, offset)) return m;
    const lead = inner.match(/^\s*/)[0];
    const trail = inner.match(/\s*$/)[0];
    return '>' + lead + "{i18nT('" + keyFor(inner.trim()) + "')}" + trail + '</';
  });
  /* Offsets here index pass1, NOT orig — the first pass has already changed
     the length of every line it touched, so testing against orig would ask
     about the wrong line. */
  const out = pass1.replace(new RegExp('\\b(' + PROPS + ')="([^"\\n]+)"', 'g'), (m, prop, val, offset) => (
    worth(val) && !inComment(pass1, offset) ? prop + "={i18nT('" + keyFor(val.trim()) + "')}" : m
  ));

  // ---- the inverse ---------------------------------------------------------
  const back = out.replace(/\{i18nT\('([^']+)'\)\}/g, (m, k) => (catalogue.has(k) ? catalogue.get(k) : m))
    .replace(new RegExp('\\b(' + PROPS + ')=([A-Za-z][^\\s>]*)', 'g'), (m) => m);
  const restored = out
    .replace(new RegExp('\\b(' + PROPS + ")=\\{i18nT\\('([^']+)'\\)\\}", 'g'), (m, prop, k) => prop + '="' + catalogue.get(k) + '"')
    .replace(/\{i18nT\('([^']+)'\)\}/g, (m, k) => (catalogue.has(k) ? catalogue.get(k) : m));
  /**
   * TWO INVARIANTS, because a first pass and a re-run are different questions.
   *
   * On un-keyed source: substituting the English back for every key must
   * reproduce the file exactly — that is what proves the rewrite lost nothing.
   *
   * On source that is ALREADY keyed the substitution cannot hold, because the
   * original itself contains the keys; the meaningful claim there is that this
   * run changed nothing at all. Asserting the first invariant on a re-run made
   * every finished file report "not reversible", which is a wall of false
   * alarms and the fastest way to teach someone to ignore the output.
   */
  const wasKeyed = /\{i18nT\('/.test(orig);
  const ok = wasKeyed ? out === orig : restored === orig;
  report.push({ file: path.relative(SRC, file), added, ok, hits: (out.match(/\{i18nT\('/g) || []).length, out });
  if (!ok) {
    console.error('FAIL (' + (wasKeyed ? 'already keyed, but this run changed it' : 'not reversible') + ') '
      + path.relative(SRC, file));
    process.exitCode = 1;
    continue;
  }
  void back;
}

/* BOTH gates before anything is written: reversible AND prose. Writing per
   file as we went meant a bad catalogue was already on disk by the time it
   could be judged as a whole. */
/* Both gates run on EVERY invocation, not only under --write. A check that
   only fires when you are about to write is a check you cannot rehearse, and
   the control that exercises this script runs it read-only. */
const reversible = report.every((r) => r.ok);
const prose = assertProse(catalogue);
if (!prose) process.exitCode = 1;
if (WRITE && reversible && prose) {
  for (const r of report) {
    if (r.hits) fs.writeFileSync(path.join(SRC, r.file), r.out);
  }
} else if (WRITE) {
  console.error('\nNOTHING WRITTEN.');
  process.exitCode = 1;
}

const touched = report.filter((r) => r.hits);
for (const r of touched) console.log((r.ok ? 'ok  ' : 'FAIL') + ' ' + r.file.padEnd(38) + r.hits + ' strings, ' + r.added + ' new');
console.log('\nfiles touched : ' + touched.length + ' of ' + files.length);
console.log('unique strings: ' + catalogue.size);
console.log('reused from the web bundles: ' + reused.size);
console.log('new, native-only           : ' + [...catalogue.keys()].filter((k) => k.startsWith('n.')).length);
if (WRITE) {
  fs.writeFileSync(path.join(ROOT, 'scripts/i18n/native_catalogue.json'),
    JSON.stringify(Object.fromEntries([...catalogue].sort()), null, 2) + '\n');
  console.log('catalogue -> scripts/i18n/native_catalogue.json');
}

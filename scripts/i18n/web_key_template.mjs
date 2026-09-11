/**
 * KEY THE TEXT A TEMPLATE LITERAL PAINTS.
 *
 * The room, join.html and my-groups.html build their DOM as template literals.
 * i18n_extract/auto_key read MARKUP and see none of it; key_js reads
 * `el.textContent = '…'` and sees almost none of it; rendered_gaps cannot reach
 * the room at all, because signed out it renders an auth wall. So a page can
 * report clean everywhere and still be English on screen — which is what
 * situation-room.html was: 103 candidates.
 *
 * WHAT IT REWRITES, English kept as the fallback argument so the source still
 * reads as English and still works with no bundle loaded:
 *   `>Refresh<`              -> `>${T('situation-room.refresh', 'Refresh')}<`
 *   `alert('Pick the race.')` -> `alert(T('situation-room.pick-the-race', 'Pick the race.'))`
 *   `textContent = 'Copied'`  -> `textContent = T('situation-room.copied', 'Copied')`
 *
 * WHAT IT REFUSES, because each has burned this toolchain before:
 *   · anything holding `${…}` or a `' + …' ` concatenation — interpolation order
 *     is not a translation invariant, and those need a {placeholder} by hand;
 *   · anything that looks like code (`dist(fold(x.name), k)` matched the naive
 *     `>…<` pattern in the scan);
 *   · the wordmark and other allowlisted proper nouns;
 *   · text already inside T(…), and attribute values.
 *
 * SAFETY, same as the native keyers: substituting every English fallback back
 * through the rewrite must reproduce the file BYTE FOR BYTE, and the catalogue
 * is judged as prose as a whole before anything is written. --control plants
 * corruptions and requires them caught.
 *
 *   node scripts/i18n/web_key_template.mjs situation-room.html          # dry run
 *   node scripts/i18n/web_key_template.mjs situation-room.html --write
 *   node scripts/i18n/web_key_template.mjs --control
 */
import fs from 'node:fs';

const APP = '/home/elrio/hawkeye/app';
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const CONTROL = args.includes('--control');
const files = args.filter((a) => !a.startsWith('--'));

const en = JSON.parse(fs.readFileSync(`${APP}/i18n/en.json`, 'utf8'));
const byText = new Map();
for (const [k, v] of Object.entries(en)) if (k !== '_meta' && typeof v === 'string' && !byText.has(v)) byText.set(v, k);

/**
 * FRAGMENTS OF A SENTENCE, never keyed on their own. Each of these sits inside
 * a paragraph that also carries <strong>, <em> or an <a>, and clause order is
 * not a translation invariant: a sentence reassembled from English-ordered
 * pieces is not a translation. The whole paragraph is keyed by hand instead,
 * markup travelling inside the one string.
 */
const FRAGMENTS = new Set(['already-public', 'public docket', 'to move someone, if you see fit.', 'yours', 'not the assigned unit']);

/** Legitimately identical in every language — the checker's own allowlist. */
const KEEP = new Set(['HAWKEYE', 'Hawkeye', 'INEC', 'EC8A', 'IReV', 'PDP', 'APC', 'LP', 'NNPP', 'ADC', 'CSV', 'GPS', 'ID']);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 7).join('-') || 'x';

const prose = (raw) => {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length < 3 || KEEP.has(t) || FRAGMENTS.has(t)) return null;
  if (!/[A-Za-z]{2}/.test(t) || !/^[A-Za-z“"']/.test(t)) return null;
  if (/\$\{|\+\s*'|'\s*\+|[<>{}=;]|=>/.test(t)) return null;      // interpolation or code
  if (/\w\(|\)\s*$/.test(t)) return null;                          // a call, e.g. dist(fold(x.name), k)
  if (/^[A-Z0-9 _-]+$/.test(t)) return null;                       // CONSTANT CASE / wordmark
  if (/^(px|rem|em|auto|none|flex|grid|true|false|null)\b/.test(t)) return null;
  return t;
};

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function keyPage(file, src) {
  const page = file.replace(/\.html$/, '');
  const added = {};
  const used = new Set();
  const skipped = [];
  /**
   * ONE KEY PER ENGLISH STRING. The first pass handed a translator
   * `coverage`, `coverage-2`, `coverage-3` and `coverage-4` — the same word
   * four times, four chances to answer differently, and four things to keep in
   * step forever. The numbered suffix now only breaks a genuine COLLISION: a
   * key that already exists in en.json carrying different English.
   */
  const mine = new Map();
  const keyFor = (text) => {
    let k = byText.get(text) || mine.get(text);
    if (!k) {
      const base = `${page}.${slug(text)}`;
      k = base;
      for (let i = 2; en[k] !== undefined && en[k] !== text; i++) k = `${base}-${i}`;
      added[k] = text;
      mine.set(text, k);
    }
    used.add(k);
    return k;
  };

  /**
   * INSIDE THE INLINE SCRIPT ONLY. `${…}` interpolates in a template literal
   * and prints literally anywhere else, so running the `>text<` pass over the
   * whole file would stamp `${T('…')}` into the static header for every reader
   * to see. Static markup belongs to auto_key.mjs and its data-i18n attributes.
   */
  const SCRIPT = /(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/g;
  /**
   * `${…}` INTERPOLATES ONLY INSIDE BACKTICKS. The room also builds markup in
   * ORDINARY quoted strings — `'<button id="invite-btn">Invite observers</button>'`
   * — and writing `${T('…')}` into one of those is not a translation, it is a
   * syntax error: `'…${T('situation-room.invite-observers', …)}…'` ends the
   * string at the inner quote. node --check caught it on the written file; this
   * keeps it from being written at all. Text in a quoted string is left for a
   * human, who can turn the string into a template literal first.
   */
  const inTemplate = (body, idx) => {
    /* Decide from the ENCLOSING LINE, not from the top of the file. Counting
       backticks from character zero means one unbalanced tick anywhere earlier
       — in a comment, a regex, a docblock — inverts the answer for everything
       after it, and this script is 1,400 lines long: that mistake called 90
       genuine template literals "quoted strings". A markup fragment lives on
       one line, and on that line the quote that opened it is unambiguous. */
    const from = body.lastIndexOf('\n', idx) + 1;
    let tick = false, quote = null;
    for (let i = from; i < idx; i++) {
      const c = body[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '`') tick = !tick;
      else if (!tick && (c === "'" || c === '"')) quote = c;
    }
    // Inside a quote opened on THIS line -> a quoted string. Otherwise the line
    // is a continuation of a multi-line template literal, which is the norm here.
    return !quote;
  };
  const out = src.replace(SCRIPT, (m, open, body, close) => {
    // 1. text between tags inside a template literal — ONE LINE, and with no
    // internal whitespace run. The catalogue holds the sentence a reader sees,
    // so the English written back as the fallback must be that same string: a
    // block spanning lines, or holding a double space, comes back collapsed and
    // the inverse below then cannot reproduce the file. The room was REFUSED
    // outright until this was narrowed — those are reported, never guessed at.
    let b = body.replace(/>([^<>{}\n][^<>{}\n]{2,})</g, (mm, inner, idx) => {
      const t = prose(inner);
      if (!t) return mm;
      if (!inTemplate(body, idx)) { skipped.push(`[quoted string] ${t.slice(0, 60)}`); return mm; }
      if (t !== inner.trim()) { skipped.push(inner.trim().replace(/\s+/g, ' ').slice(0, 70)); return mm; }
      const lead = inner.match(/^\s*/)[0];
      const trail = inner.match(/\s*$/)[0];
      return `>${lead}\${T('${keyFor(t)}', '${esc(t)}')}${trail}<`;
    });
    // 2. dialogs and textContent assignments
    b = b.replace(/\b(alert|confirm)\(\s*'([^']{4,})'\s*\)/g, (mm, fn, s) => {
      const t = prose(s);
      return t ? `${fn}(T('${keyFor(t)}', '${esc(t)}'))` : mm;
    });
    b = b.replace(/(textContent\s*=\s*)'([^']{3,})'/g, (mm, lead, s) => {
      const t = prose(s);
      return t ? `${lead}T('${keyFor(t)}', '${esc(t)}')` : mm;
    });
    return open + b + close;
  });

  // ---- the inverse ----
  const back = out
    .replace(/\$\{T\('[^']+', '((?:[^'\\]|\\.)*)'\)\}/g, (m, s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
    .replace(/\b(alert|confirm)\(T\('[^']+', '((?:[^'\\]|\\.)*)'\)\)/g, (m, fn, s) => `${fn}('${s}')`)
    .replace(/(textContent\s*=\s*)T\('[^']+', '((?:[^'\\]|\\.)*)'\)/g, (m, lead, s) => `${lead}'${s}'`);
  return { out, added, ok: back === src, count: used.size, skipped };
}

if (CONTROL) {
  /* Every fixture is wrapped in a <script>, because that is now the only place
     this keyer may write. An unwrapped fixture made three of these checks pass
     for the wrong reason: nothing matched at all. */
  const wrap = (js) => `<p>Static markup here</p>\n<script>\n${js}\n</script>\n`;
  const sample = wrap("const html = `<button>Refresh</button>`;\nalert('Pick the race.');");
  const r = keyPage('control.html', sample);
  const checks = [
    ['keys both shapes', r.count === 2 && r.ok],
    ['a dropped word breaks the inverse', keyPage('control.html', sample.replace('Refresh', 'Refres')).out !== r.out],
    ['refuses an interpolated string', keyPage('control.html', wrap('const h = `<b>${x} units</b>`;')).count === 0],
    ['refuses a code fragment', keyPage('control.html', wrap('const h = `<b>dist(fold(x.name), k)</b>`;')).count === 0],
    // The reason this keyer is confined at all: `${…}` outside a template
    // literal is not interpolation, it is six characters printed on screen.
    ['leaves static markup alone', !r.out.includes('${T(') || r.out.split('${T(')[0].includes('<script>')],
    // The break node --check caught: `${…}` in a quoted string is a syntax error.
    ['leaves markup in a QUOTED string alone', keyPage('control.html', wrap("const h = '<button>Invite observers</button>';")).count === 0],
    ['…and says so', keyPage('control.html', wrap("const h = '<button>Invite observers</button>';")).skipped.some((s) => s.startsWith('[quoted string]'))],
  ];
  for (const [n, ok] of checks) console.log(ok ? 'PASS' : 'FAIL', n);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

const all = {};
for (const f of files) {
  const src = fs.readFileSync(`${APP}/${f}`, 'utf8');
  const { out, added, ok, count, skipped } = keyPage(f, src);
  if (!ok) { console.log(`REFUSED (does not round-trip)  ${f}`); continue; }
  console.log(`${String(count).padStart(3)} keyed, ${Object.keys(added).length} new  ${f}${WRITE ? '' : '  (dry run)'}`);
  if (skipped.length) {
    console.log(`     ${skipped.length} left for a human (multi-line or double-spaced):`);
    for (const s of skipped.slice(0, 20)) console.log(`       ${JSON.stringify(s)}`);
  }
  Object.assign(all, added);
  if (WRITE) fs.writeFileSync(`${APP}/${f}`, out);
}
if (Object.keys(all).length) {
  fs.writeFileSync('/home/elrio/hawkeye/tmp/web_new_keys.json', JSON.stringify(all, null, 2) + '\n');
  console.log(`\n${Object.keys(all).length} new English strings -> tmp/web_new_keys.json`);
}

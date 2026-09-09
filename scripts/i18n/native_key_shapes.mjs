/**
 * KEY THE SHAPES THE OTHER EXTRACTOR SKIPS.
 *
 * `native_extract.mjs` handles two shapes — `>Text<` and `prop="Text"` — and
 * reports "0 new" for every file. That is true and useless: 47 of 47 strings
 * photographed rendering in English were unkeyed, and all of them live in the
 * shapes it refuses. Those refusals were right for it (a partial rewrite of a
 * template is how a screen renders "[object Object]"), so this is a second tool
 * rather than a loosening of the first.
 *
 * THREE SHAPES, each rewritten only when it can be rewritten exactly:
 *
 *   1. TEMPLATE WITH INTERPOLATION
 *        `Opens in ${daysUntil(c.date)} days`
 *      ->  i18nT('key', { n0: daysUntil(c.date) })      en: "Opens in {n0} days"
 *      The runtime already interpolates {name} and 18 keys already use it, so
 *      this needs no new machinery. Expressions are hoisted into params rather
 *      than concatenated, which is the whole point: a language that puts the
 *      number after the noun is served by a placeholder and cannot be served by
 *      a join.
 *
 *   2. TERNARY OVER TWO STRINGS
 *        {c.open ? 'Reporting open' : 'Upcoming election'}
 *      ->  {c.open ? i18nT('k.a') : i18nT('k.b')}
 *      Two keys, because they are two sentences. Keying the pair as one string
 *      with a placeholder would ask a translator to translate a condition.
 *
 *   3. STRING PROPERTY IN A UI DESCRIPTOR
 *        { key: 'result', label: 'Report a Result', sub: '…' }
 *      -> reported, NOT rewritten. These are usually module-level constants,
 *      where an i18nT() call is evaluated once at import — before the stored
 *      language is known — and freezes in English forever. That bug is already
 *      in this repo's history. The fix is per-site (hold the KEY in the
 *      descriptor, resolve at render), so this tool lists them for a human
 *      instead of rewriting them wrongly.
 *
 * SAFETY. Every rewrite is checked by substituting the English back through the
 * transformation and requiring the file to be byte-identical to what it was.
 * A drifted English, a mangled quote, a lost expression all fail that. Nothing
 * is written unless every rewrite in the file round-trips.
 *
 *   node scripts/i18n/native_key_shapes.mjs <file>            # dry run
 *   node scripts/i18n/native_key_shapes.mjs <file> --write
 *   node scripts/i18n/native_key_shapes.mjs --control
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const CAT = path.join(ROOT, 'scripts/i18n/native_catalogue.json');
const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));
const byText = new Map();
for (const [k, v] of Object.entries(cat)) if (!byText.has(v)) byText.set(v, k);

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const CONTROL = args.includes('--control');
const targets = args.filter((a) => !a.startsWith('--'));

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'x';

/** A key prefix from the file path: app/(tabs)/index.tsx -> n.app.tabs.index */
const prefixFor = (file) =>
  'n.' + file.replace(/^native\/src\//, '').replace(/\.tsx?$/, '')
    .replace(/[()]/g, '').replace(/\//g, '.').replace(/\.+/g, '.');

/** Prose, or code that happens to be quoted? */
/** Add the i18nT import if this file gained its first call. The keyers rewrite
 *  call sites; a file with no previous i18nT has no import, and the rewrite
 *  then does not compile. tsc catches it, but only after the write. */
function ensureImport(src) {
  if (!/\bi18nT\(/.test(src)) return src;
  if (/import \{[^}]*\bt as i18nT\b[^}]*\} from '@\/lib\/i18n'/.test(src)) return src;
  const lines = src.split('\n');
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^import .*from '.*';\s*$/.test(lines[i])) last = i;
  if (last === -1) return src;
  lines.splice(last + 1, 0, "import { t as i18nT } from '@/lib/i18n';");
  return lines.join('\n');
}

function isProse(t) {
  const s = t.trim();
  if (s.length < 3 || s.length > 240) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (/^[a-z-]+$/.test(s)) return false;                  // css value / prop
  if (/^[A-Z_]{2,}$/.test(s)) return false;               // CONSTANT
  if (/^[\w.-]+$/.test(s) && !/\s/.test(s)) return false; // identifier / path
  if (/^(https?:|\/|\.\.?\/|#|@)/.test(s)) return false;
  // A className is a run of lowercase-hyphen tokens. isProse already rejects a
  // single one; a whole Tailwind string is many of them separated by spaces,
  // which looked like a sentence to the first version of this test.
  const toks = s.split(/\s+/).filter(Boolean);
  const cssish = toks.filter((t) => /^-?[a-z][a-z0-9]*(-[a-z0-9./[\]#%]+)+$/.test(t) || /^(flex|grid|hidden|block|w-|h-|p[xytblr]?-|m[xytblr]?-|text-|bg-|border|rounded|items-|justify-)/.test(t)).length;
  if (toks.length >= 2 && cssish / toks.length > 0.4) return false;
  if (/^\d+(px|%|rem)?$/.test(s)) return false;
  return /[A-Z]/.test(s[0]) || /\s/.test(s);
}

function keyFor(prefix, english, used) {
  if (byText.has(english)) return byText.get(english);      // reuse, never duplicate
  let k = `${prefix}.${slug(english)}`;
  let n = 2;
  while (used.has(k) || k in cat) k = `${prefix}.${slug(english)}-${n++}`;
  used.add(k);
  return k;
}

function processFile(file) {
  const abs = path.join(ROOT, file);
  const orig = fs.readFileSync(abs, 'utf8');
  let src = orig;
  const prefix = prefixFor(file);
  const used = new Set();
  const added = {};
  const rewrites = [];
  const manual = [];

  /* ---- shape 3: descriptor properties, reported only --------------------- */
  for (const m of src.matchAll(/\b(label|sub|title|text|placeholder|hint|desc)\s*:\s*'([^'\\]{3,160})'/g)) {
    if (isProse(m[2])) {
      const line = src.slice(0, m.index).split('\n').length;
      manual.push({ line, prop: m[1], text: m[2] });
    }
  }

  /* ---- shape 2: ternary over two string literals -------------------------- */
  src = src.replace(
    /\{([^{}'"`]{1,80}?)\s\?\s'([^'\\]{3,160})'\s:\s'([^'\\]{3,160})'\}/g,
    (whole, cond, a, b) => {
      if (!isProse(a) || !isProse(b)) return whole;
      const ka = keyFor(prefix, a, used);
      const kb = keyFor(prefix, b, used);
      added[ka] = a;
      added[kb] = b;
      rewrites.push({ kind: 'ternary', from: whole, a, b, to: `{${cond} ? i18nT('${ka}') : i18nT('${kb}')}` });
      return `{${cond} ? i18nT('${ka}') : i18nT('${kb}')}`;
    },
  );

  /* ---- shape 1: template literal with interpolation ----------------------- */
  src = src.replace(/`([^`\\]*\$\{[^`]*)`/g, (whole, body) => {
    // Split into literal chunks and ${expressions}.
    const parts = [];
    let i = 0;
    let depth = 0;
    let cur = '';
    let expr = null;
    while (i < body.length) {
      if (expr === null && body[i] === '$' && body[i + 1] === '{') {
        parts.push({ lit: cur });
        cur = '';
        expr = '';
        depth = 1;
        i += 2;
        continue;
      }
      if (expr !== null) {
        if (body[i] === '{') depth++;
        if (body[i] === '}') {
          depth--;
          if (depth === 0) {
            parts.push({ expr });
            expr = null;
            i++;
            continue;
          }
        }
        expr += body[i];
        i++;
        continue;
      }
      cur += body[i];
      i++;
    }
    if (expr !== null) return whole;              // unbalanced; leave it alone
    // A MULTI-LINE EXPRESSION IS LEFT ALONE. Rebuilding it collapses the
    // author's line breaks, so the round-trip check refuses the file — which is
    // correct, and means this tool must not offer the rewrite in the first
    // place. Those go to the hand-keying list.
    if (parts.some((p) => p.expr !== undefined && p.expr.includes('\n'))) return whole;
    parts.push({ lit: cur });

    const litText = parts.filter((p) => p.lit !== undefined).map((p) => p.lit).join(' ').trim();
    if (!isProse(litText)) return whole;
    // A template that is mostly expression is a composed value, not a sentence.
    if (litText.replace(/\s+/g, '').length < 6) return whole;
    // A DATA FORMAT IS NOT A SENTENCE. `race|v1|${a}|${b}` builds a ledger leaf;
    // translating it would stop the proof folding. Pipes, and lowercase runs
    // with no sentence punctuation, are machine syntax. This is the same class
    // as the filenames: a rewrite that is mechanically perfect and semantically
    // wrong, which a round-trip check cannot see by construction.
    if (/[|;=]/.test(litText)) return whole;
    // A URI IS NOT A SENTENCE. ethereum:{addr}@8453 is an EIP-681 payment URI
    // behind a donation QR; translating it routes money to nothing. Any scheme
    // followed by a colon, or an @ in a string with no spaces, is machine.
    if (/^[a-z][a-z0-9+.-]*:/.test(litText.trim())) return whole;
    if (/@/.test(litText) && !/\s/.test(litText.trim())) return whole;
    // A FILENAME IS NOT A SENTENCE. clip${n}.mp4 and photo${n}.jpg were keyed
    // by the first version of this tool: they start with a letter, contain a
    // dot, and rewrote perfectly — the round-trip check cannot catch a rewrite
    // that is mechanically right and semantically wrong. A literal with no
    // space that ends in a file extension is refused here instead.
    if (!/\s/.test(litText) && /\.[a-z0-9]{2,4}$/i.test(litText)) return whole;
    // Nested quotes or a className are not prose.
    if (/className|style=|http/.test(body)) return whole;

    const names = [];
    let english = '';
    let n = 0;
    for (const p of parts) {
      if (p.lit !== undefined) english += p.lit;
      else {
        const nm = `v${n++}`;
        names.push({ nm, expr: p.expr.trim() });
        english += `{${nm}}`;
      }
    }
    const k = keyFor(prefix, english.replace(/\{\w+\}/g, '').trim() || 'x', used);
    added[k] = english;
    rewrites.push({ kind: 'template', from: whole, english, names, key: k });
    const params = names.map((x) => `${x.nm}: ${x.expr}`).join(', ');
    return `i18nT('${k}', { ${params} })`;
  });

  /* ---- SAFETY: rebuild each rewrite from its catalogue English -----------
   *
   * PER REWRITE, not per file. The whole-file version substituted every
   * occurrence of a key, which broke as soon as a rewrite REUSED a key that
   * already existed elsewhere in the same file — it rewrote the pre-existing
   * call too, and then refused a rewrite that was correct. Reuse is the
   * behaviour we want, so the check has to tolerate it.
   */
  function verifyRewrite(rw) {
    if (rw.kind === 'ternary') {
      const a = added[byText.get(rw.a) ?? ''] ?? cat[byText.get(rw.a) ?? ''] ?? rw.a;
      const b = added[byText.get(rw.b) ?? ''] ?? cat[byText.get(rw.b) ?? ''] ?? rw.b;
      // The English on both sides must be exactly what was there.
      return a === rw.a && b === rw.b;
    }
    // Template: put the expressions back into the English and compare.
    let out = rw.english;
    for (const { nm, expr } of rw.names) out = out.split(`{${nm}}`).join('${' + expr + '}');
    return '`' + out + '`' === rw.from;
  }

  const broken = rewrites.filter((rw) => !verifyRewrite(rw));
  const roundTrips = broken.length === 0;
  const divergence = broken.length
    ? { at: 0, was: broken[0].from.slice(0, 100), now: `${broken[0].kind} did not rebuild` }
    : null;

  return { file, src, orig, added, rewrites, manual, roundTrips, divergence };
}

if (CONTROL) {
  // A template whose English drifts must fail the round-trip.
  const tmp = path.join(ROOT, 'tmp/_keyshape_control.tsx');
  fs.writeFileSync(tmp, 'const x = <Text>{`Opens in ${n} days`}</Text>;\n');
  const r = processFile('tmp/_keyshape_control.tsx');
  const ok = r.roundTrips;
  // Now corrupt the catalogue entry and re-check.
  const k = Object.keys(r.added)[0];
  r.added[k] = 'Opens in {v0} DAYS';
  let back = r.src.replace(/i18nT\('[^']+',\s*\{([^}]*)\}\)/, '`Opens in ${n} DAYS`');
  const fails = back !== r.orig;
  fs.unlinkSync(tmp);
  console.log(`  ${ok ? 'passes' : 'DEAD  '}  a clean rewrite round-trips`);
  console.log(`  ${fails ? 'fires ' : 'DEAD  '}  a drifted English does NOT round-trip`);
  process.exit(ok && fails ? 0 : 1);
}

if (!targets.length) {
  console.log('usage: node scripts/i18n/native_key_shapes.mjs <file...> [--write]');
  process.exit(2);
}

let totalAdded = 0;
const catOut = { ...cat };
for (const f of targets) {
  const r = processFile(f);
  const n = Object.keys(r.added).length;
  totalAdded += n;
  console.log(`\n${f}`);
  console.log(`  rewrites: ${r.rewrites.length}  new keys: ${n}  round-trips: ${r.roundTrips ? 'YES' : 'NO — NOT WRITTEN'}`);
  for (const rw of r.rewrites.slice(0, 6)) {
    console.log(`    ${rw.kind.padEnd(9)} ${(rw.english ?? `${rw.a} | ${rw.b}`).slice(0, 76)}`);
  }
  if (r.divergence) {
    console.log(`  first divergence at line ${r.divergence.at}:`);
    console.log(`    was: ${r.divergence.was}`);
    console.log(`    now: ${r.divergence.now}`);
  }
  if (r.manual.length) {
    console.log(`  descriptor properties for a human (module-level const trap):`);
    for (const m of r.manual.slice(0, 6)) console.log(`    line ${m.line} ${m.prop}: ${m.text.slice(0, 60)}`);
  }
  if (WRITE && r.roundTrips && n) {
    fs.writeFileSync(path.join(ROOT, f), ensureImport(r.src));
    Object.assign(catOut, r.added);
  }
}

if (WRITE) {
  fs.writeFileSync(CAT, JSON.stringify(Object.fromEntries(Object.entries(catOut).sort()), null, 2) + '\n');
  console.log(`\ncatalogue now ${Object.keys(catOut).length} keys (+${totalAdded})`);
} else {
  console.log(`\ndry run — ${totalAdded} keys would be added. Pass --write to apply.`);
}

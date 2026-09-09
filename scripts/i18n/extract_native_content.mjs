/**
 * Extract the translatable prose out of native/src/lib/content.ts.
 *
 * WHY THIS FILE GETS ITS OWN MECHANISM. content.ts is not a flat catalogue of
 * labels; it is a nested typed content tree — pages of blocks of items of
 * bullets — with 138 prose strings buried at every depth. Threading a `*Key`
 * beside each of them would mean 138 edits to a file whose whole value is that
 * it reads as prose, and would leave the renderer picking its way through pairs.
 *
 * So the strings are keyed BY THEIR ENGLISH. That is normally a bad idea — no
 * context for the translator, and two identical strings in different places are
 * forced to share a translation — but this corpus is closed, self-contained and
 * authored in one voice, and here "the same sentence gets the same translation"
 * is the correct outcome rather than a collision. The alternative costs 138 edits
 * to buy a distinction this content does not draw.
 *
 * WHAT IS SKIPPED: the privacy page. app/i18n/en.json's _meta.englishOnlyPages
 * lists privacy and terms as deliberately English, and the native port of that
 * page is the same legal text.
 *
 *   node scripts/i18n/extract_native_content.mjs        # -> tmp/native_content_en.json
 */
import fs from 'node:fs';

const SRC = '/home/elrio/hawkeye/native/src/lib/content.ts';
const src = fs.readFileSync(SRC, 'utf8');

/** Fields that hold prose. Everything else — icon, href, url, kind, tone — is machinery. */
const TEXT_FIELDS = new Set(['text', 'title', 'body', 'cta', 'kicker', 'label']);

/**
 * Parse by evaluating the object literal, not by regex: the tree is nested five
 * deep and a regex over it would silently miss whole branches — the exact
 * failure mode that left eleven web pages reported as "0 remaining".
 */
const start = src.indexOf('export const PAGES');
const open = src.indexOf('{', start);
let depth = 0, end = -1;
for (let i = open; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error('could not find the PAGES object'); process.exit(1); }
const literal = src.slice(open, end);

// eslint-disable-next-line no-new-func
const PAGES = new Function(`return (${literal});`)();
console.log(`parsed ${Object.keys(PAGES).length} pages: ${Object.keys(PAGES).join(', ')}`);

/* THE TERMS SCREEN IS A SECOND SOURCE. It keeps its own TERMS const rather than
   living in PAGES, and now routes through the same translateContent() walker,
   so its prose is translatable and has to be extracted with the rest. Parsed
   the same way: slice the object literal and evaluate it. */
const TSRC = '/home/elrio/hawkeye/native/src/app/terms.tsx';
try {
  const tsrc = fs.readFileSync(TSRC, 'utf8');
  const ts = tsrc.indexOf('const TERMS');
  if (ts >= 0) {
    const open = tsrc.indexOf('{', ts);
    let depth = 0, te = -1;
    for (let i = open; i < tsrc.length; i++) {
      if (tsrc[i] === '{') depth++;
      else if (tsrc[i] === '}') { depth--; if (depth === 0) { te = i + 1; break; } }
    }
    if (te > 0) {
      const TERMS = new Function(`return (${tsrc.slice(open, te)});`)();
      PAGES.terms = TERMS;
      console.log('parsed the terms screen as a second source');
    }
  }
} catch (e) {
  console.log('terms.tsx not parsed: ' + e.message);
}

// PRIVACY IS NO LONGER SKIPPED. It was English-by-policy; that policy was
// lifted deliberately, so its prose is now extracted like every other page.
const SKIP_PAGES = new Set([]);
const out = new Set();

function walk(node, field) {
  if (typeof node === 'string') {
    if (field && TEXT_FIELDS.has(field)) out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    // `sections: string[]` and `bullets`/`points`/`items` of bare strings are prose.
    for (const v of node) walk(v, typeof v === 'string' ? 'text' : field);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, k);
  }
}

for (const [slug, page] of Object.entries(PAGES)) {
  if (SKIP_PAGES.has(slug)) { console.log(`skipped ${slug} (English by policy)`); continue; }
  walk(page, null);
}

/** Not worth a translator's time, and not safe to hand one. */
const keep = [...out].filter((s) => s.trim().length > 1 && /[A-Za-z]{2}/.test(s) && !/^https?:|^native:|^mailto:|^tel:/.test(s));

const obj = {};
for (const s of keep.sort()) obj[s] = s;
fs.writeFileSync('/home/elrio/hawkeye/tmp/native_content_en.json', JSON.stringify(obj, null, 2) + '\n');
console.log(`${keep.length} prose strings, ${keep.join(' ').split(/\s+/).length} words -> tmp/native_content_en.json`);

// CONTROL: the walker must have reached every depth of the tree, not just the top.
const deepest = keep.some((s) => s.length > 120);
const shallow = keep.includes('How Hawkeye Works');
console.log(`${shallow ? 'PASS' : 'FAIL'}  CONTROL a top-level page title was found`);
console.log(`${deepest ? 'PASS' : 'FAIL'}  CONTROL a long nested body was found (the walker went deep)`);
if (!shallow || !deepest) process.exit(1);

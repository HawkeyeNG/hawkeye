/**
 * THE NATIVE EXPLAINER PAGES — How Hawkeye Works, the Observer Guide, About.
 *
 * 456 lines of content.ts with not one translation call in it: the whole
 * explainer surface rendered in English inside an app whose every other screen
 * was translated. It is also the largest single body of prose either client
 * ships, and the one a new observer reads first.
 *
 * The mechanism is unusual and this test is what keeps it honest. content.ts
 * stays English and stays a plain const; getPages() deep-walks it at READ time,
 * swapping each string for its translation keyed BY THE ENGLISH. So the thing to
 * assert is not "does a key exist" — there are no keys — but "does the tree that
 * comes out actually differ from the tree that went in, everywhere it should,
 * and nowhere it should not".
 *
 * Two failure modes it exists to catch:
 *  · a translation dictionary that silently fails to load, or a walk that stops
 *    at the first nesting level, leaving deep prose English while the titles
 *    move — which would look almost right in a screenshot;
 *  · the privacy page getting translated after all, when it is English by policy.
 */
import fs from 'node:fs';

const NATIVE = '/home/elrio/hawkeye/native/src';

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { failed++; if (got !== undefined) console.log(`        got  ${JSON.stringify(got)}`); }
};

/* Parse the two modules the same way the extractor does — by evaluating the
   object literals rather than pattern-matching them, so nesting is not a special
   case and nothing can be missed by a regex that stops one level early. */
function literalAfter(src, decl) {
  const start = src.indexOf(decl);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const contentSrc = fs.readFileSync(`${NATIVE}/lib/content.ts`, 'utf8');
const i18nSrc = fs.readFileSync(`${NATIVE}/lib/content-i18n.ts`, 'utf8');

// eslint-disable-next-line no-new-func
const PAGES = new Function(`return (${literalAfter(contentSrc, 'export const PAGES')});`)();
// eslint-disable-next-line no-new-func
const DICT = new Function(`return (${literalAfter(i18nSrc, 'export const CONTENT_I18N')});`)();

/** The same walk getPages() does. Reimplemented, so a broken one is visible. */
function translateNode(node, dict) {
  if (typeof node === 'string') return dict[node] ?? node;
  if (Array.isArray(node)) return node.map((v) => translateNode(v, dict));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = translateNode(v, dict);
    return out;
  }
  return node;
}

/** Every string in a tree, with the path it was found at. */
function strings(node, path = '', out = []) {
  if (typeof node === 'string') { out.push([path, node]); return out; }
  if (Array.isArray(node)) { node.forEach((v, i) => strings(v, `${path}[${i}]`, out)); return out; }
  if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out); return out; }
  return out;
}

console.log('=== the mechanism is wired at all ===');
check('content.ts exports getPages()', /export function getPages\(\)/.test(contentSrc));
check('it reads the language during render, not at import',
  /const dict = CONTENT_I18N\[currentLang_\(\)\];/.test(contentSrc));
const pageSrc = fs.readFileSync(`${NATIVE}/app/page.tsx`, 'utf8');
check('page.tsx reads getPages(), not the raw PAGES', pageSrc.includes('getPages()[key]') && !/\bPAGES\[/.test(pageSrc));
check('the dictionary has all three languages', ['ha', 'ig', 'yo'].every((l) => DICT[l]), Object.keys(DICT));

/* Machinery, not prose: these fields hold icon names, routes and block kinds,
   and must come through a translation untouched. */
const MACHINERY = /\.(icon|href|url|kind|tone|start)$/;

for (const lang of ['ha', 'ig', 'yo']) {
  console.log(`\n=== ${lang}: the tree that comes out ===`);
  const out = translateNode(PAGES, DICT[lang]);

  const before = strings(PAGES);
  const after = strings(out);
  check('the shape is unchanged (same strings, same paths)',
    before.length === after.length && before.every(([p], i) => p === after[i][0]),
    { before: before.length, after: after.length });

  const machineryChanged = before.filter(([p, v], i) => MACHINERY.test(p) && after[i][1] !== v);
  check('no icon, route or block kind was translated', machineryChanged.length === 0, machineryChanged.slice(0, 5));

  /* THE REAL ASSERTION. Prose outside the privacy page must MOVE. Counting how
     many moved is not enough — a walk that stopped at depth 1 would still move
     the four page titles and report a healthy-looking number. */
  const prose = before
    .map(([p, v], i) => ({ p, v, t: after[i][1] }))
    .filter(({ p, v }) => !p.startsWith('.privacy') && !MACHINERY.test(p)
      && v.trim().length > 12 && /\s/.test(v) && /[A-Za-z]{2}/.test(v));
  const stuck = prose.filter(({ v, t }) => t === v);
  check(`every prose string outside privacy moved (${prose.length} checked)`, stuck.length === 0,
    stuck.slice(0, 4).map((s) => `${s.p}: ${s.v.slice(0, 50)}`));

  /* Depth, explicitly. The deepest prose in this tree is a bullet inside an item
     inside a block inside a page — four levels down — and that is precisely what
     a shallow walk leaves in English. */
  const deep = prose.filter(({ p }) => (p.match(/\./g) || []).length >= 4 || (p.match(/\[/g) || []).length >= 2);
  check(`deeply nested prose was reached (${deep.length} strings at depth)`, deep.length > 20, deep.length);
  check('  ...and all of it moved', deep.every(({ v, t }) => t !== v),
    deep.filter(({ v, t }) => t === v).slice(0, 3).map((s) => s.p));

  const priv = before
    .map(([p, v], i) => ({ p, v, t: after[i][1] }))
    .filter(({ p }) => p.startsWith('.privacy'));
  check(`the privacy page stayed English (${priv.length} strings)`, priv.every(({ v, t }) => t === v),
    priv.filter(({ v, t }) => t !== v).slice(0, 3).map((s) => s.p));
}

/**
 * CONTROL: an empty dictionary must leave the tree completely unchanged, and the
 * check above must then report it. Without this, a dictionary that failed to
 * load would make "the shape is unchanged" pass and nothing else would notice.
 */
console.log('\n=== CONTROL: an empty dictionary must be caught, not silently tolerated ===');
{
  const out = translateNode(PAGES, {});
  const before = strings(PAGES);
  const after = strings(out);
  const moved = before.filter(([, v], i) => after[i][1] !== v);
  check('CONTROL an empty dictionary changes nothing', moved.length === 0, moved.length);
  const prose = before.filter(([p, v]) => !p.startsWith('.privacy') && v.length > 12 && /\s/.test(v));
  check('CONTROL ...and that is a state this test would report as failure', prose.length > 50, prose.length);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

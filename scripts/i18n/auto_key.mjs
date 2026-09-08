/**
 * KEY THE MARKUP THE OLD EXTRACTOR COULD NOT SEE.
 *
 * scripts/i18n/i18n_extract.mjs matches `<tag attrs>([^<>]+)</tag>` — the inner
 * content must contain no angle brackets. That one character class is why it
 * reported "0 remaining" on eleven pages that were still rendering ~135 English
 * strings: every heading, <li> and <p> that contains an inline <strong>, <em>,
 * <a> or <span> was never offered to it. Worse, where the INNER fragment did
 * match, the page came out half-translated — a bold lead in Hausa followed by
 * its own sentence in English.
 *
 * This walks a real DOM (linkedom) instead of a regex, so nesting is not a
 * special case, and it emits ONE OF TWO mechanisms per element:
 *
 *   data-i18n       — the element has no child elements. textContent is safe.
 *   data-i18n-html  — the element wraps inline markup. The whole sentence is one
 *                     string and the markup travels inside it, because word
 *                     order is not preserved across languages and a sentence
 *                     reassembled from English-ordered fragments is not a
 *                     translation. See the long note in app/i18n.js.
 *
 * THE DYNAMIC GUARD IS THE PART THAT MATTERS. Keying an element that a script
 * later repaints is worse than leaving it English: apply() re-runs on every
 * language change, so the two writers fight and whichever ran last wins,
 * non-deterministically from the reader's point of view. The old guard asked
 * "does this id or class appear anywhere in the page's JS", which is both too
 * weak (it only ever read five shared files, so tg.js, race.js, follow.js,
 * pu-search.js, scan.js, practice.js and six others were invisible) and too
 * strong (it rejected `.reveal` headings because an IntersectionObserver calls
 * classList.add on them, and rejected a button because something assigned
 * .onclick). Both errors were live: three real headings on index.html were
 * skipped for a class that only ever receives `classList.add('in')`.
 *
 * So the guard here reads EVERY script the page actually loads — parsed out of
 * its own <script src> tags, plus its inline scripts — and asks the narrower
 * question: is this selector the target of a TEXT WRITE (.textContent,
 * .innerHTML, .innerText, .value, insertAdjacentHTML, .append/.replaceChildren)?
 * A classList or onclick mention is not a text write and no longer disqualifies
 * anything.
 *
 *   node scripts/i18n/auto_key.mjs --dry how.html      # show what it would do
 *   node scripts/i18n/auto_key.mjs how.html guide.html # write those pages
 *   node scripts/i18n/auto_key.mjs --control           # prove the guard works
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require_ = createRequire('/home/elrio/hawkeye/tests/ui/');
const { parseHTML } = require_('linkedom');

const APP = '/home/elrio/hawkeye/app';
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const CONTROL = args.includes('--control');
const only = args.filter((a) => !a.startsWith('--'));

/** Block-level elements whose text is worth keying. */
const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'button', 'label',
  'summary', 'figcaption', 'caption', 'dt', 'dd', 'legend', 'option', 'title', 'blockquote']);
/** Inline elements that may travel INSIDE a data-i18n-html value. */
const INLINE = new Set(['strong', 'em', 'b', 'i', 'a', 'span', 'small', 'code', 'br', 'sup', 'sub', 'abbr', 'u', 'mark', 'wbr']);
/** Leaf elements worth keying on their own when they are not inside a keyed parent. */
const LEAF = new Set(['strong', 'em', 'span', 'a', 'small', 'label', 'option']);

const KEEP = /^(hawkeye|inec|ec8a|ec8b|irev|pdp|apc|lp|nnpp|adc|apga|sdp|nigeria|osun|tiktok|whatsapp|telegram|facebook|youtube|instagram|chrome|safari|firefox|android|iphone|samsung|google|apple|pwa|rekor|gps|otp|pu|lga|nin|id|sms|faq|x)$/i;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 7).join('-');

/** Worth translating at all? */
function worth(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length < 3) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (KEEP.test(t)) return false;
  if (/^https?:\/\//.test(t)) return false;
  if (/^[\d\s.,:/%+-]+$/.test(t)) return false;
  return true;
}

/**
 * Every script this page runs, concatenated. Read from the page's OWN <script>
 * tags — not a hardcoded list, which is how eleven page-specific files came to
 * be invisible to the previous guard.
 */
function scriptsOf(doc, file) {
  let js = '';
  for (const s of doc.querySelectorAll('script')) {
    const src = s.getAttribute('src');
    if (src) {
      const f = path.join(APP, src.split('?')[0].replace(/^\//, ''));
      if (fs.existsSync(f)) js += `\n/*${src}*/\n` + fs.readFileSync(f, 'utf8');
    } else {
      js += '\n' + (s.textContent || '');
    }
  }
  return js;
}

/**
 * Does a script WRITE TEXT into this element? Not "mention it" — write to it.
 * Matches `<selector-expression>.textContent =`, `.innerHTML =`, `.innerText =`,
 * `.value =`, `.insertAdjacentHTML(`, `.replaceChildren(`, `.append(` where the
 * selector expression names this element's id or one of its classes.
 */
function writtenByJs(el, js) {
  const names = [];
  if (el.id) names.push(el.id);
  const cls = (el.getAttribute('class') || '').trim();
  if (cls) names.push(...cls.split(/\s+/));
  const WRITE = String.raw`\s*(?:\?\.)?\s*(?:\.\w+)*\s*\.\s*(?:textContent|innerHTML|innerText|value|outerHTML)\s*=|\s*(?:\?\.)?\s*(?:\.\w+)*\s*\.\s*(?:insertAdjacentHTML|replaceChildren|append|prepend|appendChild)\s*\(`;
  for (const n of names) {
    if (!n) continue;
    const q = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // getElementById('x') / querySelector('#x') / querySelector('.c') / $('x')
    const sel = new RegExp(
      String.raw`(?:getElementById\(['"\`]${q}['"\`]\)|querySelector(?:All)?\(['"\`][^'"\`]*[#.]${q}\b[^'"\`]*['"\`]\)|\$\(['"\`]${q}['"\`]\))(?:${WRITE})`,
    );
    if (sel.test(js)) return true;
    // A captured reference: `const x = getElementById('id')` … `x.textContent =`
    const capture = new RegExp(
      String.raw`(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*(?:getElementById\(['"\`]${q}['"\`]\)|querySelector\(['"\`][^'"\`]*[#.]${q}\b[^'"\`]*['"\`]\))`,
    );
    const m = js.match(capture);
    if (m) {
      const v = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(String.raw`\b${v}\s*\.\s*(?:textContent|innerHTML|innerText|value|outerHTML)\s*=`).test(js)) return true;
      if (new RegExp(String.raw`\b${v}\s*\.\s*(?:insertAdjacentHTML|replaceChildren|append|prepend|appendChild)\s*\(`).test(js)) return true;
    }
  }
  return false;
}

/** True when every child element is inline and none of them is already keyed. */
function inlineOnly(el) {
  for (const c of el.children) {
    if (!INLINE.has(c.tagName.toLowerCase())) return false;
    if (c.querySelector && c.querySelector('[data-i18n],[data-i18n-html]')) return false;
    for (const d of [c, ...(c.querySelectorAll ? c.querySelectorAll('*') : [])]) {
      if (!INLINE.has(d.tagName.toLowerCase())) return false;
    }
  }
  return true;
}

function keyFor(page, text, used) {
  const ns = page.replace(/\.html$/, '');
  let base = `${ns}.${slug(text)}` || `${ns}.text`;
  let k = base; let i = 2;
  while (used.has(k)) { k = `${base}-${i}`; i++; }
  used.add(k);
  return k;
}

const en = JSON.parse(fs.readFileSync(`${APP}/i18n/en.json`, 'utf8'));
const meta = en._meta || {};
const ENGLISH_PAGES = new Set((meta.englishOnlyPages || []).map((p) => `${p}.html`));
const ENGLISH_KEYS = new Set(meta.englishOnly || []);
const ENGLISH_TEXT = new Set([...ENGLISH_KEYS].map((k) => en[k]).filter(Boolean));
/** Existing English value -> key, so identical copy reuses one key. */
const byText = new Map();
for (const [k, v] of Object.entries(en)) if (k !== '_meta' && typeof v === 'string') if (!byText.has(v)) byText.set(v, k);

const pages = (only.length ? only : fs.readdirSync(APP).filter((f) => f.endsWith('.html')))
  .filter((f) => !ENGLISH_PAGES.has(f));

const added = {};          // key -> english
const used = new Set(Object.keys(en));
let totalKeyed = 0;
const log = [];

for (const page of pages) {
  const file = path.join(APP, page);
  const raw = fs.readFileSync(file, 'utf8');
  const { document } = parseHTML(raw);
  const js = scriptsOf(document, file);
  const edits = [];      // { outerBefore, outerAfter } applied as exact string swaps

  const consider = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.hasAttribute('data-i18n') || el.hasAttribute('data-i18n-html')) return;
    if (el.closest('script,style,noscript,svg,template')) return;
    // Inside an element that is already keyed as one HTML string.
    if (el.parentElement && el.parentElement.closest('[data-i18n-html]')) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!worth(text)) return;
    if (ENGLISH_TEXT.has(text)) return;           // deliberately English
    if (writtenByJs(el, js)) return;              // a script owns this text

    const hasChildren = el.children.length > 0;
    if (hasChildren && !inlineOnly(el)) return;   // block children: recurse instead

    const attr = hasChildren ? 'data-i18n-html' : 'data-i18n';
    const before = el.outerHTML;
    // Nested keys go FIRST, so they are gone before the value is read: a
    // data-i18n-html subtree must contain none (i18n.js rebuilds those elements,
    // and a later pass would then record the TRANSLATED text as their English).
    // Reading innerHTML before this strip is how the first run of this codemod
    // baked `data-i18n="how.photograph-the-evidence"` into the bundle VALUE.
    if (hasChildren) {
      for (const d of el.querySelectorAll('[data-i18n],[data-i18n-attr],[data-i18n-html]')) {
        d.removeAttribute('data-i18n'); d.removeAttribute('data-i18n-html');
      }
    }
    const value = hasChildren ? el.innerHTML.replace(/\s+/g, ' ').trim() : text;
    const key = byText.get(value) || keyFor(page, text, used);
    if (!byText.has(value)) { added[key] = value; byText.set(value, key); }

    el.setAttribute(attr, key);
    if (hasChildren) el.innerHTML = value;
    edits.push({ before, after: el.outerHTML, key, value });
    totalKeyed++;
  };

  // Deepest-last so a parent is considered before its inline children; once a
  // parent takes data-i18n-html, its children are skipped by the closest() guard.
  for (const el of document.querySelectorAll([...BLOCK].join(','))) consider(el);
  for (const el of document.querySelectorAll([...LEAF].join(','))) consider(el);

  if (!edits.length) { log.push(`OK   ${page} — nothing to key`); continue; }
  log.push(`KEY  ${page} — ${edits.length}`);
  for (const e of edits.slice(0, 6)) log.push(`       ${e.key} = ${JSON.stringify(e.value.slice(0, 80))}`);
  if (edits.length > 6) log.push(`       … ${edits.length - 6} more`);

  if (!DRY) {
    let out = raw;
    let missed = 0;
    for (const e of edits) {
      if (out.includes(e.before)) out = out.replace(e.before, e.after);
      else missed++;
    }
    if (missed) log.push(`       ! ${missed}/${edits.length} could not be matched in the source (whitespace-normalised by the parser) — page rewritten from the DOM instead`);
    // linkedom round-trips the document faithfully enough for our markup, but
    // rewriting from the DOM would also normalise everything else on the page.
    // Only fall back to it when exact swaps failed.
    fs.writeFileSync(file, missed ? `<!doctype html>\n${document.documentElement.outerHTML}\n` : out);
  }
}

console.log(log.join('\n'));
console.log(`\n==== ${totalKeyed} elements keyed, ${Object.keys(added).length} NEW English strings${DRY ? ' (dry run — nothing written)' : ''}`);

if (!DRY && Object.keys(added).length) {
  fs.writeFileSync('/home/elrio/hawkeye/tmp/new_keys.json', JSON.stringify(added, null, 2) + '\n');
  console.log('new English strings written to tmp/new_keys.json (translate, then merge into the bundles)');
}

if (CONTROL) {
  console.log('\n=== CONTROL: the dynamic guard must reject a JS-written element and accept a decorated one ===');
  const { document: d } = parseHTML(`<body>
    <h2 id="written">Written by a script</h2>
    <h2 class="reveal" id="decorated">Only decorated</h2>
  </body>`);
  const js = `document.getElementById('written').textContent = 'x';
              document.querySelectorAll('.reveal').forEach(e => e.classList.add('in'));
              document.getElementById('decorated').onclick = () => {};`;
  const w = writtenByJs(d.getElementById('written'), js);
  const g = writtenByJs(d.getElementById('decorated'), js);
  console.log(`${w ? 'PASS' : 'FAIL'}  CONTROL a textContent write IS detected`);
  console.log(`${!g ? 'PASS' : 'FAIL'}  CONTROL classList.add / onclick is NOT mistaken for a text write`);
  if (!w || g) process.exit(1);
}

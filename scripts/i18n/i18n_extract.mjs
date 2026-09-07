/**
 * Add data-i18n keys to the app's HTML and emit the English catalogue.
 *
 * SAFETY: the transform may only ADD attributes. After rewriting, the script
 * strips every data-i18n/data-i18n-attr from both the new text and the
 * original and asserts the two are byte-identical, and separately asserts the
 * attribute count grew by exactly the number inserted. A transform that moved,
 * dropped or re-encoded one byte fails both ways. Run scripts/i18n/i18n_control.mjs to
 * confirm those assertions can still fail.
 *
 * TWO PASSES, because the header, menu and footer repeat on every page: a
 * string seen on more than one page becomes `common.<slug>` and is translated
 * once. Roughly a third of the surface is this shared chrome.
 */
import fs from 'node:fs';
import path from 'node:path';

const DIR = '/home/elrio/hawkeye/app';
const WRITE = process.argv.includes('--write');
const pages = process.argv.filter((a) => a.endsWith('.html'));

/* The shell scripts run on every page, so an id they touch is dynamic even on
   a page whose own inline script never mentions it. */
const sharedJs = ['menu.js', 'app.js', 'auth.js', 'capture.js', 'lang.js']
  .map((f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { return ''; } })
  .join('\n');

const TAGS = 'h1|h2|h3|h4|h5|h6|p|span|strong|em|small|b|i|label|button|a|li|td|th|option|summary|legend|figcaption|dt|dd|caption';
const ATTRS = ['placeholder', 'aria-label', 'title'];

/* Names and codes that must read identically in every language. Translating
   the brand or a form number would break the one thing an observer matches
   against the paper in their hand. */
const KEEP = new Set(['hawkeye', 'inec', 'ec8a', 'ec8b', 'ec8c', 'ec8d', 'faq',
  'chrome', 'safari', 'firefox', 'android', 'iphone', 'ipad', 'hawkeye.com.ng',
  'inixien', 'inixien, llc', 'apc', 'pdp', 'lp', 'nnpp']);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', times: '×', middot: '·', deg: '°',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', larr: '←',
  rarr: '→', check: '✓', bull: '•' };

/**
 * The catalogue must hold real characters, not markup. apply() writes through
 * textContent, so a value carrying `&copy;` would put those six literal
 * characters on the page.
 */
function decode(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(Number(e[1] === 'x' || e[1] === 'X' ? '0' + e.slice(1) : e.slice(1)));
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
}

const norm = (s) => decode(s).replace(/\s+/g, ' ').trim();
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'x';

// Text worth translating: has two consecutive letters, and is not a bare
// number, symbol, code fragment, template hole or a name that must not change.
function worth(t) {
  const s = norm(t);
  if (!s || s.length > 500) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (/[{}$]/.test(t)) return false;
  if (KEEP.has(s.toLowerCase().replace(/[^a-z0-9. ,]/g, '').trim())) return false;
  return true;
}

function scan(page, onHit) {
  const orig = fs.readFileSync(path.join(DIR, page), 'utf8');
  const holes = [];
  const text = orig.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, (m) => {
    holes.push(m);
    return ' HOLE' + (holes.length - 1) + ' ';
  });

  /* Elements a script writes into must NOT be translated: apply() sets
     textContent and runs again on every language change, so a counter or a
     fetched name would revert to its English placeholder. Only SELECTORS
     count — matching bare words made class="btn" dynamic everywhere and
     skipped "Take photo", "Request OTP" and "Sign & submit report". */
  const js = holes.join('\n') + sharedJs;
  const jsIds = new Set([...js.matchAll(/getElementById\(\s*['"`]([\w-]+)/g)].map((m) => m[1])
    .concat([...js.matchAll(/['"`]#([\w-]+)/g)].map((m) => m[1])));
  const jsClasses = new Set([...js.matchAll(/['"`]\.([\w-]+)/g)].map((m) => m[1])
    .concat([...js.matchAll(/classList\.[a-z]+\(\s*['"`]([\w-]+)/g)].map((m) => m[1])));
  const dynamic = (attrs) => {
    const id = /\sid="([^"]+)"/.exec(attrs);
    if (id && jsIds.has(id[1])) return true;
    const cls = /\sclass="([^"]+)"/.exec(attrs);
    return !!(cls && cls[1].split(/\s+/).some((c) => c && jsClasses.has(c)));
  };

  let out = text.replace(
    new RegExp('<(' + TAGS + ')((?:\\s[^<>]*)?)>([^<>]+)</\\1>', 'g'),
    (m, tag, attrs, inner) => {
      if (/data-i18n/.test(attrs) || !worth(inner) || dynamic(attrs)) return m;
      const k = onHit(norm(inner), 'text');
      return k ? '<' + tag + ' data-i18n="' + k + '"' + attrs + '>' + inner + '</' + tag + '>' : m;
    }
  );
  for (const a of ATTRS) {
    out = out.replace(new RegExp('<([a-z][a-z0-9-]*)((?:\\s[^<>]*)?)\\s' + a + '="([^"]+)"', 'g'), (m, tag, attrs, val) => {
      if (/data-i18n/.test(m) || !worth(val)) return m;
      const k = onHit(norm(val), 'attr');
      return k ? '<' + tag + ' data-i18n-attr="' + a + ':' + k + '"' + attrs + ' ' + a + '="' + val + '"' : m;
    });
  }
  return { orig, out: out.replace(/ HOLE(\d+) /g, (m, i) => holes[Number(i)]) };
}

// ---- pass 1: which strings appear on more than one page? --------------------
const seen = new Map();
for (const page of pages) {
  scan(page, (s) => {
    if (!seen.has(s)) seen.set(s, new Set());
    seen.get(s).add(page);
    return null;
  });
}

// ---- pass 2: assign keys and write -----------------------------------------
const catalogue = new Map();
const byText = new Map();
const report = [];

for (const page of pages) {
  const name = page.replace(/\.html$/, '');
  let added = 0;
  const { orig, out } = scan(page, (s) => {
    if (byText.has(s)) { added++; return byText.get(s); }
    const scope = seen.get(s).size > 1 ? 'common' : name;
    let k = scope + '.' + slug(s);
    let n = 2;
    while (catalogue.has(k)) k = scope + '.' + slug(s) + '-' + n++;
    catalogue.set(k, s);
    byText.set(s, k);
    added++;
    return k;
  });

  const strip = (s) => s.replace(/\sdata-i18n(-attr)?="[^"]*"/g, '');
  const count = (s) => (s.match(/data-i18n(-attr)?="/g) || []).length;
  const ok = strip(out) === strip(orig) && count(out) === count(orig) + added;
  report.push({ page, added, ok });
  if (!ok) { console.error('FAIL ' + page); process.exitCode = 1; continue; }
  if (WRITE && added) fs.writeFileSync(path.join(DIR, page), out);
}

for (const r of report) console.log((r.ok ? 'ok  ' : 'FAIL') + ' ' + r.page.padEnd(20) + ' ' + r.added + ' keyed');
const shared = [...catalogue.keys()].filter((k) => k.startsWith('common.')).length;
console.log('\nunique strings: ' + catalogue.size + '  (shared chrome: ' + shared + ')');
if (WRITE) {
  fs.writeFileSync('/home/elrio/hawkeye/scripts/i18n/catalogue.json',
    JSON.stringify(Object.fromEntries([...catalogue].sort()), null, 2));
  console.log('catalogue -> tmp/catalogue.json');
}

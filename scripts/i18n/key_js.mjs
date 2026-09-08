/**
 * KEY THE TEXT A SCRIPT PAINTS.
 *
 * The DOM codemod (auto_key.mjs) deliberately REFUSES any element a script
 * writes into: keying markup that JS later overwrites is worse than leaving it
 * English, because apply() and the script then fight and the reader sees
 * whichever ran last. That refusal is correct — and it means every one of those
 * strings has to be fixed here instead, at the point of the write.
 *
 * On app/app.js that is the entire observer flow: the sign-in screen, the OTP
 * exchange, the location search, the camera buttons and every submit status. It
 * is also the most-seen text in the product, and the auth screen alone renders on
 * thirteen pages. All of it was permanently English.
 *
 * WHAT IT REWRITES: `el.textContent = 'Sign In'` -> `el.textContent = T('observe.sign-in', 'Sign In')`.
 * The English literal STAYS as the fallback argument, so the file still reads as
 * English source and still works with no bundle loaded.
 *
 * WHAT IT DOES NOT TOUCH, and why:
 *  · Template literals with ${…}. Interpolation order is not a translation
 *    invariant — a language that puts the number after the noun cannot be served
 *    by a fragment-concatenating rewrite. Those are listed at the end for hand
 *    conversion to a {name} placeholder.
 *  · innerHTML assignments building whole components. Those are markup, not
 *    sentences; they belong in the DOM pass with data-i18n attributes emitted
 *    into the string.
 *  · Anything that is not user-visible prose: ids, classes, URLs, keys.
 *
 * A REPAINT IS STILL THE CALLER'S JOB. T() resolves at call time, so text
 * written once at boot will not follow a later language change on its own. The
 * flows here re-render on navigation, and the few that do not are listed by
 * --report so they can be given a 'hawkeye-lang' listener.
 *
 *   node scripts/i18n/key_js.mjs --dry app.js
 *   node scripts/i18n/key_js.mjs app.js
 */
import fs from 'node:fs';

const APP = '/home/elrio/hawkeye/app';
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const files = args.filter((a) => !a.startsWith('--'));

const en = JSON.parse(fs.readFileSync(`${APP}/i18n/en.json`, 'utf8'));
const byText = new Map();
for (const [k, v] of Object.entries(en)) if (k !== '_meta' && typeof v === 'string' && !byText.has(v)) byText.set(v, k);
const used = new Set(Object.keys(en));
const added = {};

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 7).join('-');

/** User-visible prose? */
function worth(t) {
  const s = t.trim();
  if (s.length < 4) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (!/\s/.test(s) && /^[a-z][\w-]*$/.test(s)) return false;   // an identifier, not a sentence
  if (/^https?:|^\/|^#|^[.#][\w-]+$/.test(s)) return false;
  if (/^[A-Z_]+$/.test(s)) return false;                        // CONSTANT
  return true;
}

const HELPER = `/**
 * i18n for text this file PAINTS. See scripts/i18n/key_js.mjs for why these
 * cannot be data-i18n attributes: every element below is one a script writes
 * into, and auto_key.mjs refuses to key those in markup precisely so the two
 * writers never fight.
 *
 * The English literal stays as the second argument, so this file still reads as
 * English source and still renders correctly with no bundle loaded at all.
 */
function T(key, english) {
  return window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english;
}
`;

for (const f of files) {
  const p = `${APP}/${f}`;
  let src = fs.readFileSync(p, 'utf8');
  const ns = f.replace(/\.js$/, '').replace(/[^a-z0-9]/gi, '-');
  const PAGE_NS = ns === 'app' ? 'observe' : ns;

  const hits = [];
  const skipped = [];

  // `<anything>.textContent = 'literal'` / .placeholder / .title / .value
  const re = /(\.(?:textContent|innerText|placeholder|title)\s*=\s*)('([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")/g;
  src = src.replace(re, (whole, lhs, lit) => {
    // The literal's own text, with escapes resolved for keying purposes.
    const raw = lit.slice(1, -1);
    const text = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
    if (!worth(text)) { skipped.push(text); return whole; }
    const key = byText.get(text) || (() => {
      let base = `${PAGE_NS}.${slug(text)}`; let k = base; let i = 2;
      while (used.has(k)) { k = `${base}-${i}`; i++; }
      used.add(k); added[k] = text; byText.set(text, k);
      return k;
    })();
    hits.push({ key, text });
    return `${lhs}T('${key}', ${lit})`;
  });

  // Template literals that DO carry text but no interpolation are safe too.
  const re2 = /(\.(?:textContent|innerText|placeholder|title)\s*=\s*)(`([^`$\\]*)`)/g;
  src = src.replace(re2, (whole, lhs, lit, inner) => {
    const text = inner.trim();
    if (!worth(text)) return whole;
    const key = byText.get(text) || (() => {
      let base = `${PAGE_NS}.${slug(text)}`; let k = base; let i = 2;
      while (used.has(k)) { k = `${base}-${i}`; i++; }
      used.add(k); added[k] = text; byText.set(text, k);
      return k;
    })();
    hits.push({ key, text });
    return `${lhs}T('${key}', ${lit})`;
  });

  // What was left behind, so the remaining work is visible rather than assumed done.
  const interpolated = [...fs.readFileSync(p, 'utf8').matchAll(/\.(?:textContent|innerText|placeholder|title)\s*=\s*`([^`]*\$\{[^`]*)`/g)]
    .map((m) => m[1]).filter((t) => worth(t.replace(/\$\{[^}]*\}/g, ' ')));

  if (!hits.length) { console.log(`OK   ${f} — nothing to key`); continue; }

  if (!src.includes('function T(key, english)')) {
    // After the file's own opening comment block, before the first statement.
    const at = src.search(/^(?:const|let|var|function|\(function|window\.|document\.)/m);
    src = at > 0 ? src.slice(0, at) + HELPER + '\n' + src.slice(at) : HELPER + '\n' + src;
  }

  console.log(`KEY  ${f} — ${hits.length} literals`);
  for (const h of hits.slice(0, 8)) console.log(`       ${h.key} = ${JSON.stringify(h.text.slice(0, 70))}`);
  if (hits.length > 8) console.log(`       … ${hits.length - 8} more`);
  if (interpolated.length) {
    console.log(`     ${interpolated.length} INTERPOLATED strings left for hand conversion (a {name} placeholder):`);
    for (const t of interpolated.slice(0, 12)) console.log(`       ${JSON.stringify(t.slice(0, 78))}`);
    if (interpolated.length > 12) console.log(`       … ${interpolated.length - 12} more`);
  }

  if (!DRY) fs.writeFileSync(p, src);
}

console.log(`\n==== ${Object.keys(added).length} NEW English strings${DRY ? ' (dry run — nothing written)' : ''}`);
if (!DRY && Object.keys(added).length) {
  fs.writeFileSync('/home/elrio/hawkeye/tmp/new_keys.json', JSON.stringify(added, null, 2) + '\n');
  console.log('written to tmp/new_keys.json');
}

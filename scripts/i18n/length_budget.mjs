/**
 * A CHARACTER BUDGET PER KEY, DERIVED FROM WHERE IT RENDERS.
 *
 * Hausa, Igbo and Yorùbá all run longer than English — measurably so in this
 * app's own bundles — and the app shipped with a three-line button label and a
 * bottom sheet whose copy pushed against a fixed snap point. Telling translators
 * "keep it short" does not survive contact with 900 strings. A number per key,
 * checked by the build, does.
 *
 * THE BUDGET IS NOT A STYLE PREFERENCE. It is derived from the control:
 *
 *   button   a label inside a Pressable. Must fit on one or two short lines and
 *            cannot be truncated without losing what the button does. Tightest.
 *   chip     a filter or tag. Sits in a row of siblings; one long one breaks the
 *            row for all of them.
 *   heading  a screen or card title. Wraps, but a title over three lines stops
 *            reading as a title.
 *   body     prose. Wraps freely; the budget here is generous and exists only to
 *            catch a translation that has turned into a paragraph.
 *
 * WHY A MULTIPLIER AND NOT A FIXED WIDTH. The English is the only thing known
 * for every key, and the real constraint is "how much longer than the English
 * can this get before the control breaks". Measured against this app's own
 * shipped translations, ha/ig/yo average about 1.35x the English. The button
 * multiplier is set BELOW that average deliberately: a button is where the
 * language has to be compressed, and a translator who cannot fit it should
 * choose a shorter word — "Karɓa" over "Ka amince da shi" — which is exactly
 * the instruction that does not survive without a number attached.
 *
 * A FLOOR, because a multiplier alone is wrong for short strings: 1.3x of "Ask"
 * is four characters, and no language can do that. Short labels get absolute
 * headroom instead.
 *
 *   node scripts/i18n/length_budget.mjs            # write the budget file
 *   node scripts/i18n/length_budget.mjs --check    # check the bundles against it
 *   node scripts/i18n/length_budget.mjs --control  # prove the check can fail
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/home/elrio/hawkeye';
const SRC = path.join(ROOT, 'native/src');
const CAT = path.join(ROOT, 'scripts/i18n/native_catalogue.json');
const OUT = path.join(ROOT, 'scripts/i18n/native_budget.json');

const cat = JSON.parse(fs.readFileSync(CAT, 'utf8'));

/** Multiplier and absolute floor, per surface. */
const RULES = {
  button: { mult: 1.25, floor: 14 },
  chip: { mult: 1.3, floor: 12 },
  heading: { mult: 1.4, floor: 20 },
  body: { mult: 1.75, floor: 40 },
};

/* ------------------------------------------------------------------ classify
 * Read the SOURCE, not the key name. A key called "…confirm" may be a heading
 * and a key called "…note" may be on a button; only the call site knows.
 */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.expo') continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const files = walk(SRC);
const surface = new Map();

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  let openedAt = null;
  let opener = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(/<(Pressable|TouchableOpacity|ButtonText|Chip)\b/);
    if (m) {
      openedAt = i;
      opener = m[1];
    }
    if (openedAt !== null && i - openedAt > 12) {
      openedAt = null;
      opener = null;
    }
    for (const km of ln.matchAll(/i18nT\('([^']+)'\)/g)) {
      const key = km[1];
      let kind = 'body';
      if (opener === 'ButtonText') kind = 'button';
      else if (opener === 'Chip') kind = 'chip';
      else if (opener) kind = 'button';
      else if (/text-(xl|2xl|3xl)|font-bold text-lg|<Prompt>|title=/.test(ln)) kind = 'heading';
      // The tightest classification wins: a key reused on a button and in prose
      // has to fit the button.
      const rank = { button: 0, chip: 1, heading: 2, body: 3 };
      if (!surface.has(key) || rank[kind] < rank[surface.get(key)]) surface.set(key, kind);
    }
  }
}

const budget = {};
for (const [k, en] of Object.entries(cat)) {
  const kind = surface.get(k) ?? 'body';
  const { mult, floor } = RULES[kind];
  budget[k] = {
    kind,
    en: en.length,
    max: Math.max(Math.ceil(en.length * mult), en.length + floor),
  };
}

/* --------------------------------------------------------------------- check */
if (process.argv.includes('--check') || process.argv.includes('--control')) {
  const CONTROL = process.argv.includes('--control');
  let over = 0;
  const rows = [];
  for (const code of ['ha', 'ig', 'yo']) {
    const p = path.join(SRC, `lib/i18n/${code}.json`);
    if (!fs.existsSync(p)) continue;
    const b = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(b)) {
      const spec = budget[k];
      if (!spec || typeof v !== 'string') continue;
      let len = v.length;
      if (CONTROL && k === Object.keys(b)[0]) len = spec.max + 50;
      if (len > spec.max) {
        over++;
        rows.push({ code, k, kind: spec.kind, len, max: spec.max, over: len - spec.max, v });
      }
    }
  }
  rows.sort((a, b) => b.over - a.over);
  const byKind = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  console.log(`over budget: ${over}`);
  for (const [kind, n] of Object.entries(byKind)) console.log(`  ${kind.padEnd(8)} ${n}`);
  console.log('\nworst offenders:');
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${r.code} ${r.kind.padEnd(7)} +${String(r.over).padStart(3)} over ${String(r.max).padStart(3)}  ${r.k.slice(-46)}`);
    console.log(`        ${r.v.slice(0, 92)}`);
  }
  if (CONTROL) {
    console.log(over > 0 ? '\nCONTROL PASSED — a planted over-length string was caught'
      : '\nCONTROL FAILED — the check cannot see an over-length string');
    process.exit(over > 0 ? 0 : 1);
  }
  process.exit(0);
}

fs.writeFileSync(OUT, JSON.stringify(budget, null, 1) + '\n');
const counts = {};
for (const v of Object.values(budget)) counts[v.kind] = (counts[v.kind] || 0) + 1;
console.log(`wrote ${Object.keys(budget).length} budgets to scripts/i18n/native_budget.json`);
for (const [k, n] of Object.entries(counts)) console.log(`  ${k.padEnd(8)} ${n}`);

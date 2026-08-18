#!/usr/bin/env node
/**
 * Repair mojibake in polling_units.name.
 *
 * The register carries names whose UTF-8 bytes were decoded as CP1252 somewhere
 * upstream, so a single character arrives as two or three wrong ones:
 *
 *   "Absu Park â€“ Absu"   should be  "Absu Park – Absu"      (– U+2013)
 *   "Soâ€™O Primary School" should be "So’O Primary School"   (’ U+2019)
 *
 * The tell is CP1252, not latin1: € “ ™ are cp1252 bytes 0x80 0x93 0x99, which
 * latin1 does not define. So the repair is: re-encode the string as CP1252, then
 * decode those bytes as UTF-8.
 *
 * WHY THIS MATTERS BEYOND TIDINESS. An observer searching "So'O" finds nothing,
 * because the register says "Soâ€™O". And the 2027 search packs
 * (docs/PU-SEARCH-2027.md) ship exactly what this table holds, so a name that is
 * wrong here is wrong offline too — with no server to correct it.
 *
 * WHAT IT DOES NOT TOUCH. 53 names contain ’ (U+2019) legitimately —
 * "Adeleye’S House" is correct text with a typographic apostrophe, not damage.
 * A repair is applied ONLY when the string re-encodes to CP1252 cleanly AND the
 * result is valid UTF-8 AND it actually changes. Everything else is left alone.
 *
 * SECOND RULE — the visible newline. 12 names carry U+21B5 (↵), the glyph a
 * spreadsheet shows for a line break, where a space belongs:
 *
 *   "Ifelodun Nursery & Primary↵School"  ->  "Ifelodun Nursery & Primary School"
 *
 * Same harm as the mojibake: nobody searching "Primary School" can match it. The
 * repair is unambiguous (the character is not text anyone typed), so it is done
 * here rather than left for a human. Collapses the doubled space it can leave.
 *
 * THIRD RULE — the stranded no-break space. 16 names carry a lone U+00E2 (â)
 * immediately before a space:
 *
 *   "18,â Thomasâ Salakoâ St.â Ogba"  ->  "18, Thomas Salako St. Ogba"
 *
 * That â is the wreckage of a NO-BREAK SPACE. U+00A0 is C2 A0 in UTF-8, which
 * mis-decodes to "Â"+NBSP; the register was then title-cased (lowering Â to â)
 * and its whitespace normalised (turning the NBSP into a plain space), leaving
 * the lead byte behind with nothing to pair with. The bytes cannot round-trip
 * any more — the second half is gone — so this is the one repair here that is
 * inference rather than arithmetic. It is a safe one: â never appears in this
 * register as a letter, only ever adjacent to a space.
 *
 * FOURTH RULE — mojibake that was title-cased afterwards. Three names only round
 * trip once the case change is undone: "Cafã‰" -> "CafÉ" -> "Café". Uppercase the
 * non-ASCII characters, re-run rule 1, then restore the register's Title Case by
 * lowering a recovered letter that sits mid-word.
 *
 * FIFTH RULE — residue. What survives the above and still is not text (a stray
 * ©, a doubled ê at the end of a name) is deleted. These are not characters
 * anyone typed and they are not recoverable; leaving them only makes the name
 * read as broken.
 *
 * Idempotent: repaired text no longer round-trips, so a second run is a no-op.
 *
 *   node scripts/fix_register_mojibake.mjs            # dry run, prints the diff
 *   node scripts/fix_register_mojibake.mjs --apply    # writes (backs up first)
 *
 * The packs are generated from this table, so after --apply:
 *   node scripts/build_register_packs.mjs --verify
 *
 * PRODUCTION: this repairs whichever database it is pointed at. The API and the
 * packs must agree, so production needs the same run (HAWKEYE_DB=... ) before
 * packs generated from a repaired register are shipped.
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DB_PATH = process.env.HAWKEYE_DB || path.join(REPO, 'backend', 'storage', 'hawkeye.db');
const APPLY = process.argv.includes('--apply');

/** CP1252's 0x80-0x9F block; every other byte matches latin1. */
const CP1252_REVERSE = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function toCp1252(s) {
  const out = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp <= 0xff) out[i] = cp;
    else if (CP1252_REVERSE[cp] !== undefined) out[i] = CP1252_REVERSE[cp];
    else return null; // not representable => this string was never cp1252 bytes
  }
  return out;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** @returns the repaired string, or null when there is nothing to repair. */
export function repairMojibake(s) {
  if (!s || !/[^\x00-\x7F]/.test(s)) return null;

  // Rule 2: a line break that survived as its printed glyph, not as whitespace.
  if (s.includes('\u21b5')) {
    const fixed = s.replace(/\u21b5/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (fixed !== s) return fixed;
  }

  let fixed = null;
  const bytes = toCp1252(s);
  if (bytes) {
    try { fixed = strictUtf8.decode(bytes); } catch { fixed = null; }
    if (fixed === s) fixed = null;
  }

  // Rule 4: the same corruption, but title-cased after the fact, so the lead
  // byte was lowered (Â -> â, Ã -> ã) and no longer decodes. Undo the case, run
  // rule 1, then put the register's Title Case back on the recovered letter.
  if (fixed === null) {
    const unTitled = Array.from(s).map((c) => (c.codePointAt(0) > 127 ? c.toUpperCase() : c)).join('');
    const b2 = toCp1252(unTitled);
    if (b2) {
      let cand = null;
      try { cand = strictUtf8.decode(b2); } catch { cand = null; }
      if (cand && cand !== s) {
        // A letter recovered mid-word belongs in lower case: "CafÉ" -> "Café".
        fixed = cand.replace(/([a-z])([^\x00-\x7F])/g, (m, prev, ch) => prev + ch.toLowerCase());
      }
    }
  }

  // Rule 3: a lone â left where a no-break space used to be. Its partner byte is
  // gone, so nothing can decode it — drop it and keep the space it sits against.
  if (fixed === null && /\u00e2/.test(s)) {
    const cand = s
      .replace(/\u00e2(?=[\s\u00a0])/g, '')   // "Openâ Space" -> "Open Space"
      .replace(/(?<=[\s\u00a0])\u00e2/g, '')  // "Str. â Ogba"  -> "Str. Ogba"
      .replace(/\u00e2$/g, '')                  // trailing
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cand !== s && !/\u00e2/.test(cand)) fixed = cand;
  }

  // Rule 5, deliberately AFTER rule 4 and allowed to overrule it. One row,
  // "Rabi(gibberish) Magaji", decodes to "Rabie-circumflex" — faithful to the
  // bytes, but the circumflex is not Hausa orthography (so it was already
  // corrupt upstream) and, worse, "RABIE MAGAJI" does not contain "RABI MAGAJI",
  // so the obvious search misses the unit entirely. Findability wins over
  // fidelity here: this app exists so somebody can find their polling unit.
  // A letter that IS plausible survives — "Cafe-acute" keeps its accent.
  // Rule 5: residue that is not text and cannot be recovered.
  if (fixed === null || /[\u00a9\u00ea]/.test(fixed || s)) {
    const base = fixed === null ? s : fixed;
    const cand = base.replace(/[\u00a9\u00ea]+/g, '').replace(/\s{2,}/g, ' ').trim();
    if (cand !== base && cand.length) fixed = cand;
  }

  if (fixed === null || fixed === s) return null;
  // Guard: a repair removes damage, so it never lengthens the name. (Rule 2
  // returns earlier; rules 3-5 shorten by construction.)
  if (fixed.length > s.length) return null;
  return fixed;
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`FATAL: no database at ${DB_PATH}`);
    process.exit(2);
  }
  const db = new Database(DB_PATH, { readonly: !APPLY });
  const rows = db.prepare('SELECT pu_code, name FROM polling_units').all();

  const fixes = [];
  const leftAlone = [];
  for (const r of rows) {
    const fixed = repairMojibake(r.name);
    if (fixed) fixes.push({ pu_code: r.pu_code, from: r.name, to: fixed });
    else if (/[^\x00-\x7F]/.test(r.name || '')) leftAlone.push(r);
  }

  console.log(`database        : ${DB_PATH}`);
  console.log(`rows            : ${rows.length}`);
  console.log(`to repair       : ${fixes.length}`);
  console.log(`non-ASCII kept  : ${leftAlone.length}  (legitimate typography, e.g. a curly apostrophe)`);

  if (fixes.length) {
    console.log('\n--- repairs ---');
    for (const f of fixes.slice(0, 10)) {
      console.log(`${f.pu_code}\n   - ${f.from}\n   + ${f.to}`);
    }
    if (fixes.length > 10) console.log(`... and ${fixes.length - 10} more`);
  }

  // Anything still non-ASCII AND not obviously typographic is worth a human look.
  const odd = leftAlone.filter((r) => !/^[\x00-\x7F’‘“”–—]*$/.test(r.name || ''));
  if (odd.length) {
    console.log(`\n--- still damaged, NOT auto-repairable (${odd.length}) ---`);
    for (const r of odd.slice(0, 10)) console.log(`${r.pu_code} ${JSON.stringify(r.name)}`);
    console.log('These need a human: the original text cannot be recovered mechanically.');
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit these repairs.');
    db.close();
    return;
  }
  if (!fixes.length) {
    console.log('\nnothing to do.');
    db.close();
    return;
  }

  const backup = `${DB_PATH}.mojibake-backup-${Date.now()}`;
  copyFileSync(DB_PATH, backup);
  console.log(`\nbacked up to ${backup}`);

  const upd = db.prepare('UPDATE polling_units SET name = ? WHERE pu_code = ?');
  const run = db.transaction((list) => { for (const f of list) upd.run(f.to, f.pu_code); });
  run(fixes);

  // Prove it took, and that a second pass would now be a no-op.
  const after = db.prepare('SELECT pu_code, name FROM polling_units').all();
  const remaining = after.filter((r) => repairMojibake(r.name)).length;
  console.log(`applied ${fixes.length} repairs; remaining repairable: ${remaining}`);
  if (remaining !== 0) {
    console.error('FAILED: repairs did not converge — restore from the backup above.');
    process.exit(1);
  }
  console.log('OK — idempotent (a second run would change nothing).');
  db.close();
}

main();

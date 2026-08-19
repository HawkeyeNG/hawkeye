/**
 * Repairing damaged polling-unit names, and the search fold — one definition,
 * used by the boot migration in db.js and by scripts/fix_register_mojibake.mjs.
 *
 * These two belong together. The fold is computed FROM the name, so repairing a
 * name after its fold has been stored leaves the fold describing text that no
 * longer exists — and a stale fold means the offline packs and the API disagree
 * about what a query matches, which is the one failure docs/PU-SEARCH-2027.md is
 * built to prevent. db.js therefore repairs first and re-folds what it changed.
 *
 * Why the damage exists at all, and what each rule is for, is documented on
 * repairName() below.
 */

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

/**
 * THE SEARCH FOLD — must stay character-for-character identical to fold() in
 * app/register-store.js and register-pack.ts in the native app. Offline packs
 * and this API have to agree on what a query matches;
 * backend/scripts/diff_register_search.mjs fails on any divergence.
 */
export function searchFold(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, ' ')
    .trim();
}

/**
 * Repair a damaged polling-unit name, or return null if there is nothing to do.
 *
 * The register arrived with UTF-8 bytes that had been decoded as CP1252, so one
 * character became two or three wrong ones. An observer searching the real name
 * finds nothing, and the offline packs ship exactly what this table holds — so a
 * name wrong here is wrong on a phone with no signal, where there is no server
 * left to correct it.
 *
 * Rule 1  re-encode CP1252, decode UTF-8. Pure arithmetic; applied only when it
 *         round-trips into valid UTF-8 AND shortens the string, so the 53 names
 *         that legitimately contain a curly apostrophe are untouched.
 * Rule 2  U+21B5, the glyph a spreadsheet prints for a line break, where a space
 *         belongs: "Nursery & Primary(arrow)School".
 * Rule 3  a lone U+00E2 beside a space — the wreckage of a NO-BREAK SPACE whose
 *         partner byte was stripped. Inference rather than arithmetic, and the
 *         only such rule here; safe because that character never appears in this
 *         register as a letter, only ever against a space.
 * Rule 4  the same corruption but title-cased afterwards, so the lead byte was
 *         lowered and stopped decoding: "Cafa-tilde" -> "CafE-acute" -> "Cafe".
 * Rule 5  residue that is not text and cannot be recovered (a stray copyright
 *         sign, a doubled letter at the edge of a name).
 *
 * Idempotent: repaired text no longer round-trips, so running twice changes
 * nothing.
 */
export function repairName(s) {
  if (!s || !/[^\x00-\x7F]/.test(s)) return null;

  // Rule 2: a line break that survived as its printed glyph, not as whitespace.
  if (s.includes('↵')) {
    const fixed = s.replace(/↵/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (fixed !== s) return fixed;
  }

  let fixed = null;
  const bytes = toCp1252(s);
  if (bytes) {
    try { fixed = strictUtf8.decode(bytes); } catch { fixed = null; }
    if (fixed === s) fixed = null;
  }

  // Rule 4: title-cased after the corruption, so the lead byte no longer decodes.
  if (fixed === null) {
    const unTitled = Array.from(s).map((c) => (c.codePointAt(0) > 127 ? c.toUpperCase() : c)).join('');
    const b2 = toCp1252(unTitled);
    if (b2) {
      let cand = null;
      try { cand = strictUtf8.decode(b2); } catch { cand = null; }
      if (cand && cand !== s) {
        // A letter recovered mid-word belongs in lower case: "CafE" -> "Cafe".
        fixed = cand.replace(/([a-z])([^\x00-\x7F])/g, (m, prev, ch) => prev + ch.toLowerCase());
      }
    }
  }

  // Rule 3: the stranded no-break space.
  if (fixed === null && /â/.test(s)) {
    const cand = s
      .replace(/â(?=[\s ])/g, '')
      .replace(/(?<=[\s ])â/g, '')
      .replace(/â$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cand !== s && !/â/.test(cand)) fixed = cand;
  }

  /**
   * Rule 5, deliberately AFTER rule 4 and allowed to overrule it. One row
   * decodes faithfully to a name carrying a circumflex — but that is not Hausa
   * orthography, so it was already corrupt upstream, and keeping it means the
   * obvious search misses the unit because the accent breaks the substring.
   * Findability beats fidelity in a register whose purpose is letting somebody
   * find their polling unit. A plausible letter still survives: a cafe keeps
   * its accent.
   */
  if (fixed === null || /[©ê]/.test(fixed || s)) {
    const base = fixed === null ? s : fixed;
    const cand = base.replace(/[©ê]+/g, '').replace(/\s{2,}/g, ' ').trim();
    if (cand !== base && cand.length) fixed = cand;
  }

  if (fixed === null || fixed === s) return null;
  // A repair removes damage, so it never lengthens the name.
  if (fixed.length > s.length) return null;
  return fixed;
}

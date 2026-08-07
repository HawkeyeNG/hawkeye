/* Pull the polling-unit code off an OCR'd EC8A sheet.
 *
 * MIRROR: native/src/lib/pu-code.ts — keep the two byte-for-byte equivalent,
 * same convention as canonicalPayload in signatures.js. A sheet must resolve to
 * the same unit on both platforms or the ladder means nothing.
 *
 * WHY THIS IS POSSIBLE AT ALL: every code in the register is exactly
 * NN-NN-NN-NNN — state, LGA, ward, unit. Verified against production: 176,846
 * rows, all length 12, no exceptions. That rigid shape is what lets a noisy OCR
 * read be repaired and checked rather than guessed at.
 *
 * THE REGISTER IS THE ARBITER. Nothing here trusts OCR on its own: a candidate
 * only survives if the register confirms it exists. Resolution is injected
 * (`resolve`) rather than imported, so the same parser works against the cached
 * near-me slice offline and the full register online.
 *
 * SILENCE BEATS A CONFIDENT WRONG UNIT. A misattributed result is worse than a
 * slower one, so an ambiguous repair returns nothing and lets the observer fall
 * through to near-me and manual search.
 */
(function () {
  // OCR confusions, digit positions only. Deliberately one-directional: we are
  // always reading a LETTER that should have been a digit, never the reverse.
  const CONFUSED = { O: '0', D: '0', Q: '0', I: '1', L: '1', '|': '1', '!': '1', S: '5', B: '8', Z: '2', G: '6', T: '7' };
  const DIGITISH = '0-9OoDdQqIiLl|!SsBbZzGgTt';
  const SEP = '[-–—./_\\s]{0,2}';
  const RE = new RegExp(
    `(?<![${DIGITISH}])([${DIGITISH}]{2})${SEP}([${DIGITISH}]{2})${SEP}([${DIGITISH}]{2})${SEP}([${DIGITISH}]{3})(?![${DIGITISH}])`,
    'g',
  );

  const digits = (s) => s.toUpperCase().split('').map((c) => (/[0-9]/.test(c) ? c : CONFUSED[c] ?? '')).join('');

  /** Canonical NN-NN-NN-NNN, or null if this cannot be one. */
  function normalizeCode(raw) {
    const g = String(raw || '').match(/[^\W_]+/g);
    if (!g) return null;
    const d = digits(g.join(''));
    if (d.length !== 9) return null;
    return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  }

  /** Every shape-valid candidate in the recognised text, in reading order. */
  function extractCandidates(text) {
    const out = [];
    for (const m of String(text || '').matchAll(RE)) {
      const c = normalizeCode(m[1] + m[2] + m[3] + m[4]);
      if (c && !out.includes(c)) out.push(c);
    }
    return out;
  }

  /**
   * Single-substitution repairs. A digit misread is overwhelmingly ONE bad
   * character, and widening past that explodes the candidate set to the point
   * where something plausible always resolves — which is exactly the confident
   * wrong answer this module exists to avoid.
   */
  function repairs(code) {
    const bare = code.replace(/-/g, '');
    const out = [];
    for (let i = 0; i < bare.length; i++) {
      for (const d of '0123456789') {
        if (d === bare[i]) continue;
        const b = bare.slice(0, i) + d + bare.slice(i + 1);
        out.push(`${b.slice(0, 2)}-${b.slice(2, 4)}-${b.slice(4, 6)}-${b.slice(6)}`);
      }
    }
    return out;
  }

  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

  /**
   * Resolve a unit from recognised sheet text.
   *
   * @param text      SheetRead.text — the full recognised string
   * @param resolve   async (code) => unit | null. The register lookup; supply a
   *                  local one offline (the cached near-me slice) so Tier A does
   *                  not depend on the network the outbox exists to survive.
   * @param fix       optional {lat,lng} — used only to DOWNGRADE, never to pick
   * @param maxRepair probe ceiling. The full single-substitution space is 81
   *                  (9 positions x 9 digits) and the DEFAULT COVERS ALL OF IT
   *                  on purpose: uniqueness cannot be established from a partial
   *                  sweep. Repairs are generated position by position, so a cap
   *                  of 24 only ever reached the first three digits — a misread
   *                  in the unit number was never probed, and worse, a hit found
   *                  early could be declared "unique" while a second hit sat
   *                  unprobed past the cap. That is a wrong unit, not a missed
   *                  one. If the ceiling is hit before the sweep completes, the
   *                  candidate is ABANDONED rather than trusted.
   *
   *                  This is why `resolve` should be cheap: point it at the
   *                  cached near-me slice, not at 81 network round trips.
   */
  async function resolveUnitFromText(text, { resolve, fix, maxRepair = 81 } = {}) {
    if (typeof resolve !== 'function') return null;
    const cands = extractCandidates(text);
    const t = norm(text);

    // 1. Exact. If the sheet reads cleanly, no repair logic runs at all.
    for (const c of cands) {
      const u = await resolve(c);
      if (u) return finish(u, c, 'exact', t, fix);
    }

    // 2. Repair — and accept ONLY on a unique hit. Two survivors is not a
    //    close call to be broken by ranking; it is an unreadable sheet.
    for (const c of cands) {
      const all = repairs(c);
      if (all.length > maxRepair) continue; // cannot prove uniqueness; do not guess
      const hits = [];
      for (const r of all) {
        const u = await resolve(r); // eslint-disable-line no-await-in-loop
        if (u) {
          hits.push([u, r]);
          if (hits.length > 1) break; // ambiguous; stop paying for lookups
        }
      }
      if (hits.length === 1) return finish(hits[0][0], hits[0][1], 'repaired', t, fix);
    }
    return null;
  }

  function finish(unit, code, source, textNorm, fix) {
    // The unit NAME is printed on the sheet beside the code, so finding it in
    // the same read is independent corroboration that this is the right row.
    const nameMatch = norm(unit.name).split(' ').filter((w) => w.length > 3)
      .some((w) => textNorm.includes(w));
    // GPS may only VETO. A code read off a sheet that did not come from here is
    // the one failure the register cannot catch — the code is perfectly real,
    // just not yours. Distance is the only signal that sees it.
    let gpsAgrees = null;
    const uLat = unit.lat ?? unit.crowd_lat, uLng = unit.lng ?? unit.crowd_lng;
    if (fix && Number.isFinite(uLat) && Number.isFinite(uLng)) {
      gpsAgrees = distM(fix.lat, fix.lng, uLat, uLng) <= 5000;
    }
    const confidence = (source === 'exact' || nameMatch) && gpsAgrees !== false ? 'high' : 'low';
    return { code, unit, source, nameMatch, gpsAgrees, confidence };
  }

  function distM(aLat, aLng, bLat, bLng) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const s = Math.sin(dLat / 2) ** 2
      + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  window.HAWKEYE_PUCODE = { normalizeCode, extractCandidates, repairs, resolveUnitFromText };
}());

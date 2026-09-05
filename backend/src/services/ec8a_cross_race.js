/**
 * Cross-race reconciliation — free evidence that only exists in 2027.
 *
 * On 16 January 2027 the SAME polling unit files THREE EC8As on one day:
 * Presidential, Senate and House of Representatives. Some of the figures on
 * those sheets are statements about the same underlying fact, written three
 * times by the same officer. That is three independent readings of one number,
 * for reads already paid for, and Osun could not use it because a governorship
 * is a single race.
 *
 * WHICH BOXES ARE ACTUALLY INVARIANT — the whole design turns on this.
 *
 * Only two, and the argument is structural rather than measured:
 *   registered  — the unit's register. One register per unit per election day.
 *   accredited  — accreditation is ONE act per voter for the day (BVAS), not
 *                 per race. A voter accredited once votes in all three.
 *
 * Every other box is PER RACE and must never be reconciled:
 *   ballotsIssued, unusedBallots  — each race has its own ballot papers, printed
 *                                   and supplied separately.
 *   spoiled, rejected, totalValid, usedBallots  — per race by definition.
 *
 * A prior analysis reported ballotsIssued/unusedBallots/usedBallots agreeing
 * across a live two-race pair. That is n=1, and this file refuses to build on
 * it: those boxes are reported as OBSERVED agreement so the rate can be measured
 * across a real corpus, and are never used to fill or to flag. The project has
 * already been bitten by exactly this shape — `#3 == #1` held on 18 of 19
 * readable Osun labels and then failed outright in FCT 2026-02-21 (registered
 * 860 against ballots issued 900). Carried in blind, that would have fired
 * across most of the country.
 *
 * THE THREE RULES, and each exists to stop a specific way of manufacturing a
 * result:
 *
 *   1. FILL ONLY WHAT IS UNREAD. A sibling may supply a box no reader could
 *      read. It may NEVER overwrite a box that was read. Letting a sibling
 *      overrule a reading is how a transcription error propagates into three
 *      sheets instead of one.
 *
 *   2. NEVER RESOLVE A DISAGREEMENT BY MAJORITY. 2-vs-1 does not become the 2.
 *      ec8a_resolve.js already refuses the coin flip between figures and words
 *      for this reason; the rule extends upward unchanged. Disagreement on an
 *      invariant box means one of the three is misread — or the unit is
 *      genuinely anomalous — and both belong in front of a human.
 *
 *   3. A FILLED BOX IS `from_sibling`, NEVER `pass`. Same discipline as
 *      `assumed`: a value supplied from outside the sheet cannot also testify
 *      that the sheet is correct.
 */

/** Same number on every sheet a unit files on one day. Structural, not measured. */
export const INVARIANT_BOXES = ['registered', 'accredited'];

/** Per-race by definition. Agreement is MEASURED here, never assumed or enforced. */
export const PER_RACE_BOXES = ['ballotsIssued', 'unusedBallots', 'spoiled', 'rejected', 'totalValid', 'usedBallots'];

const read = (v) => (v === null || v === undefined || v === '' ? null : v);

/**
 * @param siblings {Object} contest code -> that sheet's `sheet` object.
 *                          Two or more races for ONE polling unit.
 * @returns per-box outcome plus the observed agreement of the per-race boxes.
 */
export function reconcileSiblings(siblings) {
  const contests = Object.keys(siblings || {});
  const out = { contests, boxes: {}, observed: {}, contested: [], filled: [] };
  if (contests.length < 2) return out;                 // nothing to corroborate with

  for (const box of INVARIANT_BOXES) {
    const seen = contests
      .map((c) => ({ contest: c, value: read(siblings[c]?.[box]) }))
      .filter((r) => r.value !== null);
    const distinct = [...new Set(seen.map((r) => String(r.value)))];

    if (!seen.length) {
      out.boxes[box] = { state: 'unread_everywhere' };
      continue;
    }
    if (distinct.length > 1) {
      // RULE 2. Every sheet in the group is contested, including the ones that
      // agree with each other: a 2-1 split is not a 2, and the odd sheet out is
      // as likely to be the correct reading as the pair.
      out.boxes[box] = { state: 'contested', readings: seen };
      out.contested.push(box);
      continue;
    }
    const value = seen[0].value;
    const missing = contests.filter((c) => read(siblings[c]?.[box]) === null);
    out.boxes[box] = {
      state: missing.length ? 'fillable' : 'corroborated',
      value,
      agreedBy: seen.map((r) => r.contest),
      // RULE 1: named so a caller cannot accidentally treat this as a reading.
      fillsUnreadOn: missing,
      // RULE 3.
      provenance: missing.length ? 'from_sibling' : 'independent',
    };
    if (missing.length) out.filled.push({ box, value, contests: missing });
  }

  // MEASURED, NOT USED. Report how often the per-race boxes happen to match, so
  // a claim about them can eventually rest on a corpus instead of one pair.
  for (const box of PER_RACE_BOXES) {
    const vals = contests.map((c) => read(siblings[c]?.[box])).filter((v) => v !== null);
    if (vals.length < 2) continue;
    out.observed[box] = { agree: new Set(vals.map(String)).size === 1, n: vals.length };
  }
  return out;
}

/**
 * Apply a reconciliation to one sheet, returning a NEW object.
 *
 * Only ever adds boxes that were unread. Never edits a read value, never edits a
 * contested one. The caller keeps the original for the record.
 */
export function applyFills(sheet, recon, contest) {
  const next = { ...sheet };
  const filled = [];
  for (const box of INVARIANT_BOXES) {
    const b = recon.boxes[box];
    if (!b || b.state !== 'fillable') continue;
    if (!b.fillsUnreadOn.includes(contest)) continue;
    if (read(next[box]) !== null) continue;            // RULE 1, enforced twice on purpose
    next[box] = b.value;
    filled.push({ box, value: b.value, from: b.agreedBy, provenance: 'from_sibling' });
  }
  return { sheet: next, filled };
}

/**
 * Does the sheet agree with WHERE INEC FILED IT?
 *
 * An EC8A carries its own delimitation in print — state, LGA, ward, unit. IReV
 * files it under a polling unit. If those disagree, the sheet is filed against
 * the wrong unit: internally consistent, passing every arithmetic check, and
 * invisible to everything else in the pipeline.
 *
 * IT IS A QUALITY SIGNAL, NOT A FINDING — measured, not cautious. Across all
 * 3,742 Osun sheets, the model's `puCode` against the filing:
 *
 *     67.6%  consistent — a suffix, prefix or unseparated form of it  (2,528)
 *     12.3%  contradict                                                 (462)
 *     11.0%  exact                                                      (411)
 *      9.1%  read the sheet SERIAL instead of the code                  (341)
 *
 * So 78.5% of the field is usable as a location claim — better than it first
 * appeared, and good enough to be worth keeping. But 12.3% is far too high to
 * emit findings from, and inspecting them shows why: they are dominated by a
 * single dropped digit — 290101009 read as 2901009, 290610007 as 29061007.
 * Those are our transcription slips, and publishing them would accuse real
 * polling units of a mis-filing that never happened.
 *
 * A NOTE ON HOW THIS NUMBER WAS GOT WRONG ONCE. The first measurement reported
 * 59% serials and 33% usable, because the serial pattern was /^0{2,}[0-9]+$/ and
 * that also matches "001" — the ordinary last segment of 29-01-01-001, present
 * on hundreds of sheets. Real readings were being counted as serials. The S/N is
 * seven zero-padded digits and a unit segment is three or four, so the pattern
 * now requires six. Re-measure before quoting any of these figures again.
  */

// The S/N is 7 zero-padded digits (see the serial parser). A value shaped like
// one is the model answering a different question, not a disagreement about
// where the sheet belongs.
// SIX DIGITS MINIMUM, not just leading zeros. The first version was
// /^0{2,}[0-9]+$/, which also matched "001" — the perfectly good last segment of
// 29-01-01-001, present on hundreds of sheets. That would have discarded a real
// reading as a serial. The S/N is 7 zero-padded digits; a unit segment is 3 or 4.
const SERIAL_SHAPE = /^0{2,}[0-9]{4,}$/;
const digits = (v) => String(v ?? '').replace(/[^0-9]/g, '');

export const ASSOCIATION = {
  UNREAD: 'unread',
  SERIAL: 'read_serial_not_code',
  EXACT: 'exact',
  CONSISTENT: 'consistent',
  CONTRADICTS: 'contradicts',
};

/**
 * @param readCode  what the model reported as the sheet's own polling-unit code
 * @param filedCode the unit IReV filed the sheet under
 */
export function compareAssociation(readCode, filedCode) {
  const said = digits(readCode);
  const filed = digits(filedCode);
  if (!said) return { state: ASSOCIATION.UNREAD };
  if (!filed) return { state: ASSOCIATION.UNREAD, note: 'no filing to compare against' };

  // Checked BEFORE any comparison. A serial that happens to share digits with a
  // unit code must never be scored as agreement either.
  if (SERIAL_SHAPE.test(said)) {
    return { state: ASSOCIATION.SERIAL, said, filed };
  }
  if (said === filed) return { state: ASSOCIATION.EXACT, said, filed };

  // The printed code is often read without separators, or only its last segment
  // ("001" for 29-01-01-001). Neither disagrees with the filing about anything.
  if (filed.endsWith(said) || said.endsWith(filed)
      || filed.startsWith(said) || said.startsWith(filed)) {
    return { state: ASSOCIATION.CONSISTENT, said, filed };
  }
  return { state: ASSOCIATION.CONTRADICTS, said, filed };
}

/**
 * Deliberately NOT `isFinding`. The name is the guard: at the measured 5%
 * contradiction rate, dominated by dropped digits, this routes a sheet to a
 * human and nothing else. Promoting it to a finding needs a re-measurement
 * showing the field actually holds polling-unit codes.
 */
export function needsHumanLook(result) {
  return result.state === ASSOCIATION.CONTRADICTS;
}

/** Roll a corpus up, so a prompt change can be judged on the distribution. */
export function summarise(results) {
  const out = Object.fromEntries(Object.values(ASSOCIATION).map((k) => [k, 0]));
  for (const r of results) out[r.state] = (out[r.state] || 0) + 1;
  const total = results.length || 1;
  return { total: results.length, counts: out,
    usable: (out[ASSOCIATION.EXACT] + out[ASSOCIATION.CONSISTENT]) / total };
}

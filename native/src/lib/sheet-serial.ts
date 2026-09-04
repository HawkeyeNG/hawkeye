/**
 * EC8A serial extraction — a pure parser, no imports.
 *
 * Dependency-free ON PURPOSE, exactly like lib/pu-code.ts: ocr.ts pulls in
 * react-native and a native Vision module, neither of which resolves under plain
 * node, so a parser living there could only be tested by regex-stripping its
 * imports. A previous check in this repo did that and silently measured
 * nothing. tests/sheet-serial.test.mjs imports this file directly instead.
 *
 * ocr.ts imports and re-exports parseSerial, so callers see no difference.
 */
/**
 * The EC8A serial, read off the top of the sheet.
 *
 * ── THE FORMAT IS NOT INVENTED ────────────────────────────────────────────
 *
 * Verified against real 2026 Osun sheets in audits/2026-osun-governorship:
 *
 *   29-01-01-001   S/N 0000001
 *   29-02-01-001   S/N 0000078
 *   29-05-03-002   S/N 0000388
 *
 * Label "S/N", value seven digits zero-padded, PRINTED rather than handwritten,
 * sitting under the FORM EC 8A box at the top right. Printed is why this is
 * worth reading at all: it is the most legible thing on the page, while every
 * figure the observer cares about is biro.
 *
 * ── WHY THIS IS DELIBERATELY STINGY ───────────────────────────────────────
 *
 * A serial is not a convenience field. backend/src/services/integrity.js logs
 * `duplicate_serial` at HIGH severity — "same form serial reported at a
 * DIFFERENT unit = forgery". So a MISREAD serial does not merely annoy someone:
 * it accuses two innocent polling units of forgery, and it does so at scale,
 * because one systematic misread (a form revision code, a printer's mark) would
 * repeat on every sheet in the country.
 *
 * That asymmetry decides the design. A missed serial costs nothing — the field
 * stays empty exactly as it is today. A wrong one manufactures evidence. So:
 *
 *   - ANCHORED ON THE LABEL, never a hunt for "a long number somewhere". The
 *     printed "S/N" is the only thing that distinguishes a serial from the
 *     register total, the ballot-paper count, or the unit code.
 *   - the party table's "S/N" column header is the one other place that token
 *     appears, so a line carrying party-table words is refused outright.
 *   - 6-9 digits. Real is 7; the slack is for a recogniser dropping or doubling
 *     a character, not an invitation to match anything numeric.
 *   - and whatever comes back is a PROPOSAL. Every caller shows it for
 *     confirmation before it can be sent.
 */
const SERIAL_LABEL = /^(?:S[/|\\1IL]N|SN|SIN)$/;
/** Words that only occur in the party table's header row, never beside a serial. */
const TABLE_WORDS = /\b(POLITICAL|PARTY|VOTES|FIGURES|WORDS|AGENT|SIGNATURE)\b/;

export function parseSerial(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].toUpperCase();
    if (TABLE_WORDS.test(line)) continue;
    const tokens = line.split(/[^A-Z0-9/\\|]+/).filter(Boolean);
    if (!tokens.some((tk) => SERIAL_LABEL.test(tk))) continue;

    // Same line first — that is where all three verified sheets carry it — then
    // the next line, because a recogniser may break after the dotted rule.
    for (const candidate of [line, lines[i + 1]?.toUpperCase() ?? '']) {
      if (!candidate || TABLE_WORDS.test(candidate)) continue;
      // A single space inside the run is tolerated ONLY because the label was
      // already matched on this line: real output split 0000388 as "0000 388".
      // The tolerance stops there. The same sheets also produced "nQQQ00 78",
      // where zeros came back as Qs — repairing THAT needs letter-to-digit
      // substitution, which is precisely how a printer's mark or a form code
      // becomes a forgery accusation. Stripped of its letters it is 4 digits,
      // too short, and correctly refused: the observer types it instead.
      const m = candidate.match(/\b(\d[\d ]{4,10}\d)\b/);
      if (!m) continue;
      const digits = m[1].replace(/ /g, '');
      if (digits.length >= 6 && digits.length <= 9) return digits;
    }
  }
  return null;
}

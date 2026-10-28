/**
 * Party counts off a recognised EC8A — a pure parser, no imports.
 *
 * Dependency-free for the same reason as sheet-serial.ts: ocr.ts pulls in
 * react-native and a native Vision module, neither of which resolves under plain
 * node, so tests/sheet_counts_test.mjs imports this file directly. ocr.ts
 * re-exports parseCounts, so callers see no difference.
 *
 * ── WHAT WAS WRONG (28 Oct 2026, owner's iPhone, printed practice sheet) ──────
 *
 * The phone read 26 lines off a legible sheet and paired nothing. Two faults:
 *
 *   1. Codes were compared against single words, so "Party A" — every practice
 *      party — could never match. Practice never pre-filled, on any sheet.
 *   2. A party and its count had to arrive on the SAME recognised line. Both
 *      readers split a ruled table at the column rules, so "APC" and "126"
 *      usually arrive as separate lines and the row was skipped.
 *
 * ── HOW IT PAIRS NOW ──────────────────────────────────────────────────────────
 *
 *   1. Same line: the first number AFTER the code. The FIGURES column follows
 *      the party; anything before the code is the row's S/N. This is the
 *      website's rule (app/app.js, the 'hawkeye-sheet-ocr' listener).
 *   2. Otherwise, by position. Every line that starts with a number goes to the
 *      nearest label on its left — a party, or a TOTAL row so the totals are
 *      nobody's — and each party takes the number in its leftmost column.
 *
 * "Nearest" leans DOWNWARD on purpose. Measured on the owner's sheet: the
 * printed label sits at the top of its row and the handwritten figure below it,
 * with no vertical overlap at all, so the website's "boxes must overlap" test
 * would pair nothing there either. On a real EC8A the label is centred. A figure
 * below a label costs its distance, one above costs double, and anything further
 * than one row pitch belongs to no one.
 *
 * Stingy by design, like everything here that proposes a figure: a blank field
 * costs the observer a tap, a wrong one can be accepted unread. A count is a
 * whole number standing on its own ("2ERO", a misread ZERO, is not a 2), and
 * nothing longer than six digits is a tally.
 */

/** One recognised line, in pixels, origin top-left — what both readers are converted to. */
export type OcrLine = { text: string; left: number; right: number; top: number; bottom: number };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * "Party A" matches "Party A", "PARTY A" and "PartyA"; "APC" matches "APC" but
 * never "APCX" or "XAPC" — a code counts only where it is not part of a longer
 * word, because codes are short and collide with ordinary text on the form.
 */
function codePattern(code: string): RegExp {
  const words = code.trim().split(/\s+/).map(escapeRe);
  return new RegExp(`(?:^|[^A-Z0-9])${words.join('[\\s.:-]*')}(?![A-Z0-9])`, 'i');
}

/** The two misreads worth repairing, nothing riskier: "1OO" → "100", "1,204" → "1204". */
function repairDigits(s: string): string {
  return s
    .replace(/[Oo](?=\d)/g, '0')
    .replace(/(\d)[Oo]/g, (_, d: string) => `${d}0`)
    .replace(/(\d)[Oo]/g, (_, d: string) => `${d}0`)
    .replace(/(\d)[.,](?=\d{3}\b)/g, '$1');
}

/** 1–6 digits is a tally; anything longer is a serial, a phone number or a code. */
const tally = (digits: string) => (digits.length <= 6 ? Number(digits) : null);

/** The first whole number in a string — what follows the code on its own line. */
function firstNumber(s: string): number | null {
  const m = repairDigits(s).match(/(?:^|[^A-Za-z0-9])(\d+)(?![A-Za-z0-9])/);
  return m ? tally(m[1]) : null;
}

/** A line that STARTS with a whole number: "42", "42.", "42 FORTY-TWO". Not "2ERO", not "#8". */
function leadingNumber(s: string): number | null {
  const m = repairDigits(s).match(/^[\s|(]*(\d+)(?![A-Za-z0-9])/);
  return m ? tally(m[1]) : null;
}

const mid = (b: OcrLine) => (b.top + b.bottom) / 2;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** How far a number sits from a label, in pixels: below costs its distance, above double. */
function rowCost(num: OcrLine, label: OcrLine): number {
  const d = mid(num) - mid(label);
  return d >= 0 ? d : -2 * d;
}

/**
 * Pull party counts out of a recognised sheet.
 *
 * `lines` is the reader's own line geometry. Without it — a reader that returned
 * no boxes — only the same-line rule runs, on the text's lines.
 * Keys are the codes exactly as given, so callers can index their own fields.
 */
export function parseCounts(text: string, partyCodes: string[], lines: OcrLine[] = []): Record<string, number> {
  const rows: { text: string; box?: OcrLine }[] = lines.length
    ? lines.map((box) => ({ text: box.text, box }))
    : text.split(/\r?\n/).map((t) => ({ text: t }));
  const codes = [...new Set(partyCodes.filter((c) => c.trim()))];
  const out: Record<string, number> = {};
  const labelled = new Map<string, OcrLine[]>();

  // 1. Same line. The first read per party wins, so a repeated header row
  //    cannot overwrite a real one.
  for (const code of codes) {
    const re = codePattern(code);
    for (const row of rows) {
      const m = re.exec(row.text);
      if (!m) continue;
      const n = firstNumber(row.text.slice(m.index + m[0].length));
      if (n != null && out[code] === undefined) out[code] = n;
      if (row.box) labelled.set(code, [...(labelled.get(code) ?? []), row.box]);
    }
  }
  if (!lines.length || !labelled.size) return out;

  // 2. By position. One label per party: where a code stands on several lines,
  //    keep the one nearest the party column (the median left edge of the codes
  //    that matched only once).
  const once = [...labelled.values()].filter((ls) => ls.length === 1).map((ls) => ls[0].left);
  const column = once.length ? median(once) : null;
  const parties = [...labelled].map(([code, ls]) => ({
    code: code as string | null,
    box: column == null ? ls[0] : ls.reduce((a, b) => (Math.abs(b.left - column) < Math.abs(a.left - column) ? b : a)),
  }));

  // One row pitch: the smallest gap between neighbouring labels that is more
  // than a label's height (two reads of one row are not a gap), else four label
  // heights when only one label was read.
  const height = median(parties.map((p) => p.box.bottom - p.box.top));
  const ys = parties.map((p) => mid(p.box)).sort((a, b) => a - b);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > height);
  const pitch = gaps.length ? Math.min(...gaps) : 4 * height;

  // TOTAL rows are labels too, so their figures go to no party.
  const totals = lines.filter((l) => /(?:^|[^A-Z])TOTAL(?![A-Z])/i.test(l.text)).map((box) => ({ code: null, box }));
  const anchors = [...parties, ...totals];
  const isLabel = new Set<OcrLine>([...[...labelled.values()].flat(), ...totals.map((t) => t.box)]);

  const won = new Map<string, { box: OcrLine; n: number; cost: number }[]>();
  for (const box of lines) {
    if (isLabel.has(box)) continue;
    const n = leadingNumber(box.text);
    if (n == null) continue;
    let best: { code: string | null; cost: number } | null = null;
    for (const a of anchors) {
      if (box.left <= a.box.left) continue; // the S/N column, or left of this label
      const cost = rowCost(box, a.box);
      if (cost <= pitch && (!best || cost < best.cost)) best = { code: a.code, cost };
    }
    if (best?.code != null) won.set(best.code, [...(won.get(best.code) ?? []), { box, n, cost: best.cost }]);
  }

  // Each party's FIGURES column is its leftmost: drop any number with another
  // entirely to its left (the words or agent columns), then take the nearest.
  for (const [code, cands] of won) {
    if (out[code] !== undefined) continue;
    const first = cands.filter((c) => !cands.some((o) => o.box.right < c.box.left));
    out[code] = first.reduce((a, b) => (b.cost < a.cost ? b : a)).n;
  }
  return out;
}

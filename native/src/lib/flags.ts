/**
 * Human labels for integrity flag types.
 *
 * These strings are CARD TITLES — they head a flag on Election Integrity and a
 * flag card on a case file — so they are written in Title Case, like every other
 * title in the app. (The same terms appear in sentence case inside the "What We
 * Check" checklist on integrity.tsx, where they are the subject of a definition
 * sentence rather than a heading; that difference is deliberate.)
 *
 * The map lived inside integrity.tsx, so case.tsx had no way to reach it and
 * rendered the raw enum instead: a case opened by a collation flag was headed
 * "collation_chain_undercount". Both screens read it from here now.
 *
 * `flagLabel` never returns the bare key. An unknown type — a check shipped
 * server-side before the app knows about it — is de-snaked and Title Cased so it
 * still reads as a heading rather than as a database column.
 */

const SMALL = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'of',
  'in',
  'on',
  'to',
  'for',
  'at',
  'by',
  'with',
  'from',
  'as',
  'vs',
]);

/** Preserve these exactly; Title Case must not turn INEC into Inec. */
const ACRONYM: Record<string, string> = {
  inec: 'INEC',
  irev: 'IReV',
  lga: 'LGA',
  pu: 'PU',
  gps: 'GPS',
  otp: 'OTP',
  ocr: 'OCR',
  ec8a: 'EC8A',
  ec8b: 'EC8B',
  ai: 'AI',
};

/** Title Case one word, keeping hyphenated compounds capitalised on both sides. */
function titleWord(w: string): string {
  return w
    .split('-')
    .map((part) => {
      const lower = part.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      if (ACRONYM[lower]) return part.replace(/[A-Za-z0-9]+/, ACRONYM[lower]);
      // Upper the first LETTER, not the first character — a leading bracket or
      // quote would otherwise swallow the capital and leave "(informational)".
      return part.replace(/[a-z]/, (ch) => ch.toUpperCase());
    })
    .join('-');
}

/** Title Case a phrase: principal words up, small words down unless first/last. */
export function titleCase(s: string): string {
  const words = s.split(/\s+/).filter(Boolean);
  return words
    .map((w, i) => {
      const bare = w.replace(/[^A-Za-z-]/g, '').toLowerCase();
      const isEdge = i === 0 || i === words.length - 1;
      if (!isEdge && SMALL.has(bare) && !ACRONYM[bare]) return w.toLowerCase();
      return titleWord(w);
    })
    .join(' ');
}

export const FLAG_LABEL: Record<string, string> = {
  over_voting: 'Over-Voting',
  high_turnout: 'Impossible Turnout',
  turnout_outlier: 'Turnout Outlier',
  single_party_sweep: 'Single-Party Sweep',
  duplicate_serial: 'Duplicate Serial',
  disputed_counts: 'Conflicting Counts',
  location_inconsistent: 'Location Inconsistent',
  irev_mismatch: 'INEC IReV Mismatch',
  collation_undercount: 'Collation Undercount',
  collation_disputed: 'Conflicting Collation Reports',
  collation_mismatch: 'Collation Mismatch (Full Coverage)',
  collation_chain_undercount: 'Collation Chain Undercount',
  collation_ocr_mismatch: 'Collation Form OCR Mismatch',
  signup_burst: 'Signup Burst (Informational)',
};

export function flagLabel(type: string): string {
  return FLAG_LABEL[type] ?? titleCase(String(type).replace(/_/g, ' '));
}

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

import { t } from '@/lib/i18n';
import { t as i18nT } from '@/lib/i18n';

export const FLAG_LABEL: Record<string, string> = {
  over_voting: 'Over-Voting',
  high_turnout: i18nT('n.flags.impossible-turnout'),
  turnout_outlier: i18nT('n.flags.turnout-outlier'),
  single_party_sweep: i18nT('n.flags.single-party-sweep'),
  duplicate_serial: i18nT('n.flags.duplicate-serial'),
  disputed_counts: i18nT('n.flags.conflicting-counts'),
  location_inconsistent: i18nT('n.flags.location-inconsistent'),
  irev_mismatch: i18nT('n.flags.inec-irev-mismatch'),
  collation_undercount: i18nT('n.flags.collation-undercount'),
  collation_disputed: i18nT('n.flags.conflicting-collation-reports'),
  collation_mismatch: i18nT('n.flags.collation-mismatch-full-coverage'),
  collation_chain_undercount: i18nT('n.flags.collation-chain-undercount'),
  collation_ocr_mismatch: i18nT('n.flags.collation-form-ocr-mismatch'),
  signup_burst: i18nT('n.flags.signup-burst-informational'),
};

/**
 * The translated card title for each flag.
 *
 * FLAG_LABEL above stays exactly as it is: it is the English, and the fallback
 * for a flag type the server invents that nothing here has a key for.
 *
 * RESOLVED INSIDE flagLabel(), not folded into FLAG_LABEL, because a
 * module-level constant is evaluated once at import — before AsyncStorage has
 * returned the stored language — so a translated string baked in up there would
 * freeze at whatever was current then and never move again, however many times
 * the provider remounts. flagLabel() is called during render, so it follows.
 */
const FLAG_KEY: Record<string, string> = {
  over_voting: 'n.flags.over-voting',
  high_turnout: 'n.flags.impossible-turnout',
  turnout_outlier: 'n.flags.turnout-outlier',
  single_party_sweep: 'n.flags.single-party-sweep',
  duplicate_serial: 'n.flags.duplicate-serial',
  disputed_counts: 'n.flags.conflicting-counts',
  location_inconsistent: 'n.flags.location-inconsistent',
  irev_mismatch: 'n.flags.inec-irev-mismatch',
  collation_undercount: 'n.flags.collation-undercount',
  collation_disputed: 'n.flags.conflicting-collation-reports',
  collation_mismatch: 'n.flags.collation-mismatch-full-coverage',
  collation_chain_undercount: 'n.flags.collation-chain-undercount',
  collation_ocr_mismatch: 'n.flags.collation-form-ocr-mismatch',
  signup_burst: 'n.flags.signup-burst-informational',
};

export function flagLabel(type: string): string {
  const k = FLAG_KEY[type];
  if (k) return t(k);
  return FLAG_LABEL[type] ?? titleCase(String(type).replace(/_/g, ' '));
}

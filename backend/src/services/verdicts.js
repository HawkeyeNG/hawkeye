// WHAT A VERDICT MAY SAY, and which answers are adverse.
//
// Kept apart from both the panel rule and the raters so that model, staff and
// campaign are answering the SAME question with the SAME words. A free-text
// verdict would make agreement unmeasurable — two reviewers writing "looks
// fine" and "seems ok" are agreeing, and no panel could tell.

export const VOCAB = Object.freeze({
  // Do our counts appear on INEC's sheet?
  tally_match: ['match', 'mismatch', 'unreadable'],
  // Is INEC's own sheet internally consistent?
  sheet_integrity: ['sound', 'unsound', 'unreadable'],
  // Is our observer's report credible?
  report_credibility: ['credible', 'not_credible', 'cannot_say'],
});

/**
 * The answers that mean something is wrong.
 *
 * 'unreadable' and 'cannot_say' are deliberately NOT adverse. A sheet nobody
 * can read is a fact about the photograph, not a finding against anyone, and
 * treating it as one would let image quality masquerade as irregularity — the
 * exact conflation the audit exists to resolve.
 */
export const ADVERSE = Object.freeze({
  tally_match: 'mismatch',
  sheet_integrity: 'unsound',
  report_credibility: 'not_credible',
});

export const isValid = (kind, v) => (VOCAB[kind] || []).includes(v);
export const isAdverse = (kind, v) => ADVERSE[kind] === v;

/** Severity a docket flag carries when a panel agrees on an adverse answer. */
export const SEVERITY = Object.freeze({
  // Our count and INEC's sheet disagreeing is the strongest signal we produce.
  tally_match: 'high',
  // INEC's sheet contradicting itself is about their document, not our data.
  sheet_integrity: 'high',
  // A doubted report reflects on one observer; it must not dispute a RESULT on
  // its own, so it is logged at medium and stays off the docket chain.
  report_credibility: 'medium',
});

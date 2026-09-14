// ONE REVIEWER IS NOT A RESULT. The panel rule for every label, rating and
// review in the project.
//
// A single competent person transposes a digit now and then, and a label taken
// from one reading carries that error into whatever is built on it with no way
// to find it later. So nothing passes on one opinion: a subject goes to a small
// panel, unanimity ends it, and disagreement buys more readers rather than a
// casting vote.
//
//   first=2 agree            -> agreed, done in two readings
//   first=2 disagree         -> escalate; a third and fourth are asked
//   supermajority at any n   -> agreed
//   max reached, still split -> unresolved, and a human is told
//
// WHY NOT THE DOCKET'S RULE. services/docket.js resolves crowd arbitration at
// QUORUM=50 with the same supermajority share, and that is right for a public
// vote on a disputed result. It is wrong here: expert review is expensive and
// two agreeing transcriptions of the same sheet is genuinely settled. Same
// principle, different regime, kept in separate files on purpose.
//
// REVIEWERS MUST NOT SEE EACH OTHER. Everything below assumes verdicts were
// collected blind — see the blind-review pipeline, where the gate had to be
// keyed on the REVIEWER rather than the subject for exactly this reason. A
// panel that can read the first answer is one opinion wearing three hats.

/** Defaults. `first` readers, then `escalateBy` at a time, never past `max`. */
export const PANEL = Object.freeze({
  first: 2, escalateBy: 1, max: 5, supermajority: 2 / 3,
});

/** Per-kind overrides — a cheap yes/no needs less than a full transcription. */
export const KINDS = Object.freeze({
  // Does our count match INEC's sheet? Mechanical; two readings settle it.
  tally_match: { first: 2, escalateBy: 1, max: 5 },
  // Is INEC's sheet internally sound? Arithmetic on one image, also cheap.
  sheet_integrity: { first: 2, escalateBy: 1, max: 5 },
  // Is the observer's report credible? Judgement — start wider, allow more.
  report_credibility: { first: 3, escalateBy: 2, max: 7 },
  // Full per-field transcription for ground truth. The expensive one, and the
  // one where a silent error is most costly, so it never stops at two.
  transcription: { first: 3, escalateBy: 2, max: 7 },
});

export const cfgFor = (kind) => ({ ...PANEL, ...(KINDS[kind] || {}) });

/**
 * Verdicts in, next action out. PURE — no database, no clock, no reviewer ids.
 *
 * `verdicts` is a list of already-collected answers, each comparable with ===
 * after `key()` (default JSON, so structured transcriptions compare by value).
 * Returns what the pipeline should do, never mutates anything, and is the only
 * place the rule is written down.
 */
export function decide(verdicts, kind = null, key = (v) => JSON.stringify(v)) {
  const cfg = cfgFor(kind);
  const n = verdicts.length;
  const tally = new Map();
  for (const v of verdicts) {
    const k = key(v);
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [topKey, topCount] = ranked[0] || [null, 0];
  const base = { n, distinct: tally.size, cfg, tally: Object.fromEntries(tally) };

  // Not enough readings yet to say anything at all.
  if (n < cfg.first) return { ...base, state: 'pending', need: cfg.first - n, outcome: null };

  // Unanimous. The common case, and the cheap one.
  if (tally.size === 1) return { ...base, state: 'agreed', by: 'unanimous', outcome: verdicts[0], need: 0 };

  // Split. A supermajority of everyone asked so far settles it.
  if (topCount / n >= cfg.supermajority) {
    const winner = verdicts.find((v) => key(v) === topKey);
    return { ...base, state: 'agreed', by: 'supermajority', outcome: winner, need: 0 };
  }

  // Still split, and there is room to ask more.
  if (n < cfg.max) {
    const want = Math.min(cfg.escalateBy, cfg.max - n);
    return { ...base, state: 'escalate', need: want, outcome: null };
  }

  /* Out of readers and still no supermajority. NOT a verdict by plurality:
     a sheet four people read three different ways is telling us something
     about the sheet, and flattening that into "most said X" would discard
     the finding. It goes to a person. */
  return { ...base, state: 'unresolved', need: 0, outcome: null };
}

// THE PANEL, WIRED. Collect verdicts on a pair, decide when it is settled.
//
// The rule lives in services/consensus.js; this is the part that touches the
// database, keeps reviewers blind from each other, and keeps a campaign's
// opinion out of the neutral verdict without discarding it.
import { db } from '../db.js';
import { decide, cfgFor } from './consensus.js';
import { VOCAB, isValid, isAdverse, SEVERITY } from './verdicts.js';
import { logDiscrepancy } from './integrity.js';

/** The three questions asked about every pair. */
export const KINDS = ['tally_match', 'sheet_integrity', 'report_credibility'];

/**
 * A campaign is a party to the thing it is rating.
 *
 * They are invited to rate — they know their own units, and a campaign that
 * spots a real discrepancy is exactly the signal we want — but a campaign
 * rating results in its OWN race has an obvious reason to call an unfavourable
 * unit disputed. So their verdicts are stored, attributed and shown, and they
 * are not counted toward the panel. Splitting it here rather than at the call
 * site means no future caller can forget.
 */
export const NEUTRAL = (r) => r.reviewer_type !== 'campaign';

/**
 * Record one verdict. Refuses a second from the same reviewer on the same
 * question — the schema enforces it, and this turns the constraint into an
 * answer rather than an exception.
 */
export function submitReview({ pairId, kind, reviewerType, reviewerId, verdict, note = null }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`);
  /* One vocabulary for every rater. Free text would make agreement
     unmeasurable — "looks fine" and "seems ok" agree, and no panel could tell. */
  if (!isValid(kind, verdict)) return { ok: false, error: 'bad_verdict', allowed: VOCAB[kind] };
  try {
    db.prepare(`INSERT INTO pair_reviews
      (pair_id, kind, reviewer_type, reviewer_id, verdict_json, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(pairId, kind, reviewerType, String(reviewerId), JSON.stringify(verdict), note, Date.now());
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return { ok: false, error: 'already_reviewed' };
    throw e;
  }
  return { ok: true, panel: refreshPanel(pairId, kind) };
}

/** Everything said about one question, newest last. */
export const reviewsFor = (pairId, kind) =>
  db.prepare('SELECT * FROM pair_reviews WHERE pair_id = ? AND kind = ? ORDER BY created_at')
    .all(pairId, kind);

/**
 * Re-decide one panel and store where it landed.
 *
 * Campaign verdicts are counted SEPARATELY and returned alongside, so a
 * reviewer screen can show "the campaign says mismatch" without that moving the
 * verdict. A campaign disagreeing with a settled panel is itself worth seeing.
 */
export function refreshPanel(pairId, kind) {
  const all = reviewsFor(pairId, kind);
  const neutral = all.filter(NEUTRAL);
  const d = decide(neutral.map((r) => JSON.parse(r.verdict_json)), kind);
  const campaign = all.filter((r) => !NEUTRAL(r))
    .map((r) => ({ reviewer_id: r.reviewer_id, verdict: JSON.parse(r.verdict_json) }));
  db.prepare(`INSERT INTO pair_panels (pair_id, kind, state, outcome, decided_by, n, need, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pair_id, kind) DO UPDATE SET
      state = excluded.state, outcome = excluded.outcome, decided_by = excluded.decided_by,
      n = excluded.n, need = excluded.need, updated_at = excluded.updated_at`)
    .run(pairId, kind, d.state, d.outcome === null ? null : JSON.stringify(d.outcome),
      d.by || null, d.n, d.need, Date.now());
  /* A pair is settled only when all three questions are. */
  const panels = db.prepare('SELECT state FROM pair_panels WHERE pair_id = ?').all(pairId);
  const settled = panels.length === KINDS.length && panels.every((p) => p.state === 'agreed');
  const stuck = panels.some((p) => p.state === 'unresolved');
  db.prepare('UPDATE result_pairs SET state = ?, updated_at = ? WHERE id = ?')
    .run(stuck ? 'unresolved' : settled ? 'agreed' : 'open', Date.now(), pairId);
  if (d.state === 'agreed') flagIfAdverse(pairId, kind, d);
  return { ...d, campaign };
}

/**
 * AN AGREED PANEL REACHES THE DOCKET. Only an agreed one, and only an adverse
 * answer.
 *
 * This is what irev.js used to do off a single OCR read — a high-severity flag
 * that disputes the result from that moment. The flag is the same; what changed
 * is that a panel of independent readers now has to agree on it first, and a
 * campaign's opinion is not among them.
 *
 * logDiscrepancy is INSERT OR IGNORE on its own key and only notifies when it
 * actually inserted, so re-deciding a settled panel cannot flag twice.
 * 'unreadable' is never adverse: a sheet nobody can read is a fact about the
 * photograph, and letting image quality masquerade as irregularity is the one
 * conflation this whole pipeline exists to prevent.
 */
function flagIfAdverse(pairId, kind, d) {
  const outcome = d.outcome;
  if (!isAdverse(kind, outcome)) return;
  const p = db.prepare('SELECT * FROM result_pairs WHERE id = ?').get(pairId);
  if (!p) return;
  const pu = db.prepare('SELECT state FROM polling_units WHERE pu_code = ?').get(p.pu_code);
  logDiscrepancy({
    type: `pair_${kind}`,
    severity: SEVERITY[kind] || 'medium',
    puCode: p.pu_code,
    contest: p.contest,
    state: pu?.state || null,
    detail: {
      pairId, kind, outcome, decidedBy: d.by, readers: d.n,
      docUrl: p.doc_url || null, docSha256: p.doc_sha256 || null,
      summary: `panel of ${d.n} agreed: ${kind} = ${outcome}`,
    },
  });
}

/**
 * The next pairs this reviewer should see, for one question.
 *
 * NOT ALREADY REVIEWED BY THEM, and only where the panel still wants readings.
 * The exclusion is keyed on the REVIEWER, not the pair: asking "has anyone
 * reviewed this" would hand a second reviewer a subject the first had already
 * answered and let them agree with a verdict they can see.
 *
 * It returns the pair WITHOUT any other reviewer's verdict attached. Callers
 * must not join pair_reviews onto this.
 */
export function queueFor({ kind, reviewerType, reviewerId, contest = null, limit = 20 }) {
  const cfg = cfgFor(kind);
  return db.prepare(`
    SELECT p.id, p.pu_code, p.contest, p.ours_json, p.theirs_json, p.doc_url, p.presence,
           COALESCE(pl.n, 0) AS panel_n, COALESCE(pl.state, 'pending') AS panel_state
      FROM result_pairs p
      LEFT JOIN pair_panels pl ON pl.pair_id = p.id AND pl.kind = ?
     WHERE p.state = 'open'
       AND (? IS NULL OR p.contest = ?)
       AND COALESCE(pl.state, 'pending') IN ('pending', 'escalate')
       AND COALESCE(pl.n, 0) < ?
       AND NOT EXISTS (
         SELECT 1 FROM pair_reviews r
          WHERE r.pair_id = p.id AND r.kind = ?
            AND r.reviewer_type = ? AND r.reviewer_id = ?)
     ORDER BY COALESCE(pl.n, 0) DESC, p.created_at
     LIMIT ?`)
    .all(kind, contest, contest, cfg.max, kind, reviewerType, String(reviewerId), limit);
}

export const panelsFor = (pairId) =>
  db.prepare('SELECT * FROM pair_panels WHERE pair_id = ?').all(pairId);

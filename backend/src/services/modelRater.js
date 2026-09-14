// THE MACHINE AS ONE READER ON THE PANEL — not as the answer.
//
// There is still no transcription ground truth: 20 sheets, read by an AI, and
// 549 training labels that are humans CONFIRMING a machine's proposal rather
// than reading blind. So nothing here may be treated as correct. The model is a
// reader whose agreement rate with human readers is itself the measurement, and
// the panel is what turns readings into a verdict.
//
// IT IS ALLOWED TO SAY NOTHING. A rater forced to answer will guess, and a
// guess counted as a reading is worse than a missing one: it fills a panel slot
// with noise that looks like evidence. Abstaining returns null and writes no
// review, so the subject simply waits for a reader who can answer it.
import { ocrMatchCounts } from './ocr.js';
import { submitReview } from './review.js';
import { db } from '../db.js';

export const MODEL_ID = process.env.RATER_MODEL_ID || 'ocr-v1';

/**
 * Does our tally appear on INEC's sheet?
 *
 * The thresholds are inherited from the check this replaces, and they are
 * deliberately timid: OCR reads roughly 60-77% of counts on a CLEAN sheet, so a
 * single missed digit must never read as a contradiction.
 *
 *   zero of >= 3 found  -> mismatch   (nothing of ours is on their sheet)
 *   half or more found  -> match
 *   anything else       -> unreadable (a fact about the photo, not a finding)
 */
export function judgeTally(ocr) {
  if (!ocr || !ocr.total) return { verdict: null, reason: 'ocr_failed' };
  if (ocr.total >= 3 && ocr.matched === 0) {
    return { verdict: 'mismatch', reason: `none of ${ocr.total} counts found`, evidence: ocr };
  }
  if (ocr.matched >= Math.ceil(ocr.total / 2)) {
    return { verdict: 'match', reason: `${ocr.matched}/${ocr.total} found`, evidence: ocr };
  }
  return { verdict: 'unreadable', reason: `${ocr.matched}/${ocr.total} found — too few to say`, evidence: ocr };
}

/**
 * Is the sheet internally consistent?
 *
 * Three contradictions that need far less reading accuracy than a transcription
 * does, because each is checkable against one image and needs no outside truth:
 * party votes not summing to the recorded total, accredited below votes cast,
 * votes above registered.
 *
 * Requires a STRUCTURED read of their sheet. Until one exists for a pair this
 * abstains rather than inferring soundness from silence — "we could not check"
 * and "we checked and it was fine" are different answers and must not collapse.
 */
export function judgeIntegrity(theirs) {
  if (!theirs || typeof theirs !== 'object') return { verdict: null, reason: 'no_structured_read' };
  const { registered, accredited, votesCast, parties, total } = theirs;
  const sum = Array.isArray(parties) ? parties.reduce((n, p) => n + (Number(p.count) || 0), 0) : null;
  const faults = [];
  if (sum !== null && Number.isFinite(total) && sum !== total) faults.push(`party votes sum to ${sum}, sheet says ${total}`);
  if (Number.isFinite(accredited) && Number.isFinite(votesCast) && votesCast > accredited) faults.push(`votes cast ${votesCast} exceed accredited ${accredited}`);
  if (Number.isFinite(registered) && Number.isFinite(votesCast) && votesCast > registered) faults.push(`votes cast ${votesCast} exceed registered ${registered}`);
  const checked = [sum !== null && Number.isFinite(total),
    Number.isFinite(accredited) && Number.isFinite(votesCast),
    Number.isFinite(registered) && Number.isFinite(votesCast)].filter(Boolean).length;
  if (!checked) return { verdict: null, reason: 'nothing_checkable' };
  return faults.length
    ? { verdict: 'unsound', reason: faults.join('; '), evidence: { faults, checked } }
    : { verdict: 'sound', reason: `${checked} check(s) passed`, evidence: { checked } };
}

/**
 * Is the observer's report credible?
 *
 * ALWAYS ABSTAINS, and that is the honest answer rather than a gap. Credibility
 * is about a person's circumstances — whether they were moved, turned away, or
 * simply wrong — and nothing in an image speaks to it. A model producing a
 * number here would be laundering a guess into a panel slot that a human is
 * supposed to occupy.
 */
export const judgeCredibility = () => ({ verdict: null, reason: 'model_abstains_by_design' });

/**
 * Rate one pair on every question it can answer, and record only real answers.
 * Returns what it did, including what it declined and why — a silent abstention
 * is indistinguishable from a crash.
 */
export async function ratePair(pairId, { fetchImpl = fetch } = {}) {
  const p = db.prepare('SELECT * FROM result_pairs WHERE id = ?').get(pairId);
  if (!p) return { error: 'no_such_pair' };
  const out = { pairId, pu: p.pu_code, submitted: [], abstained: [] };

  let ocr = null;
  if (p.doc_url && p.ours_json) {
    try {
      const res = await fetchImpl(p.doc_url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        ocr = await ocrMatchCounts(buf, JSON.parse(p.ours_json));
      }
    } catch { ocr = null; }
  }

  const jobs = [
    ['tally_match', judgeTally(ocr)],
    ['sheet_integrity', judgeIntegrity(p.theirs_json ? JSON.parse(p.theirs_json) : null)],
    ['report_credibility', judgeCredibility()],
  ];
  for (const [kind, j] of jobs) {
    if (!j.verdict) { out.abstained.push({ kind, reason: j.reason }); continue; }
    const r = submitReview({
      pairId, kind, reviewerType: 'model', reviewerId: MODEL_ID,
      verdict: j.verdict, note: j.reason,
    });
    out.submitted.push({ kind, verdict: j.verdict, ok: r.ok, error: r.error || null, panel: r.panel?.state });
  }
  return out;
}

/** Rate every open pair the model has not already seen. */
export async function rateQueue({ contest = null, limit = 25, fetchImpl = fetch } = {}) {
  const rows = db.prepare(`
    SELECT p.id FROM result_pairs p
     WHERE p.state = 'open' AND p.doc_url IS NOT NULL
       AND (? IS NULL OR p.contest = ?)
       AND NOT EXISTS (SELECT 1 FROM pair_reviews r
                        WHERE r.pair_id = p.id AND r.reviewer_type = 'model' AND r.reviewer_id = ?)
     LIMIT ?`).all(contest, contest, MODEL_ID, limit);
  const done = [];
  for (const r of rows) done.push(await ratePair(r.id, { fetchImpl }));
  return { rated: done.length, results: done };
}

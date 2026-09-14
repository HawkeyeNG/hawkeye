// ADMIN REVIEW: the queue, one pair at a time, and a verdict.
//
// WHO IS REVIEWING, and the limit of it. The console is gated by a SHARED
// passphrase, so it proves somebody is staff and proves nothing about which
// member of staff. A panel needs to tell readers apart or it can never reach two
// readings, so each reviewer names themselves once and that name rides on every
// verdict as x-reviewer-id.
//
// That is DISTINGUISHING, not authenticating, and the difference matters: one
// person who knows the passphrase could answer twice under two names and settle
// a panel alone. Two things make that visible rather than preventable — the
// client IP is recorded beside every verdict, so a panel decided entirely from
// one address can be found afterwards, and /summary reports it. Real
// authentication needs per-reviewer credentials; until then this is honest
// about what it is.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAdmin } from './admin.js';
import { clientIp } from '../services/security.js';
import { submitReview, queueFor, panelsFor, KINDS } from '../services/review.js';
import { pairSummary } from '../services/pairs.js';
import { VOCAB } from '../services/verdicts.js';

export const pairsRouter = Router();
pairsRouter.use(requireAdmin);

const reviewerOf = (req) => String(req.headers['x-reviewer-id'] || '').trim().slice(0, 40);

pairsRouter.get('/meta', (req, res) => {
  res.json({
    kinds: KINDS,
    vocab: VOCAB,
    contests: db.prepare('SELECT DISTINCT contest FROM result_pairs ORDER BY contest').all().map((r) => r.contest),
  });
});

pairsRouter.get('/summary', (req, res) => {
  const irevId = req.query.irev_id || null;
  const base = irevId ? pairSummary(irevId) : {
    total: db.prepare('SELECT COUNT(*) n FROM result_pairs').get().n,
    byPresence: db.prepare('SELECT presence, COUNT(*) n FROM result_pairs GROUP BY presence').all(),
    byState: db.prepare('SELECT state, COUNT(*) n FROM result_pairs GROUP BY state').all(),
  };
  const panels = db.prepare('SELECT kind, state, COUNT(*) n FROM pair_panels GROUP BY kind, state').all();
  /* Panels decided entirely from one address. Not proof of anything — a small
     team may share an office — but it is the shape self-dealing would make, and
     it should be visible without anybody having to go looking. */
  const sameIp = db.prepare(`
    SELECT pair_id, kind, COUNT(DISTINCT reviewer_id) readers, COUNT(DISTINCT ip) ips
      FROM pair_reviews WHERE reviewer_type != 'model'
     GROUP BY pair_id, kind HAVING readers > 1 AND ips = 1`).all();
  res.json({ ...base, panels, singleAddressPanels: sameIp.length });
});

/**
 * The queue for ONE reviewer and one question.
 *
 * queueFor excludes only what THIS reviewer has answered, and returns no other
 * reviewer's verdict on the row — the blindness rule is enforced there and must
 * not be undone by anything added here.
 */
pairsRouter.get('/queue', (req, res) => {
  const reviewer = reviewerOf(req);
  if (!reviewer) return res.status(400).json({ error: 'no_reviewer_id' });
  const kind = String(req.query.kind || KINDS[0]);
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad_kind' });
  res.json({
    kind,
    reviewer,
    items: queueFor({
      kind, reviewerType: 'staff', reviewerId: reviewer,
      contest: req.query.contest || null, limit: Number(req.query.limit) || 20,
    }),
  });
});

/**
 * One pair to look at. DELIBERATELY WITHOUT the reviews.
 *
 * A reviewer who can see the machine's answer, or the first colleague's, is not
 * an independent reading — the blind-review pipeline had exactly this defect and
 * it defeated the whole feature. Panels are returned only for questions this
 * reviewer has ALREADY answered, so they can see where their own verdict landed
 * without being primed on the ones they have not.
 */
pairsRouter.get('/:id', (req, res) => {
  const reviewer = reviewerOf(req);
  const p = db.prepare('SELECT * FROM result_pairs WHERE id = ?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'no_such_pair' });
  const mine = new Set(db.prepare('SELECT kind FROM pair_reviews WHERE pair_id = ? AND reviewer_type = ? AND reviewer_id = ?')
    .all(p.id, 'staff', reviewer).map((r) => r.kind));
  const unit = db.prepare('SELECT name, ward, lga, state FROM polling_units WHERE pu_code = ?').get(p.pu_code);
  res.json({
    id: p.id,
    pu_code: p.pu_code,
    unit: unit || null,
    contest: p.contest,
    presence: p.presence,
    ours: p.ours_json ? JSON.parse(p.ours_json) : null,
    theirs: p.theirs_json ? JSON.parse(p.theirs_json) : null,
    doc_url: p.doc_url,
    doc_sha256: p.doc_sha256,
    doc_seen_at: p.doc_seen_at,
    answered: [...mine],
    panels: panelsFor(p.id).filter((x) => mine.has(x.kind)),
  });
});

pairsRouter.post('/:id/review', (req, res) => {
  const reviewer = reviewerOf(req);
  if (!reviewer) return res.status(400).json({ error: 'no_reviewer_id' });
  const { kind, verdict, note } = req.body || {};
  if (!KINDS.includes(kind)) return res.status(400).json({ error: 'bad_kind' });
  let out;
  try {
    out = submitReview({
      pairId: Number(req.params.id), kind, reviewerType: 'staff',
      reviewerId: reviewer, verdict, note: note || null,
    });
  } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!out.ok) return res.status(409).json(out);
  db.prepare('UPDATE pair_reviews SET ip = ? WHERE pair_id = ? AND kind = ? AND reviewer_type = ? AND reviewer_id = ?')
    .run(clientIp(req), Number(req.params.id), kind, 'staff', reviewer);
  /* The panel state goes back so the UI can say "one more reading needed"
     without revealing what anyone said. */
  res.json({ ok: true, panel: { state: out.panel.state, n: out.panel.n, need: out.panel.need } });
});

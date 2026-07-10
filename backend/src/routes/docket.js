// Public Docket API — crowd arbitration of flagged results.
// Browsing is open to the world; casting a verdict requires a verified observer
// identity (one signed, structured verdict per person per case). Everything —
// flags, openings, every verdict, resolutions — is on the public record.
import path from 'node:path';
import { Router } from 'express';
import { db } from '../db.js';
import { requireObserver } from './observers.js';
import { computeVerdict, verdictTally, docketHead, appendDocket, QUORUM, SUPERMAJORITY, WINDOW_DAYS } from '../services/docket.js';

export const docketRouter = Router();

const RULE = 'verdict computed from answers: sheet=no OR counts=no -> fraudulent; '
  + 'sheet=yes AND counts=yes AND EVERY flag answered no (all reasons rejected) -> legit; '
  + 'otherwise inconclusive. Comments are public but never counted. '
  + `Resolution: >=${QUORUM} verdicts AND >=${Math.round(SUPERMAJORITY * 100)}% supermajority.`;

const caseShape = (c) => ({
  id: c.id,
  puCode: c.pu_code,
  contest: c.contest,
  status: c.status,
  openedAt: c.opened_at,
  closesAt: c.closes_at,
  resolvedAt: c.resolved_at,
  tally: verdictTally(c.id),
});

docketRouter.get('/docket', (_req, res) => {
  const rows = db.prepare(`
    SELECT c.*, p.name, p.ward, p.lga, p.state FROM cases c
    JOIN polling_units p ON p.pu_code = c.pu_code ORDER BY c.opened_at DESC`).all();
  res.json({
    rule: RULE,
    quorum: QUORUM,
    supermajority: SUPERMAJORITY,
    windowDays: WINDOW_DAYS,
    cases: rows.map((c) => ({ ...caseShape(c), name: c.name, ward: c.ward, lga: c.lga, state: c.state })),
  });
});

// The case file: every piece of evidence a juror needs, plus the ledger proof
// pointers — judge the evidence, verify the record, trust nobody.
docketRouter.get('/docket/:id', (req, res) => {
  const c = db.prepare(`
    SELECT c.*, p.name, p.ward, p.lga, p.state, p.registered_voters
    FROM cases c JOIN polling_units p ON p.pu_code = c.pu_code WHERE c.id = ?`).get(req.params.id);
  if (!c) return res.status(404).json({ error: 'no_such_case' });
  const flags = db.prepare('SELECT id, type, severity, detail, status, created_at FROM discrepancies WHERE id IN ('
    + JSON.parse(c.flag_ids).map(() => '?').join(',') + ')').all(...JSON.parse(c.flag_ids))
    .map((f) => ({ ...f, detail: JSON.parse(f.detail || '{}') }));
  const subs = db.prepare(`
    SELECT id, votes_json, image_path, venue_image_path, image_sha256, venue_image_sha256,
           captured_at, location_verified, ocr_matched, ocr_total, vision_json, entry_hash, created_at
    FROM submissions WHERE pu_code = ? AND contest = ? ORDER BY id`).all(c.pu_code, c.contest);
  // Every verdict is public — including the optional comment — so the jury
  // itself stays auditable (anonymous observer ids, never names).
  const verdicts = db.prepare(`
    SELECT observer_id, answers_json, verdict, comment, created_at
    FROM verdicts WHERE case_id = ? ORDER BY id DESC LIMIT 500`).all(c.id)
    .map((v) => ({ observer: v.observer_id, answers: JSON.parse(v.answers_json), verdict: v.verdict, comment: v.comment, at: v.created_at }));
  res.json({
    ...caseShape(c),
    unit: { name: c.name, ward: c.ward, lga: c.lga, state: c.state, registeredVoters: c.registered_voters },
    flags,
    verdicts,
    rule: RULE,
    submissions: subs.map((s) => ({
      id: s.id,
      votes: JSON.parse(s.votes_json),
      sheetUrl: `/uploads/${path.basename(s.image_path)}`,
      venueUrl: `/uploads/${path.basename(s.venue_image_path)}`,
      sheetSha256: s.image_sha256,
      capturedAt: s.captured_at,
      locationVerified: Boolean(s.location_verified),
      ocr: s.ocr_total != null ? { matched: s.ocr_matched, total: s.ocr_total } : null,
      vision: s.vision_json ? JSON.parse(s.vision_json) : null,
      entryHash: s.entry_hash,
    })),
  });
});

// My verdict on this case (so the UI can show "you already judged this").
docketRouter.get('/docket/:id/mine', requireObserver, (req, res) => {
  const v = db.prepare('SELECT answers_json, verdict, created_at FROM verdicts WHERE case_id = ? AND observer_id = ?')
    .get(req.params.id, req.observer.id);
  res.json(v ? { verdict: v.verdict, answers: JSON.parse(v.answers_json), at: v.created_at } : { verdict: null });
});

// Cast a structured verdict. One per verified identity per case, device-tagged,
// appended to the docket chain — the jury itself is auditable.
docketRouter.post('/docket/:id/verdict', requireObserver, (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'no_such_case' });
  if (c.status !== 'open' || c.closes_at <= Date.now()) return res.status(400).json({ error: 'case_closed' });
  const ok = new Set(['yes', 'no', 'unsure']);
  // One answer per flag on the case — each flag can be wrong (or right) in its
  // own way, so they are judged individually, never as a blob.
  const flagIds = JSON.parse(c.flag_ids);
  const flagAnswers = {};
  for (const id of flagIds) {
    const v = String(req.body?.flags?.[id] || '');
    if (!ok.has(v)) return res.status(400).json({ error: 'bad_answers', hint: `answer yes|no|unsure for every flag (missing flag ${id})` });
    flagAnswers[id] = v;
  }
  const answers = {
    sheet: String(req.body?.sheet || ''),
    counts: String(req.body?.counts || ''),
    flags: flagAnswers,
  };
  if (!ok.has(answers.sheet) || !ok.has(answers.counts)) {
    return res.status(400).json({ error: 'bad_answers', hint: 'sheet and counts must be yes|no|unsure' });
  }
  const comment = String(req.body?.comment || '').trim().slice(0, 280) || null;
  const verdict = computeVerdict(answers);
  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64) || null;
  try {
    db.prepare(`
      INSERT INTO verdicts (case_id, observer_id, device_id, answers_json, verdict, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, req.observer.id, deviceId, JSON.stringify(answers), verdict, comment, Date.now());
  } catch {
    return res.status(409).json({ error: 'already_judged' });
  }
  appendDocket('verdict', { caseId: c.id, observer: req.observer.id, answers, verdict, comment });
  res.status(201).json({ ok: true, verdict, tally: verdictTally(c.id) });
});

// The docket's own chain, publicly re-verifiable exactly like the main ledger.
docketRouter.get('/docket-ledger', (_req, res) => {
  const rows = db.prepare('SELECT id, kind, payload, prev_hash, entry_hash, created_at FROM docket_ledger ORDER BY id').all();
  res.json({ head: docketHead(), entries: rows });
});

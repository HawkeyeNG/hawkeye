// Practice / mock-election sandbox. A DELIBERATELY isolated teaching flow for
// new users — it never touches the real submission pipeline, ledger, anchoring,
// leaderboard, docket or dashboard. Everything here writes only to
// practice_submissions, which is disposable and auto-deleted (see db.js /
// practice.json). No auth: an ad-campaign visitor can try the flow instantly.
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, practiceElection, practiceActive } from '../db.js';

export const practiceRouter = Router();

// What the practice page needs to render — the election, its sample unit and
// neutral placeholder parties. Returns { active:false } once the window closes.
practiceRouter.get('/practice', (_req, res) => {
  if (!practiceActive()) return res.json({ active: false });
  const { name, office, note, unit, parties, autoDeleteAt } = practiceElection;
  res.json({ active: true, name, office, note, unit, parties, autoDeleteAt });
});

// Record a practice run. Light validation only; returns a realistic-looking
// (but clearly practice) confirmation so the learner sees the full end screen.
// The "ledger hash" is random and never chained to anything real.
practiceRouter.post('/practice/submit', (req, res) => {
  if (!practiceActive()) return res.status(410).json({ error: 'practice_closed' });
  const votes = Array.isArray(req.body?.votes) ? req.body.votes : [];
  const clean = votes
    .filter((v) => v && typeof v.party === 'string' && Number.isInteger(v.count) && v.count >= 0 && v.count <= 100000)
    .slice(0, 30)
    .map((v) => ({ party: v.party.slice(0, 24), count: v.count }));
  if (!clean.length) return res.status(400).json({ error: 'no_counts' });
  const puName = String(req.body?.puName || practiceElection.unit?.name || 'Practice Polling Unit').slice(0, 80);
  db.prepare('INSERT INTO practice_submissions (pu_name, votes_json, created_at) VALUES (?, ?, ?)')
    .run(puName, JSON.stringify(clean), Date.now());
  // A throwaway hash purely so the confirmation screen looks like the real one.
  const entryHash = 'practice-' + crypto.randomBytes(8).toString('hex');
  res.json({ ok: true, practice: true, status: 'recorded (practice)', entryHash, recordedAt: Date.now() });
});

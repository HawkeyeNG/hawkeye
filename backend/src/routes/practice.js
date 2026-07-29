// Practice / mock-election sandbox. A DELIBERATELY isolated teaching flow for
// new users — it never touches the real submission pipeline, ledger, anchoring,
// leaderboard, docket or dashboard. Everything here writes only to
// practice_submissions, which is disposable and auto-deleted (see db.js /
// practice.json). No auth: an ad-campaign visitor can try the flow instantly.
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, practiceElection, practiceActive } from '../db.js';

// A separate genesis from the real ledger, so the two chains can never be
// confused even if a hash is quoted out of context.
const PRACTICE_GENESIS = 'p'.repeat(64);
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

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
  // A real register unit may be practised against (that is how someone rehearses
  // at their OWN unit, in a state with no live election). Stored as a plain
  // string: practice never joins polling_units, so it can never reach a result.
  const puCode = String(req.body?.puCode || practiceElection.unit?.code || '').slice(0, 32) || null;
  const contest = String(req.body?.contest || 'PRACTICE').slice(0, 16);
  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64) || null;

  // Chain it, exactly as the real ledger does — sha256(prev + payload) — on the
  // practice chain. Same arithmetic, different chain, never anchored.
  const entry = db.transaction(() => {
    const last = db.prepare('SELECT entry_hash FROM practice_submissions WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    const prevHash = last ? last.entry_hash : PRACTICE_GENESIS;
    const payload = JSON.stringify({ practice: true, puCode, contest, votes: clean });
    const entryHash = sha256(prevHash + payload);
    const info = db
      .prepare(`INSERT INTO practice_submissions
        (pu_name, pu_code, contest, votes_json, prev_hash, entry_hash, ledger_payload, device_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(puName, puCode, contest, JSON.stringify(clean), prevHash, entryHash, payload, deviceId, Date.now());
    return { entryHash, id: info.lastInsertRowid };
  })();

  res.json({
    ok: true,
    practice: true,
    status: 'recorded (practice)',
    entryHash: entry.entryHash,
    submissionId: entry.id,
    recordedAt: Date.now(),
  });
});

// The practice chain, readable and verifiable exactly like the real one — so a
// rehearsal can include "recompute the chain yourself", which is the part of
// Hawkeye hardest to explain in words.
practiceRouter.get('/practice/ledger', (_req, res) => {
  const rows = db
    .prepare(`SELECT id, pu_name, pu_code, contest, created_at, prev_hash, entry_hash, ledger_payload
              FROM practice_submissions WHERE entry_hash IS NOT NULL ORDER BY id`)
    .all();
  let prev = PRACTICE_GENESIS;
  let ok = true;
  let brokenAtId = null;
  for (const r of rows) {
    if (r.prev_hash !== prev || sha256(prev + r.ledger_payload) !== r.entry_hash) {
      ok = false;
      brokenAtId = r.id;
      break;
    }
    prev = r.entry_hash;
  }
  res.json({
    practice: true,
    anchored: false, // never — this chain exists precisely so it is not
    genesis: PRACTICE_GENESIS,
    ok,
    brokenAtId,
    entries: rows.length,
    head: prev,
    rows,
  });
});

// This device's own practice runs. No auth by design — practice never asks for a
// sign-in, so the device id it already sends is the only handle there is. A
// missing header returns nothing rather than everyone's runs.
practiceRouter.get('/practice/mine', (req, res) => {
  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64);
  if (!deviceId) return res.json({ runs: [] });
  const runs = db
    .prepare(`SELECT id, pu_name, pu_code, contest, votes_json, entry_hash, created_at
              FROM practice_submissions
              WHERE device_id = ? ORDER BY id DESC LIMIT 50`)
    .all(deviceId)
    .map((r) => ({ ...r, votes: JSON.parse(r.votes_json), votes_json: undefined }));
  res.json({ runs });
});

import { Router } from 'express';
import { db } from '../db.js';
import { runForensics, benfordSummary, collationSummary } from '../services/integrity.js';
import { irevScan, irevSummary } from '../services/irev.js';

export const integrityRouter = Router();

// Headline counts for the dashboard.
integrityRouter.get('/integrity/summary', (_req, res) => {
  const byType = db.prepare('SELECT type, severity, COUNT(*) AS c FROM discrepancies GROUP BY type, severity').all();
  const bySeverity = db.prepare('SELECT severity, COUNT(*) AS c FROM discrepancies GROUP BY severity').all();
  const total = db.prepare('SELECT COUNT(*) AS c FROM discrepancies').get().c;
  const unitsFlagged = db.prepare('SELECT COUNT(DISTINCT pu_code) AS c FROM discrepancies WHERE pu_code IS NOT NULL').get().c;
  const reports = db.prepare('SELECT COUNT(*) AS c FROM submissions').get().c;
  res.json({ total, unitsFlagged, reports, bySeverity, byType });
});

// Filterable discrepancy log (most recent first).
integrityRouter.get('/integrity/discrepancies', (req, res) => {
  const where = [];
  const args = [];
  for (const k of ['type', 'severity', 'state']) {
    if (req.query[k]) { where.push(`d.${k} = ?`); args.push(String(req.query[k])); }
  }
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const sql = `
    SELECT d.id, d.type, d.severity, d.pu_code, d.contest, d.state, d.detail, d.status, d.created_at,
           p.name AS pu_name
    FROM discrepancies d LEFT JOIN polling_units p ON p.pu_code = d.pu_code
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY d.created_at DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit).map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));
  res.json({ discrepancies: rows });
});

integrityRouter.get('/integrity/benford', (_req, res) => res.json(benfordSummary()));

integrityRouter.get('/integrity/irev', (_req, res) => res.json(irevSummary()));

integrityRouter.get('/integrity/collation', (_req, res) => res.json(collationSummary()));

// Public anchor history — the externally published chain heads.
integrityRouter.get('/anchors', (_req, res) => {
  res.json({
    anchors: db.prepare('SELECT day, head_hash, collation_head, entries, collation_entries, tweet, created_at FROM anchors ORDER BY id DESC LIMIT 60').all(),
  });
});

// Manual scan trigger — fire-and-forget (a pass can take minutes).
integrityRouter.post('/integrity/irev-scan', (_req, res) => {
  irevScan().catch((e) => console.error('[irev]', e.message));
  res.json({ started: true });
});

// Manual re-scan trigger (also runs on an interval in server.js).
integrityRouter.post('/integrity/scan', (_req, res) => {
  try { runForensics(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

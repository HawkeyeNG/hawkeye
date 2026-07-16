// Owner-only review/publish console API (review.html). Guarded by a shared
// passphrase (ADMIN_CONSOLE_SECRET) sent as the x-admin-secret header. Not linked
// anywhere in the app. Handles the incident moderation queue: view pending reports
// (with media), publish (→ public feed + best-effort social) or reject them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, contests } from '../db.js';
import { config } from '../config.js';
import { notifyMaster, notifyUnitSavers } from '../services/notify.js';
import { runAnchor } from '../services/anchor.js';
import { raceKey, contestScope } from '../services/scope.js';

export const adminRouter = Router();

// Constant-time secret check; disabled entirely if no secret is configured.
// Exported for other routers with owner-only actions (e.g. label QA in training).
export function requireAdmin(req, res, next) {
  const secret = config.adminConsoleSecret;
  const given = String(req.headers['x-admin-secret'] || '');
  if (!secret) return res.status(403).json({ error: 'console_disabled' });
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    notifyMaster(`🔐 FAILED admin console login from ${req.ip}`);
    return res.status(401).json({ error: 'bad_passphrase' });
  }
  next();
}

// Lightweight auth probe for the login screen.
adminRouter.post('/admin/auth', requireAdmin, (_req, res) => res.json({ ok: true }));

// One-off/idempotent repair: rebuild sheet_authenticity discrepancy summaries
// from the fullest available reason (vision_json > detail.reason), so old rows
// truncated mid-word (e.g. "…a photograph of a c") read cleanly.
adminRouter.post('/admin/integrity/repair-summaries', requireAdmin, (_req, res) => {
  const clip = (s, n) => { s = String(s || '').trim(); return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '').replace(/[.,;:]$/, '') + '…'; };
  const rows = db.prepare("SELECT id, submission_id, detail FROM discrepancies WHERE type = 'sheet_authenticity'").all();
  let fixed = 0;
  for (const r of rows) {
    let det; try { det = JSON.parse(r.detail); } catch { continue; }
    let reason = det.reason || '';
    if (r.submission_id) {
      try { const vj = db.prepare('SELECT vision_json FROM submissions WHERE id = ?').get(r.submission_id);
        if (vj && vj.vision_json) { const v = JSON.parse(vj.vision_json); if (v.reason) reason = v.reason; } } catch { /* keep detail.reason */ }
    }
    reason = clip(reason, 400);
    const bad = det.authentic === 'no';
    det.reason = reason;
    det.summary = bad
      ? `AI vision flags this image as likely not a genuine EC8A — ${reason}`
      : `AI vision could not confirm this image is a genuine EC8A result sheet — ${reason}`;
    db.prepare('UPDATE discrepancies SET detail = ? WHERE id = ?').run(JSON.stringify(det), r.id);
    fixed++;
  }
  res.json({ ok: true, fixed });
});

// Manually record a ledger anchor now (admin-only).
adminRouter.post('/admin/anchor', requireAdmin, async (req, res) => {
  try { res.json(await runAnchor(req.query.force === '1')); }
  catch (e) { console.error('[admin/anchor]', e); res.status(500).json({ error: 'internal_error' }); }
});

// Open the public docket: every result still carrying an open high-severity flag
// becomes a crowd-arbitration case (run after the election window closes).
adminRouter.post('/admin/docket/open', requireAdmin, async (req, res) => {
  try {
    const d = await import('../services/docket.js');
    res.json(d.openCases(Number(req.query.windowDays) || undefined));
  } catch (e) { console.error('[admin/docket]', e); res.status(500).json({ error: 'internal_error' }); }
});

// Force the resolution pass now (normally runs on its interval).
adminRouter.post('/admin/docket/resolve', requireAdmin, async (_req, res) => {
  try {
    const d = await import('../services/docket.js');
    res.json(d.resolveDueCases());
  } catch (e) { console.error('[admin/docket]', e); res.status(500).json({ error: 'internal_error' }); }
});

adminRouter.get('/admin/incidents', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'pending');
  const rows = db.prepare(`
    SELECT i.id, i.observer_id, i.kind, i.description, i.media_json, i.lat, i.lng,
           i.pu_code, i.state, i.status, i.created_at, i.ai_json
    FROM incidents i WHERE i.status = ? ORDER BY i.created_at DESC LIMIT 200`).all(status)
    .map((r) => ({
      ...r, media: JSON.parse(r.media_json), media_json: undefined,
      ai: r.ai_json ? JSON.parse(r.ai_json) : null, ai_json: undefined,
    }));
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS c FROM incidents GROUP BY status').all().map((r) => [r.status, r.c]),
  );
  res.json({ incidents: rows, counts });
});

adminRouter.post('/admin/incidents/:id/publish', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
  if (!inc) return res.status(404).json({ error: 'not_found' });
  db.prepare("UPDATE incidents SET status = 'published' WHERE id = ?").run(id);
  notifyMaster(`📣 incident #${id} published to the public feed`);
  // In-app feed + push: the reporter ("your report is live") and saved-unit
  // watchers; Telegram fan-out kept for savers who linked it.
  import('../services/notifications.js').then((n) => {
    if (inc.observer_id) n.pushNote(inc.observer_id, {
      kind: 'incident', title: 'Your incident report is live',
      body: `${inc.kind}${inc.pu_code ? ' · ' + inc.pu_code : ''} — approved and published.`,
      url: 'https://hawkeye.com.ng/incidents.html',
    });
    if (inc.pu_code) n.noteUnitSavers(inc.pu_code, {
      kind: 'incident', title: 'Incident published at your unit',
      body: `${inc.pu_code} · ${inc.kind}`,
      url: 'https://hawkeye.com.ng/incidents.html',
    });
  }).catch(() => {});
  try {
    if (inc.pu_code) {
      notifyUnitSavers(inc.pu_code,
        `🚨 Incident report published for your polling unit ${inc.pu_code} (${inc.kind}).\nSee it: https://hawkeye.com.ng/incidents.html`);
    }
  } catch { /* best-effort */ }
  res.json({ ok: true, status: 'published' });
});

adminRouter.post('/admin/incidents/:id/reject', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare("UPDATE incidents SET status = 'rejected' WHERE id = ? AND status != 'published'").run(id);
  if (!info.changes) return res.status(404).json({ error: 'not_found_or_published' });
  res.json({ ok: true, status: 'rejected' });
});

// Bulk-attach PU coordinates from a CSV already uploaded to storage/raw
// (same logic + Nigeria-bbox gate as scripts/attach_coordinates.js — this is
// the no-SSH path for loading the INEC locator crawl on the server).
// Body: { file: "inec_pu_coords.csv", source: "inec_locator" }
adminRouter.post('/admin/coords/load', requireAdmin, async (req, res) => {
  const name = String(req.body?.file || '');
  if (!/^[\w.-]+\.csv$/.test(name)) return res.status(400).json({ error: 'bad_filename' });
  const file = path.join(path.dirname(config.registerCsvPath), name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'file_not_found' });
  const source = String(req.body?.source || 'unspecified').slice(0, 40);
  const { parse } = await import('csv-parse/sync');
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, trim: true });
  const inNigeria = (lat, lng) => lat >= 4 && lat <= 14 && lng >= 2.5 && lng <= 15;
  const update = db.prepare('UPDATE polling_units SET lat = ?, lng = ?, coords_source = ? WHERE pu_code = ?');
  let attached = 0; let unmatched = 0; let invalid = 0;
  db.transaction(() => {
    for (const r of rows) {
      const lat = Number(r.lat); const lng = Number(r.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inNigeria(lat, lng)) { invalid++; continue; }
      const out = update.run(lat, lng, r.source || source, (r.pu_code || '').trim());
      if (out.changes === 0) unmatched++; else attached++;
    }
  })();
  const geocoded = db.prepare('SELECT COUNT(*) AS c FROM polling_units WHERE lat IS NOT NULL').get().c;
  const total = db.prepare('SELECT COUNT(*) AS c FROM polling_units').get().c;
  notifyMaster(`📍 coords loaded: ${attached} attached (${unmatched} unmatched, ${invalid} invalid) — ${geocoded}/${total} geocoded`);
  res.json({ ok: true, attached, unmatched, invalid, geocoded, total });
});

// Clear a unit's CROWD-derived location (tier-2 fix written by aggregate.js from
// clustered observer GPS). Use when a fix is wrong — e.g. a test report mapped a
// unit to the wrong place. Deliberately narrow:
//   - never touches lat/lng (official/verified coords)
//   - refuses units whose crowd fix is bulk 'geocoded' data (GRID3 envelopes)
//   - also drops any pu_mappings fixes for the unit, so it can't re-promote
// The unit falls back to 'unmapped' (or its approx envelope) until re-mapped.
adminRouter.post('/admin/coords/clear-crowd', requireAdmin, (req, res) => {
  const puCode = String(req.body?.puCode || '').trim();
  const pu = db.prepare('SELECT pu_code, name, crowd_lat, crowd_lng, crowd_reports, coords_source FROM polling_units WHERE pu_code = ?').get(puCode);
  if (!pu) return res.status(404).json({ error: 'unknown_polling_unit' });
  if (pu.coords_source === 'geocoded') {
    return res.status(409).json({ error: 'geocoded_not_crowd', hint: 'This unit’s crowd coords are bulk geocoded data, not an observer fix.' });
  }
  if (pu.crowd_lat == null && pu.coords_source !== 'crowd_mapped') {
    return res.json({ ok: true, alreadyClear: true, unit: pu.name });
  }
  const before = { crowd_lat: pu.crowd_lat, crowd_lng: pu.crowd_lng, crowd_reports: pu.crowd_reports, coords_source: pu.coords_source };
  let droppedFixes = 0;
  db.transaction(() => {
    droppedFixes = db.prepare('DELETE FROM pu_mappings WHERE pu_code = ?').run(puCode).changes;
    db.prepare(`UPDATE polling_units
       SET crowd_lat = NULL, crowd_lng = NULL, crowd_reports = 0, -- NOT NULL DEFAULT 0
           lat = CASE WHEN coords_source = 'crowd_mapped' THEN NULL ELSE lat END,
           lng = CASE WHEN coords_source = 'crowd_mapped' THEN NULL ELSE lng END,
           coords_source = CASE WHEN coords_source = 'crowd_mapped' THEN NULL ELSE coords_source END
       WHERE pu_code = ?`).run(puCode);
  })();
  notifyMaster(`📍 crowd fix CLEARED for ${pu.name} (${puCode}) — was ${before.crowd_lat},${before.crowd_lng} (${before.crowd_reports} report(s)); ${droppedFixes} mapping fix(es) dropped`);
  res.json({ ok: true, unit: pu.name, puCode, before, droppedFixes });
});

// Archive a finished election cycle to a browsable folder tree:
//   storage/elections/<election>/<race-type>/<race>/results.json
// One folder per election (e.g. 2027-general-elections), a subfolder per race
// type (presidential, senate, ...), a folder per specific race (raceKey-derived),
// each holding the race's consensus results, every underlying signed submission
// (with its ledger hashes), and the latest anchor for provenance. Idempotent —
// re-running overwrites with current data.
adminRouter.post('/admin/archive-election', requireAdmin, (req, res) => {
  const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const election = String(req.body?.election || contests[0]?.election || 'election');
  const root = path.join(path.dirname(config.dbPath), 'elections', slug(election));
  const typeName = Object.fromEntries(contests.map((c) => [c.code, c.name]));
  const dateOf = Object.fromEntries(contests.map((c) => [c.code, c.date || null]));
  const byRace = new Map();
  const bucket = (pu, contest) => {
    const key = raceKey(pu, contest);
    if (!key) return null;
    let b = byRace.get(key);
    if (!b) { b = { contest, scope: contestScope(pu, contest), results: [], submissions: [] }; byRace.set(key, b); }
    return b;
  };
  const P = 'p.state, p.senatorial, p.federal_constituency, p.lga';
  for (const r of db.prepare(`SELECT r.*, ${P} FROM results r JOIN polling_units p ON p.pu_code = r.pu_code`).all()) {
    const b = bucket(r, r.contest);
    if (b) b.results.push({ pu_code: r.pu_code, votes: JSON.parse(r.votes_json), confidence: r.confidence, status: r.status, location_status: r.location_status });
  }
  for (const s of db.prepare(`SELECT s.*, ${P} FROM submissions s JOIN polling_units p ON p.pu_code = s.pu_code`).all()) {
    const b = bucket(s, s.contest);
    if (b) b.submissions.push({ id: s.id, pu_code: s.pu_code, observer_id: s.observer_id, votes: JSON.parse(s.votes_json), image_sha256: s.image_sha256, venue_image_sha256: s.venue_image_sha256, prev_hash: s.prev_hash, entry_hash: s.entry_hash, created_at: s.created_at });
  }
  const a = db.prepare('SELECT * FROM anchors ORDER BY id DESC LIMIT 1').get() || {};
  const anchor = { head: a.head_hash || null, racesRoot: a.races_root ?? null, rekorLogIndex: a.rekor_log_index ?? null, rekorUuid: a.rekor_uuid ?? null };
  let files = 0;
  for (const [key, b] of byRace) {
    const race = key === 'PRES' ? 'national' : slug(key.split('|').slice(1).join(' '));
    const dir = path.join(root, slug(typeName[b.contest] || b.contest), race);
    fs.mkdirSync(dir, { recursive: true });
    const totals = {};
    for (const r of b.results) for (const v of r.votes) totals[v.party] = (totals[v.party] || 0) + v.count;
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({
      election, contest: b.contest, contestName: typeName[b.contest] || b.contest,
      electionDate: dateOf[b.contest], raceKey: key, scope: b.scope, totals,
      unitsReporting: b.results.length, results: b.results, submissions: b.submissions,
      anchor, archivedAt: new Date().toISOString(),
    }, null, 1));
    files++;
  }
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(
    { election, races: files, generatedAt: new Date().toISOString(), anchor }, null, 1));
  notifyMaster(`🗃️ election archived: ${election} — ${files} race folder(s)`);
  res.json({ ok: true, election, races: files });
});

// Pull an already-published incident back off the public feed (test posts,
// moderation reversals). Kept separate from reject so it's an explicit act.
adminRouter.post('/admin/incidents/:id/unpublish', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare("UPDATE incidents SET status = 'rejected' WHERE id = ? AND status = 'published'").run(id);
  if (!info.changes) return res.status(404).json({ error: 'not_found_or_not_published' });
  notifyMaster(`🗑 incident #${id} unpublished from the public feed`);
  res.json({ ok: true, status: 'rejected' });
});

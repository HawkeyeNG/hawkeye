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
function requireAdmin(req, res, next) {
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

// Manually record a ledger anchor now (admin-only).
adminRouter.post('/admin/anchor', requireAdmin, async (req, res) => {
  try { res.json(await runAnchor(req.query.force === '1')); }
  catch (e) { console.error('[admin/anchor]', e); res.status(500).json({ error: 'internal_error' }); }
});

adminRouter.get('/admin/incidents', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'pending');
  const rows = db.prepare(`
    SELECT i.id, i.observer_id, i.kind, i.description, i.media_json, i.lat, i.lng,
           i.pu_code, i.state, i.status, i.created_at
    FROM incidents i WHERE i.status = ? ORDER BY i.created_at DESC LIMIT 200`).all(status)
    .map((r) => ({ ...r, media: JSON.parse(r.media_json), media_json: undefined }));
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
  // Alert everyone who saved this unit as theirs.
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

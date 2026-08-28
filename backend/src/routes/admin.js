// Owner-only review/publish console API (review.html). Guarded by a shared
// passphrase (ADMIN_CONSOLE_SECRET) sent as the x-admin-secret header. Not linked
// anywhere in the app. Handles the incident moderation queue: view pending reports
// (with media), publish (→ public feed + best-effort social) or reject them.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Router } from 'express';
import { db, contests } from '../db.js';
import { config } from '../config.js';
import { notifyMaster, notifyUnitSavers } from '../services/notify.js';
import { mediaHealth } from './incidents.js';
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

// ---- User content-flag queue (POST /api/flags feeds it). Resolving a flag
// records the decision; actual content action stays explicit: unpublish for
// incidents (back to 'pending', off the public feed), or observer suspension
// via /admin/observers/:id/suspend below. Nothing is ever hard-deleted — the
// ledger/audit model forbids it, and flags themselves are part of the record.
adminRouter.get('/admin/flags', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'open');
  const rows = db.prepare(`
    SELECT f.*, CASE f.kind WHEN 'incident' THEN i.description ELSE s.votes_json END AS target_preview,
           i.status AS incident_status
    FROM content_flags f
    LEFT JOIN incidents i ON f.kind = 'incident' AND i.id = f.target_id
    LEFT JOIN submissions s ON f.kind = 'result' AND s.id = f.target_id
    WHERE f.status = ? ORDER BY f.id DESC LIMIT 200`).all(status);
  res.json({ flags: rows });
});

adminRouter.post('/admin/flags/:id/resolve', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.body?.action || 'dismiss'); // dismiss | resolve
  const status = action === 'resolve' ? 'resolved' : 'dismissed';
  const info = db.prepare("UPDATE content_flags SET status = ? WHERE id = ? AND status = 'open'").run(status, id);
  if (!info.changes) return res.status(404).json({ error: 'not_found_or_closed' });
  res.json({ ok: true, status });
});

// Take a published incident back off the public feed (flag upheld). Returns it
// to 'pending' rather than 'rejected' so the owner can re-review or re-publish.
adminRouter.post('/admin/incidents/:id/unpublish', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare("UPDATE incidents SET status = 'pending' WHERE id = ? AND status = 'published'").run(id);
  if (!info.changes) return res.status(404).json({ error: 'not_published' });
  notifyMaster(`📤 incident #${id} UNPUBLISHED (content flag upheld)`);
  res.json({ ok: true, status: 'pending' });
});

// Suspend/reinstate an observer. requireObserver already refuses any
// status != 'active', so suspension blocks every authenticated action
// (submissions, incidents, docket votes) with no further changes.
adminRouter.post('/admin/observers/:id/status', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '');
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  const info = db.prepare('UPDATE observers SET status = ? WHERE id = ?').run(status, id);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  notifyMaster(`⛔ observer #${id} status → ${status}`);
  res.json({ ok: true, status });
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
/**
 * Merge duplicate spellings of one seat in polling_units.
 *
 * The register carried 116 senatorial values for 109 districts and 393 federal
 * for 360 — harmless while a single-state governorship was the only live
 * contest, and visible the moment SEN/REP opened: the leaderboard drew a region
 * per spelling.
 *
 * APPLIES A REVIEWED LIST, IT DOES NOT INFER. src/data/register_name_fixes.json
 * is produced offline by scripts/normalize_register_names.js, which picks the
 * canonical spelling by AUTHORITY (the NASS roster and INEC's published list)
 * rather than by polling-unit count — counting picks 'Deltal North' (1,011
 * units) over 'Delta North' (752) and writes the typo in as correct. Nothing
 * fuzzy runs against live data.
 *
 * Idempotent: a second call matches no rows and reports zero changes.
 */
adminRouter.post('/admin/register/normalize', requireAdmin, (req, res) => {
  const file = path.join(config.dataDir, 'register_name_fixes.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no_fixes_file' });
  const { fixes } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const COLS = new Set(['senatorial', 'federal_constituency']);
  const distinct = (c) => db.prepare(
    `SELECT COUNT(DISTINCT ${c}) AS n FROM polling_units WHERE ${c} IS NOT NULL AND ${c} <> ''`).get().n;
  const before = { senatorial: distinct('senatorial'), federal: distinct('federal_constituency') };
  const dryRun = req.body?.apply !== true;
  let changed = 0;
  const applied = [];
  const run = db.transaction(() => {
    for (const f of fixes) {
      // Column name is interpolated, so it must come from the allow-list — never
      // from the file, which would be an injection point on a privileged route.
      if (!COLS.has(f.col)) continue;
      const n = dryRun
        ? db.prepare(`SELECT COUNT(*) AS n FROM polling_units WHERE ${f.col} = ?`).get(f.from).n
        : db.prepare(`UPDATE polling_units SET ${f.col} = ? WHERE ${f.col} = ?`).run(f.to, f.from).changes;
      if (n) applied.push({ ...f, units: n });
      changed += n;
    }
  });
  run();
  const after = dryRun ? before : { senatorial: distinct('senatorial'), federal: distinct('federal_constituency') };
  if (!dryRun) notifyMaster(`🧹 register normalised: ${changed} units across ${applied.length} spellings`);
  res.json({ ok: true, dryRun, changed, applied, before, after, real: { senatorial: 109, federal: 360 } });
});

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

/**
 * Close every race that has been declared, without waiting for a restart.
 *
 * The declarations themselves live in backend/src/data/declarations.json,
 * written by hand from the returning officer's announcement. This endpoint just
 * runs the pass — on the night, that means editing the file and calling this,
 * instead of editing the file and restarting the server mid-count.
 *
 * DRY RUN IS THE DEFAULT, the same rule the push broadcast follows and for the
 * same reason: this deletes subscriptions and pushes to phones, and a push
 * cannot be unsent. A dry run returns the exact notification each entry would
 * produce — title, body, url — and how many followers it would reach, changing
 * nothing. Read it, then repeat with { dryRun: false }.
 *
 * Idempotent either way: an entry already recorded in race_closures is reported
 * as skipped rather than applied a second time.
 */
adminRouter.post('/admin/close-races', requireAdmin, async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  try {
    const { closeFinishedRaces } = await import('../services/declarations.js');
    const r = await closeFinishedRaces({ dryRun });
    if (!dryRun) {
      const done = r.applied.filter((a) => a.applied);
      if (done.length) {
        notifyMaster(`🏁 races closed: ${done.map((a) => `${a.key} (${a.dropped} follow(s), `
          + `${a.announce ? a.followers : 0} alert(s))`).join(' · ')}`);
      }
    }
    res.json({ ok: true, dryRun, ...r });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
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

// OTP-delivery diagnostics: which provider/keys the RUNNING process sees and
// whether the SMS token is accepted (live balance probe — no SMS is sent).
adminRouter.get('/admin/otp-diag', requireAdmin, async (_req, res) => {
  const out = { provider: config.smsProvider, smsPrimary: config.smsPrimary, bulksmsSender: config.bulksmsNgSenderId, bulksmsTokenSet: Boolean(config.bulksmsNgApiToken), sendchampKeySet: Boolean(config.sendchampApiKey), termiiKeySet: Boolean(config.termiiApiKey) };
  if (config.bulksmsNgApiToken) {
    try {
      const r = await fetch('https://www.bulksmsnigeria.com/api/v2/balance', {
        headers: { authorization: `Bearer ${config.bulksmsNgApiToken}` },
      });
      const b = await r.json().catch(() => ({}));
      out.bulksmsTokenValid = r.ok && Boolean(b.balance || b?.data?.status === 'success');
      out.bulksmsBalance = b?.balance?.total_balance ?? b?.data?.message ?? b?.message ?? null;
    } catch (e) { out.bulksmsTokenValid = false; out.bulksmsBalance = String(e.message || e); }
  }
  // No harmless Sendchamp validity probe exists: their wallet endpoint rejects
  // the public access key that verification/create happily accepts, and create
  // says "Invalid Access Key" for malformed bodies even with a valid key. Key
  // validity is only provable by a real verification send (confirmed working
  // 2026-07-23).
  res.json(out);
});

// Unlink a phone from its Telegram chat so OTP delivery for it falls back to
// SMS — used to test the SMS path with an already-linked number. The observer
// account itself is untouched; opening the bot again relinks in one tap.
adminRouter.post('/admin/unlink-telegram', requireAdmin, async (req, res) => {
  const { normalizePhone, phoneHash } = await import('./observers.js');
  const phone = normalizePhone(String(req.body?.phone || ''));
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });
  const info = db.prepare('DELETE FROM telegram_links WHERE phone_hash = ?').run(phoneHash(phone));
  notifyMaster(`🔗 Telegram unlinked for ${phone.slice(0, 7)}… (${info.changes} link(s) removed)`);
  res.json({ ok: true, removed: info.changes });
});

// Forget a phone entirely (test accounts): deletes the observer row, Telegram
// link, pending OTPs and deep-link tokens so the number can run a genuinely
// fresh sign-up. Refuses if the observer has ANY reports — this is a
// test-hygiene tool, not an account-deletion path (profile.html has that).
adminRouter.post('/admin/forget-phone', requireAdmin, async (req, res) => {
  const { normalizePhone, phoneHash } = await import('./observers.js');
  const phone = normalizePhone(String(req.body?.phone || ''));
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });
  const hash = phoneHash(phone);
  const obs = db.prepare('SELECT id FROM observers WHERE phone_hash = ?').get(hash);
  if (obs) {
    const refs = ['submissions', 'collation_reports', 'incidents']
      .map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE observer_id = ?`).get(obs.id).c)
      .reduce((a, b) => a + b, 0);
    if (refs > 0) return res.status(409).json({ error: 'observer_has_reports', reports: refs });
  }
  const out = {};
  db.transaction(() => {
    out.telegramLinks = db.prepare('DELETE FROM telegram_links WHERE phone_hash = ?').run(hash).changes;
    out.otps = db.prepare('DELETE FROM otps WHERE phone_hash = ?').run(hash).changes;
    out.linkTokens = db.prepare('DELETE FROM tg_link_tokens WHERE phone_hash = ?').run(hash).changes;
    out.observer = obs ? db.prepare('DELETE FROM observers WHERE id = ?').run(obs.id).changes : 0;
  })();
  notifyMaster(`🧽 phone forgotten (test hygiene): ${phone.slice(0, 7)}… ${JSON.stringify(out)}`);
  res.json({ ok: true, ...out });
});

// One-time pre-election reset: wipe the finished (mock) election cycle so every
// chain — submissions ledger, collation ledger, docket ledger, anchors — starts
// again at genesis for the new election. Archive first (/admin/archive-election);
// this endpoint does NOT archive. Keeps observers, devices, polling units,
// mapping fixes, Telegram links, subscriptions and saved units. Deletes the
// evidence photos belonging to the wiped rows. Requires an explicit confirm
// phrase so a stray call can't destroy live-election data.
adminRouter.post('/admin/reset-election', requireAdmin, (req, res) => {
  if (String(req.body?.confirm || '') !== 'RESET LEDGER') {
    return res.status(400).json({ error: 'confirm_required', hint: "body.confirm must be 'RESET LEDGER'" });
  }
  const tables = ['venue_matches', 'discrepancies', 'verdicts', 'cases', 'docket_ledger',
    'results', 'submissions', 'collation_reports', 'anchor_races', 'anchors',
    'incidents', 'notifications'];
  const counts = {};
  db.transaction(() => {
    for (const t of tables) counts[t] = db.prepare(`DELETE FROM ${t}`).run().changes;
  })();
  // Evidence photos: flat <sha>.jpg for submissions/collations + incidents/ media.
  let filesRemoved = 0;
  try {
    for (const f of fs.readdirSync(config.uploadDir)) {
      if (f.endsWith('.jpg')) { fs.rmSync(path.join(config.uploadDir, f), { force: true }); filesRemoved++; }
    }
    const incDir = path.join(config.uploadDir, 'incidents');
    if (fs.existsSync(incDir)) {
      filesRemoved += fs.readdirSync(incDir).length;
      fs.rmSync(incDir, { recursive: true, force: true });
    }
    fs.mkdirSync(incDir, { recursive: true });
  } catch (err) { console.error('[admin:reset]', err.message); }
  notifyMaster(`🧹 election reset — all chains back to genesis. Rows: ${JSON.stringify(counts)}; ${filesRemoved} photo(s) removed`);
  res.json({ ok: true, counts, filesRemoved });
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

// ---- social media upload (post.html) ---------------------------------------
// The poster could only accept a URL that was ALREADY hosted on hawkeye.com.ng,
// so every post meant deploying the file by hand first. This takes the file
// straight off the device and returns the public URL the poster needs.
//
// Files land in uploads/social/, deliberately NOT in the evidence tree: these
// are marketing assets and must stay out of the content-addressed audit
// artifacts that the docket and the anchor chain cover.
const socialDir = path.join(config.uploadDir, 'social');
fs.mkdirSync(socialDir, { recursive: true });

const SOCIAL_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

// The claimed mimetype is client-controlled, so the extension we publish is
// decided by the actual bytes — same rule the incident uploader already uses.
function sniffSocial(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(4, 8).toString() === 'ftyp') {
    return buf.slice(8, 12).toString().startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

const socialUpload = multer({
  storage: multer.memoryStorage(),
  // TikTok and Reels both take a full-length cut; 300 MB covers anything we make.
  limits: { fileSize: 300 * 1024 * 1024, files: 1 },
}).single('file');

adminRouter.post('/admin/social/upload', requireAdmin, (req, res) => {
  socialUpload(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? 'too_large' : 'upload_failed',
        detail: String(err.message || err),
      });
    }
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'no_file' });
    const real = sniffSocial(f.buffer);
    if (!real || !SOCIAL_EXT[real]) {
      return res.status(415).json({ error: 'unsupported_type', hint: 'jpg, png, webp, mp4, mov or webm' });
    }
    // Content-addressed, so re-uploading the same cut reuses one URL instead of
    // littering the folder with near-duplicates in the run-up to a launch.
    const sha = crypto.createHash('sha256').update(f.buffer).digest('hex');
    const name = `${sha}.${SOCIAL_EXT[real]}`;
    const dest = path.join(socialDir, name);
    const reused = fs.existsSync(dest);
    if (!reused) fs.writeFileSync(dest, f.buffer);
    res.json({
      ok: true,
      url: `${config.publicBaseUrl}/uploads/social/${name}`,
      mediaType: real.startsWith('video/') ? 'video' : 'image',
      bytes: f.buffer.length,
      reused,
    });
  });
});

// ---- owner stats snapshot -------------------------------------------------
// Read-only counts, for answering "how many observers do we have" without
// pulling a copy of production down. That matters here specifically: the
// database runs in WAL mode and the write-ahead log is comparable in size to
// the database itself, so a downloaded .db WITHOUT its -wal is a stale
// snapshot that silently under-reports. Asking the running process is the only
// way to see committed state.
//
// observers.created_at is MILLISECONDS (Date.now(), see routes/observers.js) —
// NOT seconds. Comparing it against a seconds-based cutoff made every single
// observer look like it registered in the last 24 hours, because any ms
// timestamp (~1.78e12) dwarfs any seconds cutoff (~1.78e9). The window is a
// thousand times too wide and every row falls inside it, so the bug reads as
// plausible data rather than an error. Other tables are not assumed to match;
// only columns verified as ms are compared this way.
const MS_DAY = 86400000;
/**
 * WHERE DOES THIS PROCESS ACTUALLY RESOLVE MODULES FROM?
 *
 * Two `npm install` runs from the DirectAdmin panel left the app reporting
 * "@ffmpeg-installer/ffmpeg (not installed)" on a freshly booted process. That
 * has only a few possible causes and none of them can be told apart from
 * outside: the panel's app root may not be the directory we upload to; the
 * CloudLinux Node Selector may install into a virtualenv that this process is
 * not using; or the install may be failing outright.
 *
 * There is no shell on that host, so the running app IS the probe. It reports
 * its own cwd, the node_modules directories Node would search, which of those
 * exist, and whether a few known-good dependencies resolve — if `express`
 * resolves and `@ffmpeg-installer/ffmpeg` does not, the install went to the
 * right place and simply did not include it; if NOTHING resolves from the
 * expected path, the app root is elsewhere.
 */
function runtimeProbe() {
  const req = createRequire(import.meta.url);
  const resolves = (m) => {
    try { return req.resolve(m).replace(/\/node_modules\/.*$/, '/node_modules'); }
    catch { return null; }
  };
  const dirs = (req.resolve.paths('express') || []).slice(0, 6).map((p) => {
    let kind = 'missing';
    try {
      const st = fs.lstatSync(p);
      kind = st.isSymbolicLink() ? `symlink -> ${fs.readlinkSync(p)}` : `dir (${fs.readdirSync(p).length} entries)`;
    } catch { /* missing */ }
    return `${p} [${kind}]`;
  });
  return {
    node: process.version,
    cwd: process.cwd(),
    searchPaths: dirs,
    // A dependency that has always been installed, as a control: if this is
    // null too, the problem is the app root, not the package.
    expressFrom: resolves('express'),
    sharpFrom: resolves('sharp'),
    ffmpegInstallerFrom: resolves('@ffmpeg-installer/ffmpeg'),
  };
}

adminRouter.get('/admin/stats', requireAdmin, (_req, res) => {
  const n = (sql) => {
    try { return db.prepare(sql).get().c; } catch { return null; }
  };
  const now = Date.now();
  /**
   * IS THE VIDEO TRANSCODE ACTUALLY RUNNING?
   *
   * There was no way to answer this from outside the box, which is how it went
   * unnoticed that it was not: incident videos were being stored exactly as
   * recorded, and the only symptom was a reviewer getting audio and a black
   * frame. `untranscodedVideos` counts what is already on disk that way, so a
   * fix has a work-list rather than a guess.
   */
  const untranscoded = (() => {
    try {
      return db.prepare(
        `SELECT COUNT(*) AS c FROM incidents WHERE media_json LIKE '%"transcoded":false%'`).get().c;
    } catch { return null; }
  })();
  res.json({
    at: new Date(now).toISOString(),
    media: {
      ffmpeg: mediaHealth.ffmpeg,
      // WHERE it was found, or everywhere it was looked for. "missing" with no
      // list is not actionable on a host with no shell to go and check.
      ffmpegPath: mediaHealth.ffmpegPath,
      ffmpegTried: mediaHealth.ffmpegTried,
      npmPackages: mediaHealth.npmPackages,
      runtime: runtimeProbe(),
      // Detection runs ONCE at boot. If this predates an npm install, the
      // install simply has not been picked up yet and the process is stale —
      // a different problem from a failed install, and previously
      // indistinguishable from it.
      bootedAt: mediaHealth.bootedAt,
      transcodeFailuresSinceBoot: mediaHealth.transcodeFailures,
      lastTranscodeFailure: mediaHealth.lastFailure,
      untranscodedVideoReports: untranscoded,
    },
    observers: {
      total: n('SELECT COUNT(*) AS c FROM observers'),
      active: n("SELECT COUNT(*) AS c FROM observers WHERE status = 'active'"),
      suspended: n("SELECT COUNT(*) AS c FROM observers WHERE status != 'active'"),
      newLast24h: n(`SELECT COUNT(*) AS c FROM observers WHERE created_at >= ${now - MS_DAY}`),
      newLast7d: n(`SELECT COUNT(*) AS c FROM observers WHERE created_at >= ${now - 7 * MS_DAY}`),
      newLast30d: n(`SELECT COUNT(*) AS c FROM observers WHERE created_at >= ${now - 30 * MS_DAY}`),
      firstRegisteredAt: n('SELECT MIN(created_at) AS c FROM observers'),
      lastRegisteredAt: n('SELECT MAX(created_at) AS c FROM observers'),
      telegramLinked: n('SELECT COUNT(*) AS c FROM telegram_links'),
      withSavedUnit: n('SELECT COUNT(DISTINCT observer_id) AS c FROM saved_units'),
      pushSubscribed: n('SELECT COUNT(DISTINCT observer_id) AS c FROM device_push_tokens'),
      /**
       * PUSH, BROKEN DOWN — because "pushSubscribed: 3" cannot answer the only
       * question worth asking when push is not arriving: on WHICH platform?
       *
       * `pushIosDead` counts iOS rows holding a raw 64-hex APNs token rather
       * than an FCM one. services/push.js skips those silently and deliberately
       * (deleting would churn the row), so a device can be registered, look
       * subscribed here, and never receive anything. That is exactly the shape
       * that hid a broken iOS registration, so it gets its own number.
       */
      pushIos: n("SELECT COUNT(*) AS c FROM device_push_tokens WHERE platform = 'ios'"),
      pushAndroid: n("SELECT COUNT(*) AS c FROM device_push_tokens WHERE platform = 'android'"),
      pushWeb: n("SELECT COUNT(*) AS c FROM device_push_tokens WHERE platform = 'web'"),
      pushIosDead: n(`SELECT COUNT(*) AS c FROM device_push_tokens
                      WHERE platform = 'ios' AND LENGTH(token) = 64 AND token GLOB '[0-9a-fA-F]*'`),
    },
    activity: {
      submissions: n('SELECT COUNT(*) AS c FROM submissions'),
      collationReports: n('SELECT COUNT(*) AS c FROM collation_reports'),
      incidents: n('SELECT COUNT(*) AS c FROM incidents'),
      practiceRuns: n('SELECT COUNT(*) AS c FROM practice_submissions'),
      unitsCrowdMapped: n("SELECT COUNT(*) AS c FROM polling_units WHERE coords_source = 'crowd_mapped'"),
    },
  });
});

// Per-observer roll with a full activity timeline, oldest first.
//
// EVERY created_at in this file's queries is MILLISECONDS. Verified per table
// rather than assumed — submissions, collation_reports, incidents, pu_mappings,
// saved_units and observers all write Date.now(). Getting this wrong once
// already produced a "6 of 6 registered today" that looked like data.
//
// Result submissions carry a ledger link. The submissions table IS the chain
// (prev_hash/entry_hash per row), so a report is addressable by its entry hash
// and ledger.html deep-links to it. Collation reports are a SEPARATE chain with
// its own head and no public per-entry view, so those carry the hash but no
// deep link — saying so beats inventing a URL that 404s.
const LEDGER_URL = (h) => `${config.publicBaseUrl}/ledger.html#${h}`;

adminRouter.get('/admin/observers', requireAdmin, (req, res) => {
  const full = String(req.query.full || '') === '1';
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const q = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };

  const observers = q('SELECT id, phone_hash, status, reputation, created_at FROM observers ORDER BY id ASC');
  const subs = q(`SELECT id, observer_id, pu_code, contest, created_at, entry_hash
                  FROM submissions ORDER BY created_at ASC`);
  const coll = q(`SELECT id, observer_id, contest, level, state, lga, ward, created_at, entry_hash
                  FROM collation_reports ORDER BY created_at ASC`);
  const inc  = q(`SELECT id, observer_id, kind, pu_code, state, status, created_at
                  FROM incidents ORDER BY created_at ASC`);
  const maps = q('SELECT observer_id, pu_code, created_at FROM pu_mappings ORDER BY created_at ASC');
  const saved = q('SELECT observer_id, pu_code, created_at FROM saved_units');
  const tg = q('SELECT phone_hash FROM telegram_links');
  const push = q('SELECT observer_id, COUNT(*) AS c FROM device_push_tokens GROUP BY observer_id');

  const tgSet = new Set(tg.map((r) => r.phone_hash));
  const pushBy = Object.fromEntries(push.map((r) => [r.observer_id, r.c]));
  const savedBy = Object.fromEntries(saved.map((r) => [r.observer_id, r]));
  const byObs = (rows) => rows.reduce((m, r) => ((m[r.observer_id] ||= []).push(r), m), {});
  const S = byObs(subs); const C = byObs(coll); const I = byObs(inc); const M = byObs(maps);

  res.json({
    at: new Date().toISOString(),
    count: observers.length,
    hashes: full ? 'full' : 'truncated to 12 chars — add ?full=1 for complete hashes',
    note: 'Result reports link into the public ledger by entry hash. Collation reports '
        + 'are on a separate chain with no per-entry public view yet, so they carry the '
        + 'hash only.',
    observers: observers.map((o) => {
      const mine = {
        result: (S[o.id] || []).map((r) => ({
          type: 'result', at: iso(r.created_at), puCode: r.pu_code, contest: r.contest,
          entryHash: r.entry_hash, ledgerUrl: LEDGER_URL(r.entry_hash),
        })),
        collation: (C[o.id] || []).map((r) => ({
          type: 'collation', at: iso(r.created_at), contest: r.contest, level: r.level,
          scope: [r.ward, r.lga, r.state].filter(Boolean).join(', '),
          entryHash: r.entry_hash, ledgerUrl: null,
        })),
        incident: (I[o.id] || []).map((r) => ({
          type: 'incident', at: iso(r.created_at), kind: r.kind,
          puCode: r.pu_code, state: r.state, status: r.status,
        })),
        mapped: (M[o.id] || []).map((r) => ({
          type: 'unit_mapped', at: iso(r.created_at), puCode: r.pu_code,
        })),
      };
      const sv = savedBy[o.id];
      const timeline = [
        { type: 'signup', at: iso(o.created_at) },
        ...mine.result, ...mine.collation, ...mine.incident, ...mine.mapped,
        ...(sv ? [{ type: 'saved_unit', at: iso(sv.created_at), puCode: sv.pu_code }] : []),
      ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

      return {
        id: o.id,
        phoneHash: full ? o.phone_hash : String(o.phone_hash || '').slice(0, 12),
        status: o.status,
        reputation: o.reputation,
        registered: iso(o.created_at),
        telegramLinked: tgSet.has(o.phone_hash),
        pushTokens: pushBy[o.id] || 0,
        savedUnit: sv ? sv.pu_code : null,
        counts: {
          results: mine.result.length,
          collation: mine.collation.length,
          incidents: mine.incident.length,
          unitsMapped: mine.mapped.length,
          total: timeline.length - 1,        // signup is not an activity
        },
        lastActiveAt: timeline.length ? timeline[timeline.length - 1].at : iso(o.created_at),
        timeline,
      };
    }),
  });
});

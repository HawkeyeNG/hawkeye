// Collation-form reports (EC8B ward / EC8C LGA / EC8D state). Same evidence rigor
// as PU submissions — two live photos, GPS capture stamps, freshness window,
// duplicate-image guards, client ECDSA signature — chained on the collation
// reports' OWN tamper-evident hash chain (separate from the PU chain).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { db, contestCodes, partyCodes } from '../db.js';
import { config } from '../config.js';
import { sha256Hex } from '../services/images.js';
import { canonicalCollationPayload, canonicalVotes, verifyObserverSignature } from '../services/signatures.js';
import { checkCollation } from '../services/integrity.js';
import { ocrMatchCounts } from '../services/ocr.js';
import { requireObserver } from './observers.js';
import { notifyChat, notifyMaster, chatIdByHash } from '../services/notify.js';

export const collationRouter = Router();
const LEVELS = new Set(['ward', 'lga', 'state']);
const FORM = { ward: 'EC8B', lga: 'EC8C', state: 'EC8D' };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
});
const photoFields = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'venuePhoto', maxCount: 1 }]);

const isFresh = (ts, now) => Number.isFinite(ts) && ts <= now + 120_000 && now - ts <= config.photoMaxAgeS * 1000;

collationRouter.post('/collations', requireObserver, photoFields, async (req, res) => {
  try {
    const now = Date.now();
    const level = String(req.body.level || '');
    const contest = String(req.body.contest || 'PRES');
    const state = String(req.body.state || '').trim();
    const lga = String(req.body.lga || '').trim() || null;
    const ward = String(req.body.ward || '').trim() || null;
    if (!LEVELS.has(level)) return res.status(400).json({ error: 'invalid_level' });
    if (!contestCodes.has(contest)) return res.status(400).json({ error: 'unknown_contest' });
    if (!state || (level !== 'state' && !lga) || (level === 'ward' && !ward)) {
      return res.status(400).json({ error: 'scope_required' });
    }
    // scope must exist on the register
    const known = db.prepare(`SELECT 1 FROM polling_units WHERE state = ?${lga ? ' AND lga = ?' : ''}${ward ? ' AND ward = ?' : ''} LIMIT 1`)
      .get(...[state, lga, ward].filter(Boolean));
    if (!known) return res.status(404).json({ error: 'unknown_scope' });

    const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64) || null;
    let votes;
    try {
      votes = canonicalVotes(JSON.parse(req.body.votes));
    } catch { return res.status(400).json({ error: 'invalid_votes' }); }
    if (!votes.length || votes.some((v) => !partyCodes.has(v.party) || !Number.isInteger(v.count) || v.count < 0)) {
      return res.status(400).json({ error: 'invalid_votes' });
    }

    const sheet = req.files?.photo?.[0];
    const venue = req.files?.venuePhoto?.[0];
    if (!sheet) return res.status(400).json({ error: 'photo_required' });
    if (!venue) return res.status(400).json({ error: 'venue_photo_required' });
    const capturedAt = Number(req.body.capturedAt);
    const venueCapturedAt = Number(req.body.venueCapturedAt);
    if (!isFresh(capturedAt, now) || !isFresh(venueCapturedAt, now)) {
      return res.status(400).json({ error: 'photo_not_fresh' });
    }
    const lat = Number(req.body.lat); const lng = Number(req.body.lng);
    if (![lat, lng].every(Number.isFinite)) return res.status(400).json({ error: 'gps_required' });

    const imageSha256 = sha256Hex(sheet.buffer);
    const venueImageSha256 = sha256Hex(venue.buffer);
    if (imageSha256 === venueImageSha256) return res.status(409).json({ error: 'duplicate_image' });
    const dupe = db.prepare('SELECT 1 FROM collation_reports WHERE image_sha256 IN (?, ?) OR venue_image_sha256 IN (?, ?)')
      .get(imageSha256, venueImageSha256, imageSha256, venueImageSha256);
    if (dupe) return res.status(409).json({ error: 'duplicate_image' });

    const payload = canonicalCollationPayload({
      level, contest, state, lga, ward, votes, imageSha256, venueImageSha256,
      capturedAt, venueCapturedAt, lat, lng,
    });
    if (!verifyObserverSignature(req.observer.public_key_jwk, payload, String(req.body.signature || ''))) {
      return res.status(400).json({ error: 'bad_signature' });
    }

    const imagePath = path.join(config.uploadDir, `${imageSha256}.jpg`);
    const venuePath = path.join(config.uploadDir, `${venueImageSha256}.jpg`);
    fs.writeFileSync(imagePath, sheet.buffer);
    fs.writeFileSync(venuePath, venue.buffer);

    const formSerial = String(req.body.formSerial || '').trim().slice(0, 40) || null;
    const ledgerPayload = JSON.stringify({ observerId: req.observer.id, payload, signature: req.body.signature });
    let inserted;
    try {
      inserted = db.transaction(() => {
        const last = db.prepare('SELECT entry_hash FROM collation_reports ORDER BY id DESC LIMIT 1').get();
        const prevHash = last ? last.entry_hash : '0'.repeat(64);
        const entryHash = sha256(prevHash + ledgerPayload);
        const info = db.prepare(`
          INSERT INTO collation_reports
            (observer_id, device_id, contest, level, state, lga, ward, votes_json, form_serial,
             image_sha256, image_path, venue_image_sha256, venue_image_path,
             lat, lng, accuracy, captured_at, venue_captured_at,
             client_sig, ledger_payload, prev_hash, entry_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(req.observer.id, deviceId, contest, level, state, lga, ward, JSON.stringify(votes), formSerial,
            imageSha256, imagePath, venueImageSha256, venuePath,
            lat, lng, Number(req.body.accuracy) || null, capturedAt, venueCapturedAt,
            String(req.body.signature), ledgerPayload, prevHash, entryHash, now);
        return { id: info.lastInsertRowid, entryHash };
      })();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'already_submitted' });
      throw e;
    }

    // OCR corroboration (time-boxed like PU reports — never delays the response path).
    let ocr = null;
    try {
      ocr = await Promise.race([
        ocrMatchCounts(sheet.buffer, votes),
        new Promise((r) => setTimeout(() => r(null), 12000)),
      ]);
    } catch { /* corroborative only */ }
    if (ocr) {
      db.prepare('UPDATE collation_reports SET ocr_matched = ?, ocr_total = ? WHERE id = ?')
        .run(ocr.matched, ocr.total, inserted.id);
    }

    const report = db.prepare('SELECT * FROM collation_reports WHERE id = ?').get(inserted.id);
    try { checkCollation(report); } catch (e) { console.error('[collation-check]', e.message); }

    const scope = [state, lga, ward].filter(Boolean).join(' / ');
    notifyChat(chatIdByHash(req.observer.phone_hash),
      `🦅 ${FORM[level]} collation report recorded — ${scope} (${contest}). It is now on the public record.`);
    notifyMaster(`collation · observer #${req.observer.id} · ${FORM[level]} ${scope} (${contest})`);
    res.status(201).json({ ok: true, entryHash: inserted.entryHash, form: FORM[level] });
  } catch (err) {
    console.error('[collation]', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Public read: collation reports for transparency.
collationRouter.get('/collations', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, contest, level, state, lga, ward, votes_json, created_at
    FROM collation_reports ORDER BY created_at DESC LIMIT 200`).all()
    .map((r) => ({ ...r, votes: JSON.parse(r.votes_json), votes_json: undefined }));
  res.json({ collations: rows });
});

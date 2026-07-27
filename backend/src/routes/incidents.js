import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import sharp from 'sharp';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireObserver } from './observers.js';
import { notifyMaster, notifyChat, chatIdByHash } from '../services/notify.js';

export const incidentsRouter = Router();

// ffmpeg is optional (shared host may not have it) — detect once at boot.
let FFMPEG = null;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); FFMPEG = 'ffmpeg'; } catch { /* absent */ }

// Re-mux a video to a clean MP4 (H.264/AAC), stripping metadata and any
// container-embedded payload. Returns true on success, false to fall back.
async function remuxVideo(inBuf, destPath) {
  if (!FFMPEG) return false;
  const tmp = path.join(os.tmpdir(), `hk_${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, inBuf);
    execFileSync(FFMPEG, [
      '-y', '-i', tmp, '-map_metadata', '-1', '-movflags', '+faststart',
      // downscale to <=720p long edge (keeps aspect, never upscales) + a leaner CRF —
      // incident clips are evidence, not cinema; this roughly halves election-day storage.
      '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k', destPath,
    ], { stdio: 'ignore', timeout: 60_000 });
    return fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
  } catch { return false; } finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

const incidentDir = path.join(config.uploadDir, 'incidents');
fs.mkdirSync(incidentDir, { recursive: true });

const KINDS = new Set(['violence', 'ballot_snatching', 'vote_buying', 'intimidation', 'bvas_failure', 'late_materials', 'obstruction', 'other']);
const OK_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 4 }, // 30 MB/file, up to 4
  fileFilter: (_req, file, cb) => cb(null, OK_MIME.has(file.mimetype)),
});

// The claimed mimetype is attacker-controlled — verify the actual file bytes.
function sniffType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(4, 8).toString() === 'ftyp') {
    const brand = buf.slice(8, 12).toString();
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

// Observer files an incident. Media (photos/videos) + text; queued as 'pending'
// for human review before it can be published anywhere. Never auto-published.
incidentsRouter.post('/incidents', requireObserver, upload.array('media', 4), async (req, res) => {
  const kind = String(req.body.kind || '').trim();
  if (!KINDS.has(kind)) return res.status(400).json({ error: 'invalid_kind' });
  const description = String(req.body.description || '').trim().slice(0, 2000);
  if (!description && !(req.files || []).length) {
    return res.status(400).json({ error: 'empty_report', hint: 'add a photo/video or a description' });
  }
  const lat = Number(req.body.lat); const lng = Number(req.body.lng);
  const puCode = String(req.body.puCode || '').trim() || null;
  const pu = puCode ? db.prepare('SELECT state FROM polling_units WHERE pu_code = ?').get(puCode) : null;

  const media = [];
  for (const f of req.files || []) {
    // Trust the sniffed bytes, not the client's claimed mimetype.
    const real = sniffType(f.buffer);
    if (!real) return res.status(400).json({ error: 'invalid_media', hint: 'unrecognized file format' });
    let buffer = f.buffer;
    let ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }[real];
    if (real.startsWith('image/')) {
      // Re-encode every image: strips EXIF (incl. the REPORTER's GPS — a safety
      // issue if the photo is later published) and neutralizes malformed files.
      try {
        buffer = await sharp(f.buffer, { failOn: 'error' }).rotate()
          .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 }).toBuffer();
        ext = 'jpg';
      } catch {
        return res.status(400).json({ error: 'invalid_media', hint: 'could not process image' });
      }
    }
    const isVideo = real.startsWith('video');
    // Transcode target is always .mp4 so ffmpeg's H.264/AAC output matches the
    // container; without ffmpeg we keep the sniffed-safe original extension.
    if (isVideo && FFMPEG) ext = 'mp4';
    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    const dest = path.join(incidentDir, name);
    if (isVideo) {
      const remuxed = await remuxVideo(f.buffer, dest);
      if (!remuxed) fs.writeFileSync(dest, buffer); // ffmpeg absent/failed → store sniffed original
    } else {
      fs.writeFileSync(dest, buffer);
    }
    media.push({ file: `incidents/${name}`, type: real.startsWith('video') ? 'video' : 'image' });
  }

  const info = db.prepare(`
    INSERT INTO incidents (observer_id, kind, description, media_json, lat, lng, pu_code, state, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(req.observer.id, kind, description, JSON.stringify(media),
      Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null,
      puCode, pu?.state || null, Date.now());

  import('../services/triage.js').then((t) => t.triageIncident(info.lastInsertRowid)).catch(() => {});
  notifyMaster(`🆘 incident [${kind}] from observer #${req.observer.id}${pu?.state ? ' · ' + pu.state : ''} · ${media.length} file(s) · awaiting review (#${info.lastInsertRowid})`);
  notifyChat(chatIdByHash(req.observer.phone_hash), `🆘 Your incident report was received and is under review. Thank you for helping protect the vote.`);
  res.status(201).json({ ok: true, id: info.lastInsertRowid, status: 'pending' });
});

// Public feed — only human-approved (published) incidents are ever shown.
incidentsRouter.get('/incidents', (_req, res) => {
  const rows = db.prepare(`
    SELECT id, kind, description, media_json, state, pu_code, created_at
    FROM incidents WHERE status = 'published' ORDER BY created_at DESC LIMIT 100`).all()
    .map((r) => ({ ...r, media: JSON.parse(r.media_json), media_json: undefined }));
  res.json({ incidents: rows });
});

incidentsRouter.get('/incidents/kinds', (_req, res) => res.json([...KINDS]));

// ---- "Report this content" (store UGC compliance: Play UGC policy, App Store
// Guideline 1.2). Any reader — signed in or not — can flag a published incident
// or a unit result they believe is abusive, false, or privacy-violating. Flags
// go to the owner console's queue and ping the master chat; they never remove
// content automatically (takedown stays a human decision, consistent with the
// pre-publication moderation model).
const FLAG_KINDS = new Set(['incident', 'result']);
const FLAG_REASONS = new Set(['abuse', 'false', 'privacy', 'other']);
// Same-source dedupe without storing raw IPs: salted hash, unique-indexed per
// (kind, target). jwtSecret as salt keeps the hash stable across restarts.
const flagIpHash = (ip) =>
  crypto.createHash('sha256').update(config.jwtSecret + '|flag|' + String(ip || '')).digest('hex').slice(0, 32);

incidentsRouter.post('/flags', (req, res) => {
  const kind = String(req.body?.kind || '').trim();
  const targetId = Number(req.body?.targetId);
  const reason = String(req.body?.reason || '').trim();
  const detail = String(req.body?.detail || '').trim().slice(0, 500) || null;
  if (!FLAG_KINDS.has(kind) || !Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'invalid_target' });
  }
  if (!FLAG_REASONS.has(reason)) return res.status(400).json({ error: 'invalid_reason' });

  // The target must be real and public — otherwise the endpoint becomes a
  // probe for unpublished queue ids.
  const exists = kind === 'incident'
    ? db.prepare("SELECT id FROM incidents WHERE id = ? AND status = 'published'").get(targetId)
    : db.prepare('SELECT id FROM submissions WHERE id = ?').get(targetId);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  // Optional observer attribution (better signal for repeat-abuse patterns),
  // but never required — flagging must not demand an account.
  let observerId = null;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      observerId = Number(jwt.verify(header.slice(7), config.jwtSecret).sub) || null;
    } catch { /* anonymous is fine */ }
  }

  try {
    db.prepare(`
      INSERT INTO content_flags (kind, target_id, reason, detail, observer_id, ip_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, targetId, reason, detail, observerId, flagIpHash(req.ip), Date.now());
  } catch {
    // UNIQUE(kind, target_id, ip_hash) — same reader re-flagging the same item.
    return res.json({ ok: true, status: 'already_reported' });
  }
  const open = db.prepare("SELECT COUNT(*) c FROM content_flags WHERE status = 'open'").get().c;
  notifyMaster(`🚩 content flag: ${kind} #${targetId} · ${reason}${detail ? ' · "' + detail.slice(0, 80) + '"' : ''} · ${open} open flag(s)`);
  res.status(201).json({ ok: true, status: 'received' });
});

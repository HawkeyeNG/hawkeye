import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import sharp from 'sharp';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireObserver } from './observers.js';
import { notifyMaster, notifyChat, chatIdByHash } from '../services/notify.js';

export const incidentsRouter = Router();

const execFileAsync = promisify(execFile);

/**
 * ffmpeg is optional (a shared host may not have it) — detect once at boot.
 *
 * IT MUST SAY SO. This used to fail silently, and silence is indistinguishable
 * from success: every incident video was stored exactly as the phone recorded
 * it, which on any recent Android or iPhone means HEVC. The container's AAC
 * audio still plays, so a reviewer gets sound and a black frame, and a
 * downloaded copy asks them to buy an HEVC extension. Meanwhile
 * docs/SCALE-1M.md budgets incident media at "720p re-encode server-side" —
 * a plan quietly resting on a step that was not running.
 */
export const mediaHealth = {
  ffmpeg: false,
  ffmpegPath: null,
  ffmpegTried: [],
  /** What the npm-packaged binaries resolved to, INCLUDING "not installed". */
  npmPackages: [],
  /** So a stale process is distinguishable from a bad install. */
  bootedAt: new Date().toISOString(),
  transcodeFailures: 0,
  lastFailure: null,
};

/**
 * FIND ffmpeg, don't just ask PATH for it.
 *
 * This was a bare `execFileSync('ffmpeg', …)`, which resolves through PATH and
 * nothing else. A jailed DirectAdmin/CloudLinux Node process routinely runs
 * with a minimal environment, so /usr/bin/ffmpeg can be sitting right there and
 * still be invisible — and the failure looks identical to not having it
 * installed at all, which is not a distinction anyone can make from the
 * outside.
 *
 * So: an explicit override first, then PATH, then the places it actually lives
 * on shared hosting, then a bundled binary if `ffmpeg-static` is ever added as
 * a dependency (an npm install needs no root, which is the point — there is no
 * shell on that host and `apt-get` is not an option there).
 *
 * Every candidate tried is recorded, so the admin diagnostic can say what was
 * looked for rather than just "missing".
 */
function findFfmpeg() {
  /**
   * A bundled binary, from whichever packaging is installed.
   *
   * `ffmpeg-static` is the dependency in package.json; it downloads a ~76 MB
   * static build in a postinstall step. `@ffmpeg-installer/ffmpeg` is accepted
   * too because it ships platform binaries as ordinary npm packages with NO
   * postinstall download — the fallback worth having if this host's outbound
   * access ever blocks the first one.
   *
   * Neither can be uploaded by the deploy script: 76 MB against a 10 MB
   * per-request limit, and no shell on the host to reassemble chunks. The
   * binary has to arrive via an `npm install` run from the DirectAdmin Node.js
   * panel — Passenger restarts on tmp/restart.txt but never installs anything.
   */
  const bundled = (() => {
    /**
     * createRequire, NOT a bare `require`.
     *
     * This file is an ES module and ESM has no `require` — the server reported
     * "load failed: require is not defined" for a package that was correctly
     * installed. It passed locally only because the test ran the module through
     * `node -e`, which runs in CommonJS mode and leaks a global `require` that
     * does not exist when Node starts a real .js entry point. The test was
     * measuring its own invocation, not the code.
     */
    const req = createRequire(import.meta.url);
    for (const mod of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
      try {
        const m = req(mod);
        const p = typeof m === 'string' ? m : m && m.path;
        if (typeof p === 'string' && p) {
          // Resolved but possibly not downloaded: ffmpeg-static fetches its
          // binary in a postinstall step, so the module can be present while
          // the 76 MB file it points at is not.
          mediaHealth.npmPackages.push(`${mod} -> ${p}${fs.existsSync(p) ? '' : ' (MODULE PRESENT BUT BINARY MISSING)'}`);
          return p;
        }
        mediaHealth.npmPackages.push(`${mod} (loaded but exported no path)`);
      } catch (e) {
        /**
         * REPORT THE ERROR, NOT A GUESS AT IT.
         *
         * This said "(not installed)" for any failure, which was wrong and cost
         * two rounds: the package WAS installed and resolvable — it threw while
         * LOADING. `require()` executes a module; `require.resolve()` only
         * locates it, and the two disagreeing is the whole signal. The usual
         * cause is a platform binary that is an optionalDependency, which npm
         * skips silently when it cannot install it.
         */
        const msg = String((e && e.message) || e).split('\n')[0].slice(0, 160);
        mediaHealth.npmPackages.push(`${mod} (load failed: ${msg})`);
      }
    }
    return null;
  })();
  const candidates = [
    process.env.FFMPEG_PATH,
    'ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/ffmpeg/bin/ffmpeg',
    '/usr/local/ffmpeg/bin/ffmpeg',
    '/home/hawkeye/bin/ffmpeg',
    bundled,
  ].filter(Boolean);

  for (const c of candidates) {
    mediaHealth.ffmpegTried.push(c);
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch { /* try the next one */ }
  }
  return null;
}

let FFMPEG = findFfmpeg();
mediaHealth.ffmpeg = !!FFMPEG;
mediaHealth.ffmpegPath = FFMPEG;
if (FFMPEG) {
  console.log(`[incidents] ffmpeg found at "${FFMPEG}" — videos will be transcoded to 720p H.264/AAC`);
} else {
  console.warn('[incidents] ffmpeg NOT FOUND. Incident videos will be stored EXACTLY as recorded '
    + '(HEVC on most phones: unplayable in browsers, ~13x larger than transcoded).\n'
    + `           tried: ${mediaHealth.ffmpegTried.join(', ')}\n`
    + '           Fixes, in order of least privilege: set FFMPEG_PATH if it is installed elsewhere; '
    + 'add the `ffmpeg-static` npm dependency (needs no root, which matters on a shared host with no shell); '
    + 'or ask the host to install it. Reported at GET /api/admin/stats -> media.');
}

/** How long one transcode may run. Generous BECAUSE it no longer blocks: the
 *  old 60s ceiling had to stay tight since it froze the whole server. */
const TRANSCODE_TIMEOUT_MS = 120_000;

/**
 * Re-mux a video to a clean MP4 (H.264/AAC), stripping metadata and any
 * container-embedded payload.
 *
 * ASYNCHRONOUS, and that is the point. This was `execFileSync` inside an
 * `async function` — the `async` was decoration; the sync call pinned Node's
 * single thread for up to a minute. On election day, when incident uploads
 * arrive together, one video froze every other request on the server: signups,
 * result submissions, the dashboard, all of it. `execFile` + promisify keeps
 * the event loop free while ffmpeg runs in its own process.
 *
 * Returns { ok, reason } rather than a bare boolean so the caller can record
 * WHY, instead of quietly keeping the original.
 */
async function remuxVideo(inBuf, destPath) {
  if (!FFMPEG) return { ok: false, reason: 'ffmpeg_absent' };
  const tmp = path.join(os.tmpdir(), `hk_${crypto.randomBytes(8).toString('hex')}`);
  try {
    await fs.promises.writeFile(tmp, inBuf);
    await execFileAsync(FFMPEG, [
      '-y', '-i', tmp, '-map_metadata', '-1', '-movflags', '+faststart',
      /**
       * Downscale to <=720p long edge (keeps aspect, never upscales) + a leaner
       * CRF — incident clips are evidence, not cinema. Measured 10.5x on a real
       * phone clip pulled off the server.
       *
       * TWO scale passes, NOT `force_divisible_by=2`. That option arrived in
       * FFmpeg 4.2 (2019), and the binary that installs without a download here
       * (@ffmpeg-installer) is a 2018 build: it reports an `hevc` decoder and a
       * `libx264` encoder, passes a version check, and then dies mid-stream with
       * "Option 'force_divisible_by' not found". A second scale rounding to even
       * does the same job and works on both — verified against the 2018 binary
       * and a current one, producing byte-identical dimensions.
       */
      '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k', destPath,
    ], { timeout: TRANSCODE_TIMEOUT_MS, maxBuffer: 1 << 20 });
    const good = fs.existsSync(destPath) && fs.statSync(destPath).size > 0;
    return good ? { ok: true } : { ok: false, reason: 'empty_output' };
  } catch (e) {
    return { ok: false, reason: e && e.killed ? 'timeout' : 'ffmpeg_error' };
  } finally {
    try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
  }
}

/** One place that both counts a failure and says so, so neither can be forgotten. */
function noteTranscodeFailure(reason) {
  mediaHealth.transcodeFailures += 1;
  mediaHealth.lastFailure = { reason, at: new Date().toISOString() };
  console.warn(`[incidents] video transcode failed (${reason}) — storing the original. `
    + 'It may be HEVC and unplayable in a browser.');
}

const incidentDir = path.join(config.uploadDir, 'incidents');
fs.mkdirSync(incidentDir, { recursive: true });

const KINDS = new Set(['violence', 'ballot_snatching', 'vote_buying', 'intimidation', 'bvas_failure', 'late_materials', 'obstruction', 'other']);
const OK_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);

/**
 * FOUR FILES, AT MOST TWO VIDEOS.
 *
 * The old ceiling was 4 x 30 MB = 120 MB per report, and the cost is almost
 * entirely video: a client-compressed photo is a few hundred KB, a minute of
 * phone video is tens of MB. Cutting the total to two would lose corroboration
 * — a wide shot and a close-up of the same scene support each other — while
 * saving almost nothing, so the cap goes where the bytes are.
 *
 * multer only understands ONE fileSize, so it is set to the larger (video)
 * limit and photos are checked against PHOTO_BYTES in the handler, after the
 * sniff proves what they actually are.
 */
const MAX_FILES = 4;
const MAX_VIDEOS = 2;
/* 25 MB, raised from 15. The clients cap RECORDING at 45s and treat that as the
   gate; a 45s clip from this app is 13-16 MB before compression, so a 15 MB
   ceiling refused recordings the app had just instructed someone to make. This
   must stay >= the clients' VIDEO_BYTES, or the server silently becomes the
   real limit and the observer is refused after paying for the upload. */
const VIDEO_BYTES = 25 * 1024 * 1024;
const PHOTO_BYTES = 8 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VIDEO_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => cb(null, OK_MIME.has(file.mimetype)),
});

/**
 * Multer's own rejections were UNHANDLED, so an oversize attachment fell
 * through to the generic error handler and the observer got
 * `{"error":"internal_error"}` with a 500 — after spending the data to send it.
 * "Something broke, try again" invites the identical retry; naming the limit is
 * the only reply that lets them fix it.
 */
function uploadOr400(req, res, next) {
  upload.array('media', MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'file_too_large',
        hint: `Each video must be under ${Math.round(VIDEO_BYTES / 1048576)} MB and each photo under ${Math.round(PHOTO_BYTES / 1048576)} MB. Record a shorter clip and try again.`,
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'too_many_files', hint: `Up to ${MAX_FILES} files per report.` });
    }
    return res.status(400).json({ error: 'upload_failed', hint: 'That attachment could not be read.' });
  });
}

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
incidentsRouter.post('/incidents', requireObserver, uploadOr400, async (req, res) => {
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
  let videoCount = 0;
  for (const f of req.files || []) {
    // Trust the sniffed bytes, not the client's claimed mimetype.
    const real = sniffType(f.buffer);
    if (!real) return res.status(400).json({ error: 'invalid_media', hint: 'unrecognized file format' });

    /* Enforced HERE, not in multer, for the same reason the type is sniffed
       here: multer only sees the claimed mimetype, and it is the client's to
       lie about. These checks run against what the bytes actually are. */
    if (real.startsWith('video/')) {
      if (++videoCount > MAX_VIDEOS) {
        return res.status(400).json({
          error: 'too_many_videos',
          hint: `Up to ${MAX_VIDEOS} videos per report — send the rest as photos, or file a second report.`,
        });
      }
    } else if (f.buffer.length > PHOTO_BYTES) {
      return res.status(413).json({
        error: 'file_too_large',
        hint: `Each photo must be under ${Math.round(PHOTO_BYTES / 1048576)} MB.`,
      });
    }
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
    const stem = crypto.randomBytes(12).toString('hex');

    if (!isVideo) {
      const name = `${stem}.${ext}`;
      fs.writeFileSync(path.join(incidentDir, name), buffer);
      media.push({ file: `incidents/${name}`, type: 'image' });
      continue;
    }

    /**
     * NAME IT FOR WHAT IT ACTUALLY IS. The extension used to be set to .mp4 up
     * front whenever ffmpeg merely EXISTED, so a transcode that then failed
     * left the phone's original bytes wearing an .mp4 name — a QuickTime/HEVC
     * file the admin player could not decode and nothing on disk admitted to.
     * Decide after the outcome instead.
     *
     * A failed transcode still STORES the original: this is evidence, and
     * losing it to save disk would be the worse trade. It is recorded as
     * untranscoded so review can see why it will not play, and so the
     * out-of-band fixer has a list.
     */
    const mp4Name = `${stem}.mp4`;
    const mp4Dest = path.join(incidentDir, mp4Name);
    const r = await remuxVideo(f.buffer, mp4Dest);
    if (r.ok) {
      media.push({ file: `incidents/${mp4Name}`, type: 'video', transcoded: true });
    } else {
      try { fs.unlinkSync(mp4Dest); } catch { /* nothing was written */ }
      noteTranscodeFailure(r.reason);
      const name = `${stem}.${ext}`;
      fs.writeFileSync(path.join(incidentDir, name), buffer);
      media.push({ file: `incidents/${name}`, type: 'video', transcoded: false, transcodeError: r.reason });
    }
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

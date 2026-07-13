// TikTok routes — connect Hawkeye's own account (OAuth) and Direct-Post videos.
// Auth/callback are open (TikTok redirects to callback with no auth header); the
// owner-only actions (status, post) require the admin secret. No-ops with a clear
// message until TikTok credentials are configured.
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { requireAdmin } from './admin.js';
import { tiktokEnabled, authUrl, exchangeCode, tiktokStatus, directPostFile, postStatus, creatorInfoRaw } from '../services/tiktok.js';

export const tiktokRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

// Short-lived OAuth state tokens (CSRF), kept in memory.
const states = new Map();
const putState = (s) => { states.set(s, Date.now()); for (const [k, t] of states) if (Date.now() - t > 600_000) states.delete(k); };

// Begin OAuth — redirect the owner to TikTok's consent screen.
tiktokRouter.get('/tiktok/auth', (_req, res) => {
  if (!tiktokEnabled()) return res.status(503).send('TikTok not configured (set TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET).');
  const state = crypto.randomBytes(16).toString('hex');
  putState(state);
  res.redirect(authUrl(state));
});

// OAuth redirect target — exchange the code and store the token.
tiktokRouter.get('/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/post.html?error=' + encodeURIComponent(String(error)));
  if (!code || !state || !states.has(String(state))) return res.redirect('/post.html?error=bad_state');
  states.delete(String(state));
  try {
    await exchangeCode(String(code));
    res.redirect('/post.html?connected=1');
  } catch (e) {
    res.redirect('/post.html?error=' + encodeURIComponent(String(e.message || e)));
  }
});

tiktokRouter.get('/tiktok/status', requireAdmin, (_req, res) => res.json(tiktokStatus()));

// Diagnostic: raw creator_info — shows the account's eligibility, allowed privacy
// options, and any TikTok error code (the real reason a Direct Post is refused).
tiktokRouter.get('/tiktok/creator-info', requireAdmin, async (_req, res) => {
  if (!tiktokEnabled()) return res.status(503).json({ error: 'not_configured' });
  try { res.json(await creatorInfoRaw()); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// FILE_UPLOAD — the admin uploads the video file (multipart); the server pushes
// the bytes to TikTok. No domain verification needed.
tiktokRouter.post('/tiktok/post', requireAdmin, upload.single('video'), async (req, res) => {
  if (!tiktokEnabled()) return res.status(503).json({ error: 'not_configured' });
  const { title, privacy } = req.body || {};
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'video_file_required' });
  try {
    const out = await directPostFile({ title, buffer: req.file.buffer, privacy, mime: req.file.mimetype || 'video/mp4' });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

tiktokRouter.get('/tiktok/post/:id', requireAdmin, async (req, res) => {
  try { res.json(await postStatus(req.params.id)); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

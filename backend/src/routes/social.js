// Unified social poster — one endpoint fans a post out to TikTok, the Facebook
// Page, and Instagram from a single caption + public media URL. Owner-only.
// Per-platform errors are collected, not fatal, so one failure doesn't block the
// others. TikTok posts by fetching the URL then push_by_file (SELF_ONLY until
// audited); Meta posts from the URL directly.
import { Router } from 'express';
import { requireAdmin } from './admin.js';
import { tiktokEnabled, tiktokStatus, directPostByUrl } from '../services/tiktok.js';
import { metaEnabled, metaStatus, postFacebook, postInstagram } from '../services/meta.js';
import { xEnabled, xStatus, postX } from '../services/x.js';

export const socialRouter = Router();

socialRouter.get('/social/status', requireAdmin, async (_req, res) => {
  const [meta, x] = await Promise.all([
    metaStatus().catch((e) => ({ error: String(e.message || e) })),
    xStatus().catch((e) => ({ error: String(e.message || e) })),
  ]);
  res.json({ tiktok: tiktokStatus(), meta, x });
});

// body: { targets: ['tiktok','facebook','instagram'], caption, mediaUrl, mediaType }
socialRouter.post('/social/post', requireAdmin, async (req, res) => {
  const { targets = [], caption = '', mediaUrl = '', mediaType = 'video' } = req.body || {};
  if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'no_targets' });
  const out = {};

  if (targets.includes('tiktok')) {
    try {
      if (!tiktokEnabled()) throw new Error('not_configured');
      if (mediaType !== 'video') throw new Error('tiktok_requires_video');
      if (!mediaUrl) throw new Error('media_url_required');
      out.tiktok = await directPostByUrl({ title: caption, url: mediaUrl });
    } catch (e) { out.tiktokError = String(e.message || e); }
  }
  if (targets.includes('facebook')) {
    try {
      if (!metaEnabled()) throw new Error('not_configured');
      out.facebook = (await postFacebook({ message: caption, mediaUrl, mediaType })).fb;
    } catch (e) { out.facebookError = String(e.message || e); }
  }
  if (targets.includes('instagram')) {
    try {
      if (!metaEnabled()) throw new Error('not_configured');
      if (mediaType === 'text') throw new Error('instagram_requires_media');
      out.instagram = (await postInstagram({ caption, mediaUrl, mediaType })).ig;
    } catch (e) { out.instagramError = String(e.message || e); }
  }
  if (targets.includes('x')) {
    try {
      if (!xEnabled()) throw new Error('not_configured');
      out.x = await postX({ text: caption }); // text-only for now; caption carries the link
    } catch (e) { out.xError = String(e.message || e); }
  }

  const anyOk = out.tiktok || out.facebook || out.instagram || out.x;
  res.status(anyOk ? 200 : 400).json({ ok: Boolean(anyOk), ...out });
});

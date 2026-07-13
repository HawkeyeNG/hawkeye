// Meta routes — post Hawkeye's own content to its Facebook Page and/or Instagram.
// Owner-only (admin secret). No OAuth flow: the Page token is supplied via env.
import { Router } from 'express';
import { requireAdmin } from './admin.js';
import { metaEnabled, metaStatus, postFacebook, postInstagram, metaDiag } from '../services/meta.js';

export const metaRouter = Router();

metaRouter.get('/meta/status', requireAdmin, async (_req, res) => {
  try { res.json(await metaStatus()); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

metaRouter.get('/meta/diag', requireAdmin, async (_req, res) => {
  if (!metaEnabled()) return res.status(503).json({ error: 'not_configured' });
  try { res.json(await metaDiag()); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// body: { target: 'fb'|'ig'|'both', caption, mediaUrl, mediaType: 'text'|'image'|'video', link }
metaRouter.post('/meta/post', requireAdmin, async (req, res) => {
  if (!metaEnabled()) return res.status(503).json({ error: 'not_configured' });
  const { target = 'both', caption = '', mediaUrl = '', mediaType = 'text', link = '' } = req.body || {};
  if (target === 'ig' && mediaType === 'text') return res.status(400).json({ error: 'instagram_requires_media' });
  const out = {};
  try {
    if (target === 'fb' || target === 'both') Object.assign(out, await postFacebook({ message: caption, mediaUrl, mediaType, link }));
  } catch (e) { out.fbError = String(e.message || e); }
  try {
    if (target === 'ig' || target === 'both') Object.assign(out, await postInstagram({ caption, mediaUrl, mediaType }));
  } catch (e) { out.igError = String(e.message || e); }
  const anyOk = out.fb || out.ig;
  res.status(anyOk ? 200 : 400).json({ ok: Boolean(anyOk), ...out });
});

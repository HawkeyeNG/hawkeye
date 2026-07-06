// Public TikTok OAuth callback (Login Kit redirect target). TikTok sends the
// authorization code here after the owner approves; we exchange it for tokens
// and bounce back to the review console. Must be a registered redirect URI on a
// domain-verified property (config.tiktok.redirectUri).
import { Router } from 'express';
import { checkState, exchangeCode } from '../services/tiktok.js';
import { notifyMaster } from '../services/notify.js';

export const tiktokRouter = Router();

tiktokRouter.get('/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/review.html?tiktok=denied');
  if (!code || !checkState(String(state || ''))) return res.redirect('/review.html?tiktok=badstate');
  try {
    const r = await exchangeCode(String(code));
    notifyMaster(`✅ TikTok connected — open_id ${String(r.open_id || '').slice(0, 10)}…`);
    res.redirect('/review.html?tiktok=connected');
  } catch (e) {
    console.error('[tiktok]', e.message);
    res.redirect('/review.html?tiktok=error');
  }
});

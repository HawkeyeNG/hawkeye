import { Router } from 'express';
import { requireObserver } from './observers.js';
import { requireAdmin } from './admin.js';
import { registerPushToken, checkPushCredentials, vapidPublicKey } from '../services/push.js';

// Mobile shell registers its FCM/APNs device token here after sign-in so the
// backend can push "new report at your saved unit" etc. to that observer.
export const pushRouter = Router();

// Owner-only: does the FCM service account actually work? Admin-gated rather
// than public because it reaches out to Google's token endpoint — cached for an
// hour, but not something to leave open to anonymous callers.
pushRouter.get('/push/health', requireAdmin, async (_req, res) => {
  res.json(await checkPushCredentials());
});

// Public: the VAPID public key a browser needs to subscribe to Web Push. Empty
// string when VAPID isn't configured — the client treats that as "push off".
pushRouter.get('/push/vapid', (_req, res) => {
  res.json({ publicKey: vapidPublicKey() });
});

pushRouter.post('/push/register', requireObserver, (req, res) => {
  const token = String(req.body?.token || '').trim();
  const platform = String(req.body?.platform || 'android');
  if (!token) return res.status(400).json({ error: 'token_required' });
  registerPushToken(req.observer.id, token, platform);
  res.status(201).json({ ok: true });
});

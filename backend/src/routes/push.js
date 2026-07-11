import { Router } from 'express';
import { requireObserver } from './observers.js';
import { registerPushToken } from '../services/push.js';

// Mobile shell registers its FCM/APNs device token here after sign-in so the
// backend can push "new report at your saved unit" etc. to that observer.
export const pushRouter = Router();

pushRouter.post('/push/register', requireObserver, (req, res) => {
  const token = String(req.body?.token || '').trim();
  const platform = String(req.body?.platform || 'android');
  if (!token) return res.status(400).json({ error: 'token_required' });
  registerPushToken(req.observer.id, token, platform);
  res.status(201).json({ ok: true });
});

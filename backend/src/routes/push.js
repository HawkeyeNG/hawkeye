import { Router } from 'express';
import { requireObserver } from './observers.js';
import { requireAdmin } from './admin.js';
import {
  registerPushToken, checkPushCredentials, vapidPublicKey, broadcast,
} from '../services/push.js';

// Mobile shell registers its FCM/APNs device token here after sign-in so the
// backend can push "new report at your saved unit" etc. to that observer.
export const pushRouter = Router();

// Owner-only: does the FCM service account actually work? Admin-gated rather
// than public because it reaches out to Google's token endpoint — cached for an
// hour, but not something to leave open to anonymous callers.
/**
 * The audience a broadcast would reach, without sending anything.
 *
 * Its own endpoint so the console can show the number BEFORE the compose pane
 * is filled in — "this will go to 19 people" changes what you write, and
 * finding out afterwards is too late.
 */
pushRouter.get('/push/audience', requireAdmin, async (_req, res) => {
  const r = await broadcast({ title: 'x', body: 'x', dryRun: true });
  res.json({ audience: r.audience, android: r.android, web: r.web });
});

/**
 * Send a broadcast from the admin console.
 *
 * Mirrors the CLI's guards rather than trusting the UI to enforce them, because
 * a guard that lives only in a form is not a guard: `confirm` must be the exact
 * string SEND, and `maxAudience` must be stated by the caller and match reality.
 * A push cannot be recalled, so both halves have to be deliberate.
 */
pushRouter.post('/push/broadcast', requireAdmin, async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 120);
  const body = String(req.body?.body || '').trim().slice(0, 400);
  const url = String(req.body?.url || '').trim().slice(0, 500);
  const dryRun = req.body?.dryRun !== false;
  const maxAudience = Math.max(0, Math.floor(Number(req.body?.maxAudience) || 0));

  if (!title || !body) return res.status(400).json({ error: 'title_and_body_required' });
  // Only our own origin or a Play link — a push that opens an arbitrary URL is
  // a phishing vector aimed at the people who trust this app most.
  if (url && !/^https:\/\/(hawkeye\.com\.ng|play\.google\.com)\//.test(url)) {
    return res.status(400).json({ error: 'url_must_be_hawkeye_or_play' });
  }

  try {
    const r = await broadcast({
      title,
      body,
      data: url ? { url, kind: 'admin_broadcast' } : { kind: 'admin_broadcast' },
      dryRun,
      confirm: dryRun ? null : req.body?.confirm,
      maxAudience,
      // Absent means everyone, which is what every existing caller meant. An
      // unknown value THROWS in broadcast() and surfaces as the 400 below,
      // rather than quietly targeting nobody and reporting a clean send.
      platforms: req.body?.platforms ?? null,
    });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

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

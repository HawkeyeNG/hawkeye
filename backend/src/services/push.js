// Native push (FCM for Android; APNs stubbed until the iOS build exists).
// Credential-gated exactly like the AI providers: with no FCM service-account
// env set, every send is a silent no-op — the app still works, it just doesn't
// push. Tokens are registered by the mobile shell (app/native.js) and tied to an
// observer; "new report at your saved unit" fans out here alongside Telegram.
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { config } from '../config.js';

const FCM_ENABLED = Boolean(config.fcmProjectId && config.fcmClientEmail && config.fcmPrivateKey);
// Web Push (VAPID) — independent of FCM. Unset keys = silent no-op.
const VAPID_ENABLED = Boolean(config.vapidPublicKey && config.vapidPrivateKey);

// web-push is an OPTIONAL server dependency. If it isn't installed in the server's
// node_modules, Web Push is simply OFF (sends no-op) instead of crashing the whole
// API at import time — a missing optional dep must never take the transparency
// backend down. Lazy-loaded + cached; VAPID details are set on first load.
let _webpush; // undefined = not yet tried, null = unavailable, object = loaded
async function getWebpush() {
  if (_webpush !== undefined) return _webpush;
  try {
    _webpush = (await import('web-push')).default;
    if (VAPID_ENABLED) {
      _webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
    }
  } catch {
    _webpush = null;
  }
  return _webpush;
}

/** Are the three FCM service-account vars present? Booleans only — safe to
 *  surface publicly, and it answers "did my .env land" without a deploy log. */
export const pushConfigured = () => FCM_ENABLED;
export const webPushConfigured = () => VAPID_ENABLED;
/** The VAPID public key the browser needs to subscribe (safe to serve). */
export const vapidPublicKey = () => config.vapidPublicKey;

/**
 * Prove the credential actually WORKS, without pushing anything to anyone.
 *
 * Present-and-parseable are different questions, and the gap between them is
 * where this fails in practice: FCM_PRIVATE_KEY must carry literal \n escapes
 * (fcmAccessToken un-escapes them below), so a key pasted with real newlines is
 * truncated at the first break and every send dies on signature validation.
 * Without this check that surfaces only when a real observer misses a real
 * alert. Minting an access token exercises the whole chain — key parses, JWT
 * signs, Google accepts the grant — and the result is cached for an hour, so
 * calling it is nearly free.
 */
export async function checkPushCredentials() {
  if (!FCM_ENABLED) {
    const missing = [
      !config.fcmProjectId && 'FCM_PROJECT_ID',
      !config.fcmClientEmail && 'FCM_CLIENT_EMAIL',
      !config.fcmPrivateKey && 'FCM_PRIVATE_KEY',
    ].filter(Boolean);
    return { configured: false, ok: false, missing };
  }
  try {
    await fcmAccessToken();
    return { configured: true, ok: true, projectId: config.fcmProjectId };
  } catch (e) {
    // Coarse reason only — never echo the key or Google's raw payload.
    return { configured: true, ok: false, reason: e?.message || 'fcm_oauth_failed' };
  }
}

export function registerPushToken(observerId, token, platform) {
  if (!token) return;
  // A 'web' token is a JSON PushSubscription (endpoint + keys) — longer than an
  // FCM device token, so allow more room; anything unknown falls back to android.
  const p = platform === 'web' ? 'web' : platform === 'ios' ? 'ios' : 'android';
  db.prepare(`
    INSERT INTO device_push_tokens (token, observer_id, platform, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET observer_id = excluded.observer_id, platform = excluded.platform`)
    .run(String(token).slice(0, 2048), observerId, p, Date.now());
}

// Cached OAuth access token for FCM v1 (service-account JWT grant).
let cachedToken = null;
let cachedExp = 0;
async function fcmAccessToken() {
  if (cachedToken && Date.now() < cachedExp - 60_000) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { scope: 'https://www.googleapis.com/auth/firebase.messaging' },
    config.fcmPrivateKey.replace(/\\n/g, '\n'),
    { algorithm: 'RS256', issuer: config.fcmClientEmail, audience: 'https://oauth2.googleapis.com/token', subject: config.fcmClientEmail, expiresIn: 3600 },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('fcm_oauth_failed');
  cachedToken = j.access_token;
  cachedExp = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedToken;
}

async function fcmSend(accessToken, deviceToken, title, body, data) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${config.fcmProjectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
        android: { priority: 'high' },
      },
    }),
  });
  // 404/UNREGISTERED → the app was uninstalled / token rotated: drop it.
  if (res.status === 404 || res.status === 403) {
    db.prepare('DELETE FROM device_push_tokens WHERE token = ?').run(deviceToken);
  }
  return res.ok;
}

async function webPushSend(subJson, title, body, data) {
  let sub;
  try { sub = JSON.parse(subJson); } catch { return false; }
  const wp = await getWebpush();
  if (!wp) return false; // web-push not installed on this server — silent no-op
  try {
    await wp.sendNotification(sub, JSON.stringify({ title, body, data: data || {} }));
    return true;
  } catch (e) {
    // 404/410 → the browser dropped the subscription: forget it.
    if (e?.statusCode === 404 || e?.statusCode === 410) {
      db.prepare('DELETE FROM device_push_tokens WHERE token = ?').run(subJson);
    }
    return false;
  }
}

// Best-effort; never throws into the caller (mirrors the Telegram helpers). Fans
// out to BOTH the observer's Android (FCM) and web (VAPID) subscriptions; each
// channel is gated independently so one being unconfigured never blocks the other.
export async function sendToObserver(observerId, { title, body, data } = {}) {
  if (!observerId) return 0;
  let sent = 0;
  if (FCM_ENABLED) {
    const rows = db.prepare("SELECT token FROM device_push_tokens WHERE observer_id = ? AND platform = 'android'").all(observerId);
    if (rows.length) {
      try {
        const at = await fcmAccessToken();
        for (const r of rows) if (await fcmSend(at, r.token, title, body, data).catch(() => false)) sent++;
      } catch { /* FCM oauth failed — web still goes out below */ }
    }
  }
  if (VAPID_ENABLED) {
    const rows = db.prepare("SELECT token FROM device_push_tokens WHERE observer_id = ? AND platform = 'web'").all(observerId);
    for (const r of rows) if (await webPushSend(r.token, title, body, data)) sent++;
  }
  return sent;
}

// Fan out a push to everyone who saved this polling unit (Android only for now).
export async function pushUnitSavers(puCode, { title, body, data } = {}) {
  if (!FCM_ENABLED || !puCode) return 0;
  const ids = db.prepare("SELECT DISTINCT s.observer_id FROM saved_units s JOIN observers o ON o.id = s.observer_id AND o.status = 'active' WHERE s.pu_code = ?").all(puCode);
  let n = 0;
  for (const { observer_id } of ids) n += await sendToObserver(observer_id, { title, body, data });
  return n;
}

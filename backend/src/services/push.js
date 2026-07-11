// Native push (FCM for Android; APNs stubbed until the iOS build exists).
// Credential-gated exactly like the AI providers: with no FCM service-account
// env set, every send is a silent no-op — the app still works, it just doesn't
// push. Tokens are registered by the mobile shell (app/native.js) and tied to an
// observer; "new report at your saved unit" fans out here alongside Telegram.
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { config } from '../config.js';

const FCM_ENABLED = Boolean(config.fcmProjectId && config.fcmClientEmail && config.fcmPrivateKey);

export function registerPushToken(observerId, token, platform) {
  if (!token) return;
  db.prepare(`
    INSERT INTO device_push_tokens (token, observer_id, platform, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET observer_id = excluded.observer_id, platform = excluded.platform`)
    .run(String(token).slice(0, 512), observerId, platform === 'ios' ? 'ios' : 'android', Date.now());
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

// Best-effort; never throws into the caller (mirrors the Telegram helpers).
export async function sendToObserver(observerId, { title, body, data } = {}) {
  if (!FCM_ENABLED || !observerId) return 0;
  const rows = db.prepare("SELECT token FROM device_push_tokens WHERE observer_id = ? AND platform = 'android'").all(observerId);
  if (!rows.length) return 0;
  try {
    const at = await fcmAccessToken();
    let sent = 0;
    for (const r of rows) if (await fcmSend(at, r.token, title, body, data).catch(() => false)) sent++;
    return sent;
  } catch { return 0; }
}

// Fan out a push to everyone who saved this polling unit (Android only for now).
export async function pushUnitSavers(puCode, { title, body, data } = {}) {
  if (!FCM_ENABLED || !puCode) return 0;
  const ids = db.prepare("SELECT DISTINCT s.observer_id FROM saved_units s JOIN observers o ON o.id = s.observer_id AND o.status = 'active' WHERE s.pu_code = ?").all(puCode);
  let n = 0;
  for (const { observer_id } of ids) n += await sendToObserver(observer_id, { title, body, data });
  return n;
}

// Native push — FCM for BOTH Android and iOS. The iOS app joined the same
// Firebase project on 2026-08-24 and now registers an FCM token (see
// native/src/lib/push.ts), so there is one transport rather than two.
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

/**
 * A RAW APNs DEVICE TOKEN, which FCM cannot deliver to.
 *
 * iOS builds call expo-notifications' getDevicePushTokenAsync(), which
 * registers with APNs directly and resolves Apple's own 64-hex device token —
 * confirmed in that package's PushTokenModule.swift. FCM v1 only accepts FCM
 * REGISTRATION tokens, so such a token comes back 404 UNREGISTERED, and the
 * handler below would then DELETE it: an iOS device would register, be dropped,
 * register again, be dropped, forever.
 *
 * Recognised by SHAPE rather than by the stored `platform`, on purpose — and
 * that choice is what made the 2026-08-24 switch need no migration. The iOS app
 * is in Firebase now and hands over a real FCM token while still reporting
 * platform 'ios'; a platform check would have kept skipping those forever. This
 * test stopped being true exactly when the token stopped being an APNs one.
 *
 * It still fires for rows registered BEFORE the switch, which hold an APNs token
 * until that device next re-registers. Keep it until those have aged out.
 */
const isRawApnsToken = (t) => /^[0-9a-f]{64}$/i.test(String(t || ''));

async function fcmSend(accessToken, deviceToken, title, body, data) {
  if (isRawApnsToken(deviceToken)) {
    // A pre-switch iOS row. Not an error and not the device's fault. Kept, NOT
    // deleted: it becomes deliverable the moment that app re-registers, and
    // deleting would just churn the row.
    return false;
  }
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${config.fcmProjectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
        android: { priority: 'high' },
        // APNS RELAY SETTINGS. FCM ignores this block for an Android target, so
        // it costs Android nothing — but for an iOS target it is not optional:
        // without `apns-push-type` Apple rejects the relay outright, and without
        // `apns-priority` an alert can be delayed or coalesced away. `sound`
        // is what makes it an alert rather than a silent arrival.
        apns: {
          headers: { 'apns-push-type': 'alert', 'apns-priority': '10' },
          payload: { aps: { sound: 'default', 'content-available': 1 } },
        },
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
    // 'ios' TOO, since 2026-08-24 — the iOS app is registered in the same
    // Firebase project and @react-native-firebase/messaging now hands back an
    // FCM token, so one transport serves both. Rows registered BEFORE that
    // change still hold a raw APNs token; isRawApnsToken skips those, so the
    // switch needs no migration and no cutover — a device starts being
    // deliverable the moment it re-registers with an FCM token.
    const rows = db.prepare("SELECT token FROM device_push_tokens WHERE observer_id = ? AND platform IN ('android', 'ios')").all(observerId);
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

/**
 * Push to EVERY registered device. Use sparingly and deliberately.
 *
 * This is the only send in this file with no natural audience limit, so it is
 * the only one that can annoy every user at once, and a push cannot be
 * unsent. Three guards, all of which exist because the failure is
 * irreversible:
 *
 *   `dryRun`   default TRUE. Counts and returns the audience without sending
 *              anything. A broadcast should always be dry-run first, and making
 *              that the default means forgetting to costs nothing.
 *   `confirm`  a real send must pass the exact string 'SEND'. A truthy flag is
 *              too easy to set by accident from a form or a stray default.
 *   `maxAudience` refuses if the audience is larger than the caller expected.
 *              The caller states the number it believes it is sending to; if
 *              reality disagrees, nothing goes out.
 *
 * Returns { audience, people, sent, failed, dryRun } so a caller can report
 * honestly rather than assuming success. `audience` is DEVICES and `people` is
 * distinct observers — they differ by a factor of about five here, and only one
 * of them is reach.
 */
/** The only audiences that exist. Anything else is a caller mistake, not a
 *  filter that quietly matches nothing. */
export const PUSH_PLATFORMS = ['android', 'ios', 'web'];

export async function broadcast({
  title, body, data, dryRun = true, confirm = null, maxAudience = 0, platforms = null,
} = {}) {
  if (!title || !body) throw new Error('broadcast needs a title and body');

  /**
   * WHO IT GOES TO. Omitted means everyone, so every existing caller is
   * unchanged.
   *
   * Needed because not every announcement is true on every platform: an
   * Android-only crash fix told to iPhone users is noise at best and, on an
   * election tool, an invitation to distrust the next one. The store case is the
   * opposite shape and is handled without this — /get redirects each device to
   * its own store, so "update from the store" stays ONE message.
   *
   * An UNKNOWN platform THROWS rather than filtering to nothing. A typo'd
   * 'ios ' silently matching zero devices, reported as a successful send to
   * nobody, is the worst outcome available here.
   */
  let want = PUSH_PLATFORMS;
  if (platforms != null) {
    const list = (Array.isArray(platforms) ? platforms : [platforms]).map((p) => String(p).trim());
    const bad = list.filter((p) => !PUSH_PLATFORMS.includes(p));
    if (bad.length) throw new Error(`broadcast: unknown platform(s) ${bad.join(', ')}`);
    if (!list.length) throw new Error('broadcast: platforms was empty — omit it to mean everyone');
    want = [...new Set(list)];
  }

  // 'android' AND 'ios' through ONE query — one FCM transport serves both since
  // the iOS app joined the Firebase project (2026-08-24). A row registered
  // before that still holds a raw APNs token and isRawApnsToken declines it, so
  // no migration is needed: each device becomes deliverable when it re-registers.
  const fcmWant = want.filter((p) => p !== 'web');
  const holes = fcmWant.map(() => '?').join(',');
  const android = FCM_ENABLED && fcmWant.length
    ? db.prepare(`
        SELECT t.token, t.platform FROM device_push_tokens t
        LEFT JOIN observers o ON o.id = t.observer_id
        WHERE t.platform IN (${holes}) AND (o.id IS NULL OR o.status = 'active')`).all(...fcmWant)
    : [];
  const web = VAPID_ENABLED && want.includes('web')
    ? db.prepare(`
        SELECT t.token FROM device_push_tokens t
        LEFT JOIN observers o ON o.id = t.observer_id
        WHERE t.platform = 'web' AND (o.id IS NULL OR o.status = 'active')`).all()
    : [];
  const audience = android.length + web.length;
  // REPORTED SEPARATELY even though they send through one loop. The admin Push
  // tab prints these, and folding iOS into "android" would make the console lie
  // about who a broadcast reached — the exact class of mistake that made "107
  // devices" read as 107 people.
  const iosCount = android.filter((r) => r.platform === 'ios').length;
  const androidCount = android.length - iosCount;

  /**
   * REGISTERED IS NOT REACHABLE, and on iOS right now they differ.
   *
   * Every iOS row created before 2026-08-24 holds a RAW APNS token, because
   * that is what expo-notifications hands back; fcmSend declines it by shape.
   * Those devices are genuinely registered, so they belong in the audience —
   * but nothing can be delivered to them until the app re-registers with an
   * FCM token, which needs a build carrying @react-native-firebase/messaging.
   *
   * Counted and reported because the alternative is a dry run promising "3
   * iPhone" and a send reporting "0 sent, 3 failed" — which reads as a broken
   * APNs key, and would send someone to re-upload a key that was fine.
   */
  const undeliverable = android.filter((r) => isRawApnsToken(r.token)).length;

  /**
   * DEVICES ARE NOT PEOPLE, and the difference is large enough to mislead.
   *
   * A token row is created per browser profile, per reinstall, and every time
   * Android rotates its FCM registration; nothing merges them, and dead ones are
   * only removed when a send FAILS (see the delete in fcmSend/webPushSend). So a
   * project that has never broadcast accumulates several tokens per person and
   * prunes none of them — 107 devices across ~20 observers, which reads as 107
   * people to anyone who is not looking at this query.
   *
   * The send still goes to every device, which is right: someone may carry the
   * app on a phone and have it open in a browser. Only the REPORTING changes, so
   * the number cannot be mistaken for reach.
   */
  // SCOPED TO THE SAME PLATFORMS as the send. Counting every observer while
  // sending to only Android would report reach this broadcast does not have —
  // and "people" is the number a human reads before pressing SEND.
  const peopleHoles = want.map(() => '?').join(',');
  const people = db.prepare(`
    SELECT COUNT(DISTINCT t.observer_id) AS n FROM device_push_tokens t
    LEFT JOIN observers o ON o.id = t.observer_id
    WHERE t.platform IN (${peopleHoles}) AND (o.id IS NULL OR o.status = 'active')`).get(...want)?.n || 0;

  if (dryRun) return { audience, people, android: androidCount, ios: iosCount, web: web.length, undeliverable, sent: 0, failed: 0, dryRun: true };
  if (confirm !== 'SEND') throw new Error("broadcast refused: pass confirm:'SEND' for a real send");
  if (maxAudience && audience > maxAudience) {
    throw new Error(`broadcast refused: audience ${audience} exceeds the expected maximum ${maxAudience}`);
  }

  /**
   * FILE IT IN ALERTS BEFORE SENDING IT.
   *
   * A broadcast used to write no notification rows at all, so an announcement
   * swiped away on the lock screen was gone forever — and an observer who simply
   * had notifications off never learned it existed. The Alerts screen is the
   * durable copy; the push is the interruption.
   *
   * BEFORE the send, not after: the send loop is slow (one FCM call per device)
   * and can fail partway. Filing first means a phone that receives the push
   * always has the row waiting behind it, rather than a notification that opens
   * an Alerts screen not yet mentioning it.
   *
   * Scoped to the same platforms as the send, so someone reached only on Android
   * does not get an Alerts row for an iPhone-only message.
   *
   * ORPHANED TOKENS GET THE PUSH BUT NO ROW, which is correct rather than a gap:
   * `notifications` is keyed per observer, and those rows belong to accounts that
   * no longer exist. The audience query keeps them (`o.id IS NULL`) precisely so
   * a deleted account's device still receives the message.
   */
  const noteHolders = db.prepare(`
    SELECT DISTINCT t.observer_id FROM device_push_tokens t
    JOIN observers o ON o.id = t.observer_id AND o.status = 'active'
    WHERE t.platform IN (${peopleHoles})`).all(...want).map((r) => r.observer_id);
  let filed = 0;
  try {
    const n = await import('./notifications.js');
    filed = n.noteMany(noteHolders, {
      kind: 'announcement',
      title,
      body,
      url: data?.url ?? null,
    });
  } catch {
    // The send is the point; a failure to file must not stop it. It is reported
    // as filed:0 rather than swallowed, so the console can say so.
  }

  let sent = 0;
  let failed = 0;
  if (android.length) {
    try {
      const at = await fcmAccessToken();
      for (const r of android) {
        // eslint-disable-next-line no-await-in-loop
        if (await fcmSend(at, r.token, title, body, data).catch(() => false)) sent++; else failed++;
      }
    } catch { failed += android.length; }
  }
  for (const r of web) {
    // eslint-disable-next-line no-await-in-loop
    if (await webPushSend(r.token, title, body, data)) sent++; else failed++;
  }
  return { audience, people, android: androidCount, ios: iosCount, web: web.length, undeliverable, sent, failed, filed, dryRun: false };
}

// Fan out a push to everyone who saved this polling unit (Android only for now).
export async function pushUnitSavers(puCode, { title, body, data } = {}) {
  if (!FCM_ENABLED || !puCode) return 0;
  const ids = db.prepare("SELECT DISTINCT s.observer_id FROM saved_units s JOIN observers o ON o.id = s.observer_id AND o.status = 'active' WHERE s.pu_code = ?").all(puCode);
  let n = 0;
  for (const { observer_id } of ids) n += await sendToObserver(observer_id, { title, body, data });
  return n;
}

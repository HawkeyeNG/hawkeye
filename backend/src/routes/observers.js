import crypto from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { config } from '../config.js';
import { validatePublicKeyJwk } from '../services/signatures.js';
import { sendOtp } from '../services/sms.js';
import { notifyChat, notifyMaster, chatIdByHash } from '../services/notify.js';
import { noteRegistration } from '../services/integrity.js';

export const observersRouter = Router();

export function phoneHash(phone) {
  return crypto.createHmac('sha256', config.phoneSalt).update(phone).digest('hex');
}

// Nigerian mobile numbers only: 0803..., or +234803...
export function normalizePhone(raw) {
  const p = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^0[789][01]\d{8}$/.test(p)) return '+234' + p.slice(1);
  if (/^\+234[789][01]\d{8}$/.test(p)) return p;
  return null;
}

// Naive in-memory limiter to stop OTP spamming/SMS bombing.
// Production: Redis-backed limiter + your SMS provider's abuse controls.
const otpRequests = new Map();
function otpRateLimited(ip) {
  const now = Date.now();
  const hits = (otpRequests.get(ip) || []).filter((t) => now - t < 3600_000);
  hits.push(now);
  otpRequests.set(ip, hits);
  // CGNAT-aware: one carrier IP can front thousands of real users. Per-phone
  // protections (OTP TTL, attempt cap) do the fine-grained work.
  return hits.length > 500;
}

observersRouter.post('/register', async (req, res) => {
  if (otpRateLimited(req.ip)) return res.status(429).json({ error: 'too_many_requests' });
  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: 'invalid_phone', hint: 'Nigerian mobile, e.g. 08031234567' });
  }
  const hash = phoneHash(phone);
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`
    INSERT INTO otps (phone_hash, code, expires_at, attempts) VALUES (?, ?, ?, 0)
    ON CONFLICT(phone_hash) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`)
    .run(hash, code, Date.now() + config.otpTtlS * 1000);

  const sent = await sendOtp(phone, code, hash);
  if (!sent.ok && sent.telegramLink) {
    // Not an error: the observer must open the bot once to link their Telegram.
    return res.json({ ok: true, telegramLink: sent.telegramLink });
  }
  if (!sent.ok) return res.status(502).json({ error: 'sms_send_failed' });

  const body = { ok: true };
  if (config.smsProvider === 'telegram') body.viaTelegram = true;
  // The code is only ever echoed back on the dev console provider.
  if (config.env !== 'production' && config.smsProvider === 'console') body.devOtp = code;
  res.json(body);
});

observersRouter.post('/verify', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || '');
  const jwk = req.body?.publicKeyJwk;
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });
  if (!validatePublicKeyJwk(jwk)) return res.status(400).json({ error: 'invalid_public_key' });

  const hash = phoneHash(phone);
  const row = db.prepare('SELECT * FROM otps WHERE phone_hash = ?').get(hash);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'otp_expired' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'too_many_attempts' });
  if (row.code !== otp) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone_hash = ?').run(hash);
    return res.status(400).json({ error: 'otp_incorrect' });
  }
  db.prepare('DELETE FROM otps WHERE phone_hash = ?').run(hash);

  const jwkJson = JSON.stringify(jwk);
  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64) || null;
  let observer = db.prepare('SELECT * FROM observers WHERE phone_hash = ?').get(hash);
  let isNew = false;
  if (!observer) {
    isNew = true;
    const info = db
      .prepare('INSERT INTO observers (phone_hash, public_key_jwk, device_id, created_at) VALUES (?, ?, ?, ?)')
      .run(hash, jwkJson, deviceId, Date.now());
    observer = db.prepare('SELECT * FROM observers WHERE id = ?').get(info.lastInsertRowid);
  } else {
    // A fresh OTP proves control of the phone, so key rotation (new device / cleared
    // storage) is allowed. The observer row — and its one-report-per-unit history —
    // stays the same, so rotation never buys a second report. Bind this device so
    // the SAME device can auto-resume later without another OTP.
    db.prepare('UPDATE observers SET public_key_jwk = ?, device_id = ? WHERE id = ?')
      .run(jwkJson, deviceId, observer.id);
  }

  // Telegram: send the observer their identity details, and ping the master.
  const chatId = chatIdByHash(hash);
  const when = new Date(observer.created_at).toISOString().replace('T', ' ').slice(0, 16);
  notifyChat(chatId,
    `✅ Hawkeye verification complete.\nObserver ID: ${observer.id}\nIdentity hash: ${hash.slice(0, 16)}…\nRegistered: ${when} UTC\nThis device is now saved — you won't need to sign up again on it.`);
  notifyMaster(`${isNew ? 'NEW' : 'repeat'} phone verified · observer #${observer.id} · ${hash.slice(0, 12)}…`);
  if (isNew) { try { noteRegistration(); } catch { /* informational only */ } }

  const token = jwt.sign({ sub: String(observer.id) }, config.jwtSecret, { expiresIn: '30d' });
  res.json({ ok: true, observerId: observer.id, token });
});

// Auto-resume a saved device: no OTP needed if this exact device (fingerprint +
// its persistent signing key) already belongs to a verified observer. Keeps
// users signed up permanently on their own phone.
observersRouter.post('/resume', (req, res) => {
  const deviceId = String(req.body?.deviceId || '');
  const jwk = req.body?.publicKeyJwk;
  if (!/^[0-9a-f]{64}$/.test(deviceId)) return res.status(400).json({ error: 'device_required' });
  if (!validatePublicKeyJwk(jwk)) return res.status(400).json({ error: 'invalid_public_key' });
  const observer = db.prepare('SELECT * FROM observers WHERE device_id = ?').get(deviceId);
  if (!observer || observer.status !== 'active' || observer.public_key_jwk !== JSON.stringify(jwk)) {
    return res.status(404).json({ error: 'not_recognized' });
  }
  const token = jwt.sign({ sub: String(observer.id) }, config.jwtSecret, { expiresIn: '30d' });
  res.json({ ok: true, observerId: observer.id, token });
});

// One-off test-data reset (owner only, guarded by ADMIN_RESET_SECRET). Deletes
// every observer identity AND its FK-linked activity (reports, mappings,
// subscriptions, telegram links) so the signup flow can be re-tested clean.
observersRouter.post('/admin/reset', (req, res) => {
  if (!config.adminResetSecret || req.body?.secret !== config.adminResetSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const counts = {};
  db.transaction(() => {
    for (const t of ['venue_matches', 'submissions', 'results', 'pu_mappings', 'subscriptions', 'tg_link_tokens', 'telegram_links', 'otps', 'observers']) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      db.exec(`DELETE FROM ${t}`);
    }
    // release any crowd-mapped coordinates back to unlocated
    db.prepare("UPDATE polling_units SET lat = NULL, lng = NULL, coords_source = NULL WHERE coords_source = 'crowd_mapped'").run();
  })();
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM observers').get().c;
  res.json({ ok: true, deleted: counts, remainingObservers: remaining });
});

export function requireObserver(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const observer = db.prepare('SELECT * FROM observers WHERE id = ?').get(Number(payload.sub));
    if (!observer || observer.status !== 'active') {
      return res.status(401).json({ error: 'unknown_observer' });
    }
    req.observer = observer;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

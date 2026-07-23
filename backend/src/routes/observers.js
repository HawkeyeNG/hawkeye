import crypto from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { config } from '../config.js';
import { validatePublicKeyJwk } from '../services/signatures.js';
import { sendOtp, confirmWhatsappOtp } from '../services/sms.js';
import { notifyChat, notifyMaster, chatIdByHash } from '../services/notify.js';
import { noteRegistration } from '../services/integrity.js';
import { verifyWebAppPayload, parseJsonField } from '../services/telegramWebApp.js';

export const observersRouter = Router();

export function phoneHash(phone) {
  return crypto.createHmac('sha256', config.phoneSalt).update(phone).digest('hex');
}

// Short-lived (7d), device-bound sessions. Auto-resume silently re-issues on the
// saved device, so the short life is invisible to real users but shrinks the
// window a leaked token is useful. `did` = truncated hash of the device id: a
// token stolen and replayed from ANOTHER device fails the check in
// requireObserver (enforced only where the client sends x-device-id — all write
// paths do). Grandfathered tokens without `did` keep working until they expire.
const didHash = (deviceId) =>
  deviceId ? crypto.createHmac('sha256', config.jwtSecret).update(deviceId).digest('hex').slice(0, 24) : null;

function issueToken(observerId, deviceId, via) {
  const claims = { sub: String(observerId) };
  const did = didHash(deviceId);
  if (did) claims.did = did;
  // `via` records HOW this session was proven ('otp' | 'tg' | 'pw' | 'resume').
  // A fresh otp/tg session doubles as the password-reset path in /set-password.
  if (via) claims.via = via;
  return jwt.sign(claims, config.jwtSecret, { expiresIn: '7d' });
}

// --- Optional password sign-in ------------------------------------------------
// Lets an observer sign in on a NEW device without an OTP round-trip. scrypt
// (dependency-free), per-user salt, timing-safe compare. OTP/Telegram remain the
// recovery path, so a forgotten password never locks anyone out.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), crypto.scryptSync(pw, salt, 32));
  } catch {
    return false;
  }
}
// 10 wrong passwords per phone per hour locks the PASSWORD path only — the OTP
// path stays open (it's also the recovery route, and it proves phone control).
const pwFails = new Map();
function pwLocked(hash) {
  const rec = pwFails.get(hash);
  return !!rec && rec.count >= 10 && Date.now() - rec.first < 3600_000;
}
function notePwFail(hash) {
  const rec = pwFails.get(hash);
  if (!rec || Date.now() - rec.first > 3600_000) pwFails.set(hash, { first: Date.now(), count: 1 });
  else rec.count += 1;
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
    INSERT INTO otps (phone_hash, code, expires_at, attempts, sc_reference) VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT(phone_hash) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0, sc_reference = NULL`)
    .run(hash, code, Date.now() + config.otpTtlS * 1000);

  // 'telegram' | 'sms' | 'whatsapp' — the delivery choice made on the sign-up form.
  const channel = ['telegram', 'sms', 'whatsapp'].includes(req.body?.channel) ? req.body.channel : '';
  const sent = await sendOtp(phone, code, hash, channel);
  if (!sent.ok && sent.telegramLink) {
    // Not an error: the observer must open the bot once to link their Telegram.
    return res.json({ ok: true, telegramLink: sent.telegramLink });
  }
  if (!sent.ok) return res.status(502).json({ error: 'sms_send_failed' });

  const body = { ok: true };
  if (sent.viaWhatsapp && sent.scReference) {
    // Sendchamp generated + delivered this code over WhatsApp; /verify must
    // confirm against their reference instead of our local code.
    db.prepare('UPDATE otps SET sc_reference = ? WHERE phone_hash = ?').run(sent.scReference, hash);
    body.viaWhatsapp = true;
  } else if (sent.viaSms) {
    // SMS delivery; the optional Telegram link is offered as an alternative,
    // not auto-launched.
    body.viaSms = true;
    if (sent.telegramLink) body.telegramLink = sent.telegramLink;
  } else if (config.smsProvider === 'telegram') body.viaTelegram = true;
  // The code is only ever echoed back on the dev console provider.
  if (config.env !== 'production' && config.smsProvider === 'console') body.devOtp = code;
  res.json(body);
});

observersRouter.post('/verify', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || '');
  const jwk = req.body?.publicKeyJwk;
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });
  if (!validatePublicKeyJwk(jwk)) return res.status(400).json({ error: 'invalid_public_key' });

  const hash = phoneHash(phone);
  const row = db.prepare('SELECT * FROM otps WHERE phone_hash = ?').get(hash);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'otp_expired' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'too_many_attempts' });
  // WhatsApp codes were generated by Sendchamp — confirm against their
  // reference; every other channel checks our locally stored code. The local
  // attempts counter and expiry apply to both paths.
  const codeOk = row.sc_reference ? await confirmWhatsappOtp(row.sc_reference, otp) : row.code === otp;
  if (!codeOk) {
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
    // the SAME device can auto-resume later without another OTP. A previously
    // deleted ID is resurrected here (same row, same history).
    db.prepare("UPDATE observers SET public_key_jwk = ?, device_id = ?, status = 'active' WHERE id = ?")
      .run(jwkJson, deviceId, observer.id);
  }

  // Telegram: send the observer their identity details, and ping the master.
  const chatId = chatIdByHash(hash);
  const when = new Date(observer.created_at).toISOString().replace('T', ' ').slice(0, 16);
  notifyChat(chatId,
    `✅ Hawkeye verification complete.\nObserver ID: ${observer.id}\nIdentity hash: ${hash.slice(0, 16)}…\nRegistered: ${when} UTC\nThis device is now saved — you won't need to sign up again on it.`);
  notifyMaster(`${isNew ? 'NEW' : 'repeat'} phone verified · observer #${observer.id} · ${hash.slice(0, 12)}…`);
  if (isNew) { try { noteRegistration(); } catch { /* informational only */ } }

  const token = issueToken(observer.id, deviceId, 'otp');
  res.json({ ok: true, observerId: observer.id, token });
});

// Telegram Mini App sign-in: no OTP. Telegram itself vouches for the phone —
// the app calls WebApp.requestContact(), and Telegram hands back a payload
// signed with the bot token containing the account's verified phone number.
// We verify BOTH signatures (initData and the contact payload), require the
// contact to belong to the same Telegram user, then mint the same observer
// identity the OTP path would (same phone hash ⇒ same observer row either way).
observersRouter.post('/telegram-verify', (req, res) => {
  const jwk = req.body?.publicKeyJwk;
  if (!validatePublicKeyJwk(jwk)) return res.status(400).json({ error: 'invalid_public_key' });

  const init = verifyWebAppPayload(String(req.body?.initData || ''));
  if (!init) return res.status(401).json({ error: 'tg_initdata_invalid' });
  const tgUser = parseJsonField(init.user);
  if (!tgUser?.id) return res.status(401).json({ error: 'tg_user_missing' });

  // contact payload: the SDK returns the raw signed querystring (sometimes
  // nested under .response) — accept a string only; anything unverifiable
  // falls back to the SMS flow client-side.
  const rawContact = typeof req.body?.contactResponse === 'string'
    ? req.body.contactResponse
    : req.body?.contactResponse?.response;
  const contactParams = verifyWebAppPayload(String(rawContact || ''), 600);
  const contact = contactParams && parseJsonField(contactParams.contact);
  if (!contact?.phone_number) return res.status(422).json({ error: 'tg_phone_unverified' });
  if (contact.user_id && Number(contact.user_id) !== Number(tgUser.id)) {
    return res.status(401).json({ error: 'tg_user_mismatch' });
  }

  const digits = String(contact.phone_number).replace(/[^\d]/g, '');
  const phone = normalizePhone(digits.startsWith('234') ? `+${digits}` : digits);
  if (!phone) return res.status(400).json({ error: 'not_a_nigerian_number' });

  const hash = phoneHash(phone);
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
    // Telegram's contact-share proves control of the phone, same as a fresh OTP.
    // Also resurrects a previously deleted ID (same row, same history).
    db.prepare("UPDATE observers SET public_key_jwk = ?, device_id = ?, status = 'active' WHERE id = ?")
      .run(jwkJson, deviceId, observer.id);
  }

  // Bind the Telegram chat for alerts/receipts (contact share implies the user
  // has the bot conversation open, so messages will deliver).
  db.prepare('INSERT OR REPLACE INTO telegram_links (phone_hash, chat_id, created_at) VALUES (?, ?, ?)')
    .run(hash, tgUser.id, Date.now());

  notifyChat(tgUser.id,
    `✅ Signed in to Hawkeye via Telegram.\nObserver ID: ${observer.id}\nNo codes needed on this device again.`);
  notifyMaster(`${isNew ? 'NEW' : 'repeat'} Telegram sign-in · observer #${observer.id} · ${hash.slice(0, 12)}…`);
  if (isNew) { try { noteRegistration(); } catch { /* informational only */ } }

  const token = issueToken(observer.id, deviceId, 'tg');
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
    // 200, not 404: an unknown device is the NORMAL first-visit case, and a 4xx
    // here logs a console error on every fresh visitor. Old clients treat
    // "no token" the same as a non-200, so this is backward-compatible.
    return res.json({ ok: false, recognized: false });
  }
  const token = issueToken(observer.id, deviceId, 'resume');
  res.json({ ok: true, observerId: observer.id, token });
});

// Password sign-in: phone + password on ANY device — no OTP. Success is treated
// exactly like a fresh OTP verify: the signing key rotates to this device and it
// becomes the auto-resume device. Deleted/OTP-only accounts are pointed at OTP.
observersRouter.post('/login', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  const jwk = req.body?.publicKeyJwk;
  if (!phone) return res.status(400).json({ error: 'invalid_phone' });
  if (!validatePublicKeyJwk(jwk)) return res.status(400).json({ error: 'invalid_public_key' });

  const hash = phoneHash(phone);
  if (pwLocked(hash)) {
    return res.status(429).json({ error: 'too_many_attempts', hint: 'Too many wrong passwords. Wait an hour, or sign in with an OTP instead.' });
  }
  const observer = db.prepare('SELECT * FROM observers WHERE phone_hash = ?').get(hash);
  if (!observer || observer.status !== 'active' || !observer.password_hash) {
    return res.status(401).json({ error: 'password_login_unavailable', hint: 'No password on this account — sign in with an OTP, then set one on your profile.' });
  }
  if (!verifyPassword(password, observer.password_hash)) {
    notePwFail(hash);
    return res.status(401).json({ error: 'wrong_password', hint: 'Wrong password. Forgot it? Sign in with an OTP to reset.' });
  }
  pwFails.delete(hash);

  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64) || null;
  db.prepare('UPDATE observers SET public_key_jwk = ?, device_id = ? WHERE id = ?')
    .run(JSON.stringify(jwk), deviceId, observer.id);
  // Password ≠ phone proof, so tell the owner a password sign-in happened.
  notifyChat(chatIdByHash(hash),
    `🔑 Password sign-in to your Hawkeye ID (observer #${observer.id}). If this wasn't you, sign in with an OTP and change your password.`);

  const token = issueToken(observer.id, deviceId, 'pw');
  res.json({ ok: true, observerId: observer.id, token });
});

// Set or change the password. Changing an existing one needs the current
// password — unless this session was minted by a fresh OTP/Telegram phone proof
// within 15 min (that IS the forgot-password reset path).
observersRouter.post('/set-password', requireObserver, (req, res) => {
  const pw = String(req.body?.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'password_too_short', hint: 'Use at least 8 characters.' });
  if (pw.length > 200) return res.status(400).json({ error: 'password_too_long' });
  const o = req.observer;
  if (o.password_hash) {
    const fresh = (req.auth?.via === 'otp' || req.auth?.via === 'tg')
      && req.auth.iat * 1000 > Date.now() - 900_000;
    if (!fresh && !verifyPassword(String(req.body?.currentPassword || ''), o.password_hash)) {
      return res.status(401).json({ error: 'current_password_wrong', hint: 'Enter your current password — or sign in with an OTP first to reset it.' });
    }
  }
  db.prepare('UPDATE observers SET password_hash = ? WHERE id = ?').run(hashPassword(pw), o.id);
  notifyChat(chatIdByHash(o.phone_hash),
    `🔒 Your Hawkeye password was ${o.password_hash ? 'changed' : 'set'}. If this wasn't you, sign in with an OTP and change it.`);
  res.json({ ok: true });
});

// Observer profile: identity, saved unit, followed races, and everything this
// observer has reported (PU results, collation reports, incidents).
observersRouter.get('/me', requireObserver, (req, res) => {
  const o = req.observer;
  const unit = db.prepare(`
    SELECT s.pu_code, p.name, p.ward, p.lga, p.state FROM saved_units s
    LEFT JOIN polling_units p ON p.pu_code = s.pu_code
    WHERE s.observer_id = ?`).get(o.id) || null;
  const subscriptions = db.prepare(
    'SELECT contest, state FROM subscriptions WHERE observer_id = ? ORDER BY created_at DESC').all(o.id);
  const reports = db.prepare(`
    SELECT s.pu_code, s.contest, s.created_at, s.entry_hash, p.name, p.lga, p.state
    FROM submissions s LEFT JOIN polling_units p ON p.pu_code = s.pu_code
    WHERE s.observer_id = ? ORDER BY s.created_at DESC LIMIT 50`).all(o.id);
  const collation = db.prepare(`
    SELECT contest, level, state, lga, ward, created_at
    FROM collation_reports WHERE observer_id = ? ORDER BY created_at DESC LIMIT 50`).all(o.id);
  const incidents = db.prepare(`
    SELECT id, kind, status, pu_code, state, created_at
    FROM incidents WHERE observer_id = ? ORDER BY created_at DESC LIMIT 50`).all(o.id);
  res.json({
    ok: true,
    observerId: o.id,
    identityHash: o.phone_hash,
    createdAt: o.created_at,
    hasPassword: !!o.password_hash,
    unit, subscriptions, reports, collation, incidents,
  });
});

// "My polling unit": save the unit you'll observe. Saving subscribes you to
// Telegram alerts for EVERYTHING at that unit — result reports as they land
// and incidents once approved (distinct from following a race on results.html).
observersRouter.get('/my-unit', requireObserver, (req, res) => {
  const row = db.prepare(`
    SELECT s.pu_code, p.name, p.ward, p.lga, p.state FROM saved_units s
    LEFT JOIN polling_units p ON p.pu_code = s.pu_code
    WHERE s.observer_id = ?`).get(req.observer.id);
  res.json({ ok: true, unit: row || null });
});

observersRouter.post('/my-unit', requireObserver, (req, res) => {
  const puCode = String(req.body?.puCode || '').trim();
  const pu = db.prepare('SELECT pu_code, name, ward, lga, state FROM polling_units WHERE pu_code = ?').get(puCode);
  if (!pu) return res.status(404).json({ error: 'unknown_unit' });
  db.prepare('INSERT OR REPLACE INTO saved_units (observer_id, pu_code, created_at) VALUES (?, ?, ?)')
    .run(req.observer.id, puCode, Date.now());
  notifyChat(chatIdByHash(req.observer.phone_hash),
    `⭐ Saved as your polling unit: ${pu.name} (${pu.pu_code})\n${pu.ward} ward, ${pu.lga}, ${pu.state}.\nYou'll get an alert here for every result report and approved incident at this unit.`);
  res.json({ ok: true, unit: pu });
});

observersRouter.post('/my-unit/clear', requireObserver, (req, res) => {
  db.prepare('DELETE FROM saved_units WHERE observer_id = ?').run(req.observer.id);
  res.json({ ok: true });
});

// Self-serve identity deletion. Wipes everything revocable — signing key,
// device binding, Telegram link, subscriptions, pending OTPs — and marks the
// observer 'deleted'. The row itself (id + phone hash) is a permanent
// tombstone: reports already on the public ledger stay (permanence is the
// product), and re-registering the same phone resurrects the SAME observer id,
// so deletion can never buy a second report at the same unit.
observersRouter.post('/delete', requireObserver, (req, res) => {
  const o = req.observer;
  db.transaction(() => {
    db.prepare("UPDATE observers SET status = 'deleted', public_key_jwk = '', device_id = NULL, password_hash = NULL WHERE id = ?").run(o.id);
    db.prepare('DELETE FROM telegram_links WHERE phone_hash = ?').run(o.phone_hash);
    db.prepare('DELETE FROM subscriptions WHERE observer_id = ?').run(o.id);
    db.prepare('DELETE FROM otps WHERE phone_hash = ?').run(o.phone_hash);
  })();
  notifyMaster(`observer #${o.id} deleted their ID (${o.phone_hash.slice(0, 12)}…)`);
  res.json({ ok: true, deleted: true });
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
    for (const t of ['venue_matches', 'verdicts', 'cases', 'docket_ledger', 'discrepancies', 'collation_reports', 'incidents', 'submissions', 'results', 'pu_mappings', 'saved_units', 'subscriptions', 'tg_link_tokens', 'telegram_links', 'device_push_tokens', 'notifications', 'otps', 'observers']) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      db.exec(`DELETE FROM ${t}`);
    }
    // release any crowd-mapped coordinates back to unlocated
    db.prepare("UPDATE polling_units SET lat = NULL, lng = NULL, coords_source = NULL WHERE coords_source = 'crowd_mapped'").run();
    // ...and the tier-2 crowd fixes aggregate.js derives from submission GPS.
    // Without this they outlive the reports that produced them (a wiped test
    // report left a unit permanently mis-located). Bulk 'geocoded' envelopes are
    // NOT observer data — leave those alone.
    db.prepare('UPDATE polling_units SET crowd_lat = NULL, crowd_lng = NULL, crowd_reports = 0 WHERE coords_source IS NULL AND crowd_lat IS NOT NULL').run();
  })();
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM observers').get().c;
  res.json({ ok: true, deleted: counts, remainingObservers: remaining });
});

// Election go-live reset (owner only, guarded by the SAME ADMIN_RESET_SECRET).
// Unlike /admin/reset above, this does NOT touch observers/pu_mappings/
// subscriptions/telegram_links/polling_units — registered observers and mapped
// units carry over so nobody has to re-register on election day. It clears only
// report/result/discrepancy data, so the hash chain and the per-race Merkle
// root both naturally rebuild from genesis on the next submission/anchor cycle
// — no schema change needed (nextEntry/verifyChain/raceSubchains derive purely
// from table contents). Past anchors/Rekor entries are left in place on purpose:
// the next anchor cycle publishes a fresh genesis-head anchor to Rekor, which
// becomes a permanent, public marker of exactly when test data ended and real
// reporting began.
observersRouter.post('/admin/reset-ledger', (req, res) => {
  if (!config.adminResetSecret || req.body?.secret !== config.adminResetSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const counts = {};
  db.transaction(() => {
    // crowd-arbitration tables (cases/verdicts/docket chain) reset with the
    // cycle too — a new election starts with an empty docket at genesis.
    for (const t of ['venue_matches', 'submissions', 'collation_reports', 'results', 'discrepancies', 'verdicts', 'cases', 'docket_ledger']) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      db.exec(`DELETE FROM ${t}`);
    }
  })();
  notifyMaster(`🗳️ LEDGER RESET — cleared ${counts.submissions} PU report(s), ${counts.collation_reports} collation report(s). Chain restarts at genesis; observers and unit mappings kept. Next anchor cycle publishes the reset to Rekor.`);
  res.json({ ok: true, deleted: counts });
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
    // Device binding: if the token is device-bound AND the client sent its
    // device id, they must match — a token replayed from another device fails.
    // (Soft: calls that don't send x-device-id are unaffected; grandfathered
    // tokens without `did` skip the check.)
    if (payload.did) {
      const sent = String(req.headers['x-device-id'] || '').slice(0, 64);
      if (sent && didHash(sent) !== payload.did) {
        return res.status(401).json({ error: 'device_mismatch' });
      }
    }
    req.observer = observer;
    req.auth = payload; // exposes `via` + `iat` (set-password uses these for the OTP-reset path)
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

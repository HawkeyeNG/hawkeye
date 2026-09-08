// Telegram notifications: to a specific observer's linked chat, and to the
// master (owner) chat for every site activity. All best-effort — never block or
// throw into the request path.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { tgSendMessage } from './sms.js';
import { t, langOfHash, normalise, DEFAULT_LANG } from './i18n.js';

function masterHash() {
  if (!config.masterPhone) return null;
  return crypto.createHmac('sha256', config.phoneSalt).update(config.masterPhone).digest('hex');
}

export function chatIdByHash(hash) {
  if (!hash) return null;
  return db.prepare('SELECT chat_id FROM telegram_links WHERE phone_hash = ?').get(hash)?.chat_id || null;
}

// Ping a single observer (by their linked chat_id). No-op if unlinked.
export function notifyChat(chatId, text) {
  if (chatId) tgSendMessage(chatId, text).catch(() => {});
}

/**
 * Ping one observer in THEIR language.
 *
 * Takes the observer row rather than an id so the common case — a handler that
 * already has `req.observer` — costs no query: the language is a column on the
 * row it is holding.
 */
export function notifyObserver(observer, key, params = {}) {
  if (!observer) return;
  const chatId = chatIdByHash(observer.phone_hash);
  if (!chatId) return;
  const lang = normalise(observer.lang) || DEFAULT_LANG;
  notifyChat(chatId, t(lang, key, params));
}

/** Same, when only the id is to hand. */
export function notifyObserverId(observerId, key, params = {}) {
  const row = db.prepare('SELECT phone_hash, lang FROM observers WHERE id = ?').get(observerId);
  if (row) notifyObserver(row, key, params);
}

/** Same, by phone hash — the identifier the sign-in paths carry. */
export function notifyHash(hash, key, params = {}) {
  const chatId = chatIdByHash(hash);
  if (chatId) notifyChat(chatId, t(langOfHash(hash), key, params));
}

/**
 * Alert everyone who saved this polling unit as theirs (Telegram-linked only),
 * EACH IN THEIR OWN LANGUAGE — the query already joins observers, so the
 * language rides along for free and the translation happens per row.
 */
export function notifyUnitSavers(puCode, key, params = {}) {
  if (!puCode) return 0;
  const rows = db.prepare(`
    SELECT t.chat_id, o.lang FROM saved_units s
    JOIN observers o ON o.id = s.observer_id AND o.status = 'active'
    JOIN telegram_links t ON t.phone_hash = o.phone_hash
    WHERE s.pu_code = ?`).all(puCode);
  for (const r of rows) notifyChat(r.chat_id, t(normalise(r.lang) || DEFAULT_LANG, key, params));
  return rows.length;
}

// Ping the master/owner about any activity. No-op unless MASTER_PHONE is set and
// that number has linked its Telegram.
export function notifyMaster(text) {
  const cid = chatIdByHash(masterHash());
  if (cid) tgSendMessage(cid, `🛰️ Hawkeye activity — ${text}`).catch(() => {});
}

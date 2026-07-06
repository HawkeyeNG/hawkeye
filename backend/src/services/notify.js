// Telegram notifications: to a specific observer's linked chat, and to the
// master (owner) chat for every site activity. All best-effort — never block or
// throw into the request path.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { tgSendMessage } from './sms.js';

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

// Ping the master/owner about any activity. No-op unless MASTER_PHONE is set and
// that number has linked its Telegram.
export function notifyMaster(text) {
  const cid = chatIdByHash(masterHash());
  if (cid) tgSendMessage(cid, `🛰️ Hawkeye activity — ${text}`).catch(() => {});
}

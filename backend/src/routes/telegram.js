import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { tgSendMessage } from '../services/sms.js';
import { phoneHash, normalizePhone } from './observers.js';
import { handleUpdate } from '../services/bot.js';

export const telegramRouter = Router();

// Command bot on the separate TEST token (see services/bot.js).
telegramRouter.post('/telegram/webhook-test', async (req, res) => {
  if (!config.telegramTestWebhookSecret ||
      req.headers['x-telegram-bot-api-secret-token'] !== config.telegramTestWebhookSecret) {
    return res.status(403).end();
  }
  res.json({ ok: true }); // ack immediately; process best-effort
  try { await handleUpdate(req.body || {}, config.telegramTestBotToken); } catch (e) { console.error('[tg-test]', e); }
});

// PRODUCTION bot webhook. Does BOTH:
//   • the OTP account-linking flow below (deep-link /start <token> + contact
//     share), and
//   • the full command bot (services/bot.js) for everything else — /report,
//     /incident, /results, inline buttons, quick tips, etc.
// The two linking cases are handled first; any other update is delegated to the
// command handler with the production token.
telegramRouter.post('/telegram/webhook', async (req, res) => {
  // Telegram echoes the secret we registered with setWebhook — reject the rest.
  if (req.headers['x-telegram-bot-api-secret-token'] !== config.telegramWebhookSecret) {
    return res.status(403).end();
  }
  res.json({ ok: true }); // ack immediately; process best-effort below

  try {
    const msg = req.body?.message;
    const chatId = msg?.chat?.id;
    // Linking-specific paths take priority; everything else → command bot.
    const startToken = chatId ? /^\/start (.+)$/.exec(msg.text || '')?.[1] : null;
    if (!chatId || (!startToken && !msg.contact)) {
      await handleUpdate(req.body || {}, config.telegramBotToken);
      return;
    }

    // Step 2: deep-link start
    if (startToken) {
      const row = db.prepare('SELECT * FROM tg_link_tokens WHERE token = ?').get(startToken.trim());
      if (!row || row.expires_at < Date.now()) {
        await tgSendMessage(chatId, 'This link has expired. Go back to the Hawkeye app and tap "Send verification code" again.');
        return;
      }
      db.prepare('UPDATE tg_link_tokens SET chat_id = ? WHERE token = ?').run(chatId, row.token);
      await tgSendMessage(
        chatId,
        'Welcome to Hawkeye. Tap the button below to share your phone number — this confirms the number you entered in the app is really yours.',
        {
          keyboard: [[{ text: '✅ Share my phone number', request_contact: true }]],
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      );
      return;
    }

    // Step 3: contact shared
    if (msg.contact) {
      // must be the sender's OWN contact — not a forwarded acquaintance
      if (msg.contact.user_id !== msg.from?.id) {
        await tgSendMessage(chatId, 'Please share your own contact using the button, not someone else’s.');
        return;
      }
      const pending = db
        .prepare('SELECT * FROM tg_link_tokens WHERE chat_id = ? AND expires_at > ? ORDER BY expires_at DESC')
        .get(chatId, Date.now());
      if (!pending) {
        await tgSendMessage(chatId, 'No pending verification. Go back to the Hawkeye app and tap "Send verification code".');
        return;
      }
      const shared = normalizePhone(msg.contact.phone_number.startsWith('+') ? msg.contact.phone_number : `+${msg.contact.phone_number}`);
      if (!shared || phoneHash(shared) !== pending.phone_hash) {
        await tgSendMessage(chatId, 'This Telegram account’s phone number does not match the number you entered in the Hawkeye app. Enter the number this Telegram account is registered with.');
        return;
      }
      db.prepare('INSERT INTO telegram_links (phone_hash, chat_id, created_at) VALUES (?, ?, ?) ON CONFLICT(phone_hash) DO UPDATE SET chat_id = excluded.chat_id')
        .run(pending.phone_hash, chatId, Date.now());
      db.prepare('DELETE FROM tg_link_tokens WHERE token = ?').run(pending.token);

      const otp = db.prepare('SELECT code, expires_at FROM otps WHERE phone_hash = ?').get(pending.phone_hash);
      if (otp && otp.expires_at > Date.now()) {
        await tgSendMessage(chatId, `Hawkeye code: ${otp.code}. Never share it. You can return to the app now — future codes will arrive here automatically.`, { remove_keyboard: true });
      } else {
        await tgSendMessage(chatId, 'Linked! Go back to the Hawkeye app and tap "Send verification code" again — it will arrive here.', { remove_keyboard: true });
      }
      return;
    }
  } catch (err) {
    console.error('[telegram]', err.message);
  }
});

import crypto from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';

// OTP delivery. Providers:
//   console  — dev only: logs the code, register endpoint echoes it as devOtp
//   termii   — Nigerian SMS/OTP provider (termii.com). The 'dnd' channel delivers
//              to Do-Not-Disturb-listed numbers, which most Nigerian SIMs are.
//   bulksms  — BulkSMSNigeria (bulksmsnigeria.com), 'otp' gateway route.
//   telegram — free Bot API. First time, the observer opens the bot via a
//              one-time deep link and shares their contact (Telegram-verified);
//              once the shared number matches, codes arrive in that chat.
// Returns { ok } — or { ok: false, telegramLink } when the observer still needs
// to link their Telegram account (not an error; the app shows the link).
// `channel` is the USER'S delivery choice from the sign-up form ('telegram' |
// 'sms'); empty = legacy clients, auto behaviour.
export async function sendOtp(phone, code, phoneHash, channel = '') {
  const message = `Hawkeye code: ${code}. Expires in ${Math.round(config.otpTtlS / 60)} min. Never share it.`;
  switch (config.smsProvider) {
    case 'console':
      console.log(`[sms:console] ${phone}: ${message}`);
      return { ok: true };
    case 'termii':
      return { ok: await sendTermii(phone, message) };
    case 'bulksms':
      return { ok: await sendBulkSmsNg(phone, message) };
    case 'telegram': {
      // Explicit SMS choice: straight to SMS, no Telegram involvement.
      if (channel === 'sms') {
        if (await sendFallbackSms(phone, message)) return { ok: true, viaSms: true };
        return { ok: false };
      }
      const link = db.prepare('SELECT chat_id FROM telegram_links WHERE phone_hash = ?').get(phoneHash);
      if (link) {
        if (await tgSendMessage(link.chat_id, message)) return { ok: true };
        // Telegram hiccup (blocked bot, 429, outage) — SMS keeps them moving.
        if (await sendFallbackSms(phone, message)) return { ok: true, viaSms: true };
        return { ok: false };
      }
      // Not linked yet — issue a one-time deep-link token for the bot.
      const token = crypto.randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO tg_link_tokens (token, phone_hash, expires_at) VALUES (?, ?, ?)')
        .run(token, phoneHash, Date.now() + config.otpTtlS * 1000);
      const telegramLink = `https://t.me/${config.telegramBotUsername}?start=${token}`;
      if (channel === 'telegram') {
        // Explicit Telegram choice: the bot link IS the delivery path — no SMS.
        return { ok: false, telegramLink };
      }
      // Legacy clients with no channel choice: SMS out immediately when a
      // provider is configured, bot link rides along as the free alternative.
      if (await sendFallbackSms(phone, message)) return { ok: true, viaSms: true, telegramLink };
      return { ok: false, telegramLink };
    }
    default:
      console.error(`[sms] unknown SMS_PROVIDER: ${config.smsProvider}`);
      return { ok: false };
  }
}

// SMS fallback for the telegram provider — BulkSMSNigeria preferred, Termii as
// legacy second. A provider with no key configured is skipped entirely.
async function sendFallbackSms(phone, message) {
  if (config.bulksmsNgApiToken && await sendBulkSmsNg(phone, message)) return true;
  if (config.termiiApiKey && await sendTermii(phone, message)) return true;
  return false;
}

async function sendBulkSmsNg(phone, sms) {
  try {
    const res = await fetch('https://www.bulksmsnigeria.com/api/v2/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.bulksmsNgApiToken}` },
      body: JSON.stringify({
        from: config.bulksmsNgSenderId,
        to: phone.replace('+', ''), // 2348... — no plus
        body: sms,
        gateway: config.bulksmsNgGateway,
      }),
    });
    const body = await res.json().catch(() => ({}));
    const ok = res.ok && (body.status === 'success' || body?.data?.status === 'success');
    if (!ok) console.error('[sms:bulksms] send failed', res.status, JSON.stringify(body).slice(0, 300));
    return ok;
  } catch (err) {
    console.error('[sms:bulksms]', err.message);
    return false;
  }
}

export async function tgSendMessage(chatId, text, replyMarkup = null) {
  try {
    const body = { chat_id: chatId, text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) console.error('[sms:telegram]', res.status, JSON.stringify(d).slice(0, 200));
    return Boolean(d.ok);
  } catch (err) {
    console.error('[sms:telegram]', err.message);
    return false;
  }
}

async function sendTermii(phone, sms) {
  try {
    const res = await fetch(`${config.termiiBaseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: config.termiiApiKey,
        to: phone.replace('+', ''), // Termii wants 2348..., no plus
        from: config.termiiSenderId,
        sms,
        type: 'plain',
        channel: config.termiiChannel,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.message_id) {
      console.error('[sms:termii] send failed', res.status, JSON.stringify(body));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[sms:termii]', err.message);
    return false;
  }
}

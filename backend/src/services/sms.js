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
// to link their Telegram account (not an error; the app shows the link). When
// Sendchamp generated the code (WhatsApp, or SMS as the primary provider), the
// result carries `scReference` — the caller stores it so /verify confirms
// against Sendchamp instead of our local `code`.
// `channel` is the USER'S delivery choice from the sign-up form ('telegram' |
// 'sms' | 'whatsapp'); empty = legacy clients, auto behaviour.
export async function sendOtp(phone, code, phoneHash, channel = '') {
  const message = `Hawkeye code: ${code}. Expires in ${Math.round(config.otpTtlS / 60)} min. Never share it.`;
  // WhatsApp rides Sendchamp's Verification API (Meta-approved template) —
  // Sendchamp generates + delivers the code and returns a reference we confirm
  // against. On failure it drops to the SMS chain.
  if (channel === 'whatsapp') {
    if (config.sendchampApiKey) {
      const reference = await createScOtp(phone, 'whatsapp');
      if (reference) return { ok: true, viaWhatsapp: true, scReference: reference };
    }
    const s = await sendSms(phone, message);
    return s.ok ? { ok: true, viaSms: true, scReference: s.scReference } : { ok: false };
  }
  switch (config.smsProvider) {
    case 'console':
      console.log(`[sms:console] ${phone}: ${message}`);
      return { ok: true };
    case 'termii':
      return { ok: await sendTermii(phone, message) };
    case 'bulksms':
      return { ok: await sendBulkSmsNg(phone, message) };
    case 'telegram': {
      // Explicit SMS choice: straight to the SMS chain, no Telegram involvement.
      if (channel === 'sms') {
        const s = await sendSms(phone, message);
        return s.ok ? { ok: true, viaSms: true, scReference: s.scReference } : { ok: false };
      }
      const link = db.prepare('SELECT chat_id FROM telegram_links WHERE phone_hash = ?').get(phoneHash);
      if (link) {
        if (await tgSendMessage(link.chat_id, message)) return { ok: true };
        // Telegram hiccup (blocked bot, 429, outage) — SMS keeps them moving.
        const s = await sendSms(phone, message);
        return s.ok ? { ok: true, viaSms: true, scReference: s.scReference } : { ok: false };
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
      const s = await sendSms(phone, message);
      return s.ok ? { ok: true, viaSms: true, scReference: s.scReference, telegramLink } : { ok: false, telegramLink };
    }
    default:
      console.error(`[sms] unknown SMS_PROVIDER: ${config.smsProvider}`);
      return { ok: false };
  }
}

// SMS delivery chain. Order is config-driven (SMS_PRIMARY): Nigerian carriers
// silently drop SMS from unapproved sender IDs, and sender approval is
// per-provider and asynchronous — so the chain leads with whichever provider
// currently has an APPROVED sender. Sendchamp generates its own code and
// returns a reference (confirmed in /verify against sc_reference); BulkSMS and
// Termii send our local `message`. A provider with no key configured is
// skipped. Returns { ok, scReference? }.
async function sendSms(phone, message) {
  const viaSendchamp = async () => {
    if (!config.sendchampApiKey) return null;
    const ref = await createScOtp(phone, 'sms');
    return ref ? { ok: true, scReference: ref } : null;
  };
  const viaBulksms = async () =>
    (config.bulksmsNgApiToken && await sendBulkSmsNg(phone, message)) ? { ok: true } : null;
  const order = config.smsPrimary === 'bulksms' ? [viaBulksms, viaSendchamp] : [viaSendchamp, viaBulksms];
  for (const attempt of order) {
    const r = await attempt();
    if (r) return r;
  }
  if (config.termiiApiKey && await sendTermii(phone, message)) return { ok: true };
  return { ok: false };
}

// Sendchamp Verification API — create sends the OTP over the given channel
// ('sms' | 'whatsapp') and returns a reference; confirm checks a submitted code
// against that reference. Their status field has appeared as both a string and
// a number, so accept either.
const SC_HEADERS = () => ({ 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${config.sendchampApiKey}` });
const scOk = (res, body) => res.ok && (body.status === 'success' || body.status === 200 || body.code === 200);

async function createScOtp(phone, channel) {
  try {
    const res = await fetch('https://api.sendchamp.com/api/v1/verification/create', {
      method: 'POST',
      headers: SC_HEADERS(),
      body: JSON.stringify({
        channel, // 'sms' | 'whatsapp'
        sender: config.sendchampSender,
        token_type: 'numeric',
        token_length: 6,
        expiration_time: Math.max(1, Math.round(config.otpTtlS / 60)),
        customer_mobile_number: phone.replace('+', ''),
      }),
    });
    const body = await res.json().catch(() => ({}));
    const reference = body?.data?.reference || body?.data?.id || null;
    if (!scOk(res, body) || !reference) {
      console.error(`[sms:sendchamp:${channel}] create failed`, res.status, JSON.stringify(body).slice(0, 300));
      return null;
    }
    return String(reference);
  } catch (err) {
    console.error(`[sms:sendchamp:${channel}]`, err.message);
    return null;
  }
}

export async function confirmScOtp(reference, code) {
  try {
    const res = await fetch('https://api.sendchamp.com/api/v1/verification/confirm', {
      method: 'POST',
      headers: SC_HEADERS(),
      body: JSON.stringify({ verification_reference: reference, verification_code: code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!scOk(res, body)) {
      console.error('[sms:sendchamp] confirm rejected', res.status, JSON.stringify(body).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[sms:sendchamp]', err.message);
    return false;
  }
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

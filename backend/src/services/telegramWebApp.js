// Telegram Mini App payload verification (Bot API "Validating data received
// via the Mini App"): every signed payload is a querystring whose `hash` is
// HMAC-SHA256(data_check_string, secret_key), where
//   secret_key = HMAC-SHA256(bot_token) keyed with the literal "WebAppData"
// and data_check_string is the remaining key=value pairs sorted and joined
// with \n. The same scheme signs both initData and the requestContact result.
import crypto from 'node:crypto';
import { config } from '../config.js';

function secretKey() {
  return crypto.createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
}

// Returns the parsed params (as an object) when the signature is valid and
// fresh; null otherwise. `maxAgeS` guards against replayed payloads.
export function verifyWebAppPayload(raw, maxAgeS = 86400) {
  if (!config.telegramBotToken || typeof raw !== 'string' || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const expected = crypto.createHmac('sha256', secretKey()).update(check).digest('hex');
  if (expected.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) return null;
  const out = Object.fromEntries(params.entries());
  const age = Date.now() / 1000 - Number(out.auth_date || 0);
  if (!Number.isFinite(age) || age < -300 || age > maxAgeS) return null;
  return out;
}

export function parseJsonField(v) {
  try { return JSON.parse(v); } catch { return null; }
}

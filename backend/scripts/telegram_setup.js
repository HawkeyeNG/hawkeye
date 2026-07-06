// One-time Telegram bot wiring: validates the token, then registers the webhook.
//
//   node scripts/telegram_setup.js [https://hawkeye.com.ng]
//
// Prereqs in .env: TELEGRAM_BOT_TOKEN (from @BotFather), TELEGRAM_BOT_USERNAME.
import { config } from '../src/config.js';

if (!config.telegramBotToken) {
  console.error('Set TELEGRAM_BOT_TOKEN in backend/.env first (create a bot with @BotFather).');
  process.exit(1);
}
const base = (process.argv[2] || 'https://hawkeye.com.ng').replace(/\/$/, '');
const api = (m, body) =>
  fetch(`https://api.telegram.org/bot${config.telegramBotToken}/${m}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

const me = await api('getMe');
if (!me.ok) {
  console.error('Token rejected by Telegram:', JSON.stringify(me));
  process.exit(1);
}
console.log(`bot: @${me.result.username} (${me.result.first_name})`);
if (me.result.username !== config.telegramBotUsername) {
  console.warn(`WARNING: TELEGRAM_BOT_USERNAME=${config.telegramBotUsername || '(unset)'} but the token belongs to @${me.result.username} — fix .env or deep links will point at the wrong bot.`);
}

const hook = await api('setWebhook', {
  url: `${base}/api/telegram/webhook`,
  secret_token: config.telegramWebhookSecret,
  allowed_updates: ['message'],
  drop_pending_updates: true,
});
console.log('setWebhook:', JSON.stringify(hook));
const info = await api('getWebhookInfo');
console.log('webhook info:', JSON.stringify(info.result));

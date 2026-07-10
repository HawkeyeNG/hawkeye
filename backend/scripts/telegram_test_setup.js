// One-time setup for the TEST command bot (reads TELEGRAM_TEST_BOT_TOKEN from
// the LOCAL .env): registers the "/" command menu, the Mini App menu button,
// and points the webhook at /api/telegram/webhook-test with the derived secret.
//   node scripts/telegram_test_setup.js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = fs.readFileSync(path.join(backend, '.env'), 'utf8');
const token = /^TELEGRAM_TEST_BOT_TOKEN=(\S+)/m.exec(env)?.[1];
if (!token) { console.error('TELEGRAM_TEST_BOT_TOKEN missing from .env'); process.exit(1); }
const secret = crypto.createHmac('sha256', 'hawkeye-tg-test').update(token).digest('hex').slice(0, 32);

const api = (m, body) => fetch(`https://api.telegram.org/bot${token}/${m}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

const me = await api('getMe', {});
console.log('bot:', me.result?.username, me.ok ? 'OK' : me);

console.log('commands:', (await api('setMyCommands', { commands: [
  { command: 'report', description: 'Report a polling-unit result' },
  { command: 'collation', description: 'Report a collation result' },
  { command: 'incident', description: 'Report an incident / quick tip' },
  { command: 'mapunit', description: 'Map & save your polling unit' },
  { command: 'ledger', description: 'Verify the public ledger' },
  { command: 'results', description: 'Live leaderboard snapshot' },
  { command: 'myunit', description: 'Activity at your saved unit' },
  { command: 'whoami', description: 'Your observer identity' },
  { command: 'ask', description: 'Ask about the results in plain English' },
  { command: 'cancel', description: 'Abandon the current flow' },
  { command: 'help', description: 'All commands' },
] })).ok);

console.log('menu button:', (await api('setChatMenuButton', {
  menu_button: { type: 'web_app', text: 'Open Hawkeye', web_app: { url: 'https://hawkeye.com.ng/' } },
})).ok);

const wh = await api('setWebhook', {
  url: 'https://hawkeye.com.ng/api/telegram/webhook-test',
  secret_token: secret,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});
console.log('webhook:', wh.ok ? 'OK' : wh);
console.log('info:', JSON.stringify((await api('getWebhookInfo', {})).result));

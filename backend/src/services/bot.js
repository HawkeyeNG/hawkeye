// Hawkeye command bot. Runs on either the TEST or the PRODUCTION bot token — the
// token is threaded through every call, so the same logic serves both bots.
// Architecture: commands are the menu; evidence flows open the Mini App at the
// right page (device-held keys + live camera preserved); chat-native answers
// for quick queries; one "lite" flow — /incident quick tips typed in chat,
// stored lower-trust and human-reviewed like every incident.
//
// Session state for multi-step chat flows lives in tg_sessions (chat_id PK).
// A private chat_id equals the Telegram user id, so identities linked through
// the OTP flow (telegram_links) resolve here too.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../db.js';
import { config } from '../config.js';

const SITE = 'https://hawkeye.com.ng';
const incidentDir = path.join(config.uploadDir, 'incidents');
fs.mkdirSync(incidentDir, { recursive: true });

function tgApi(token, method, payload) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json()).catch(() => null);
}
const send = (token, chatId, text, extra = {}) =>
  tgApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });

const webAppBtn = (text, page) => ({ text, web_app: { url: `${SITE}/${page}` } });

const KIND_LABEL = {
  violence: '⚠️ Violence', ballot_snatching: '🗳️ Ballot snatching', vote_buying: '💰 Vote buying',
  intimidation: '😨 Intimidation', bvas_failure: '📵 BVAS failure', late_materials: '⏰ Late materials',
  obstruction: '🚧 Obstruction', other: '❓ Other',
};

const session = {
  get: (chatId) => {
    const r = db.prepare('SELECT * FROM tg_sessions WHERE chat_id = ?').get(chatId);
    return r ? { ...r, data: JSON.parse(r.data_json || '{}') } : null;
  },
  set: (chatId, flow, step, data = {}) => db.prepare(
    'INSERT OR REPLACE INTO tg_sessions (chat_id, flow, step, data_json, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(chatId, flow, step, JSON.stringify(data), Date.now()),
  clear: (chatId) => db.prepare('DELETE FROM tg_sessions WHERE chat_id = ?').run(chatId),
};

function linkedObserver(chatId) {
  return db.prepare(`
    SELECT o.* FROM telegram_links t
    JOIN observers o ON o.phone_hash = t.phone_hash
    WHERE t.chat_id = ? AND o.status = 'active'`).get(chatId);
}

// Internal API call (the origin lock also guards localhost, so stamp the header).
function ownApi(p) {
  const headers = config.originAuthSecret ? { 'x-origin-auth': config.originAuthSecret } : {};
  return fetch(`http://127.0.0.1:${config.port}${p}`, { headers }).then((r) => r.json());
}

const HELP = [
  '<b>Hawkeye</b> — the count, witnessed and unchangeable.',
  '',
  '/report — report a polling-unit result',
  '/collation — report a collation result',
  '/incident — report an incident (full or quick tip)',
  '/mapunit — map / save your polling unit',
  '/ledger — verify the public ledger',
  '/results — live leaderboard snapshot',
  '/myunit — activity at your saved unit',
  '/whoami — your observer identity',
  '/cancel — abandon the current flow',
].join('\n');

async function cmdResults(token, chatId) {
  try {
    const d = await ownApi('/api/national/PRES');
    if (!d.unitsReporting) return send(token, chatId, 'No reports yet for the presidential race. Be the first: /report');
    const total = d.national.reduce((s, r) => s + r.votes, 0);
    const rows = d.national.slice(0, 6).map((r, i) =>
      `${i + 1}. <b>${r.party}</b> — ${r.votes.toLocaleString()} (${total ? ((r.votes / total) * 100).toFixed(1) : 0}%)`);
    return send(token, chatId, `📊 <b>Presidential — crowd tally (unofficial)</b>\n${d.unitsReporting} unit(s) reporting\n\n${rows.join('\n')}\n\nFull maps: ${SITE}/results.html`);
  } catch { return send(token, chatId, 'Could not fetch results right now — try again shortly.'); }
}

function cmdMyUnit(token, chatId) {
  const o = linkedObserver(chatId);
  if (!o) return send(token, chatId, 'Not linked yet — register in the app first (it links this Telegram automatically): /report');
  const u = db.prepare(`
    SELECT s.pu_code, p.name, p.ward, p.lga, p.state FROM saved_units s
    LEFT JOIN polling_units p ON p.pu_code = s.pu_code WHERE s.observer_id = ?`).get(o.id);
  if (!u) return send(token, chatId, 'No saved unit yet. Save one to get alerts for everything there:', {
    reply_markup: { inline_keyboard: [[webAppBtn('⭐ Map & save my unit', 'map-unit.html')]] } });
  const reports = db.prepare('SELECT COUNT(*) c FROM submissions WHERE pu_code = ?').get(u.pu_code).c;
  const incidents = db.prepare("SELECT COUNT(*) c FROM incidents WHERE pu_code = ? AND status = 'published'").get(u.pu_code).c;
  return send(token, chatId, `⭐ <b>${u.name || u.pu_code}</b> (${u.pu_code})\n${u.ward} ward, ${u.lga}, ${u.state}\n\nResult reports: ${reports}\nPublished incidents: ${incidents}\n\nYou're alerted here the moment anything new lands.`);
}

function cmdWhoami(token, chatId) {
  const o = linkedObserver(chatId);
  if (!o) return send(token, chatId, 'Not linked to an observer identity yet. Register via /report — sign-in inside Telegram needs no code.');
  const when = new Date(o.created_at).toISOString().slice(0, 10);
  return send(token, chatId, `🪪 Observer <b>#${o.id}</b>\nIdentity hash: <code>${o.phone_hash.slice(0, 16)}…</code>\nRegistered: ${when}\nYour reports are signed and permanent; your number is never stored in readable form.`);
}

async function saveTelegramPhoto(token, fileId) {
  const info = await tgApi(token, 'getFile', { file_id: fileId });
  const fp = info?.result?.file_path;
  if (!fp) return null;
  const buf = Buffer.from(await (await fetch(
    `https://api.telegram.org/file/bot${token}/${fp}`)).arrayBuffer());
  // same hygiene as the web incident route: re-encode, strip EXIF/GPS
  const jpeg = await sharp(buf, { failOn: 'error' }).rotate().jpeg({ quality: 88 }).toBuffer();
  const name = `${crypto.randomBytes(12).toString('hex')}.jpg`;
  fs.writeFileSync(path.join(incidentDir, name), jpeg);
  return { file: `incidents/${name}`, type: 'image' };
}

async function finishTip(token, chatId, s, text, photoFileId) {
  const media = [];
  if (photoFileId) {
    try { const m = await saveTelegramPhoto(token, photoFileId); if (m) media.push(m); } catch { /* skip bad file */ }
  }
  const description = String(text || '').trim().slice(0, 2000);
  if (!description && !media.length) {
    return send(token, chatId, 'Add a short description or a photo (or /cancel).');
  }
  const o = linkedObserver(chatId);
  db.prepare(`
    INSERT INTO incidents (observer_id, kind, description, media_json, lat, lng, pu_code, state, status, created_at)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'pending', ?)`)
    .run(o?.id ?? null, s.data.kind, `[telegram tip] ${description}`.trim(), JSON.stringify(media), Date.now());
  session.clear(chatId);
  return send(token, chatId, '✅ Tip received and queued for human review. If approved it appears on the public incidents page. Thank you for protecting the vote.');
}

// Handle one Telegram update for the bot identified by `token`. Returns true if
// it consumed the update (so the OTP webhook knows not to also process it).
export async function handleUpdate(update, token) {
  // inline-button presses (incident kind picker / quick-tip choice)
  const cb = update.callback_query;
  if (cb?.message?.chat?.id) {
    const chatId = cb.message.chat.id;
    tgApi(token, 'answerCallbackQuery', { callback_query_id: cb.id });
    if (cb.data === 'tip:start') {
      const rows = Object.entries(KIND_LABEL).map(([k, label]) => [{ text: label, callback_data: `tip:kind:${k}` }]);
      session.set(chatId, 'tip', 'kind');
      await send(token, chatId, 'What kind of incident?', { reply_markup: { inline_keyboard: rows } });
      return true;
    }
    const kind = /^tip:kind:(\w+)$/.exec(cb.data || '')?.[1];
    if (kind && KIND_LABEL[kind]) {
      session.set(chatId, 'tip', 'content', { kind });
      await send(token, chatId, `${KIND_LABEL[kind]} — now send ONE message describing what happened. Attach a photo if you have one (as a photo, with your text as its caption). /cancel to abort.`);
    }
    return true;
  }

  const msg = update.message;
  if (!msg?.chat?.id || msg.chat.type !== 'private') return false;
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  if (text === '/cancel') { session.clear(chatId); await send(token, chatId, 'Cancelled.'); return true; }
  if (text === '/start' || text === '/help') { session.clear(chatId); await send(token, chatId, HELP); return true; }

  if (text === '/report') { await send(token, chatId, '📋 Report the result announced at your polling unit (photos are captured live and signed on your phone):', { reply_markup: { inline_keyboard: [[webAppBtn('Open result reporter', 'observe.html?intent=observe')]] } }); return true; }
  if (text === '/collation') { await send(token, chatId, '🏛️ Report a collation-centre result:', { reply_markup: { inline_keyboard: [[webAppBtn('Open collation reporter', 'collation.html')]] } }); return true; }
  if (text === '/mapunit') { await send(token, chatId, '📍 Map your polling unit before election day — and save it to get alerts for everything there:', { reply_markup: { inline_keyboard: [[webAppBtn('Open unit mapper', 'map-unit.html')]] } }); return true; }
  if (text === '/ledger') { await send(token, chatId, '🔒 Re-verify the whole public ledger in your own browser — no trust required:', { reply_markup: { inline_keyboard: [[webAppBtn('Open ledger verifier', 'ledger.html')]] } }); return true; }
  if (text === '/incident') {
    await send(token, chatId, '🚨 Report an incident. The full reporter attaches signed photos and location; a quick tip is a fast note typed here (reviewed, lower evidential weight).', {
      reply_markup: { inline_keyboard: [
        [webAppBtn('Open full incident reporter', 'incidents.html')],
        [{ text: '⚡ Send a quick tip here instead', callback_data: 'tip:start' }],
      ] },
    });
    return true;
  }
  if (text === '/results') { await cmdResults(token, chatId); return true; }
  if (text === '/myunit') { await cmdMyUnit(token, chatId); return true; }
  if (text === '/whoami') { await cmdWhoami(token, chatId); return true; }

  // mid-flow content (quick tip)
  const s = session.get(chatId);
  if (s?.flow === 'tip' && s.step === 'content') {
    const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : null;
    await finishTip(token, chatId, s, msg.caption || msg.text, photo);
    return true;
  }

  await send(token, chatId, `Didn't catch that — here's what I can do:\n\n${HELP}`);
  return true;
}

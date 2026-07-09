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
import { db, partyCodes, contests } from '../db.js';
import { config } from '../config.js';
import { contestApplies } from './scope.js';
import { askAssistant, assistantEnabled } from './assistant.js';

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
  '/ask — ask about the results in plain English',
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

// ---- hybrid /report: collect PU + votes in chat, hand off to the Mini App for
// the live photo + on-device signature (chat can't force camera-only capture).
const CONTEST_LABEL = Object.fromEntries(contests.map((c) => [c.code, c.name]));
const puByCode = (code) => db.prepare(
  'SELECT pu_code, name, ward, lga, state, senatorial, federal_constituency FROM polling_units WHERE pu_code = ?',
).get(String(code || '').trim().toUpperCase());
const contestKeyboard = (pu) => ({
  inline_keyboard: contests.filter((c) => contestApplies(pu, c.code))
    .map((c) => [{ text: c.name, callback_data: `rep:contest:${c.code}` }]),
});

function startReport(token, chatId) {
  session.set(chatId, 'report', 'pu', {});
  const o = linkedObserver(chatId);
  const kb = [];
  if (o) {
    const su = db.prepare(`SELECT s.pu_code, p.name FROM saved_units s
      LEFT JOIN polling_units p ON p.pu_code = s.pu_code WHERE s.observer_id = ?`).get(o.id);
    if (su) kb.push([{ text: `⭐ ${su.name || su.pu_code}`, callback_data: 'rep:usesaved' }]);
  }
  kb.push([{ text: '🔎 Browse by state → unit', callback_data: 'rp:browse' }]);
  return send(token, chatId,
    '📋 Report a polling-unit result.\n\nWhich unit? Tap <b>Browse</b> to pick it from a list, or send its <b>PU code</b> (e.g. <code>25-01-05-012</code>) — /mapunit shows yours if unsure.'
    + (kb.length > 1 ? '\n\nYour saved unit:' : ''),
    { reply_markup: { inline_keyboard: kb } });
}

// Register-browse keyboards. A tall grid scrolls in the chat, so most lists show
// in full; pagination kicks in only for very long ones (big wards).
const editKb = (token, chatId, msgId, text, kb) =>
  tgApi(token, 'editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', reply_markup: kb });
const reg = (path) => ownApi(path);
function pagedKb(items, sel, nav, pageNo) {
  const PAGE = 30, start = pageNo * PAGE, slice = items.slice(start, start + PAGE), rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    for (let j = i; j < i + 2 && j < slice.length; j++) {
      const abs = start + j, t = items[abs];
      row.push({ text: t.length > 26 ? t.slice(0, 25) + '…' : t, callback_data: `${sel}:${abs}` });
    }
    rows.push(row);
  }
  const tp = Math.ceil(items.length / PAGE);
  if (tp > 1) {
    const n = [];
    if (pageNo > 0) n.push({ text: '◀', callback_data: `${nav}:${pageNo - 1}` });
    n.push({ text: `${pageNo + 1}/${tp}`, callback_data: 'rp:noop' });
    if (pageNo < tp - 1) n.push({ text: '▶', callback_data: `${nav}:${pageNo + 1}` });
    rows.push(n);
  }
  return { inline_keyboard: rows };
}
function puKb(units, pageNo) {
  const PAGE = 8, start = pageNo * PAGE, slice = units.slice(start, start + PAGE);
  const rows = slice.map((u) => [{ text: (u.name || u.pu_code).slice(0, 48), callback_data: `rp:pu:${u.pu_code}` }]);
  const tp = Math.ceil(units.length / PAGE);
  if (tp > 1) {
    const n = [];
    if (pageNo > 0) n.push({ text: '◀', callback_data: `rp:pup:${pageNo - 1}` });
    n.push({ text: `${pageNo + 1}/${tp}`, callback_data: 'rp:noop' });
    if (pageNo < tp - 1) n.push({ text: '▶', callback_data: `rp:pup:${pageNo + 1}` });
    rows.push(n);
  }
  return { inline_keyboard: rows };
}

async function reportSetPu(token, chatId, code) {
  const pu = puByCode(code);
  if (!pu) { await send(token, chatId, 'No unit with that code. Send a valid PU code like <code>25-01-05-012</code>, or /cancel.'); return; }
  session.set(chatId, 'report', 'contest', { pu: pu.pu_code, puName: `${pu.name} (${pu.pu_code})`, state: pu.state });
  await send(token, chatId, `Unit: <b>${pu.name}</b>\n${pu.ward} ward, ${pu.lga}, ${pu.state}.\n\nWhich election?`,
    { reply_markup: contestKeyboard(pu) });
}

function parseVotes(text) {
  const out = [];
  for (const tok of String(text || '').split(/[\n,;]+/)) {
    const m = /([A-Za-z]{1,6})\D+(\d[\d,]*)/.exec(tok.trim());
    if (!m) continue;
    const party = m[1].toUpperCase();
    const count = Number(m[2].replace(/,/g, ''));
    if (partyCodes.has(party) && Number.isInteger(count) && count >= 0) out.push({ party, count });
  }
  return out;
}

function reportHandoff(token, chatId, s) {
  const url = `${SITE}/observe.html?intent=observe&tg=1&pu=${encodeURIComponent(s.data.pu)}`
    + `&contest=${encodeURIComponent(s.data.contest)}&votes=${encodeURIComponent(JSON.stringify(s.data.votes))}`;
  const rows = s.data.votes.map((v) => `${v.party} — ${v.count.toLocaleString()}`).join('\n');
  session.clear(chatId);
  return send(token, chatId,
    `✅ <b>${s.data.puName}</b>\n${CONTEST_LABEL[s.data.contest] || s.data.contest}\n${rows}\n\n`
    + 'Last step — open the camera to photograph the result sheet. Photos are captured <b>live</b> and signed on your phone; that is what makes the report trustworthy.',
    { reply_markup: { inline_keyboard: [[{ text: '📸 Open camera & submit', web_app: { url } }]] } });
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
    if (cb.data === 'rep:usesaved') {
      const o = linkedObserver(chatId);
      const su = o && db.prepare('SELECT pu_code FROM saved_units WHERE observer_id = ?').get(o.id);
      if (su) await reportSetPu(token, chatId, su.pu_code);
      else await send(token, chatId, 'No saved unit found — send the PU code instead.');
      return true;
    }
    const rc = /^rep:contest:(\w+)$/.exec(cb.data || '')?.[1];
    if (rc) {
      const s = session.get(chatId);
      if (s?.flow === 'report') {
        session.set(chatId, 'report', 'votes', { ...s.data, contest: rc });
        await send(token, chatId, `${CONTEST_LABEL[rc] || rc}. Now send the votes — one party per line or comma-separated, e.g.\n<code>APC 341\nPDP 220\nLP 190</code>`);
      }
      return true;
    }
    // ---- browse cascade: state -> LGA -> ward -> unit, all editing one message ----
    const msgId = cb.message.message_id;
    const bData = () => (session.get(chatId) || { data: {} }).data;
    if (cb.data === 'rp:noop') return true;
    if (cb.data === 'rp:browse') {
      session.set(chatId, 'report', 'browse', {});
      await editKb(token, chatId, msgId, 'Pick a <b>state</b>:', pagedKb(await reg('/api/register/states'), 'rp:st', 'rp:stp', 0));
      return true;
    }
    let m = /^rp:stp:(\d+)$/.exec(cb.data);
    if (m) { await editKb(token, chatId, msgId, 'Pick a <b>state</b>:', pagedKb(await reg('/api/register/states'), 'rp:st', 'rp:stp', +m[1])); return true; }
    m = /^rp:st:(\d+)$/.exec(cb.data);
    if (m) {
      const state = (await reg('/api/register/states'))[+m[1]];
      session.set(chatId, 'report', 'browse', { ...bData(), bState: state });
      const lgas = await reg('/api/register/lgas?state=' + encodeURIComponent(state));
      await editKb(token, chatId, msgId, `State: <b>${state}</b>\nPick an <b>LGA</b>:`, pagedKb(lgas, 'rp:lg', 'rp:lgp', 0));
      return true;
    }
    m = /^rp:lgp:(\d+)$/.exec(cb.data);
    if (m) { const d = bData(); await editKb(token, chatId, msgId, `State: <b>${d.bState}</b>\nPick an <b>LGA</b>:`, pagedKb(await reg('/api/register/lgas?state=' + encodeURIComponent(d.bState)), 'rp:lg', 'rp:lgp', +m[1])); return true; }
    m = /^rp:lg:(\d+)$/.exec(cb.data);
    if (m) {
      const d = bData();
      const lga = (await reg('/api/register/lgas?state=' + encodeURIComponent(d.bState)))[+m[1]];
      session.set(chatId, 'report', 'browse', { ...d, bLga: lga });
      const wards = await reg(`/api/register/wards?state=${encodeURIComponent(d.bState)}&lga=${encodeURIComponent(lga)}`);
      await editKb(token, chatId, msgId, `${d.bState} · <b>${lga}</b>\nPick a <b>ward</b>:`, pagedKb(wards, 'rp:wd', 'rp:wdp', 0));
      return true;
    }
    m = /^rp:wdp:(\d+)$/.exec(cb.data);
    if (m) { const d = bData(); await editKb(token, chatId, msgId, `${d.bState} · <b>${d.bLga}</b>\nPick a <b>ward</b>:`, pagedKb(await reg(`/api/register/wards?state=${encodeURIComponent(d.bState)}&lga=${encodeURIComponent(d.bLga)}`), 'rp:wd', 'rp:wdp', +m[1])); return true; }
    m = /^rp:wd:(\d+)$/.exec(cb.data);
    if (m) {
      const d = bData();
      const ward = (await reg(`/api/register/wards?state=${encodeURIComponent(d.bState)}&lga=${encodeURIComponent(d.bLga)}`))[+m[1]];
      session.set(chatId, 'report', 'browse', { ...d, bWard: ward });
      const { units } = await reg(`/api/register/units?state=${encodeURIComponent(d.bState)}&lga=${encodeURIComponent(d.bLga)}&ward=${encodeURIComponent(ward)}`);
      await editKb(token, chatId, msgId, `${d.bLga} · <b>${ward}</b> ward\nPick your <b>polling unit</b>:`, puKb(units, 0));
      return true;
    }
    m = /^rp:pup:(\d+)$/.exec(cb.data);
    if (m) { const d = bData(); const { units } = await reg(`/api/register/units?state=${encodeURIComponent(d.bState)}&lga=${encodeURIComponent(d.bLga)}&ward=${encodeURIComponent(d.bWard)}`); await editKb(token, chatId, msgId, `${d.bLga} · <b>${d.bWard}</b> ward\nPick your <b>polling unit</b>:`, puKb(units, +m[1])); return true; }
    m = /^rp:pu:(.+)$/.exec(cb.data);
    if (m) { await reportSetPu(token, chatId, m[1]); return true; }
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

  if (text === '/report') { await startReport(token, chatId); return true; }
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
  if (text === '/ask' || text.startsWith('/ask ')) {
    const q = text.slice(4).trim();
    if (!assistantEnabled()) { await send(token, chatId, 'The results assistant isn\'t switched on yet.'); return true; }
    if (!q) { await send(token, chatId, 'Ask about the results, e.g. <code>/ask presidential tally so far</code> or <code>/ask how many units are mapped</code>.'); return true; }
    await tgApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    const r = await askAssistant(q);
    await send(token, chatId, `${r.answer || 'Assistant is unavailable right now.'}\n\n<i>Crowd-reported, unofficial. INEC declares official results.</i>`);
    return true;
  }
  if (text === '/myunit') { await cmdMyUnit(token, chatId); return true; }
  if (text === '/whoami') { await cmdWhoami(token, chatId); return true; }

  // mid-flow content
  const s = session.get(chatId);
  if (s?.flow === 'tip' && s.step === 'content') {
    const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1].file_id : null;
    await finishTip(token, chatId, s, msg.caption || msg.text, photo);
    return true;
  }
  if (s?.flow === 'report' && s.step === 'pu') { await reportSetPu(token, chatId, text); return true; }
  if (s?.flow === 'report' && s.step === 'votes') {
    const votes = parseVotes(text);
    if (!votes.length) {
      await send(token, chatId, 'I could not read any party votes. Send lines like <code>APC 341</code> (known party codes only), or /cancel.');
      return true;
    }
    await reportHandoff(token, chatId, { data: { ...s.data, votes } });
    return true;
  }

  await send(token, chatId, `Didn't catch that — here's what I can do:\n\n${HELP}`);
  return true;
}

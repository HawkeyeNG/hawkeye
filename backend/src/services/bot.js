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

// HTML-escape dynamic values before dropping them into a parse_mode:'HTML' message.
// INEC polling-unit/ward names routinely contain "&" (e.g. "...School & Health
// Centre") — unescaped, Telegram rejects the whole message with an entity-parse
// error. tgApi() only catches network-level failures, so that rejection (HTTP 200,
// body {ok:false}) was silently swallowed: the button's tap-loading spinner
// answered and vanished (answerCallbackQuery fires unconditionally) while the
// edit/send it was waiting on never actually posted — exactly the "loading box
// disappears and nothing happens" symptom on the browse-by-state → unit flow.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// NOTE: no localhost self-fetch here. Under Passenger the app listens on
// Passenger's socket, NOT config.port, so fetch('http://127.0.0.1:<port>/…')
// never connects in production — anything the bot needs from its own data must
// query the DB directly (we're in the same process as the API anyway).

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
    const units = db.prepare("SELECT votes_json FROM results WHERE contest = 'PRES'").all();
    if (!units.length) return send(token, chatId, 'No reports yet for the presidential race. Be the first: /report');
    const nat = {};
    for (const u of units) {
      for (const v of JSON.parse(u.votes_json)) if (v.count) nat[v.party] = (nat[v.party] || 0) + v.count;
    }
    const ranked = Object.entries(nat).map(([party, votes]) => ({ party, votes })).sort((a, b) => b.votes - a.votes);
    const total = ranked.reduce((s, r) => s + r.votes, 0);
    const rows = ranked.slice(0, 6).map((r, i) =>
      `${i + 1}. <b>${r.party}</b> — ${r.votes.toLocaleString()} (${total ? ((r.votes / total) * 100).toFixed(1) : 0}%)`);
    return send(token, chatId, `📊 <b>Presidential — crowd tally (unofficial)</b>\n${units.length} unit(s) reporting\n\n${rows.join('\n')}\n\nFull maps: ${SITE}/results.html`);
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
  const jpeg = await sharp(buf, { failOn: 'error' }).rotate()
    .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 }).toBuffer();
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
  const tipId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  import('./triage.js').then((t) => t.triageIncident(tipId)).catch(() => {});
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
// Each cascade step REPLACES the previous one: delete the tapped message and
// post the next list fresh at the bottom. In-place editMessageText proved
// unreliable in production (a silent failure forked the flow and left stale
// lists hanging in the chat); delete+send guarantees one live step at a time.
function stepKb(token, chatId, msgId, text, kb) {
  tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: msgId });
  return send(token, chatId, text, { reply_markup: kb });
}
// Append a "◀ Back" row so a mis-tap doesn't force restarting the whole cascade.
const withBack = (kb, data) => ({ inline_keyboard: [...kb.inline_keyboard, [{ text: '◀ Back', callback_data: data }]] });
// Register browse data — straight from the DB (same queries as the public
// /api/register/* endpoints; see the no-self-fetch note near the top).
const regStates = () =>
  db.prepare('SELECT DISTINCT state FROM polling_units ORDER BY state').all().map((r) => r.state);
const regLgas = (state) =>
  db.prepare('SELECT DISTINCT lga FROM polling_units WHERE state = ? ORDER BY lga').all(state).map((r) => r.lga);
const regWards = (state, lga) =>
  db.prepare('SELECT DISTINCT ward FROM polling_units WHERE state = ? AND lga = ? ORDER BY ward').all(state, lga).map((r) => r.ward);
const regUnits = (state, lga, ward) =>
  db.prepare('SELECT pu_code, name FROM polling_units WHERE state = ? AND lga = ? AND ward = ? ORDER BY pu_code').all(state, lga, ward);
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
  const PAGE = 10, start = pageNo * PAGE, slice = units.slice(start, start + PAGE);
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

// msgId set → we came from the browse cascade: replace the PU list in place
// (same one-message flow as every earlier step) instead of stacking a new message.
async function reportSetPu(token, chatId, code, msgId = null) {
  const pu = puByCode(code);
  if (!pu) { await send(token, chatId, 'No unit with that code. Send a valid PU code like <code>25-01-05-012</code>, or /cancel.'); return; }
  session.set(chatId, 'report', 'contest', { pu: pu.pu_code, puName: `${esc(pu.name)} (${pu.pu_code})`, state: pu.state });
  const text = `Unit: <b>${esc(pu.name)}</b>\n${esc(pu.ward)} ward, ${esc(pu.lga)}, ${esc(pu.state)}.\n\nWhich election?`;
  if (msgId) await stepKb(token, chatId, msgId, text, contestKeyboard(pu));
  else await send(token, chatId, text, { reply_markup: contestKeyboard(pu) });
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
      // Clear any lingering custom reply keyboard (e.g. the share-phone one) so the
      // cascade gets the full chat height. A keyboard can only be removed by sending
      // a message carrying remove_keyboard, so send-and-delete a throwaway one.
      // (The phone's own typing keyboard is out of a bot's reach — Telegram closes
      // it when the user taps the list.)
      const tmp = await tgApi(token, 'sendMessage', { chat_id: chatId, text: '🔎', reply_markup: { remove_keyboard: true } });
      if (tmp?.ok) tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: tmp.result.message_id });
      await stepKb(token, chatId, msgId, 'Pick a <b>state</b>:', pagedKb(regStates(), 'rp:st', 'rp:stp', 0));
      return true;
    }
    // Back buttons: re-show the previous list (page 0) from the session's crumbs.
    if (cb.data === 'rp:bk:st') { await stepKb(token, chatId, msgId, 'Pick a <b>state</b>:', pagedKb(regStates(), 'rp:st', 'rp:stp', 0)); return true; }
    if (cb.data === 'rp:bk:lg') { const d = bData(); await stepKb(token, chatId, msgId, `State: <b>${esc(d.bState)}</b>\nPick an <b>LGA</b>:`, withBack(pagedKb(regLgas(d.bState), 'rp:lg', 'rp:lgp', 0), 'rp:bk:st')); return true; }
    if (cb.data === 'rp:bk:wd') { const d = bData(); await stepKb(token, chatId, msgId, `${esc(d.bState)} · <b>${esc(d.bLga)}</b>\nPick a <b>ward</b>:`, withBack(pagedKb(regWards(d.bState, d.bLga), 'rp:wd', 'rp:wdp', 0), 'rp:bk:lg')); return true; }
    let m = /^rp:stp:(\d+)$/.exec(cb.data);
    if (m) { await stepKb(token, chatId, msgId, 'Pick a <b>state</b>:', pagedKb(regStates(), 'rp:st', 'rp:stp', +m[1])); return true; }
    m = /^rp:st:(\d+)$/.exec(cb.data);
    if (m) {
      const state = regStates()[+m[1]];
      session.set(chatId, 'report', 'browse', { ...bData(), bState: state });
      const lgas = regLgas(state);
      await stepKb(token, chatId, msgId, `State: <b>${esc(state)}</b>\nPick an <b>LGA</b>:`, withBack(pagedKb(lgas, 'rp:lg', 'rp:lgp', 0), 'rp:bk:st'));
      return true;
    }
    m = /^rp:lgp:(\d+)$/.exec(cb.data);
    if (m) { const d = bData(); await stepKb(token, chatId, msgId, `State: <b>${esc(d.bState)}</b>\nPick an <b>LGA</b>:`, withBack(pagedKb(regLgas(d.bState), 'rp:lg', 'rp:lgp', +m[1]), 'rp:bk:st')); return true; }
    m = /^rp:lg:(\d+)$/.exec(cb.data);
    if (m) {
      const d = bData();
      const lga = regLgas(d.bState)[+m[1]];
      session.set(chatId, 'report', 'browse', { ...d, bLga: lga });
      const wards = regWards(d.bState, lga);
      await stepKb(token, chatId, msgId, `${esc(d.bState)} · <b>${esc(lga)}</b>\nPick a <b>ward</b>:`, withBack(pagedKb(wards, 'rp:wd', 'rp:wdp', 0), 'rp:bk:lg'));
      return true;
    }
    m = /^rp:wdp:(\d+)$/.exec(cb.data);
    if (m) { const d = bData(); await stepKb(token, chatId, msgId, `${esc(d.bState)} · <b>${esc(d.bLga)}</b>\nPick a <b>ward</b>:`, withBack(pagedKb(regWards(d.bState, d.bLga), 'rp:wd', 'rp:wdp', +m[1]), 'rp:bk:lg')); return true; }
    m = /^rp:wd:(\d+)$/.exec(cb.data);
    if (m) {
      const d = bData();
      const ward = regWards(d.bState, d.bLga)[+m[1]];
      session.set(chatId, 'report', 'browse', { ...d, bWard: ward });
      const units = regUnits(d.bState, d.bLga, ward);
      await stepKb(token, chatId, msgId, `${esc(d.bLga)} · <b>${esc(ward)}</b> ward\nPick your <b>polling unit</b>:`, withBack(puKb(units, 0), 'rp:bk:wd'));
      return true;
    }
    m = /^rp:pup:(\d+)$/.exec(cb.data);
    if (m) { const d = bData(); await stepKb(token, chatId, msgId, `${esc(d.bLga)} · <b>${esc(d.bWard)}</b> ward\nPick your <b>polling unit</b>:`, withBack(puKb(regUnits(d.bState, d.bLga, d.bWard), +m[1]), 'rp:bk:wd')); return true; }
    m = /^rp:pu:(.+)$/.exec(cb.data);
    if (m) { await reportSetPu(token, chatId, m[1], msgId); return true; }
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

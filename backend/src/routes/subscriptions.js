import { Router } from 'express';
import { db, contests } from '../db.js';
import { config } from '../config.js';
import { tgSendMessage } from '../services/sms.js';
import { notifyChat, notifyMaster, chatIdByHash } from '../services/notify.js';
import { requireObserver } from './observers.js';

export const subscriptionsRouter = Router();
const contestName = (c) => contests.find((x) => x.code === c)?.name || c;

subscriptionsRouter.get('/subscriptions', requireObserver, (req, res) => {
  res.json(db.prepare('SELECT contest, state FROM subscriptions WHERE observer_id = ?').all(req.observer.id));
});

subscriptionsRouter.post('/subscriptions', requireObserver, (req, res) => {
  const contest = String(req.body?.contest || '');
  const state = String(req.body?.state || '');
  if (!contests.some((c) => c.code === contest)) return res.status(400).json({ error: 'unknown_contest' });
  const r = db.prepare('INSERT OR IGNORE INTO subscriptions (observer_id, contest, state, created_at) VALUES (?, ?, ?, ?)')
    .run(req.observer.id, contest, state, Date.now());
  if (r.changes) {
    const where = state || 'everywhere';
    notifyChat(chatIdByHash(req.observer.phone_hash),
      `🔔 You're now following ${contestName(contest)} (${where}). You'll get a Telegram ping on each new report.`);
    notifyMaster(`subscription · observer #${req.observer.id} · ${contestName(contest)} (${where})`);
  }
  res.status(201).json({ ok: true });
});

subscriptionsRouter.delete('/subscriptions', requireObserver, (req, res) => {
  db.prepare('DELETE FROM subscriptions WHERE observer_id = ? AND contest = ? AND state = ?')
    .run(req.observer.id, String(req.body?.contest || ''), String(req.body?.state || ''));
  res.json({ ok: true });
});

// The follow-scope for a report = the region the subscriber may have picked:
// state for president/governor/assembly, senatorial district for Senate, federal
// constituency for House of Reps.
const reportScope = (pu, contest) =>
  contest === 'SEN' ? pu.senatorial : contest === 'REP' ? pu.federal_constituency : pu.state;

// Fire-and-forget: ping every subscriber (contest match, all-scopes or this exact
// region) who has a linked Telegram chat. Never blocks the submission response.
export function notifySubscribers(dbh, { contest, pu }) {
  if (!config.telegramBotToken) return;
  const scope = reportScope(pu, contest) || '';
  const chats = dbh.prepare(`
    SELECT DISTINCT tl.chat_id FROM subscriptions s
    JOIN observers o ON o.id = s.observer_id
    JOIN telegram_links tl ON tl.phone_hash = o.phone_hash
    WHERE s.contest = ? AND (s.state = '' OR s.state = ?)`).all(contest, scope);
  if (!chats.length) return;
  const msg = `🦅 Hawkeye: new ${contestName(contest)} report at ${pu.name}, ${pu.state}. hawkeye.com.ng/dashboard.html`;
  for (const { chat_id } of chats) tgSendMessage(chat_id, msg).catch(() => {});
}

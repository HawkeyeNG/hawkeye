import { Router } from 'express';
import { db, contests, contestLabel } from '../db.js';
import { config } from '../config.js';
import { tgSendMessage } from '../services/sms.js';
import { notifyChat, notifyMaster, chatIdByHash } from '../services/notify.js';
import { pushNote } from '../services/notifications.js';
import { requireObserver } from './observers.js';

export const subscriptionsRouter = Router();
// `<race> (<year>)` — the same convention the board and the bot use.
const contestName = (c) => contestLabel(c);

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
      `🔔 You're now following ${contestName(contest)} (${where}). Every new report lands in your Alerts, on your phone, and here.`);
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

/**
 * Tell everyone following this race that a report landed.
 *
 * THIS USED TO REACH TELEGRAM AND NOWHERE ELSE, and the promise it was breaking
 * was made twice on the way in: the follow button says "plus the in-app feed",
 * and the Alerts screen's empty state says it carries "updates on races you
 * follow". Neither was true. Worse, the query JOINed telegram_links, so an
 * observer who followed a race WITHOUT linking Telegram got nothing at all —
 * silently, from a button that had just confirmed they were subscribed.
 *
 * Now every subscriber gets a `pushNote`, which is the pairing that already
 * exists for saved units (noteUnitSavers): it writes the row the Alerts screen
 * reads AND sends the device push, so the alert survives being swiped away and
 * reaches the phone. Telegram still goes out on top, unchanged, for the people
 * who linked it.
 *
 * FIRE-AND-FORGET, and it must stay that way: this runs on the submission path
 * on election day, so nothing here may block or throw back into the response.
 */
export function notifySubscribers(dbh, { contest, pu, exceptObserverId = null }) {
  const scope = reportScope(pu, contest) || '';
  const label = contestName(contest);
  const where = `${pu.name}, ${pu.state}`;

  // EVERY subscriber, whether or not they use Telegram. Active observers only —
  // a suspended account should not be pushed to.
  const subs = dbh.prepare(`
    SELECT DISTINCT s.observer_id FROM subscriptions s
    JOIN observers o ON o.id = s.observer_id AND o.status = 'active'
    WHERE s.contest = ? AND (s.state = '' OR s.state = ?)`).all(contest, scope);
  for (const { observer_id } of subs) {
    // NOT THE PERSON WHO JUST FILED IT. Being notified of your own report is
    // noise, and on a quiet race it would be most of the notifications someone
    // receives.
    if (exceptObserverId && observer_id === exceptObserverId) continue;
    try {
      pushNote(observer_id, {
        kind: 'result',
        title: `New ${label} report`,
        body: `A result was reported at ${where}.`,
        // The board for this race, not the generic log — the reader followed a
        // specific race and this is the screen about it.
        url: `https://hawkeye.com.ng/results.html?contest=${encodeURIComponent(contest)}`
          + (scope ? `&scope=${encodeURIComponent(scope)}` : ''),
      });
    } catch { /* one bad row must not stop the fan-out */ }
  }

  if (!config.telegramBotToken) return;
  const chats = dbh.prepare(`
    SELECT DISTINCT tl.chat_id FROM subscriptions s
    JOIN observers o ON o.id = s.observer_id
    JOIN telegram_links tl ON tl.phone_hash = o.phone_hash
    WHERE s.contest = ? AND (s.state = '' OR s.state = ?)`).all(contest, scope);
  if (!chats.length) return;
  const msg = `🦅 Hawkeye: new ${label} report at ${where}. hawkeye.com.ng/dashboard.html`;
  for (const { chat_id } of chats) tgSendMessage(chat_id, msg).catch(() => {});
}

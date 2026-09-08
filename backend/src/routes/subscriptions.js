import { Router } from 'express';
import { db, contests, contestLabel, scopeIsState } from '../db.js';
import { config } from '../config.js';
import { tgSendMessage } from '../services/sms.js';
import { notifyObserver, notifyMaster } from '../services/notify.js';
import { t, normalise, DEFAULT_LANG } from '../services/i18n.js';
import { pushNote } from '../services/notifications.js';
import { isRaceClosed } from '../services/declarations.js';
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
  /**
   * A DECLARED RACE CANNOT BE FOLLOWED. Both clients hide the control on a
   * closed race, but hiding a button is a presentation choice and this is the
   * rule — a stale page, a cached bundle or a direct call would otherwise write
   * a row that closeFinishedRaces has already been round to delete, and it
   * would sit in the follow list until the next declaration touched it.
   */
  if (isRaceClosed(contest, state)) return res.status(409).json({ error: 'race_closed' });
  const r = db.prepare('INSERT OR IGNORE INTO subscriptions (observer_id, contest, state, created_at) VALUES (?, ?, ?, ?)')
    .run(req.observer.id, contest, state, Date.now());
  if (r.changes) {
    const lang = normalise(req.observer.lang) || DEFAULT_LANG;
    const where = state || t(lang, 'word.everywhere');
    notifyObserver(req.observer, 'tg.following', { race: contestName(contest), where });
    // The master ping is always English: it goes to the owner, not an observer.
    notifyMaster(`subscription · observer #${req.observer.id} · ${contestName(contest)} (${state || 'everywhere'})`);
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
// constituency for House of Reps. `scopeIsState` (db.js) is the same rule, and
// the prune in services/declarations.js reads it to know whether a stored region
// can be checked against a contest's `states` list — so the two cannot disagree
// about what was written here.
const reportScope = (pu, contest) =>
  scopeIsState(contest) ? pu.state : contest === 'SEN' ? pu.senatorial : pu.federal_constituency;

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
        titleKey: 'note.result.title', bodyKey: 'note.result.body',
        params: { label, where },
        // The board for this race, not the generic log — the reader followed a
        // specific race and this is the screen about it.
        url: `https://hawkeye.com.ng/results.html?contest=${encodeURIComponent(contest)}`
          + (scope ? `&scope=${encodeURIComponent(scope)}` : ''),
      });
    } catch { /* one bad row must not stop the fan-out */ }
  }

  if (!config.telegramBotToken) return;
  const chats = dbh.prepare(`
    SELECT DISTINCT tl.chat_id, o.lang FROM subscriptions s
    JOIN observers o ON o.id = s.observer_id
    JOIN telegram_links tl ON tl.phone_hash = o.phone_hash
    WHERE s.contest = ? AND (s.state = '' OR s.state = ?)`).all(contest, scope);
  if (!chats.length) return;
  // Per row, not once: the people following a race do not share a language.
  for (const { chat_id, lang } of chats) {
    const msg = t(normalise(lang) || DEFAULT_LANG, 'tg.newReport', { label, where });
    tgSendMessage(chat_id, msg).catch(() => {});
  }
}

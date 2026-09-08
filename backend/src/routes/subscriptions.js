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
 * The running tally for a race, as the alert should say it.
 *
 * SAME EXCLUSIONS AS THE BOARD, and that matters more than it looks: a disputed
 * result is out of the headline total on results.html (an open high-severity
 * flag or an open case), so a tally in an alert that counted them would put a
 * different number in someone's pocket from the one on the screen the alert
 * links to. Two numbers for one race is worse than no number.
 *
 * `scope` is the region the follower picked, mapped through the same column
 * reportScope writes — state for president/governor/assembly, senatorial
 * district for the Senate, federal constituency for the House. Empty scope means
 * they follow the whole race, and the tally is the whole race.
 *
 * Returns null when there is nothing yet to report, so the caller can send the
 * plain sentence rather than "Running total: " followed by nothing.
 */
function runningTally(dbh, contest, scope) {
  try {
    const col = scopeIsState(contest) ? 'state' : contest === 'SEN' ? 'senatorial' : 'federal_constituency';
    const rows = scope
      ? dbh.prepare(`
          SELECT r.votes_json FROM results r JOIN polling_units p ON p.pu_code = r.pu_code
          WHERE r.contest = ? AND r.disputed = 0 AND p.${col} = ?`).all(contest, scope)
      : dbh.prepare(
          'SELECT votes_json FROM results WHERE contest = ? AND disputed = 0').all(contest);
    if (!rows.length) return null;
    const totals = {};
    for (const row of rows) {
      let votes = [];
      try { votes = JSON.parse(row.votes_json) || []; } catch { continue; }
      for (const v of votes) {
        if (!v || !v.count) continue;
        totals[v.party] = (totals[v.party] || 0) + v.count;
      }
    }
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    /* THREE PARTIES, NOT ALL OF THEM. A push notification is truncated by the
       operating system at a length neither we nor the reader controls, and a
       tally cut off mid-party reads as a result rather than as a fragment. The
       board carries the full field, one tap away. */
    const top = ranked.slice(0, 3).map(([party, n]) => `${party} ${n.toLocaleString('en-NG')}`);
    return { tally: top.join(' \u00b7 '), units: rows.length };
  } catch {
    // A tally is an enrichment. If this throws on election night the alert must
    // still go out — the follower needs to know a result landed far more than
    // they need the number attached to it.
    return null;
  }
}

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
  /* MIN(s.state), not DISTINCT observer_id: someone can follow the whole race
     AND this region, which used to collapse to one row by accident. Grouping
     makes that deliberate and keeps it to one notification — and MIN puts ''
     first, so a follower of the whole race gets the whole race's number rather
     than one region's. */
  const subs = dbh.prepare(`
    SELECT s.observer_id, MIN(s.state) AS follows FROM subscriptions s
    JOIN observers o ON o.id = s.observer_id AND o.status = 'active'
    WHERE s.contest = ? AND (s.state = '' OR s.state = ?)
    GROUP BY s.observer_id`).all(contest, scope);
  /* Computed at most twice for the whole fan-out rather than once per
     subscriber: on election night this runs on the submission path. */
  const tallies = { whole: undefined, scoped: undefined };
  const tallyFor = (follows) => {
    const k = follows ? 'scoped' : 'whole';
    if (tallies[k] === undefined) tallies[k] = runningTally(dbh, contest, follows || '');
    return tallies[k];
  };
  for (const { observer_id, follows } of subs) {
    // NOT THE PERSON WHO JUST FILED IT. Being notified of your own report is
    // noise, and on a quiet race it would be most of the notifications someone
    // receives.
    if (exceptObserverId && observer_id === exceptObserverId) continue;
    try {
      const running = tallyFor(follows);
      pushNote(observer_id, {
        kind: 'result',
        titleKey: 'note.result.title',
        // The plain sentence when there is nothing to count yet — "Running
        // total:" followed by nothing is worse than not saying it.
        bodyKey: running ? 'note.result.bodyTally' : 'note.result.body',
        params: running
          ? { label, where, tally: running.tally, units: running.units.toLocaleString('en-NG') }
          : { label, where },
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
    /* The same words the push and the Alerts row got. A follower linked to
       Telegram should not receive a thinner message than one who is not. */
    const running = runningTally(dbh, contest, scope);
    const msg = running
      ? t(normalise(lang) || DEFAULT_LANG, 'tg.newReportTally',
        { label, where, tally: running.tally, units: running.units.toLocaleString('en-NG') })
      : t(normalise(lang) || DEFAULT_LANG, 'tg.newReport', { label, where });
    tgSendMessage(chat_id, msg).catch(() => {});
  }
}

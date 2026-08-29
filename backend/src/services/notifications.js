// In-app notification centre. Every notable per-observer event is persisted here
// so the app has a real notifications feed (not just an ephemeral Telegram ping).
// pushNote also fires a native push (FCM) best-effort, so a notification arrives
// on the lock screen AND stays in the feed.
import { db } from '../db.js';

/**
 * The row ONLY — no push.
 *
 * Split out for the one caller that has already sent its own: broadcast() pushes
 * to every device directly, so calling pushNote there would deliver the same
 * announcement twice to every phone in the country.
 */
export function noteOnly(observerId, { kind = 'info', title, body = '', url = null } = {}) {
  if (!observerId || !title) return null;
  const info = db.prepare(`
    INSERT INTO notifications (observer_id, kind, title, body, url, read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)`)
    .run(observerId, kind, String(title).slice(0, 160), String(body).slice(0, 500), url, Date.now());
  return info.lastInsertRowid;
}

/**
 * File it in the notification centre AND push it. The normal pairing: an alert
 * that is only a push dies when it is swiped away, and one that is only a row is
 * never seen until the app is next opened.
 */
export function pushNote(observerId, { kind = 'info', title, body = '', url = null } = {}) {
  const id = noteOnly(observerId, { kind, title, body, url });
  if (id === null) return null;
  import('./push.js').then((p) => p.sendToObserver(observerId, { title, body, data: url ? { url } : {} })).catch(() => {});
  return id;
}

/**
 * File one notification for MANY observers in a single transaction.
 *
 * A broadcast reaching every registered observer is otherwise N separate
 * INSERTs on the request path. better-sqlite3 is synchronous, so wrapping them
 * commits once instead of once per row — the difference between a broadcast
 * being instant and it holding the admin console open.
 */
export function noteMany(observerIds, note) {
  const ids = [...new Set(observerIds)].filter(Boolean);
  if (!ids.length || !note?.title) return 0;
  const run = db.transaction((list) => {
    for (const id of list) noteOnly(id, note);
  });
  run(ids);
  return ids.length;
}

/**
 * HOW LONG AN ALERT STAYS IN THE FEED.
 *
 * 90 days. The common default across in-app notification centres is 14-30 days
 * (Power Apps expires at 14; several notification servers default to 30), and
 * the standard advice is to expire deliberately so an inbox never goes stale.
 * Hawkeye sits at the long end of that range on purpose:
 *
 *   - These are civic alerts, not marketing. "A result was reported at your
 *     polling unit" stays meaningful for as long as that result can be
 *     challenged, and Nigeria's petition window alone is 21 days from
 *     declaration, with tribunals running months past it.
 *   - 90 days covers a whole election event plus that aftermath, so an observer
 *     coming back to check what they were told still finds it.
 *   - It is still a bound. Without one the table only grows, and a single
 *     broadcast writes one row per observer.
 *
 * THIS IS THE FEED, NOT THE RECORD. Results, the hash-chained ledger and
 * incidents are permanent and untouched — this prunes only the copy that exists
 * to tell someone something happened.
 *
 * Pruned by age regardless of read state: a 90-day-old unread alert is not a
 * task anyone still needs to do, and exempting unread rows would mean a lapsed
 * account keeps its notifications for ever — the opposite of a retention rule.
 */
export const NOTIFICATION_RETENTION_DAYS = 90;

export function pruneOldNotifications() {
  const cutoff = Date.now() - NOTIFICATION_RETENTION_DAYS * 86_400_000;
  return db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff).changes;
}

// Fan a notification out to everyone who saved this polling unit as theirs.
export function noteUnitSavers(puCode, note) {
  if (!puCode) return 0;
  const ids = db.prepare(
    "SELECT DISTINCT s.observer_id FROM saved_units s JOIN observers o ON o.id = s.observer_id AND o.status = 'active' WHERE s.pu_code = ?")
    .all(puCode);
  for (const { observer_id } of ids) pushNote(observer_id, note);
  return ids.length;
}

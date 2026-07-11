// In-app notification centre. Every notable per-observer event is persisted here
// so the app has a real notifications feed (not just an ephemeral Telegram ping).
// pushNote also fires a native push (FCM) best-effort, so a notification arrives
// on the lock screen AND stays in the feed.
import { db } from '../db.js';

export function pushNote(observerId, { kind = 'info', title, body = '', url = null } = {}) {
  if (!observerId || !title) return null;
  const info = db.prepare(`
    INSERT INTO notifications (observer_id, kind, title, body, url, read, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)`)
    .run(observerId, kind, String(title).slice(0, 160), String(body).slice(0, 500), url, Date.now());
  import('./push.js').then((p) => p.sendToObserver(observerId, { title, body, data: url ? { url } : {} })).catch(() => {});
  return info.lastInsertRowid;
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

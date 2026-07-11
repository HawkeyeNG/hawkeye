import { Router } from 'express';
import { db } from '../db.js';
import { requireObserver } from './observers.js';

export const notificationsRouter = Router();

// The observer's feed (newest first) + unread count for the header badge.
notificationsRouter.get('/notifications', requireObserver, (req, res) => {
  const items = db.prepare(`
    SELECT id, kind, title, body, url, read, created_at
    FROM notifications WHERE observer_id = ? ORDER BY id DESC LIMIT 60`).all(req.observer.id);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE observer_id = ? AND read = 0').get(req.observer.id).c;
  res.json({ items, unread });
});

// Mark one (id) or all read.
notificationsRouter.post('/notifications/read', requireObserver, (req, res) => {
  if (req.body?.all) {
    db.prepare('UPDATE notifications SET read = 1 WHERE observer_id = ? AND read = 0').run(req.observer.id);
  } else {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id_or_all_required' });
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND observer_id = ?').run(id, req.observer.id);
  }
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE observer_id = ? AND read = 0').get(req.observer.id).c;
  res.json({ ok: true, unread });
});

/* Offline outbox for signed reports. Election-day networks are hostile, so a
   report that's already been captured, compressed, hashed and SIGNED must not be
   lost to a dead connection. It's queued in IndexedDB and flushed when
   connectivity returns. Idempotent: the server dedupes on image hash + one-per-
   device-per-race, so a resend either lands (201) or is a known duplicate (409)
   — both mean "the server has it", so we drop it from the queue either way.
   The signature was computed over the exact bytes queued, so it stays valid. */
(function () {
  const DB = 'hawkeye-outbox';
  const STORE = 'reports';
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = (mode, fn) => open().then((db) => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    let out;
    const rq = fn(t.objectStore(STORE));
    if (rq) rq.onsuccess = () => { out = rq.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  }));

  const Outbox = {
    queue: (entry) => run('readwrite', (s) => s.add({ ...entry, queuedAt: Date.now() })),
    all: () => run('readonly', (s) => s.getAll()),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    async count() { return (await Outbox.all() || []).length; },
    async flush() {
      const token = localStorage.getItem('hawkeye_token');
      if (!token || !navigator.onLine) return { sent: 0 };
      const base = (window.HAWKEYE && window.HAWKEYE.apiBase) || '';
      let sent = 0;
      for (const it of (await Outbox.all() || [])) {
        const form = new FormData();
        for (const [k, v] of Object.entries(it.fields)) form.set(k, v);
        form.set('photo', it.sheet, 'ec8a.jpg');
        form.set('venuePhoto', it.venue, 'venue.jpg');
        let resp;
        try {
          resp = await fetch(base + '/api/submissions', {
            method: 'POST', headers: { authorization: 'Bearer ' + token }, body: form,
          });
        } catch { break; } // still offline — stop and keep the rest for next time
        if (resp.ok || resp.status === 409) { await Outbox.remove(it.id); sent++; }        // landed or already there
        else if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) { await Outbox.remove(it.id); } // unfixable -> drop
        // 5xx / 429 -> leave queued, retry later
      }
      if (sent) window.dispatchEvent(new CustomEvent('hawkeye-outbox-sent', { detail: { sent } }));
      return { sent };
    },
  };
  window.HawkeyeOutbox = Outbox;
  window.addEventListener('online', () => Outbox.flush().catch(() => {}));
  document.addEventListener('DOMContentLoaded', () => Outbox.flush().catch(() => {}));
})();

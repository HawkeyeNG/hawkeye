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
        // The mode is decided HERE, not when the report was queued. A report
        // captured underground and flushed on the surface should use whatever
        // the server offers now; and a queue written before direct upload
        // existed still flushes, because it carries the blobs either way.
        let directBody = null;
        if (window.HawkeyeDirect && it.fields.imageSha256 && it.fields.venueImageSha256) {
          const ok = await window.HawkeyeDirect.upload({
            base,
            token,
            blobs: { sheet: it.sheet, venue: it.venue },
            hashes: { sheet: it.fields.imageSha256, venue: it.fields.venueImageSha256 },
          });
          if (ok) directBody = JSON.stringify({ ...it.fields });
        }
        const form = new FormData();
        for (const [k, v] of Object.entries(it.fields)) form.set(k, v);
        form.set('photo', it.sheet, 'ec8a.jpg');
        form.set('venuePhoto', it.venue, 'venue.jpg');
        let resp;
        try {
          resp = await fetch(base + '/api/submissions', {
            method: 'POST',
            headers: directBody
              ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
              : { authorization: 'Bearer ' + token },
            body: directBody || form,
          });
        } catch { break; } // still offline — stop and keep the rest for next time
        // 409 USED TO MEAN "the server already has it" — already_submitted or
        // duplicate_image — so dropping the queue entry was right. Direct upload
        // added a 409 that means the OPPOSITE: photo_not_uploaded, i.e. the bucket
        // does not have the photos yet. Treating that as "landed" would delete a
        // signed report AND count it as sent, telling the observer it succeeded.
        let body = null;
        try { body = await resp.clone().json(); } catch { /* not json */ }
        const retryable409 = resp.status === 409
          && body && (body.error === 'photo_not_uploaded' || body.error === 'storage_unavailable');
        if (retryable409) { /* leave queued — the next flush re-presigns and re-PUTs */ }
        else if (resp.ok || resp.status === 409) { await Outbox.remove(it.id); sent++; }        // landed or already there
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

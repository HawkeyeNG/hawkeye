/* Offline outbox for signed reports. Election-day networks are hostile, so a
   report that's already been captured, compressed, hashed and SIGNED must not be
   lost to a dead connection. It's queued in IndexedDB and flushed when
   connectivity returns. Idempotent: the server dedupes on image hash + one-per-
   device-per-race, so a resend either lands (201) or is a known duplicate (409)
   — both mean "the server has it", so we drop it from the queue either way.
   The signature was computed over the exact bytes queued, so it stays valid.

   WHERE IT RUNS. Every page (menu.js injects it; the report pages also load it
   directly) and the service worker (sw.js importScripts it). A page flushes on
   load, on reconnect, on returning to the tab/app, and every minute while
   visible. The service worker flushes on a Background Sync — Chrome/Android
   wakes it on reconnect even with every tab closed. Safari and in-app WebViews
   have no Background Sync; there the queue sends whenever any page is open. */
(function (G) {
  if (G.HawkeyeOutbox) return; // loaded twice on the report pages: once is enough
  const inPage = !!G.document;
  const DB = 'hawkeye-outbox';
  const STORE = 'reports';
  const openDb = (name, store, opts) => new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store, opts);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = (name, store, opts) => (mode, fn) => openDb(name, store, opts).then((db) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    let out;
    const rq = fn(t.objectStore(store));
    if (rq) rq.onsuccess = () => { out = rq.result; };
    t.oncomplete = () => { db.close(); res(out); };
    t.onerror = () => { db.close(); rej(t.error); };
  }));
  const run = tx(DB, STORE, { keyPath: 'id', autoIncrement: true });
  // A SECOND database rather than a new store in the first: a new store means a
  // version upgrade, which any older tab holding the first one open would block.
  // It holds what the service worker needs and cannot read from localStorage —
  // the session token — and the drops it records while no page is open.
  const kv = tx('hawkeye-outbox-meta', 'kv');
  const getKv = (k) => kv('readonly', (s) => s.get(k));
  const putKv = (k, v) => kv('readwrite', (s) => s.put(v, k));

  // Ask the browser to wake the service worker on reconnect (Chrome/Android).
  const wantSync = () => {
    try { G.navigator.serviceWorker.ready.then((r) => r.sync && r.sync.register('hawkeye-outbox')).catch(() => {}); } catch { /* no SW */ }
  };

  // The session token. A page reads localStorage and mirrors it for the service
  // worker — including its absence, so signing out also signs the worker out.
  const session = async () => {
    if (!inPage) return getKv('token');
    const t = G.localStorage.getItem('hawkeye_token');
    putKv('token', t || null).catch(() => {});
    return t;
  };

  // Reports the server refused for good, with the reason it gave — native's
  // K_DROPPED list, same shape and cap. Before this a refused report vanished
  // from the queue without a word, so the observer believed it had been sent.
  const K_DROPPED = 'hawkeye_outbox_dropped';
  const dropped = () => { try { return JSON.parse(G.localStorage.getItem(K_DROPPED) || '[]'); } catch { return []; } };
  const refusal = (status, body) =>
    `${(body && (body.hint || body.error)) || 'refused'} (${(body && body.error) || 'no code'} / HTTP ${status})`;
  const tell = async (fresh) => {
    try { await G.i18nReady; } catch { /* English fallback below */ }
    const I = G.HawkeyeI18n;
    const line = I ? I.t('observe.a-queued-report-was-dropped', 'A queued report was dropped \u2014 {v0}.')
      : 'A queued report was dropped \u2014 {v0}.';
    alert(fresh.map((d) => line.replace('{v0}', `${d.label}: ${d.why}`)).join('\n\n'));
  };
  // A page records a drop and says so at once. The service worker has neither
  // localStorage nor anyone to tell, so it parks the drop for the next page.
  const record = async (fresh) => {
    if (!inPage) return putKv('swDropped', [...fresh, ...((await getKv('swDropped')) || [])].slice(0, 20));
    try { G.localStorage.setItem(K_DROPPED, JSON.stringify([...fresh, ...dropped()].slice(0, 20))); } catch { /* the drop already happened */ }
    tell(fresh);
  };

  let busy = null; // one flush at a time per realm; overlapping triggers share it
  const Outbox = {
    async queue(entry) {
      const id = await run('readwrite', (s) => s.add({ ...entry, queuedAt: Date.now() }));
      session().catch(() => {}); // the worker needs the token to send it
      wantSync();
      return id;
    },
    all: () => run('readonly', (s) => s.getAll()),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    dropped,
    async count() { return (await Outbox.all() || []).length; },
    flush() { return busy || (busy = Outbox.flushNow().finally(() => { busy = null; })); },
    async flushNow() {
      const token = await session();
      if (!token || !G.navigator.onLine) return { sent: 0 };
      const base = (G.HAWKEYE && G.HAWKEYE.apiBase) || '';
      let sent = 0;
      const fresh = [];
      for (const it of (await Outbox.all() || [])) {
        // The mode is decided HERE, not when the report was queued. A report
        // captured underground and flushed on the surface should use whatever
        // the server offers now; and a queue written before direct upload
        // existed still flushes, because it carries the blobs either way.
        let directBody = null;
        if (!it.url && G.HawkeyeDirect && it.fields.imageSha256 && it.fields.venueImageSha256) {
          const ok = await G.HawkeyeDirect.upload({
            base,
            token,
            blobs: { sheet: it.sheet, venue: it.venue },
            hashes: { sheet: it.fields.imageSha256, venue: it.fields.venueImageSha256 },
          });
          if (ok) directBody = JSON.stringify({ ...it.fields });
        }
        const form = new FormData();
        for (const [k, v] of Object.entries(it.fields)) form.set(k, v);
        // Collation and incident entries carry their own endpoint and file list
        // (incident media repeat under one name, so append); a unit report
        // carries its two photos as sheet/venue.
        if (it.files) for (const [name, blob, filename] of it.files) form.append(name, blob, filename);
        else { form.set('photo', it.sheet, 'ec8a.jpg'); form.set('venuePhoto', it.venue, 'venue.jpg'); }
        let resp;
        try {
          const auth = { authorization: 'Bearer ' + token, ...(it.deviceId ? { 'x-device-id': it.deviceId } : {}) };
          resp = await fetch(base + (it.url || '/api/submissions'), {
            method: 'POST',
            headers: directBody ? { ...auth, 'content-type': 'application/json' } : auth,
            body: directBody || form,
          });
        } catch { wantSync(); break; } // still offline — keep the rest, and ask to be woken
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
        // 401 is the SESSION, not the report: it used to fall into the drop below
        // and delete a signed report because a token expired while it waited.
        // Keep it; the next flush after sign-in sends it (native defers it too).
        else if (resp.status === 401) break;
        else if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) { // unfixable -> drop, and SAY so
          await Outbox.remove(it.id);
          const f = it.fields || {};
          fresh.push({ label: it.label || [f.puCode, f.contest].filter(Boolean).join(' \u00b7 ') || 'report',
            queuedAt: it.queuedAt, droppedAt: Date.now(), why: refusal(resp.status, body) });
        }
        // 5xx / 429 -> leave queued, retry later
      }
      if (fresh.length) {
        await record(fresh).catch(() => {});
        G.dispatchEvent(new CustomEvent('hawkeye-outbox-dropped', { detail: { dropped: fresh } }));
      }
      if (sent) G.dispatchEvent(new CustomEvent('hawkeye-outbox-sent', { detail: { sent } }));
      return { sent, dropped: fresh.length };
    },
  };
  G.HawkeyeOutbox = Outbox;

  const go = () => Outbox.flush().catch(() => {});
  if (inPage) {
    G.addEventListener('online', go);
    // Coming back to the tab or app (the Lite shell resumes its WebView this
    // way) is often the first moment the network is back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') go(); });
    setInterval(() => { if (document.visibilityState === 'visible') go(); }, 60000);
    const start = async () => {
      // Drops the service worker recorded while no page was open.
      const parked = await getKv('swDropped').catch(() => null);
      if (parked && parked.length) { await putKv('swDropped', []).catch(() => {}); record(parked); }
      go();
    };
    // menu.js injects this after the page has parsed, so DOMContentLoaded may be gone.
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  } else {
    // Service worker. A rejected waitUntil makes the browser retry the sync
    // later, so anything still queued (offline again, 5xx) rejects.
    G.addEventListener('sync', (e) => {
      if (e.tag !== 'hawkeye-outbox') return;
      e.waitUntil(Outbox.flush().then(async () => { if (await Outbox.count()) throw new Error('outbox not empty'); }));
    });
  }
})(self);

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

  /* WHEN TO TRY AGAIN (ELECTION-NIGHT-HOSTING.md §2.5, P0 item 10). The phone
     is the queue, so admission control at the origin loses nothing — PROVIDED
     the phones do not all come back in the same second. Two rules:
     - the server's Retry-After is a floor, never a suggestion, plus 0–50% random
       on top, so two phones told "30" do not both return at exactly 30 s;
     - with no Retry-After, full jitter over native's backoff ceilings
       (outbox.ts BACKOFF_MS): a uniform wait in [0, ceiling). */
  const BACKOFF_MS = [30000, 120000, 480000, 1800000];
  // A header is the server's word, but a wrong one must not freeze the queue.
  const RETRY_AFTER_CAP_MS = 15 * 60000;
  // "Not now" rather than "never". Every other 4xx keeps its old handling.
  const retryableStatus = (s) => s >= 500 || s === 408 || s === 425 || s === 429;
  // Answers about the SERVER (busy) or this OBSERVER (rate-limited), not about
  // one report: every report behind it would get the same answer, so stop.
  const holdsQueue = (s) => s === 429 || s === 503;
  /** Retry-After as ms from `now` — delta-seconds or an HTTP-date; null if absent or unreadable. */
  function parseRetryAfter(v, now) {
    const s = v == null ? '' : String(v).trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.min(RETRY_AFTER_CAP_MS, Math.round(Number(s) * 1000));
    const at = Date.parse(s);
    return Number.isFinite(at) ? Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - now)) : null;
  }
  /**
   * How long to wait before the next attempt. Retry-After is honoured for the
   * two statuses that define it here (429, 503); `attempt` counts earlier
   * failures (0 = first). `rand`/`now` are injectable for tests.
   */
  function retryDelayMs(status, retryAfter, attempt, rand, now) {
    const r = rand || Math.random;
    const ra = (status === 429 || status === 503) ? parseRetryAfter(retryAfter, now == null ? Date.now() : now) : null;
    if (ra != null) return ra + Math.floor(r() * 0.5 * Math.max(ra, 2000));
    return Math.floor(r() * BACKOFF_MS[Math.min(Math.max(0, attempt | 0), BACKOFF_MS.length - 1)]);
  }
  // Retry-After from a response: the header, else the body's retryAfterS (a
  // cross-origin page — the Lite shell — cannot read an unexposed header).
  const retryAfterOf = (resp, body) => {
    let h = null;
    try { h = resp.headers.get('retry-after'); } catch { /* no headers */ }
    return h || (body && body.retryAfterS != null ? String(body.retryAfterS) : null);
  };

  let busy = null; // one flush at a time per realm; overlapping triggers share it
  const Outbox = {
    retryDelayMs,
    parseRetryAfter,
    retryableStatus,
    /** `entry.notBefore` (epoch ms), when given, holds the first attempt until then. */
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
      // Per-report "not before" + failure count, keyed by queue id. Kept in the
      // meta database, not written back onto the report: a put() of a report
      // another realm (the service worker) has just sent and deleted would
      // resurrect it.
      const retry = (await getKv('retry').catch(() => null)) || {};
      let retryDirty = false;
      const later = (it, status, ra, tried) => {
        const prev = retry[it.id] || { at: 0, n: 0 };
        const at = Date.now() + retryDelayMs(status, ra, prev.n);
        retry[it.id] = { at: Math.max(at, prev.at || 0), n: prev.n + (tried ? 1 : 0) };
        retryDirty = true;
      };
      const forget = (it) => { if (retry[it.id]) { delete retry[it.id]; retryDirty = true; } };
      // A busy/rate-limited answer holds EVERY report still queued, each with its
      // own jitter, so the queue does not come back as one burst either.
      const holdRest = (rest, status, ra) => rest.forEach((x, j) => later(x, status, ra, j === 0));
      const items = (await Outbox.all()) || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (Math.max(it.notBefore || 0, (retry[it.id] && retry[it.id].at) || 0) > Date.now()) continue; // not due
        // The mode is decided HERE, not when the report was queued. A report
        // captured underground and flushed on the surface should use whatever
        // the server offers now; and a queue written before direct upload
        // existed still flushes, because it carries the blobs either way.
        let directBody = null;
        if (!it.url && G.HawkeyeDirect && it.fields.imageSha256 && it.fields.venueImageSha256) {
          const D = G.HawkeyeDirect;
          const up = await (D.tryUpload || D.upload)({
            base,
            token,
            blobs: { sheet: it.sheet, venue: it.venue },
            hashes: { sheet: it.fields.imageSha256, venue: it.fields.venueImageSha256 },
          });
          // Presign refused as busy (429/503): NOT a reason to push the photo
          // bytes through the origin instead. Hold the queue until Retry-After.
          if (up && up.busy) { holdRest(items.slice(i), up.status, up.retryAfter); break; }
          if (up === true) directBody = JSON.stringify({ ...it.fields });
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
        else if (resp.ok || resp.status === 409) { await Outbox.remove(it.id); forget(it); sent++; } // landed or already there
        // 401 is the SESSION, not the report: it used to fall into the drop below
        // and delete a signed report because a token expired while it waited.
        // Keep it; the next flush after sign-in sends it (native defers it too).
        else if (resp.status === 401) break;
        // 429 / 503: the server or this observer is over its limit \u2014 every
        // report behind this one would hear the same, so hold them all and stop.
        else if (holdsQueue(resp.status)) { holdRest(items.slice(i), resp.status, retryAfterOf(resp, body)); break; }
        // Other 5xx, 408, 425 -> leave queued, retry after a jittered backoff.
        else if (retryableStatus(resp.status)) later(it, resp.status, retryAfterOf(resp, body), true);
        else if (resp.status >= 400 && resp.status < 500) { // unfixable -> drop, and SAY so
          await Outbox.remove(it.id);
          forget(it);
          const f = it.fields || {};
          fresh.push({ label: it.label || [f.puCode, f.contest].filter(Boolean).join(' \u00b7 ') || 'report',
            queuedAt: it.queuedAt, droppedAt: Date.now(), why: refusal(resp.status, body) });
        }
      }
      if (retryDirty) {
        // Drop entries for reports no longer queued (sent or dropped elsewhere).
        const live = new Set(items.map((x) => String(x.id)));
        for (const k of Object.keys(retry)) if (!live.has(k)) delete retry[k];
        await putKv('retry', retry).catch(() => {});
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
  // Reconnect and resume are the moments every phone in an area acts at once
  // (a mast comes back; everyone unlocks at close of poll), so the first
  // attempt is staggered by a random delay rather than fired on the event.
  const goSoon = (maxMs) => setTimeout(go, Math.floor(Math.random() * maxMs));
  if (inPage) {
    G.addEventListener('online', () => goSoon(10000));
    // Coming back to the tab or app (the Lite shell resumes its WebView this
    // way) is often the first moment the network is back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') goSoon(3000); });
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
      // Chrome fires this on reconnect for every phone at once: stagger it too.
      e.waitUntil(new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5000)))
        .then(() => Outbox.flush())
        .then(async () => { if (await Outbox.count()) throw new Error('outbox not empty'); }));
    });
  }
})(self);

/* Direct-to-bucket uploads for evidence photos.
 *
 * WHY. GO54 counts INBOUND bytes against the 150 GB monthly allowance
 * ("providers measure traffic at the network interface level, not just what is
 * served out"), and at a measured 369 KB per observer the submission request is
 * the bandwidth ceiling. When the server is in direct mode the phone PUTs its
 * photos straight to the bucket and the origin handles a few hundred bytes of
 * JSON instead. See docs/DIRECT-UPLOAD.md.
 *
 * IT ALWAYS DEGRADES TO THE OLD PATH. Every failure here — the server not being
 * in direct mode, a presign refusal, a dead bucket, CORS, an offline phone —
 * returns null, and the caller posts multipart exactly as it always has. That is
 * deliberate: this ships long before the bucket exists, and an observer standing
 * in a polling unit must never lose a report because a storage optimisation was
 * unavailable. There is no configuration on the phone; the SERVER decides, and
 * one client build works against either mode.
 *
 * EXCEPT WHEN THE SERVER SAYS "BUSY". A presign answered 429 (this observer is
 * rate-limited) or 503 (the origin is shedding load) is not "direct upload is
 * unavailable" — it is "not now". Falling back to multipart there sends the
 * photo bytes THROUGH the origin at exactly the moment it asked for less
 * (ELECTION-NIGHT-HOSTING.md §2.4, the CGNAT finding). tryUpload() hands that
 * back as { busy, status, retryAfter } so the caller parks the signed report in
 * the outbox until Retry-After. upload() keeps the old true|null contract for
 * any caller that has not learned about busy.
 *
 * WHAT IT DOES NOT DO: compute a perceptual hash. That was tried and measured —
 * a browser canvas cannot reproduce the server's sharp pipeline (0/24 exact
 * matches over real sheets, median 10 bits apart against a threshold of 4) — so
 * the server computes it from the stored bytes instead, moments later.
 */
(function () {
  const SLOTS = [['sheet', 'imageSha256'], ['venue', 'venueImageSha256']];

  /* D1 EVIDENCE STORE (photo quorum). Once a sheet holds its quorum of agreeing
   * photo-backed reports, a later agreeing report sends hashes only, and THIS
   * PHONE is where its photos live. They must outlive the election-petition
   * window whatever the "keep copies on this phone" switch says: that switch
   * governs the gallery copy (save-media.js); this one is the page's own store.
   *
   * A page has no reliable device storage: IndexedDB may be evicted under
   * storage pressure (or after 7 idle days in Safari) unless the browser grants
   * PERSISTENT storage. So the figures are offered only when it is granted, and
   * the copy is read back before "hash-only" is accepted. Otherwise the photos
   * upload exactly as before. */
  const EVIDENCE_DB = 'hawkeye-evidence';
  const EVIDENCE_STORE = 'photos';
  // End of 31 July 2027 in Lagos (UTC+1): the 2027 election-petition window.
  const KEEP_UNTIL = Date.UTC(2027, 6, 31, 23, 0, 0);
  // A report filed later (a by-election) still gets a window of its own.
  const MIN_KEEP_MS = 180 * 24 * 3600 * 1000;
  const keepUntil = (now) => Math.max(KEEP_UNTIL, now + MIN_KEEP_MS);
  // Firefox asks the user before granting persistence: never let that
  // question hold a report up.
  const PERSIST_WAIT_MS = 1500;

  const done = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  function openEvidence() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(EVIDENCE_DB, 1);
      rq.onupgradeneeded = () => {
        if (!rq.result.objectStoreNames.contains(EVIDENCE_STORE)) rq.result.createObjectStore(EVIDENCE_STORE, { keyPath: 'sha256' });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
      rq.onblocked = () => rej(new Error('evidence store blocked'));
    });
  }

  /** Can this page keep photos until the petition window closes? */
  async function evidenceAvailable() {
    try {
      const S = navigator.storage;
      if (!window.indexedDB || !S) return false;
      if (S.persisted && await S.persisted()) return true;
      if (!S.persist) return false;
      const granted = await Promise.race([S.persist(), new Promise((r) => setTimeout(() => r(false), PERSIST_WAIT_MS))]);
      return granted === true;
    } catch { return false; }
  }

  /** Drop entries whose window has closed. Nothing is due before August 2027. */
  async function pruneEvidence(now) {
    let db;
    try {
      const t = now || Date.now();
      db = await openEvidence();
      const tx = db.transaction(EVIDENCE_STORE, 'readwrite');
      const rq = tx.objectStore(EVIDENCE_STORE).openCursor();
      rq.onsuccess = () => {
        const c = rq.result;
        if (!c) return;
        if (!(c.value && c.value.keepUntil > t)) c.delete();
        c.continue();
      };
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    } catch { /* housekeeping only */ } finally { try { if (db) db.close(); } catch { /* closed */ } }
  }

  /**
   * Keep both photos of a hash-only report. True only once both are READ BACK
   * at their full size: "kept" is a claim about the phone, not about the request.
   */
  async function keepEvidence({ blobs, hashes, figures, now }) {
    let db;
    try {
      const t = now || Date.now();
      db = await openEvidence();
      const tx = db.transaction(EVIDENCE_STORE, 'readwrite');
      const s = tx.objectStore(EVIDENCE_STORE);
      for (const [slot] of SLOTS) {
        s.put({
          sha256: hashes[slot], slot, blob: blobs[slot],
          puCode: figures.puCode, contest: figures.contest, keptAt: t, keepUntil: keepUntil(t),
        });
      }
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      const rd = db.transaction(EVIDENCE_STORE, 'readonly').objectStore(EVIDENCE_STORE);
      const got = await Promise.all(SLOTS.map(([slot]) => done(rd.get(hashes[slot]))));
      const ok = SLOTS.every(([slot], i) => got[i] && got[i].blob && got[i].blob.size === blobs[slot].size);
      if (ok) pruneEvidence(t);
      return ok;
    } catch { return false; } finally { try { if (db) db.close(); } catch { /* closed */ } }
  }

  /** One kept photo by its content hash (for a later evidence request), or null. */
  async function getEvidence(sha256) {
    let db;
    try {
      db = await openEvidence();
      return (await done(db.transaction(EVIDENCE_STORE, 'readonly').objectStore(EVIDENCE_STORE).get(sha256))) || null;
    } catch { return null; } finally { try { if (db) db.close(); } catch { /* closed */ } }
  }

  /**
   * Presign, then PUT both photos to the bucket.
   *
   * `figures` ({ puCode, contest, votes }) is optional. Given, and only if this
   * page can keep the photos (evidenceAvailable), it goes with the presign so
   * the server can answer "hash-only" (D1). The photos are then kept here and
   * nothing is uploaded; if they cannot be kept, it asks again without figures.
   *
   * @returns {Promise<true|null|{hashOnly:true}|{busy:true,status:number,retryAfter:string|null}>}
   *   true when both photos are in the bucket and the caller should submit
   *   hashes as JSON; {hashOnly:true} when the photos are kept on this phone
   *   and the caller should submit hashes as JSON with hashOnly:'1'; null when
   *   the caller should fall back to the multipart path; a busy object when
   *   the server refused the presign as 429/503 — the caller must NOT post
   *   multipart, but hold the report until `retryAfter` (the Retry-After
   *   header, else the body's retryAfterS; null if neither).
   */
  async function tryUpload({ base, token, blobs, hashes, figures }) {
    if (!token || !navigator.onLine) return null;
    const offer = !!(figures && figures.puCode && figures.contest && figures.votes) && await evidenceAvailable();
    let plan;
    try {
      const r = await fetch(base + '/api/uploads/presign', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        // The byte counts are signed into the URL, so the bucket refuses a body
        // of any other length. Content-Length itself is set by the browser and
        // cannot be set here — which is the point: the signature pins the TRUE
        // length, not one we assert.
        body: JSON.stringify({
          sheetSha256: hashes.sheet,
          venueSha256: hashes.venue,
          sheetBytes: blobs.sheet && blobs.sheet.size,
          venueBytes: blobs.venue && blobs.venue.size,
          ...(offer ? { puCode: figures.puCode, contest: figures.contest, votes: figures.votes } : {}),
        }),
      });
      // 409 is the server saying "I am in proxy mode" — an answer, not a fault.
      if (r.status === 409) return null;
      if (r.status === 429 || r.status === 503) {
        // The header is unreadable cross-origin (the Lite shell) unless the
        // server exposes it, so the body's retryAfterS is the fallback.
        let ra = null;
        try { ra = r.headers.get('retry-after'); } catch { /* no headers */ }
        if (!ra) {
          try { const b = await r.json(); if (b && b.retryAfterS != null) ra = String(b.retryAfterS); } catch { /* not json */ }
        }
        return { busy: true, status: r.status, retryAfter: ra };
      }
      if (!r.ok) return null;
      plan = await r.json();
    } catch { return null; }
    // D1: the sheet already holds its quorum for these figures. Keep the photos
    // here, then send hashes only. If they cannot be kept, ask again WITHOUT the
    // figures, which gets the ordinary answer (direct, or 409 → multipart).
    if (plan && plan.mode === 'hash-only') {
      if (offer && await keepEvidence({ blobs, hashes, figures })) return { hashOnly: true };
      return tryUpload({ base, token, blobs, hashes });
    }
    if (!plan || plan.mode !== 'direct') return null;

    try {
      for (const [slot] of SLOTS) {
        const p = plan[slot];
        if (!p) return null;
        // Content-addressed storage: if the bytes are already there, a second
        // upload would be a no-op, so skip it and save the observer their data.
        if (p.alreadyStored) continue;
        if (!p.url) return null;
        const put = await fetch(p.url, {
          method: 'PUT',
          headers: p.headers || {},
          body: blobs[slot],
        });
        // The bucket verifies the body against the signed checksum, so a 400
        // here means the bytes are not what we said they were. Falling back to
        // multipart is right: the origin will hash them itself and decide.
        if (!put.ok) return null;
      }
    } catch { return null; }
    return true;
  }

  // The old contract: busy degrades to multipart, exactly as before. Kept for a
  // cached caller that predates tryUpload; every caller in this repo uses tryUpload.
  // Never hash-only: this contract has no way to say so.
  const upload = async (opts) => ((await tryUpload({ ...opts, figures: undefined })) === true ? true : null);

  window.HawkeyeDirect = { upload, tryUpload };
  // D1: the kept photos, for a later evidence request (none exists yet).
  window.HawkeyeDirect.evidence = { available: evidenceAvailable, keep: keepEvidence, get: getEvidence, prune: pruneEvidence, KEEP_UNTIL };
}());

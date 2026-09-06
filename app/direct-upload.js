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
 * WHAT IT DOES NOT DO: compute a perceptual hash. That was tried and measured —
 * a browser canvas cannot reproduce the server's sharp pipeline (0/24 exact
 * matches over real sheets, median 10 bits apart against a threshold of 4) — so
 * the server computes it from the stored bytes instead, moments later.
 */
(function () {
  const SLOTS = [['sheet', 'imageSha256'], ['venue', 'venueImageSha256']];

  /**
   * Presign, then PUT both photos to the bucket.
   *
   * @returns {Promise<boolean|null>} true when both photos are in the bucket and
   *   the caller should submit hashes as JSON; null when the caller should fall
   *   back to the multipart path.
   */
  async function upload({ base, token, blobs, hashes }) {
    if (!token || !navigator.onLine) return null;
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
        }),
      });
      // 409 is the server saying "I am in proxy mode" — an answer, not a fault.
      if (r.status === 409) return null;
      if (!r.ok) return null;
      plan = await r.json();
    } catch { return null; }
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

  window.HawkeyeDirect = { upload };
}());

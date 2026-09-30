/* Live photo capture — ONE implementation, shared by every page that shoots.
 *
 * WHY THIS FILE EXISTS. observe.html (via app.js) and collation.html each
 * carried their own copy of this. They drifted, and every fix had to be made
 * twice: the native-scanner routing, the OpenCV warm-up and the camera height
 * were all fixed on the result flow and left broken on collation, one round at
 * a time. Lifted VERBATIM from the working result-flow implementation in
 * app.js — this is that code, not a reimplementation of it.
 *
 * Contract:
 *   HAWKEYE_CAPTURE.open(target, { onShot, onError, labels })
 *     target  'sheet' | 'venue'
 *     onShot  async (blob, target) => truthy to close the camera, falsy to keep
 *             it open for a retake (the caller's GPS/validation tail)
 *   HAWKEYE_CAPTURE.native()  is the OS scanner in play?
 *   HAWKEYE_CAPTURE.warm()    start the OpenCV worker early (web only)
 *
 * The caller keeps its own state, previews and validation; only the camera
 * mechanics live here.
 */
(function () {
  // Same helper as app.js: the English stays in the source as the fallback.
  const T = (key, english, params) => {
    let out = window.HawkeyeI18n ? window.HawkeyeI18n.t(key, english) : english;
    for (const [k, v] of Object.entries(params || {})) out = String(out).split('{' + k + '}').join(v);
    return out;
  };
  /* The scan worker's quality warnings arrive as English sentences: a worker has
     no i18n runtime and is cached on its own ?v=, so its words are the wire
     format and the KEY is chosen here, where the confirm is shown. An unknown
     sentence still shows — in English, never as nothing. */
  const SCAN_WARNING = {
    'The photo looks blurry.': 'capture.photo-looks-blurry',
    'Glare is washing out part of the sheet.': 'capture.glare-washing-out-sheet',
  };
  const warningText = (w) => (SCAN_WARNING[w] ? T(SCAN_WARNING[w], w) : w);
  const $ = (id) => document.getElementById(id);
  let stream = null;
  let target = null;
  let busy = false;
  let onShot = null;
  let onError = null;

  /* FUNCTIONS, NOT CONSTANTS: resolved when the camera opens, so the words are
     in the language of that moment rather than of whenever this file loaded.
     Callers pass labels already resolved the same way. */
  const DEFAULT_LABELS = () => ({
    sheet: { title: T('observe.results-sheet-ec8a', 'Results sheet (EC8A)'), action: T('observe.capture-ec8a', 'Capture EC8A') },
    venue: { title: T('observe.polling-venue', 'Polling venue'), action: T('observe.capture-polling-venue', 'Capture Polling Venue') },
  });
  const VENUE_GUIDE = () => T('observe.venue-guide', '📸 VENUE PHOTO — aim at the polling unit itself: the building, booth, banner or the crowd around it. This is NOT the results sheet.');
  /**
   * Paint a camera label, taking its markup key OFF. The title and the Capture
   * button carry data-i18n for their first words, and menu.js re-runs apply()
   * on every language change — which would put "Results sheet (EC8A)" back over
   * a venue title. Every open repaints both, so nothing needs the key after.
   */
  const paintLabel = (el, text) => {
    if (!el) return;
    el.removeAttribute('data-i18n');
    el.textContent = text;
  };

  /** Native shell: the OS camera replaces the getUserMedia overlay entirely. */
  function native() {
    return Boolean(window.HAWKEYE && window.HAWKEYE.native
      && window.HAWKEYE.capabilities && window.HAWKEYE.capabilities.camera
      && window.HAWKEYE.capturePhoto);
  }

  /**
   * Start the document scanner's OpenCV worker BEFORE the camera opens — it is
   * ~13 MB and used to load inside start(), i.e. at the shutter, so it was never
   * ready and sheet capture fell back to a plain viewport. Web only: the APK
   * strips opencv.js because the shell has ML Kit.
   */
  function warm() {
    if (native()) return;
    try { if (window.DocScanner && DocScanner.warm) DocScanner.warm(); } catch { /* manual framing still works */ }
  }

  function close() {
    if (window.DocScanner) DocScanner.stop();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    const o = $('camera-overlay');
    if (o) o.hidden = true;
  }

  async function capture() {
    if (busy || !stream) return;
    busy = true;
    try {
      let blob;
      if (target === 'sheet' && window.DocScanner) {
        const scan = await DocScanner.capture();
        if (scan.warnings.length && !(await hkConfirm(T('capture.use-this-photo-anyway', '{v0} Use this photo anyway?', { v0: scan.warnings.map(warningText).join(' ') })))) {
          DocScanner.rearm();
          return;
        }
        blob = scan.blob;
      } else {
        const video = $('video');
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      }
      const ok = await onShot(blob, target);
      if (!ok) { if (target === 'sheet' && window.DocScanner) DocScanner.rearm(); return; }
      close();
    } finally {
      busy = false;
    }
  }

  async function nativeCapture(t) {
    if (busy) return;
    busy = true;
    target = t;
    try {
      let blob;
      try {
        blob = await window.HAWKEYE.capturePhoto(t);
      } catch (e) {
        // Never swallow everything as "user cancelled": a denied permission or a
        // missing plugin then looks exactly like a button that does nothing.
        const msg = String((e && e.message) || e || '');
        if (!/cancel/i.test(msg) && onError) onError(`Camera unavailable — ${msg || 'unknown error'}`);
        return;
      }
      if (blob) await onShot(blob, t);
    } finally {
      busy = false;
    }
  }

  async function open(t, opts) {
    opts = opts || {};
    onShot = opts.onShot || (() => true);
    onError = opts.onError || (() => {});
    const labels = opts.labels || DEFAULT_LABELS();
    if (native()) return nativeCapture(t);

    target = t;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      });
    } catch {
      return void hkAlert(T('capture.camera-access-required', 'Camera access is required — Hawkeye only accepts live photos. If you denied it, allow Camera for this site (tap the padlock/ⓘ icon by the address bar → Permissions) and try again.'));
    }
    const lab = labels[t] || {};
    paintLabel($('camera-title'), lab.title || '');
    paintLabel($('btn-capture'), lab.action || T('common.capture', 'Capture'));
    const guide = $('camera-guide');
    if (guide) {
      guide.textContent = t === 'venue' ? (opts.venueGuide || VENUE_GUIDE()) : '';
      guide.hidden = t !== 'venue';
    }
    $('camera-overlay').hidden = false;
    const video = $('video');
    video.srcObject = stream;
    await video.play();
    // Sheet capture gets Adobe-Scan-style document detection: live outline,
    // auto-capture when steady, perspective-corrected output (scan.js).
    if (t === 'sheet' && window.DocScanner) {
      DocScanner.start(video, $('scan-canvas'), $('scan-hint'), capture);
    }
  }

  // The overlay's own buttons belong to the camera, so they are wired here once
  // rather than in each page.
  document.addEventListener('DOMContentLoaded', () => {
    const cap = $('btn-capture');
    const cancel = $('btn-cancel-camera');
    if (cap) cap.onclick = capture;
    if (cancel) cancel.onclick = close;
  });

  /**
   * Downscale a photo before it is uploaded.
   *
   * FOR THE UNSIGNED PATHS ONLY — incident photos today. The server already
   * re-encodes those, but only after the bytes have crossed the observer's own
   * mobile data on election day, which is the expensive part and the part that
   * decides whether the upload finishes at all.
   *
   * DELIBERATELY NOT SHARED WITH app.js:compressCapture, which does the same
   * arithmetic for EC8A and venue photos. Those bytes are hashed, signed and
   * content-addressed in the ledger, so their compression must never change as
   * a side effect of someone tuning the incident path. The duplication is the
   * isolation; if you "fix" it by merging them, read submissions.js first.
   *
   * Returns the ORIGINAL blob on any failure, and whenever shrinking made it
   * bigger — attaching evidence must never fail because compression did.
   */
  async function shrink(blob, maxDim, quality) {
    try {
      if (!blob || !/^image\//.test(blob.type)) return blob;
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
      if (!out || out.size >= blob.size) return blob;
      // Keep it a File where possible so the upload still carries a filename.
      const name = (blob.name || 'photo.jpg').replace(/\.[^.]+$/, '') + '.jpg';
      try { return new File([out], name, { type: 'image/jpeg' }); } catch { return out; }
    } catch { return blob; }
  }

  window.HAWKEYE_CAPTURE = { open, close, capture, native, warm, shrink };
}());

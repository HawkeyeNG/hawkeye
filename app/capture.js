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
  const $ = (id) => document.getElementById(id);
  let stream = null;
  let target = null;
  let busy = false;
  let onShot = null;
  let onError = null;

  const DEFAULT_LABELS = {
    sheet: { title: 'Results sheet (EC8A)', action: 'Capture EC8A' },
    venue: { title: 'Polling venue', action: 'Capture Polling Venue' },
  };
  const VENUE_GUIDE = '📸 VENUE PHOTO — aim at the polling unit itself: the building, booth, banner or the crowd around it. This is NOT the results sheet.';

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
        if (scan.warnings.length && !confirm(`${scan.warnings.join(' ')} Use this photo anyway?`)) {
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
    const labels = opts.labels || DEFAULT_LABELS;
    if (native()) return nativeCapture(t);

    target = t;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } },
        audio: false,
      });
    } catch {
      return alert('Camera access is required — Hawkeye only accepts live photos. If you denied it, allow Camera for this site (tap the padlock/ⓘ icon by the address bar → Permissions) and try again.');
    }
    $('camera-title').textContent = (labels[t] || {}).title || '';
    $('btn-capture').textContent = (labels[t] || {}).action || 'Capture';
    const guide = $('camera-guide');
    if (guide) {
      guide.textContent = t === 'venue' ? (opts.venueGuide || VENUE_GUIDE) : '';
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

/* EC8A document scanner — Adobe-Scan-style auto document recognition.
 * Live edge detection over the camera feed, green outline + auto-capture when
 * the sheet is steady, then perspective-warp to a flat rectangle and quality-
 * check (blur/glare) before the photo is accepted.
 *
 * OpenCV itself runs in a Web Worker (scan-worker.js) — the heavy math and its
 * eval() requirement are isolated from the DOM. This file is the thin main-
 * thread controller: it grabs frames, ships them to the worker, draws the
 * overlay from the corners the worker returns, and warps on capture. If the
 * worker or OpenCV fails to load, capture falls back to the raw frame exactly
 * as before — scanning never blocks a submission.
 */
window.DocScanner = (() => {
  const PROC_W = 400; // detection runs on a downscaled copy (bigger = steadier corners)
  const STABLE_NEEDED = 5; // ~0.8 s of steady corners -> auto-capture

  let video = null, canvas = null, hint = null, onAuto = null;
  let timer = null, quad = null, lastRaw = null, stable = 0, fired = false;
  let worker = null, workerDead = false, awaitingDetect = false, cvReady = false;
  const procBuf = document.createElement('canvas'); // reused downscale target

  // Corner jitter tolerance scales with frame size — detection runs at PROC_W and
  // is upscaled ~6x, so a fixed 14px was far too tight (1px of detection wobble
  // became ~18px here and reset "hold steady" every frame). ~3.5% of the frame
  // width absorbs that upscale jitter and normal hand tremor.
  const moveTol = () => Math.max(18, (video ? video.videoWidth : 640) * 0.035);
  // Exponential smoothing so the outline (and the corners we capture with) don't
  // twitch frame-to-frame.
  const smooth = (prev, next, a = 0.5) =>
    (!prev ? next : next.map((p, i) => ({ x: prev[i].x + (p.x - prev[i].x) * a, y: prev[i].y + (p.y - prev[i].y) * a })));

  function makeWorker() {
    if (worker || workerDead) return worker;
    try {
      worker = new Worker('/scan-worker.js?v=3');
    } catch { workerDead = true; return null; }
    worker.onerror = () => { workerDead = true; if (hint) hint.textContent = 'Auto-detect unavailable — frame the sheet and capture manually'; };
    worker.onmessage = (e) => {
      const m = e.data || {};
      // OpenCV finished loading inside the worker. Until this flips, capture()
      // must NOT wait on the worker — see the readiness check there.
      if (m.type === 'ready') cvReady = true;
      if (m.type === 'error') {
        workerDead = true;
        if (hint) hint.textContent = 'Auto-detect unavailable — frame the sheet and capture manually';
      }
      // 'quad' + 'warped' are consumed by the loop / capture() via their own handlers.
    };
    // Kick the OpenCV load immediately. start() also posts this, but the whole
    // point of creating the worker early (warm) is spending the wait BEFORE the
    // camera opens — without a preload the 13 MB download still started late.
    try { worker.postMessage({ type: 'preload' }); } catch { /* onerror covers it */ }
    return worker;
  }

  // Full-res video coords for a corner set the worker returned in downscaled coords.
  function upscale(pts, sx, sy) {
    return pts && pts.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  }

  function frameImageData(w, h) {
    procBuf.width = w; procBuf.height = h;
    const g = procBuf.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  }

  // Ask the worker for the current sheet corners (one in flight at a time).
  function requestDetect() {
    // Skipping until OpenCV is ready keeps detect frames from QUEUEING in the
    // worker — otherwise every frame posted during the download replays in one
    // burst when it lands, all against a camera that has since moved.
    if (!worker || workerDead || !cvReady || awaitingDetect || !video) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const w = PROC_W, h = Math.max(1, Math.round(vh * (PROC_W / vw)));
    const id = frameImageData(w, h);
    awaitingDetect = true;
    const onMsg = (e) => {
      if (!e.data || e.data.type !== 'quad') return;
      worker.removeEventListener('message', onMsg);
      awaitingDetect = false;
      const q = upscale(e.data.quad, vw / w, vh / h);
      if (q) {
        // Steady if every corner moved less than the frame-relative tolerance.
        const steady = lastRaw && q.every((p, i) => Math.hypot(p.x - lastRaw[i].x, p.y - lastRaw[i].y) < moveTol());
        stable = steady ? stable + 1 : 1;
        lastRaw = q;
        quad = smooth(quad, q); // smoothed corners drive the outline + capture
      } else {
        // Brief detection dropouts (a flicker, a shadow) shouldn't wipe progress.
        stable = Math.max(0, stable - 2);
        lastRaw = null;
        if (stable === 0) quad = null;
      }
      draw();
      if (hint) {
        hint.textContent = !quad ? 'Point the camera at the whole EC8A sheet'
          : stable >= STABLE_NEEDED ? 'Sheet detected — capturing…' : 'Sheet found — hold steady';
      }
      if (quad && stable >= STABLE_NEEDED && !fired && onAuto) { fired = true; onAuto(); }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ type: 'detect', buf: id.data.buffer, w, h }, [id.data.buffer]);
  }

  function draw() {
    if (!canvas || !video) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!quad) return;
    g.beginPath();
    quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    const locked = stable >= STABLE_NEEDED;
    g.lineWidth = Math.max(3, canvas.width / 250);
    g.strokeStyle = locked ? '#2e9940' : '#f5a623';
    g.fillStyle = locked ? 'rgba(46,153,64,0.15)' : 'rgba(245,166,35,0.08)';
    g.fill();
    g.stroke();
  }

  function tick() {
    if (!video) return;
    requestDetect();
    timer = setTimeout(tick, 140);
  }

  function start(v, overlayCanvas, hintEl, onAutoCapture) {
    video = v; canvas = overlayCanvas; hint = hintEl; onAuto = onAutoCapture;
    quad = null; stable = 0; fired = false; awaitingDetect = false;
    canvas.hidden = false;
    if (hint) { hint.hidden = false; hint.textContent = 'Loading document detection…'; }
    makeWorker();
    if (workerDead || !worker) {
      if (hint) hint.textContent = 'Auto-detect unavailable — frame the sheet and capture manually';
      return;
    }
    worker.postMessage({ type: 'preload' }); // no-op if the warm() preload already ran
    // Honest hint: auto-detect only exists once OpenCV has landed. The Capture
    // button works either way — an un-ready scanner takes a plain frame.
    if (hint) {
      hint.textContent = cvReady
        ? 'Point the camera at the whole EC8A sheet'
        : 'Loading auto-detect… you can already capture manually';
    }
    tick();
  }

  function stop() {
    clearTimeout(timer);
    timer = null; video = null; onAuto = null;
    if (canvas) {
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, canvas.width, canvas.height);
      canvas.hidden = true;
      canvas = null;
    }
    if (hint) { hint.hidden = true; hint = null; }
    quad = null; stable = 0; fired = false; awaitingDetect = false;
  }

  // Allow another auto-capture after an aborted one (no GPS / user chose retake).
  function rearm() { fired = false; stable = 0; }

  const rawFrame = async () => {
    const v = video;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    return { blob, scanned: false, warnings: [] };
  };

  // Grab the full-res frame and DETECT the sheet on that captured frame, then
  // warp — exactly what Adobe Scan / CamScanner do. Manual capture no longer
  // depends on the live overlay holding a quad at the tap instant: whether the
  // observer waited for auto-capture or pressed the button, we re-find the sheet
  // in the shot and flatten it. Any failure falls back to the raw frame.
  async function capture() {
    if (!video) return { blob: null, scanned: false, warnings: [] };
    // NOT READY IS NOT WORTH WAITING FOR. A capture message posted while OpenCV
    // (13.3 MB) is still downloading gets no reply until it lands, so this used
    // to sit on its 10-second timeout and then fall back anyway — a tap on the
    // Capture button that did nothing for ten seconds reads as a broken button.
    // The observer's tap means NOW: take the plain frame immediately, exactly
    // what the venue capture does. The scan upgrade applies when it is ready.
    if (workerDead || !worker || !cvReady) return rawFrame();
    const vw = video.videoWidth, vh = video.videoHeight;
    const id = frameImageData(vw, vh);
    const res = await new Promise((resolve) => {
      const to = setTimeout(() => { worker.removeEventListener('message', onMsg); resolve(null); }, 10000);
      const onMsg = (e) => {
        if (!e.data || e.data.type !== 'captured') return;
        clearTimeout(to); worker.removeEventListener('message', onMsg); resolve(e.data);
      };
      worker.addEventListener('message', onMsg);
      // Pass the live smoothed quad as a hint; the worker re-detects on the
      // full-res frame and falls back to this hint if its own detect misses.
      worker.postMessage({ type: 'capture', buf: id.data.buffer, w: vw, h: vh, hintQuad: quad }, [id.data.buffer]);
    }).catch(() => null);
    if (res && res.blob) return { blob: res.blob, scanned: res.scanned, warnings: res.warnings || [] };
    return rawFrame();
  }

  /**
   * Spin the worker up BEFORE the camera opens.
   *
   * The worker pulls opencv.js — 13.3 MB — and it used to start only inside
   * start(), i.e. at the moment the observer opens the camera. With capture now
   * the FIRST step of the flow, that download has no time to finish, so
   * auto-detect was simply not ready and the sheet capture behaved like a plain
   * photo. Warming here buys it the whole sign-in-to-shutter window instead.
   *
   * Safe to call repeatedly: makeWorker() is idempotent, and a failure just sets
   * workerDead so capture() falls back to the manual frame exactly as before.
   */
  function warm() { try { makeWorker(); } catch { /* falls back to manual */ } }

  return { start, stop, rearm, capture, warm };
})();

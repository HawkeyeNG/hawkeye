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
  const MISS_GRACE = 3; // ~0.4 s of dropouts tolerated before the lock is dropped
  let timer = null, quad = null, lastRaw = null, stable = 0, fired = false, misses = 0;
  // RENDERING IS DECOUPLED FROM DETECTION. Detection is expensive, so it runs on
  // the 140 ms timer below (~7 Hz) — but the overlay used to be painted from the
  // same tick, which meant the outline redrew 7 times a second on top of a 30-60
  // fps preview. Every hand movement made it visibly stutter and trail the sheet.
  // `shown` is the quad actually drawn: it eases toward the newest detected quad
  // on every animation frame, so the outline glides at display rate while the
  // detector keeps its own pace.
  let rafId = null, shown = null;
  const RENDER_EASE = 0.35; // per animation frame; converges in ~5 frames
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
        misses = 0;
      } else {
        /**
         * A DROPOUT MUST NOT RESET THE COMPARISON POINT.
         *
         * This used to null `lastRaw`, so the next successful detection had
         * nothing to measure against, scored `steady = false` and knocked
         * `stable` back to 1. Against a real sheet detection alternates
         * hit/miss constantly (shadow, hand tremor, a passing head), so stable
         * oscillated around 1 and NEVER reached STABLE_NEEDED — auto-capture
         * could not fire at all, and the outline blinked out on every miss.
         *
         * Keeping the last corners through a few misses lets a steady hand
         * accumulate across the gaps, and holds the outline on screen instead
         * of flickering. Only a sustained loss clears the state.
         */
        // NO DECREMENT INSIDE THE GRACE WINDOW. Docking a point per miss just
        // cancels the point the next hit earns: against choppy detection the
        // count oscillates 1,0,1,0 and still never reaches STABLE_NEEDED. A miss
        // only pauses progress; `misses` resets on every hit, so it takes
        // MISS_GRACE CONSECUTIVE misses to drop the lock.
        misses += 1;
        if (misses > MISS_GRACE) { quad = null; lastRaw = null; stable = 0; misses = 0; }
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

  /**
   * A PERSISTENT FRAMING GUIDE — the scanner has to look like a scanner.
   *
   * draw() used to clear the canvas and return whenever no document was
   * detected, so until OpenCV locked onto a sheet the overlay was completely
   * blank: on the web the sheet step was indistinguishable from a plain camera,
   * which is exactly the "there is no scanner on the website" report. The native
   * shell never showed this because ML Kit brings its own scanner chrome.
   *
   * Corner brackets are always on, and dim once a document is outlined so the
   * detected quad is the thing that stands out.
   */
  function drawGuide(g, w, h, detected) {
    const inset = Math.round(Math.min(w, h) * 0.06);
    const len = Math.round(Math.min(w, h) * 0.11);
    g.save();
    g.strokeStyle = detected ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.85)';
    g.lineWidth = Math.max(3, w / 220);
    g.lineCap = 'round';
    const corners = [
      [inset, inset, 1, 1], [w - inset, inset, -1, 1],
      [inset, h - inset, 1, -1], [w - inset, h - inset, -1, -1],
    ];
    for (const [x, y, dx, dy] of corners) {
      g.beginPath();
      g.moveTo(x, y + dy * len); g.lineTo(x, y); g.lineTo(x + dx * len, y);
      g.stroke();
    }
    g.restore();
  }

  /**
   * The overlay is drawn in DISPLAYED pixels, not video pixels.
   *
   * The video now fills the frame with object-fit: cover, so the visible image
   * is a CENTRE CROP of the stream — the canvas can no longer just inherit the
   * intrinsic size and be stretched, or the outline would sit wherever the crop
   * pushed it. Detection stays in intrinsic coords (capture() warps with those);
   * only the drawing is mapped through the same cover transform the browser
   * applied, so the outline lands exactly on the sheet the observer can see.
   */
  function draw() {
    if (!canvas || !video) return;
    const box = canvas.parentElement;
    const dw = (box && box.clientWidth) || 0;
    const dh = (box && box.clientHeight) || 0;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!dw || !dh || !vw || !vh) return; // stream or layout not up yet
    // Assigning canvas.width/height RESETS the surface, so doing it every frame
    // reallocated the backing store 60 times a second once this moved to rAF.
    // Only touch it when the box actually changed size (rotation, keyboard).
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, dw, dh);
    drawGuide(g, dw, dh, !!shown);
    if (!shown) return;
    const s = Math.max(dw / vw, dh / vh);            // cover: fill, crop overflow
    const ox = (dw - vw * s) / 2, oy = (dh - vh * s) / 2;
    g.beginPath();
    shown.forEach((p, i) => {
      const x = p.x * s + ox, y = p.y * s + oy;
      return i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.closePath();
    const locked = stable >= STABLE_NEEDED;
    g.lineWidth = Math.max(3, dw / 160);
    g.strokeStyle = locked ? '#2e9940' : '#f5a623';
    g.fillStyle = locked ? 'rgba(46,153,64,0.15)' : 'rgba(245,166,35,0.08)';
    g.fill();
    g.stroke();
  }

  /**
   * Display loop. Runs at the browser's frame rate and does no detection at all,
   * so it stays cheap on a phone: ease `shown` toward the newest `quad`, paint.
   * The easing is what removes the chop — between two detections (140 ms apart)
   * the outline keeps moving toward where the sheet actually is instead of
   * sitting still and then jumping.
   */
  function render() {
    if (!video || !canvas) { rafId = null; return; }
    if (quad) {
      shown = shown && shown.length === quad.length
        ? quad.map((p, i) => ({
          x: shown[i].x + (p.x - shown[i].x) * RENDER_EASE,
          y: shown[i].y + (p.y - shown[i].y) * RENDER_EASE,
        }))
        : quad.map((p) => ({ x: p.x, y: p.y })); // first lock: snap, don't fly in
    } else {
      shown = null;
    }
    draw();
    rafId = requestAnimationFrame(render);
  }

  function tick() {
    if (!video) return;
    // Detection only. Painting is the rAF loop's job — when both lived here the
    // overlay redrew at 7 Hz over a 60 fps preview, which is what made scanning
    // look choppy on a moving hand. Detection is skipped until OpenCV is ready
    // (and entirely if the worker died); the overlay still paints regardless.
    requestDetect();
    timer = setTimeout(tick, 140);
  }

  function start(v, overlayCanvas, hintEl, onAutoCapture) {
    video = v; canvas = overlayCanvas; hint = hintEl; onAuto = onAutoCapture;
    quad = null; stable = 0; fired = false; awaitingDetect = false; misses = 0; lastRaw = null;
    shown = null;
    canvas.hidden = false;
    // Start painting immediately: the guide brackets should be up while OpenCV
    // is still downloading, not only once detection begins.
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
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
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null; shown = null;
    timer = null; video = null; onAuto = null;
    if (canvas) {
      const g = canvas.getContext('2d');
      g.clearRect(0, 0, canvas.width, canvas.height);
      canvas.hidden = true;
      canvas = null;
    }
    if (hint) { hint.hidden = true; hint = null; }
    quad = null; stable = 0; fired = false; awaitingDetect = false; misses = 0; lastRaw = null;
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

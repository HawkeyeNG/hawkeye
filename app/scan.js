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
  const PROC_W = 320; // detection runs on a downscaled copy of the frame
  const STABLE_NEEDED = 8; // ~1.2 s of steady corners -> auto-capture
  const MOVE_TOL = 14; // corner jitter tolerance, video px

  let video = null, canvas = null, hint = null, onAuto = null;
  let timer = null, quad = null, stable = 0, fired = false;
  let worker = null, workerDead = false, awaitingDetect = false;
  const procBuf = document.createElement('canvas'); // reused downscale target

  function makeWorker() {
    if (worker || workerDead) return worker;
    try {
      worker = new Worker('/scan-worker.js');
    } catch { workerDead = true; return null; }
    worker.onerror = () => { workerDead = true; if (hint) hint.textContent = 'Auto-detect unavailable — frame the sheet and capture manually'; };
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'error') {
        workerDead = true;
        if (hint) hint.textContent = 'Auto-detect unavailable — frame the sheet and capture manually';
      }
      // 'quad' + 'warped' are consumed by the loop / capture() via their own handlers.
    };
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
    if (!worker || workerDead || awaitingDetect || !video) return;
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
      if (q && quad && q.every((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y) < MOVE_TOL)) stable++;
      else stable = q ? 1 : 0;
      quad = q;
      draw();
      if (hint) {
        hint.textContent = !q ? 'Point the camera at the whole EC8A sheet'
          : stable >= STABLE_NEEDED ? 'Sheet detected — capturing…' : 'Sheet found — hold steady';
      }
      if (q && stable >= STABLE_NEEDED && !fired && onAuto) { fired = true; onAuto(); }
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
    worker.postMessage({ type: 'preload' }); // warm OpenCV in the worker
    if (hint) hint.textContent = 'Point the camera at the whole EC8A sheet';
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

  // Grab a full-res frame; if a quad is locked, warp + quality-check it in the
  // worker. Any failure falls back to the raw frame.
  async function capture() {
    if (!video) return { blob: null, scanned: false, warnings: [] };
    if (workerDead || !worker || !quad) return rawFrame();
    const vw = video.videoWidth, vh = video.videoHeight;
    const id = frameImageData(vw, vh);
    const warped = await new Promise((resolve) => {
      const to = setTimeout(() => { worker.removeEventListener('message', onMsg); resolve(null); }, 8000);
      const onMsg = (e) => {
        if (!e.data || e.data.type !== 'warped') return;
        clearTimeout(to); worker.removeEventListener('message', onMsg); resolve(e.data);
      };
      worker.addEventListener('message', onMsg);
      worker.postMessage({ type: 'warp', buf: id.data.buffer, w: vw, h: vh, quad }, [id.data.buffer]);
    }).catch(() => null);
    if (warped && warped.blob) return { blob: warped.blob, scanned: true, warnings: warped.warnings || [] };
    return rawFrame();
  }

  return { start, stop, rearm, capture };
})();

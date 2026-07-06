/* EC8A document scanner — Adobe-Scan-style auto document recognition.
 * Live edge detection over the camera feed, green outline + auto-capture when
 * the sheet is steady, then perspective-warp to a flat rectangle and quality-
 * check (blur/glare) before the photo is accepted.
 *
 * Loads /opencv.js (~13 MB, service-worker cached after first fetch) lazily,
 * only when the SHEET camera opens. Corroborative only: if OpenCV fails to
 * load or no document is found, capture falls back to the raw frame exactly
 * as before — scanning never blocks a submission.
 */
window.DocScanner = (() => {
  const PROC_W = 320; // detection runs on a downscaled copy of the frame
  const STABLE_NEEDED = 8; // ~1.2 s of steady corners -> auto-capture
  const MOVE_TOL = 14; // corner jitter tolerance, video px
  const MIN_AREA_SHARE = 0.2; // quad must cover >= 20% of the frame
  const BLUR_MIN_VAR = 40; // Laplacian variance below this = blurry
  const GLARE_MAX_SHARE = 0.2; // >20% blown-out pixels = glare warning

  let cvPromise = null;
  let video = null, canvas = null, hint = null, onAuto = null;
  let timer = null, quad = null, stable = 0, fired = false;

  function loadCv() {
    if (cvPromise) return cvPromise;
    cvPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/opencv.js';
      s.onload = () => {
        const t0 = Date.now();
        (function poll() {
          const m = window.cv;
          if (m && m.Mat) return resolve(m);
          if (m && typeof m.then === 'function') return m.then(resolve, reject);
          if (Date.now() - t0 > 25000) return reject(new Error('opencv init timeout'));
          setTimeout(poll, 100);
        })();
      };
      s.onerror = () => reject(new Error('opencv load failed'));
      document.head.appendChild(s);
    }).catch((e) => { cvPromise = null; throw e; });
    return cvPromise;
  }

  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
    const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
    return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // TL, TR, BR, BL
  }

  // Largest convex quadrilateral in the current frame, in full video coords.
  function detect(cv) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    const scale = PROC_W / vw;
    const pw = PROC_W, ph = Math.round(vh * scale);
    const buf = detect.buf || (detect.buf = document.createElement('canvas'));
    buf.width = pw; buf.height = ph;
    buf.getContext('2d').drawImage(video, 0, 0, pw, ph);
    const src = cv.imread(buf);
    const gray = new cv.Mat(), edges = new cv.Mat();
    const contours = new cv.MatVector(), hier = new cv.Mat();
    let best = null, bestArea = pw * ph * MIN_AREA_SHARE;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      cv.Canny(gray, edges, 50, 150);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, k);
      k.delete();
      cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const approx = new cv.Mat();
        cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          const area = Math.abs(cv.contourArea(approx));
          if (area > bestArea) {
            bestArea = area;
            best = [];
            for (let j = 0; j < 4; j++) {
              best.push({ x: approx.data32S[j * 2] / scale, y: approx.data32S[j * 2 + 1] / scale });
            }
          }
        }
        approx.delete();
        cnt.delete();
      }
    } finally {
      src.delete(); gray.delete(); edges.delete(); contours.delete(); hier.delete();
    }
    return best && orderCorners(best);
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

  function tick(cv) {
    if (!video) return;
    let q = null;
    try { q = detect(cv); } catch { q = null; }
    if (q && quad && q.every((p, i) => Math.hypot(p.x - quad[i].x, p.y - quad[i].y) < MOVE_TOL)) {
      stable++;
    } else {
      stable = q ? 1 : 0;
    }
    quad = q;
    draw();
    if (hint) {
      hint.textContent = !q ? 'Point the camera at the whole EC8A sheet'
        : stable >= STABLE_NEEDED ? 'Sheet detected — capturing…'
          : 'Sheet found — hold steady';
    }
    if (q && stable >= STABLE_NEEDED && !fired && onAuto) {
      fired = true;
      onAuto();
    }
    timer = setTimeout(() => tick(cv), 120);
  }

  function start(v, overlayCanvas, hintEl, onAutoCapture) {
    video = v; canvas = overlayCanvas; hint = hintEl; onAuto = onAutoCapture;
    quad = null; stable = 0; fired = false;
    canvas.hidden = false;
    if (hint) { hint.hidden = false; hint.textContent = 'Loading document detection…'; }
    loadCv().then((cv) => {
      if (!video) return; // camera already closed
      if (hint) hint.textContent = 'Point the camera at the whole EC8A sheet';
      tick(cv);
    }).catch(() => {
      if (hint) hint.textContent = 'Auto-detect unavailable — frame the sheet and capture manually';
    });
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
    quad = null; stable = 0; fired = false;
  }

  // Allow another auto-capture after an aborted one (no GPS / user chose retake).
  function rearm() { fired = false; stable = 0; }

  // Grab a full-res frame; warp + quality-check it if a document quad is locked.
  async function capture() {
    const v = video;
    const full = document.createElement('canvas');
    full.width = v.videoWidth;
    full.height = v.videoHeight;
    full.getContext('2d').drawImage(v, 0, 0);
    let out = full, scanned = false;
    const warnings = [];
    const cv = await loadCv().catch(() => null);
    if (cv && quad) {
      const [tl, tr, br, bl] = quad;
      let W = Math.round(Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y)));
      let H = Math.round(Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y)));
      const cap = 2200 / Math.max(W, H);
      if (cap < 1) { W = Math.round(W * cap); H = Math.round(H * cap); }
      const src = cv.imread(full);
      const dst = new cv.Mat();
      const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
      const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
      const M = cv.getPerspectiveTransform(from, to);
      cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      const gray = new cv.Mat();
      cv.cvtColor(dst, gray, cv.COLOR_RGBA2GRAY);
      const lap = new cv.Mat();
      cv.Laplacian(gray, lap, cv.CV_64F);
      const mean = new cv.Mat(), std = new cv.Mat();
      cv.meanStdDev(lap, mean, std);
      const blurVar = std.data64F[0] * std.data64F[0];
      const bright = new cv.Mat();
      cv.threshold(gray, bright, 250, 255, cv.THRESH_BINARY);
      const glare = cv.countNonZero(bright) / (W * H);
      if (blurVar < BLUR_MIN_VAR) warnings.push('The photo looks blurry.');
      if (glare > GLARE_MAX_SHARE) warnings.push('Glare is washing out part of the sheet.');
      const oc = document.createElement('canvas');
      oc.width = W; oc.height = H;
      cv.imshow(oc, dst);
      out = oc; scanned = true;
      [src, dst, from, to, M, gray, lap, mean, std, bright].forEach((m) => m.delete());
    }
    const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.92));
    return { blob, scanned, warnings };
  }

  return { start, stop, rearm, capture };
})();

/* EC8A edge-detection worker. OpenCV runs HERE, in a DOM-less Web Worker, so
 * its eval() requirement is confined to a sandbox with no access to the DOM,
 * cookies or tokens. This file is served with its own scoped CSP that grants
 * 'unsafe-eval' ONLY to this worker (see backend securityHeaders) — the page's
 * sitewide CSP stays strict.
 *
 * Messages in:
 *   {type:'detect', buf, w, h}          downscaled RGBA frame -> find the sheet
 *   {type:'warp',   buf, w, h, quad}    full-res RGBA frame + quad -> flatten
 * Messages out:
 *   {type:'ready'} | {type:'error'}
 *   {type:'quad', quad}                 corners in the downscaled frame's coords
 *   {type:'warped', blob, scanned, warnings}
 */
const MIN_AREA_SHARE = 0.2;
const BLUR_MIN_VAR = 40;
const GLARE_MAX_SHARE = 0.2;

let cvPromise = null;
function loadCv() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    try { self.importScripts('/opencv.js'); } catch (e) { return reject(e); }
    const t0 = Date.now();
    (function poll() {
      const m = self.cv;
      if (m && m.Mat) return resolve(m);
      if (m && typeof m.then === 'function') return m.then(resolve, reject);
      if (Date.now() - t0 > 25000) return reject(new Error('opencv init timeout'));
      setTimeout(poll, 100);
    })();
  }).catch((e) => { cvPromise = null; throw e; });
  return cvPromise;
}

const imageData = (buf, w, h) => new ImageData(new Uint8ClampedArray(buf), w, h);

function orderCorners(pts) {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]]; // TL, TR, BR, BL
}

// Largest convex quadrilateral in the (already downscaled) frame.
function detect(cv, id) {
  const src = cv.matFromImageData(id);
  const gray = new cv.Mat(), edges = new cv.Mat();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  let best = null, bestArea = id.width * id.height * MIN_AREA_SHARE;
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
          for (let j = 0; j < 4; j++) best.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
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

// Perspective-flatten the full-res frame to the detected quad, then quality-check.
function warp(cv, id, quad) {
  const [tl, tr, br, bl] = quad;
  let W = Math.round(Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y)));
  let H = Math.round(Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y)));
  const cap = 2200 / Math.max(W, H);
  if (cap < 1) { W = Math.round(W * cap); H = Math.round(H * cap); }
  const src = cv.matFromImageData(id);
  const dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(from, to);
  const gray = new cv.Mat(), lap = new cv.Mat(), mean = new cv.Mat(), std = new cv.Mat(), bright = new cv.Mat();
  const warnings = [];
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    cv.cvtColor(dst, gray, cv.COLOR_RGBA2GRAY);
    cv.Laplacian(gray, lap, cv.CV_64F);
    cv.meanStdDev(lap, mean, std);
    const blurVar = std.data64F[0] * std.data64F[0];
    cv.threshold(gray, bright, 250, 255, cv.THRESH_BINARY);
    const glare = cv.countNonZero(bright) / (W * H);
    if (blurVar < BLUR_MIN_VAR) warnings.push('The photo looks blurry.');
    if (glare > GLARE_MAX_SHARE) warnings.push('Glare is washing out part of the sheet.');
    // dst is RGBA (src was RGBA) — hand back a copy so we can free the Mat.
    const out = new ImageData(new Uint8ClampedArray(dst.data), W, H);
    return { imageData: out, W, H, warnings };
  } finally {
    src.delete(); dst.delete(); from.delete(); to.delete(); M.delete();
    gray.delete(); lap.delete(); mean.delete(); std.delete(); bright.delete();
  }
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  let cv;
  try { cv = await loadCv(); } catch { self.postMessage({ type: 'error' }); return; }
  if (msg.type === 'detect') {
    let quad = null;
    try { quad = detect(cv, imageData(msg.buf, msg.w, msg.h)); } catch { quad = null; }
    self.postMessage({ type: 'quad', quad });
  } else if (msg.type === 'warp') {
    try {
      const r = warp(cv, imageData(msg.buf, msg.w, msg.h), msg.quad);
      const oc = new OffscreenCanvas(r.W, r.H);
      oc.getContext('2d').putImageData(r.imageData, 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      self.postMessage({ type: 'warped', blob, scanned: true, warnings: r.warnings });
    } catch {
      self.postMessage({ type: 'warped', blob: null, scanned: false, warnings: [] });
    }
  } else if (msg.type === 'preload') {
    self.postMessage({ type: 'ready' });
  }
};

import sharp from 'sharp';
import { config } from '../config.js';

// Venue-photo scene matching: do two DIFFERENT photographs show the SAME physical
// place? ORB keypoints + Lowe ratio test + RANSAC homography — a pair is only
// 'confirmed' when enough matched points agree on one geometric transform, which
// two different buildings essentially never do. (Perceptual hashes can't do this:
// they detect copies, not scenes.) A CLIP-style embedding second stage could add
// viewpoint robustness later, but its failure mode — scoring two similar-looking
// school buildings as a match — is the common case among polling venues, so ORB's
// precision is the trustworthy core. Everything here degrades gracefully: on any
// failure we return null and the submission proceeds without scene evidence.
let cvPromise = null;
function getCv() {
  if (!cvPromise) {
    cvPromise = (async () => {
      const mod = (await import('@techstark/opencv-js')).default;
      if (mod && typeof mod.then === 'function') return await mod;
      if (mod.Mat) return mod;
      return new Promise((resolve) => { mod.onRuntimeInitialized = () => resolve(mod); });
    })().catch((err) => {
      console.error('[scene] OpenCV init failed:', err.message);
      return null;
    });
  }
  return cvPromise;
}

const MAX_DIM = 1000; // normalise photo size before detection

function makeOrb(cv) {
  try { return new cv.ORB(config.orbFeatures); } catch { return new cv.ORB(); }
}

// Serialized features: [uint32 n][n * (float32 x, float32 y)][n * 32 bytes descriptor]
export async function extractFeatures(jpegBuffer) {
  const cv = await getCv();
  if (!cv) return null;
  let mat, gray, kp, des, orb, none;
  try {
    const { data, info } = await sharp(jpegBuffer)
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    mat = new cv.Mat(info.height, info.width, cv.CV_8UC4);
    mat.data.set(data);
    gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    orb = makeOrb(cv);
    kp = new cv.KeyPointVector();
    des = new cv.Mat();
    none = new cv.Mat();
    orb.detectAndCompute(gray, none, kp, des);
    const n = kp.size();
    if (n < 8 || des.rows !== n) return null;
    const buf = Buffer.alloc(4 + n * 8 + n * 32);
    buf.writeUInt32LE(n, 0);
    for (let i = 0; i < n; i++) {
      const p = kp.get(i).pt;
      buf.writeFloatLE(p.x, 4 + i * 8);
      buf.writeFloatLE(p.y, 8 + i * 8);
    }
    Buffer.from(des.data.buffer, des.data.byteOffset, n * 32).copy(buf, 4 + n * 8);
    return buf;
  } catch (err) {
    console.error('[scene] extract failed:', err.message);
    return null;
  } finally {
    for (const m of [mat, gray, kp, des, orb, none]) m?.delete?.();
  }
}

function deserialize(cv, buf) {
  const n = buf.readUInt32LE(0);
  const pts = new Float32Array(n * 2);
  for (let i = 0; i < n * 2; i++) pts[i] = buf.readFloatLE(4 + i * 4);
  const des = cv.matFromArray(n, 32, cv.CV_8UC1, Array.from(buf.subarray(4 + n * 8, 4 + n * 8 + n * 32)));
  return { pts, des };
}

export async function matchFeatures(bufA, bufB) {
  const cv = await getCv();
  if (!cv || !bufA || !bufB) return null;
  let a, b, bf, knn, srcMat, dstMat, mask, H;
  try {
    a = deserialize(cv, bufA);
    b = deserialize(cv, bufB);
    bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    knn = new cv.DMatchVectorVector();
    bf.knnMatch(a.des, b.des, knn, 2);
    const src = [];
    const dst = [];
    for (let i = 0; i < knn.size(); i++) {
      const pair = knn.get(i);
      if (pair.size() < 2) continue;
      const m = pair.get(0);
      const n2 = pair.get(1);
      if (m.distance < config.sceneRatio * n2.distance) {
        src.push(a.pts[m.queryIdx * 2], a.pts[m.queryIdx * 2 + 1]);
        dst.push(b.pts[m.trainIdx * 2], b.pts[m.trainIdx * 2 + 1]);
      }
    }
    const good = src.length / 2;
    let inliers = 0;
    if (good >= config.sceneMinGoodMatches) {
      srcMat = cv.matFromArray(good, 1, cv.CV_32FC2, src);
      dstMat = cv.matFromArray(good, 1, cv.CV_32FC2, dst);
      mask = new cv.Mat();
      H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 5, mask);
      if (!H.empty()) for (let i = 0; i < mask.rows; i++) inliers += mask.data[i];
    }
    const confirmed = inliers >= config.sceneMinInliers && inliers >= config.sceneInlierShare * good;
    return { good, inliers, confirmed };
  } catch (err) {
    console.error('[scene] match failed:', err.message);
    return null;
  } finally {
    for (const m of [a?.des, b?.des, bf, knn, srcMat, dstMat, mask, H]) m?.delete?.();
  }
}

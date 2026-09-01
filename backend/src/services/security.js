// Security middleware, dependency-free (shared host: fewer deps = smaller attack
// surface and no native-build risk). Two pieces:
//   securityHeaders — helmet-equivalent header set + CSP tuned to this app
//   makeLimiter     — fixed-window per-IP rate limiter for abuse-prone endpoints

// CSP notes: pages use inline <script>/<style> (static files, no templating — so
// 'unsafe-inline', not nonces). Leaflet is self-hosted; OSM tiles are images;
// opencv.js WASM needs 'wasm-unsafe-eval'. telegram.org hosts the Mini App SDK,
// and Telegram Web (web.telegram.org) embeds the site in an iframe — so
// frame-ancestors allows exactly that origin (no X-Frame-Options: it can't
// express an allow-list and would override this).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://unpkg.com https://telegram.org",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: blob: https://*.openstreetmap.org https://tile.openstreetmap.org",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://web.telegram.org",
].join('; ');

// OpenCV.js needs JS eval() to initialise. Instead of granting 'unsafe-eval'
// sitewide, we run OpenCV inside scan-worker.js (a DOM-less Web Worker) and
// give ONLY that worker its own CSP with 'unsafe-eval'. A worker has no DOM,
// cookie or token access, so eval there can't be turned into a page XSS. The
// page's CSP above stays strict.
const WORKER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

export function securityHeaders(req, res, next) {
  const isScanWorker = /\/scan-worker\.js$/.test(req.path || '');
  res.setHeader('Content-Security-Policy', isScanWorker ? WORKER_CSP : CSP);
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // The PWA itself needs camera + GPS (same origin); everything else off.
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
}

// Concurrency guard for CPU/RAM-heavy paths (image re-encode, OCR). Bounds how
// many such requests run at once so a burst of large uploads can't exhaust the
// shared host even if the per-IP rate limiter is bypassed (CGNAT / many IPs).
export function concurrencyLimit(max, name = 'busy') {
  let inFlight = 0;
  return (req, res, next) => {
    if (inFlight >= max) {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'server_busy', scope: name, retryAfterS: 5 });
    }
    inFlight++;
    let done = false;
    const release = () => { if (!done) { done = true; inFlight--; } };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

/**
 * The caller's real IP — NOT `req.ip`, which anyone can choose.
 *
 * THE BUG THIS CLOSES. server.js sets `trust proxy: true`, so Express reads the
 * LEFTMOST entry of X-Forwarded-For. That header is appended to by each hop, and
 * the first entry is whatever the ORIGINAL CLIENT sent. So anyone could defeat
 * every limit below by varying one request header:
 *
 *     curl -H 'X-Forwarded-For: 1.2.3.4' ...     -> counted as a new visitor
 *
 * Cloudflare overwrites CF-Connecting-IP with the actual TCP peer on every
 * request, so it cannot be spoofed from outside. It is trustworthy here for a
 * second reason too: the origin lock in server.js already refuses anything that
 * did not come through the edge, so a request reaching this code has passed
 * Cloudflare.
 *
 * FALLBACK IS THE SOCKET, NEVER A HEADER. If CF-Connecting-IP is absent the
 * request either bypassed the edge (which the origin lock should have refused)
 * or came via an edge that publishes no client-IP header. Project Shield is in
 * the latter group — it exposes Client_Region and nothing finer. Keying on the
 * socket peer then collapses callers together and limits too aggressively, which
 * is the safe direction to fail; trusting a forgeable header is not. Revisit if
 * Shield ever becomes the primary edge.
 */
export function clientIp(req) {
  const cf = req.headers?.['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Fixed-window in-memory limiter. Adequate for a single-process host; swap for a
// Redis store if the app ever runs multi-instance.
export function makeLimiter({ windowMs, max, name }) {
  const hits = new Map(); // ip -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const ip = clientIp(req);
    let h = hits.get(ip);
    if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + windowMs }; hits.set(ip, h); }
    h.count++;
    if (h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.resetAt - now) / 1000));
      return res.status(429).json({ error: 'rate_limited', scope: name, retryAfterS: Math.ceil((h.resetAt - now) / 1000) });
    }
    next();
  };
}
